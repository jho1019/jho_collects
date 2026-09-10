-- 007_deal_functions.sql — the deal views and functions.
--
-- Apply AFTER 006_deals.sql has committed. Everything here references the
-- 'traded' card_status value, which Postgres will not allow in the same
-- transaction that adds it.

-- ------------------------------------------------------------ find_cards
-- Replaces the 004 version. A traded card has LEFT inventory and must not be
-- offered as a sale candidate. Without this a card given away at a show stays
-- findable and sellable, and selling it would invent receipts.
create or replace function find_cards(q text)
returns table (
  id bigint, sku text, title text, year text, set_name text,
  parallel text, grader text, grade text, status card_status,
  acquisition_cost numeric, acquired_on date,
  matched_alias text, match_type text, score real
)
language sql stable
set search_path = public, pg_temp
as $$
  with exact as (
    select c.id, c.sku, c.title, c.year, c.set_name, c.parallel,
           c.grader, c.grade, c.status, c.acquisition_cost, c.acquired_on,
           a.alias as matched_alias, 'alias'::text as match_type, 1.0::real as score
    from card_aliases a
    join cards c on c.id = a.card_id
    where a.user_id = auth.uid()
      and a.retired_at is null
      and lower(a.alias) = lower(btrim(q))
      and c.status not in ('sold', 'traded')
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
      and c.status not in ('sold', 'traded')
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

-- ------------------------------------------------------ tracked_inventory
-- Replaces the 005 version. A traded card is GONE — counting it as on-hand
-- overstates ending inventory, which understates COGS and overstates profit.
-- Same column list as 005, so CREATE OR REPLACE is sufficient.
create or replace view tracked_inventory with (security_invoker = on) as
select
  count(*)                                                     as cards_on_hand,
  count(*) filter (where is_opening_stock)                     as opening_stock_cards,
  count(*) filter (where not is_opening_stock)                 as acquired_since_start,
  count(*) filter (where acquisition_cost is null)             as cards_without_cost,
  coalesce(sum(acquisition_cost), 0)                           as known_cost_basis,
  coalesce(sum(acquisition_cost) filter (where is_opening_stock), 0)
                                                               as opening_cost_basis,
  coalesce(sum(acquisition_cost) filter (where not is_opening_stock), 0)
                                                               as acquired_cost_basis
from cards
where user_id = auth.uid() and status not in ('sold', 'traded');

-- ----------------------------------------------------------- deal_summary
-- One row per deal. Left joins throughout: an empty deal returns a row with
-- zeroes. This is also the day-totals and per-show P&L query.
--
-- The per-deal net is computed HERE, as a query result. That is the only place
-- it belongs — never stored, and never used to collapse a deal's rows into one.
create view deal_summary with (security_invoker = on) as
select
  d.id                                            as deal_id,
  d.occurred_on,
  d.event_name,
  coalesce(b.display_name, b.platform_username)   as counterparty,
  coalesce(t.net_cash, 0)                         as net_cash,
  coalesce(t.txn_count, 0)                        as txn_count,
  coalesce(ci.cards_in, 0)                        as cards_in,
  coalesce(co.cards_out, 0)                       as cards_out,
  case
    when coalesce(ci.cards_in, 0) > 0 and coalesce(co.cards_out, 0) > 0 then 'trade'
    when coalesce(ci.cards_in, 0) > 0                                   then 'purchase'
    when coalesce(co.cards_out, 0) > 0                                  then 'sale'
    else 'cash_only'
  end                                             as kind,
  d.needs_review,
  d.notes
from deals d
left join buyers b on b.id = d.counterparty_id
left join lateral (
  select sum(x.net_cash) as net_cash, count(*) as txn_count
  from transactions x where x.deal_id = d.id
) t on true
left join lateral (
  select count(*) as cards_in from cards c where c.acquired_deal_id = d.id
) ci on true
left join lateral (
  select count(*) as cards_out from cards c where c.disposed_deal_id = d.id
) co on true
where d.user_id = auth.uid();

-- -------------------------------------------------------------- open_deal
-- Creates a deal from nothing. Every argument optional — a deal opened at a
-- table before anything is agreed is a valid, empty deal.
create or replace function open_deal(
  p_occurred_on     date   default current_date,
  p_event_name      text   default null,
  p_counterparty_id bigint default null,
  p_notes           text   default null
) returns bigint
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  insert into deals (occurred_on, event_name, counterparty_id, notes)
  values (coalesce(p_occurred_on, current_date), p_event_name, p_counterparty_id, p_notes)
  returning id into v_id;
  return v_id;
end;
$$;

-- ----------------------------------------------------- attach_transaction
-- Retro-fits deal grouping onto a transaction row that already exists. This is
-- what makes it safe to record the cash first and group it later.
create or replace function attach_transaction(p_deal_id bigint, p_transaction_id bigint)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from deals where id = p_deal_id and user_id = auth.uid()) then
    raise exception 'deal % not found', p_deal_id;
  end if;

  update transactions
     set deal_id = p_deal_id
   where id = p_transaction_id and user_id = auth.uid();

  if not found then
    raise exception 'transaction % not found', p_transaction_id;
  end if;
end;
$$;

-- ------------------------------------------------------------- sell_card
-- Replaces the 004 version. Two changes: sold_on became exited_on, and an
-- optional deal_id links a sale that happened as part of a deal.
--
-- Dropped rather than replaced: adding a defaulted parameter creates an
-- overload, and every existing 9-argument call would become ambiguous.
drop function if exists sell_card(bigint, numeric, platform, date, numeric, numeric, numeric, numeric, text);

create function sell_card(
  p_card_id          bigint,
  p_item_amount      numeric,
  p_platform         platform,
  p_occurred_on      date    default current_date,
  p_shipping_charged numeric default 0,
  p_sales_tax        numeric default 0,
  p_platform_fees    numeric default 0,
  p_shipping_cost    numeric default 0,
  p_notes            text    default null,
  p_deal_id          bigint  default null
) returns bigint
language plpgsql
set search_path = public, pg_temp
as $$
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
  if v_card.status in ('sold', 'traded') then
    raise exception 'card % has already left inventory (% on %)',
      p_card_id, v_card.status, v_card.exited_on;
  end if;
  if p_deal_id is not null
     and not exists (select 1 from deals where id = p_deal_id and user_id = auth.uid()) then
    raise exception 'deal % not found', p_deal_id;
  end if;

  insert into transactions (
    occurred_on, type, platform, description, qty,
    item_amount, shipping_charged, sales_tax_collected,
    platform_fees, shipping_cost, notes, deal_id
  ) values (
    p_occurred_on, 'sale', p_platform, v_card.title, 1,
    p_item_amount, p_shipping_charged, p_sales_tax,
    p_platform_fees, p_shipping_cost, p_notes, p_deal_id
  ) returning id into v_txn_id;

  update cards
     set status              = 'sold',
         sale_transaction_id = v_txn_id,
         exited_on           = p_occurred_on,
         disposed_deal_id    = coalesce(p_deal_id, disposed_deal_id)
   where id = p_card_id;

  update card_aliases
     set retired_at = now()
   where card_id = p_card_id and retired_at is null;

  return v_txn_id;
end;
$$;

-- ------------------------------------------------------------ record_trade
-- Atomic, and the reason Phase 6 exists.
--
-- Writes ONE transaction for the CASH leg only — purchase if cash went out,
-- sale if cash came in. Never a negative purchase. The cards that moved are
-- NOT a transaction: they are card rows linked by disposed_deal_id and
-- acquired_deal_id.
--
-- BASIS CARRIES OVER AT COST, NEVER AT MARKET. The received card's basis is
-- the cash paid plus the COST BASIS of the cards given up. Cards given up at a
-- $100 comp that cost $30 carry $30. Comp values go in est_value and touch no
-- cost figure.
--
-- p_cash_direction is 'paid' or 'received' and is NEVER inferred: "gave him
-- $95" and "he gave me $95" differ only in this. Called with cash but no
-- direction, this writes the deal and the card legs, skips the transaction row
-- and flags the deal rather than guessing.
create or replace function record_trade(
  p_out_card_ids    bigint[]  default '{}'::bigint[],
  p_in_titles       text[]    default '{}'::text[],
  p_in_est_values   numeric[] default null,
  p_cash_amount     numeric   default 0,
  p_cash_direction  text      default null,
  p_platform        platform  default 'card_show',
  p_occurred_on     date      default current_date,
  p_event_name      text      default null,
  p_counterparty_id bigint    default null,
  p_notes           text      default null,
  p_deal_id         bigint    default null
) returns bigint
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_deal_id      bigint;
  v_txn_id       bigint;
  v_card         cards%rowtype;
  v_on           date    := coalesce(p_occurred_on, current_date);
  v_cash         numeric := coalesce(p_cash_amount, 0);
  v_dir          text    := lower(nullif(btrim(coalesce(p_cash_direction, '')), ''));
  v_carried      numeric := 0;
  v_null_basis   int     := 0;
  v_out_count    int     := coalesce(array_length(p_out_card_ids, 1), 0);
  v_in_count     int     := coalesce(array_length(p_in_titles, 1), 0);
  v_needs_review boolean := false;
  v_total_basis  numeric := 0;
  v_est_sum      numeric := 0;
  v_use_prorata  boolean := false;
  v_alloc        numeric;
  v_running      numeric := 0;
  v_est          numeric;
  v_cost_known   boolean;
  i              int;
begin
  if v_dir is not null and v_dir not in ('paid', 'received') then
    raise exception 'p_cash_direction must be ''paid'' or ''received'', got %', p_cash_direction;
  end if;
  if v_cash < 0 then
    raise exception 'cash amount must be positive; direction is carried by p_cash_direction, not by the sign';
  end if;

  -- Cash with no direction is unrecoverable later, and guessing it inverts the
  -- sign of a real Schedule C figure. Record everything else, flag the deal.
  if v_cash > 0 and v_dir is null then
    v_needs_review := true;
  end if;

  if p_deal_id is null then
    insert into deals (occurred_on, counterparty_id, event_name, notes)
    values (v_on, p_counterparty_id, p_event_name, p_notes)
    returning id into v_deal_id;
  else
    select id into v_deal_id from deals
     where id = p_deal_id and user_id = auth.uid();
    if not found then
      raise exception 'deal % not found', p_deal_id;
    end if;
  end if;

  -- Outgoing: lock each row, refuse anything that already left, sum the basis.
  for i in 1 .. v_out_count loop
    select * into v_card from cards
     where id = p_out_card_ids[i] and user_id = auth.uid()
     for update;

    if not found then
      raise exception 'card % not found', p_out_card_ids[i];
    end if;
    if v_card.status in ('sold', 'traded') then
      raise exception 'card % has already left inventory (% on %)',
        v_card.id, v_card.status, v_card.exited_on;
    end if;

    if v_card.acquisition_cost is null then
      v_null_basis := v_null_basis + 1;
    else
      v_carried := v_carried + v_card.acquisition_cost;
    end if;
  end loop;

  -- A missing basis must be VISIBLE, not silent. Same principle as
  -- tracked_inventory.cards_without_cost.
  if v_null_basis > 0 then
    v_needs_review := true;
  end if;

  -- The cash leg: exactly one row, for the cash and nothing else.
  if v_cash > 0 and v_dir is not null then
    insert into transactions (
      occurred_on, type, platform, description, qty, item_amount, deal_id, notes
    ) values (
      v_on,
      case when v_dir = 'paid' then 'purchase'::txn_type else 'sale'::txn_type end,
      p_platform,
      coalesce(nullif(btrim(coalesce(p_event_name, '')), ''), 'deal') || ' — deal ' || v_deal_id
        || case when v_dir = 'paid' then ' (cash out)' else ' (cash in)' end,
      1, v_cash, v_deal_id, p_notes
    ) returning id into v_txn_id;
  end if;

  -- Dispose the outgoing cards. status='traded' with sale_transaction_id left
  -- NULL is precisely what keeps net_cash honest: no receipt is invented.
  if v_out_count > 0 then
    update cards
       set status           = 'traded',
           disposed_deal_id = v_deal_id,
           exited_on        = v_on
     where id = any (p_out_card_ids) and user_id = auth.uid();

    update card_aliases
       set retired_at = now()
     where card_id = any (p_out_card_ids) and retired_at is null;
  end if;

  -- Incoming basis = cash paid + carried basis. Cash RECEIVED reduces it.
  if v_in_count > 0 then
    v_total_basis := v_carried
                     + case when v_dir = 'paid'     then v_cash else 0 end
                     - case when v_dir = 'received' then v_cash else 0 end;
    if v_total_basis < 0 then
      v_total_basis  := 0;
      v_needs_review := true;
    end if;

    -- Pro-rata by est_value only when every incoming card has one.
    -- When every outgoing card had an unknown basis and no cash moved, NOTHING
    -- is known about this card's cost. Writing 0.00 would assert that it cost
    -- nothing — understating ending inventory and hiding the gap from
    -- tracked_inventory.cards_without_cost, which counts nulls. Write null so
    -- the gap stays visible there as well as on deals.needs_review.
    -- A genuinely free card (no cards out, no cash) still gets 0.00, correctly.
    v_cost_known := not (v_null_basis > 0 and v_total_basis = 0);

    if p_in_est_values is not null
       and coalesce(array_length(p_in_est_values, 1), 0) = v_in_count
       and not exists (select 1 from unnest(p_in_est_values) as x where x is null) then
      select coalesce(sum(x), 0) into v_est_sum from unnest(p_in_est_values) as x;
      v_use_prorata := v_est_sum > 0;
    end if;

    for i in 1 .. v_in_count loop
      if v_use_prorata then
        v_alloc := round(v_total_basis * (p_in_est_values[i] / v_est_sum), 2);
      else
        v_alloc := round(v_total_basis / v_in_count, 2);
      end if;
      -- Last card absorbs the rounding remainder so the parts sum to the whole.
      if i = v_in_count then
        v_alloc := v_total_basis - v_running;
      end if;
      v_running := v_running + v_alloc;

      v_est := case
                 when p_in_est_values is not null
                  and coalesce(array_length(p_in_est_values, 1), 0) >= i
                 then p_in_est_values[i]
               end;

      -- acquisition_transaction_id is deliberately NOT set. The cash row covers
      -- the whole deal, not this card, and most of this basis carried over from
      -- cards given up rather than from that payment.
      insert into cards (
        title, status, acquisition_cost, acquired_on, acquired_deal_id,
        est_value, est_valued_on, is_opening_stock
      ) values (
        p_in_titles[i], 'held',
        case when v_cost_known then v_alloc end,
        v_on, v_deal_id,
        v_est, case when v_est is not null then v_on end, false
      );
    end loop;
  end if;

  if v_needs_review then
    update deals set needs_review = true where id = v_deal_id;
  end if;

  return v_deal_id;
end;
$$;
