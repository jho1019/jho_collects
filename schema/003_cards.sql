-- 003_cards.sql — individually tracked cards.
--
-- `transactions` remains the ONLY source of cash truth. This table is an
-- inventory/lookup layer on top of it. Nothing here changes net_cash, and
-- COGS still comes from the annual physical count.
--
-- Deliberately OPT-IN. A bulk lot stays a single cash row with no card rows.
-- Create a card only when it is worth finding by name later — graded slabs,
-- anything listed individually, anything you would say out loud at a show.

create extension if not exists pg_trgm;

create type card_status as enum ('held', 'listed', 'sold');

create table cards (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id),

  sku         text,          -- matches eBay's 'Custom label'. The import join key.
  title       text not null, -- free text, as spoken: "michael jordan psa 10"

  -- Structured fields exist to DISAMBIGUATE. When two cards both match
  -- "michael jordan psa 10", these are what get shown to tell them apart.
  player      text,
  year        text,
  set_name    text,
  card_number text,
  parallel    text,
  grader      text,          -- PSA, BGS, SGC, CGC, or null for raw
  grade       text,          -- '10', '9.5'

  status      card_status not null default 'held',

  acquisition_transaction_id bigint references transactions (id) on delete set null,
  acquisition_cost           numeric(10,2),  -- null is fine: bulk-lot cards have none
  acquired_on                date,

  sale_transaction_id        bigint references transactions (id) on delete set null,
  sold_on                    date,

  notes       text,
  created_at  timestamptz not null default now(),

  constraint sold_cards_have_a_sale check (
    status <> 'sold' or sale_transaction_id is not null
  )
);

alter table cards enable row level security;
create policy own_cards on cards
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create unique index cards_sku_uniq
  on cards (user_id, sku) where sku is not null;
create index cards_status on cards (user_id, status);

-- One haystack for fuzzy matching.
alter table cards add column search_text text
  generated always as (
    coalesce(title, '')      || ' ' || coalesce(player, '')   || ' ' ||
    coalesce(year, '')       || ' ' || coalesce(set_name, '') || ' ' ||
    coalesce(parallel, '')   || ' ' || coalesce(grader, '')   || ' ' ||
    coalesce(grade, '')
  ) stored;

create index cards_search_trgm on cards using gin (search_text gin_trgm_ops);

-- ------------------------------------------------------------ lookup
-- Returns unsold candidates ranked by similarity, with enough detail for a
-- human to pick between two cards that both match the same phrase.
create or replace function find_cards(q text)
returns table (
  id bigint, sku text, title text, year text, set_name text,
  parallel text, grader text, grade text, status card_status,
  acquisition_cost numeric, acquired_on date, score real
)
language sql stable as $$
  select c.id, c.sku, c.title, c.year, c.set_name, c.parallel,
         c.grader, c.grade, c.status, c.acquisition_cost, c.acquired_on,
         similarity(c.search_text, q) as score
  from cards c
  where c.user_id = auth.uid()
    and c.status <> 'sold'
    and c.search_text % q
  order by score desc, c.acquired_on desc nulls last
  limit 10;
$$;

-- ------------------------------------------------------------- sell
-- Records the cash event and closes the card in ONE transaction. Never do
-- these as two separate calls — a failure between them leaves a card marked
-- sold with no money recorded, or money with the card still showing as held.
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
  v_card  cards%rowtype;
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

  return v_txn_id;
end;
$$;

-- --------------------------------------------------------- inventory
-- Cost basis of tracked unsold stock. A floor for the year-end count, not a
-- replacement: bulk-lot cards carry no acquisition_cost and are invisible here.
create view tracked_inventory as
select
  count(*)                                            as cards_on_hand,
  count(*) filter (where acquisition_cost is null)    as cards_without_cost,
  coalesce(sum(acquisition_cost), 0)                  as known_cost_basis
from cards
where user_id = auth.uid() and status <> 'sold';
