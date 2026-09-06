-- 004_card_aliases.sql — nicknames for cards.
--
-- Aliases name a CARD, not a transaction. A transaction is a cash event that
-- already happened; an alias points at an object you still own.
--
-- The point is accumulation: every disambiguation is a chance to record what
-- you actually said, so the same phrase resolves instantly next time.

create table card_aliases (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users (id),
  card_id    bigint not null references cards (id) on delete cascade,
  alias      text not null,
  retired_at timestamptz,          -- set when the card sells; frees the name
  created_at timestamptz not null default now()
);

alter table card_aliases enable row level security;
create policy own_card_aliases on card_aliases
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- An active alias resolves to exactly one card. That uniqueness is what lets
-- an alias hit skip the disambiguation prompt entirely.
--
-- Partial on retired_at so a nickname becomes reusable once the card sells —
-- you WILL own another "the jordan" eventually. Retired rows stay queryable
-- for "what did I call that card I sold last year".
create unique index card_aliases_active_uniq
  on card_aliases (user_id, lower(alias)) where retired_at is null;

create index card_aliases_card on card_aliases (card_id);

-- ------------------------------------------------------------ lookup
-- Replaces find_cards from 003. Two-stage:
--   1. exact active alias  -> match_type 'alias', always a single row
--   2. otherwise fuzzy over title, structured fields AND alias text
--
-- Claude: match_type = 'alias' means DO NOT ask which card. It is unambiguous
-- by construction.
create or replace function find_cards(q text)
returns table (
  id bigint, sku text, title text, year text, set_name text,
  parallel text, grader text, grade text, status card_status,
  acquisition_cost numeric, acquired_on date,
  matched_alias text, match_type text, score real
)
language sql stable as $$
  with exact as (
    select c.id, c.sku, c.title, c.year, c.set_name, c.parallel,
           c.grader, c.grade, c.status, c.acquisition_cost, c.acquired_on,
           a.alias as matched_alias, 'alias'::text as match_type, 1.0::real as score
    from card_aliases a
    join cards c on c.id = a.card_id
    where a.user_id = auth.uid()
      and a.retired_at is null
      and lower(a.alias) = lower(btrim(q))
      and c.status <> 'sold'
  ),
  fuzzy as (
    select c.id, c.sku, c.title, c.year, c.set_name, c.parallel,
           c.grader, c.grade, c.status, c.acquisition_cost, c.acquired_on,
           null::text as matched_alias, 'fuzzy'::text as match_type,
           greatest(
             similarity(c.search_text, q),
             coalesce((select max(similarity(a2.alias, q))
                       from card_aliases a2
                       where a2.card_id = c.id and a2.retired_at is null), 0)
           ) as score
    from cards c
    where c.user_id = auth.uid()
      and c.status <> 'sold'
      and not exists (select 1 from exact)
      and (
        c.search_text % q
        or exists (select 1 from card_aliases a3
                   where a3.card_id = c.id and a3.retired_at is null
                     and a3.alias % q)
      )
  )
  select * from exact
  union all
  select * from fuzzy
  order by score desc, acquired_on desc nulls last
  limit 10;
$$;

-- ------------------------------------------------------------ naming
create or replace function name_card(p_card_id bigint, p_alias text)
returns bigint
language plpgsql as $$
declare
  v_id bigint;
  v_owner bigint;
begin
  if btrim(p_alias) = '' then
    raise exception 'alias cannot be blank';
  end if;

  select a.card_id into v_owner
    from card_aliases a
   where a.user_id = auth.uid()
     and a.retired_at is null
     and lower(a.alias) = lower(btrim(p_alias));

  if found and v_owner <> p_card_id then
    raise exception '% is already the nickname for card %', p_alias, v_owner;
  end if;

  insert into card_aliases (card_id, alias)
  values (p_card_id, btrim(p_alias))
  on conflict do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- ------------------------------------------------------------ selling
-- Same as 003 but retires the card's nicknames so they can be reused.
create or replace function sell_card(
  p_card_id          bigint,
  p_item_amount      numeric,
  p_platform         platform,
  p_occurred_on      date    default current_date,
  p_shipping_charged numeric default 0,
  p_sales_tax        numeric default 0,
  p_platform_fees    numeric default 0,
  p_shipping_cost    numeric default 0,
  p_notes            text    default null
) returns bigint
language plpgsql as $$
declare
  v_card   cards%rowtype;
  v_txn_id bigint;
begin
  select * into v_card from cards
   where id = p_card_id and user_id = auth.uid()
   for update;

  if not found then
    raise exception 'card % not found', p_card_id;
  end if;
  if v_card.status = 'sold' then
    raise exception 'card % is already sold (%)', p_card_id, v_card.sold_on;
  end if;

  insert into transactions (
    occurred_on, type, platform, description, qty,
    item_amount, shipping_charged, sales_tax_collected,
    platform_fees, shipping_cost, notes
  ) values (
    p_occurred_on, 'sale', p_platform, v_card.title, 1,
    p_item_amount, p_shipping_charged, p_sales_tax,
    p_platform_fees, p_shipping_cost, p_notes
  ) returning id into v_txn_id;

  update cards
     set status = 'sold', sale_transaction_id = v_txn_id, sold_on = p_occurred_on
   where id = p_card_id;

  update card_aliases
     set retired_at = now()
   where card_id = p_card_id and retired_at is null;

  return v_txn_id;
end;
$$;
