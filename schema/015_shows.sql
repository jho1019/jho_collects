-- 015_shows.sql — card shows as a real entity.
--
-- Phase 6 deferred show-level grouping twice: admission/table fees had no
-- counterparty so they sat as `expense` rows with a null `deal_id`, and
-- `deals.event_name` was free text that could not be grouped or joined.
-- This file makes the show a row, points deals and transactions at it, and
-- retires `event_name`.

create table shows (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references auth.users (id),

  name           text not null,
  venue          text,
  city           text,
  state          text,

  starts_on      date not null,
  ends_on        date,                 -- null for single-day
  doors_at       timestamptz,          -- null when time unknown

  is_vendor      boolean not null default false,
  admission_cost numeric(10,2),        -- expected, for planning only
  table_cost     numeric(10,2),        -- expected, for planning only

  url            text,
  notes          text,
  status         text not null default 'planned',  -- planned | attended | skipped
  needs_review   boolean not null default false,
  created_at     timestamptz not null default now()
);

comment on table shows is
  'One row per occurrence, not a recurring series. A weekly show is weekly until it is not (holidays, special editions, changed hours) — the dated row carries status, actual doors time, notes and the deals that hang off it, which a series definition could hold none of.';
comment on column shows.admission_cost is
  'Expected cost, for deciding whether to go. What was actually spent is a transactions row with this show_id. If this column ever feeds a P&L figure, there are two ledgers that will disagree.';
comment on column shows.table_cost is
  'Same caveat as admission_cost. Ships unused: vending is not happening yet.';
comment on column shows.is_vendor is
  'Ships unused. Nullable and free to carry now; the alternative is a migration the week a table is first rented.';
comment on column shows.status is
  'Free text (planned | attended | skipped), not an enum — same one-way-door reasoning as releases.drop_type.';

alter table shows enable row level security;
create policy own_shows on shows
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index shows_user_day on shows (user_id, starts_on);

alter table deals        add column show_id bigint references shows (id);
alter table transactions add column show_id bigint references shows (id);

comment on column deals.show_id is
  'The show this deal happened at. Replaces event_name (dropped below) — a free-text label beside a foreign key is a second source of truth that drifts.';
comment on column transactions.show_id is
  'Set on show-level expenses (admission, table fee, parking) that have no deal_id — this is what makes them attributable to a show in show_summary without inventing a fake deal for them.';

create index deals_show        on deals (show_id) where show_id is not null;
create index transactions_show on transactions (show_id) where show_id is not null;

-- ---------------------------------------------------------------- seed + backfill
-- Five Anaheim occurrences (Wednesdays) plus the LA show, all September 2026.
-- The 2nd, 9th and 12th are past and attended; the rest are upcoming. The 2nd
-- has no deals against it on purpose — a show attended with nothing bought or
-- sold is a truthful record, not a gap, and show_summary must report it with
-- zero deals rather than erroring or omitting it.
--
-- venue, doors_at and admission_cost are left null rather than guessed; an
-- invented venue is worse than an empty one.
--
-- Deals 1 and 2 backfill to the 9 September Anaheim show; deals 3 through 6
-- to the 12 September LA show — this is the actual history in `deals`, not a
-- guess (see reference/ in the repo history for the Phase 6 fixture).
with anaheim_0902 as (
  insert into shows (name, city, state, starts_on, status)
  values ('Anaheim Card Show', 'Anaheim', 'CA', '2026-09-02', 'attended')
  returning id
),
anaheim_0909 as (
  insert into shows (name, city, state, starts_on, status)
  values ('Anaheim Card Show', 'Anaheim', 'CA', '2026-09-09', 'attended')
  returning id
),
la_0912 as (
  insert into shows (name, city, state, starts_on, status)
  values ('LA Card Show', 'Los Angeles', 'CA', '2026-09-12', 'attended')
  returning id
),
anaheim_0916 as (
  insert into shows (name, city, state, starts_on, status)
  values ('Anaheim Card Show', 'Anaheim', 'CA', '2026-09-16', 'planned')
  returning id
),
anaheim_0923 as (
  insert into shows (name, city, state, starts_on, status)
  values ('Anaheim Card Show', 'Anaheim', 'CA', '2026-09-23', 'planned')
  returning id
),
anaheim_0930 as (
  insert into shows (name, city, state, starts_on, status)
  values ('Anaheim Card Show', 'Anaheim', 'CA', '2026-09-30', 'planned')
  returning id
)
update deals set show_id = case
    when occurred_on = '2026-09-09' then (select id from anaheim_0909)
    when occurred_on = '2026-09-12' then (select id from la_0912)
  end
where occurred_on in ('2026-09-09', '2026-09-12');

-- ---------------------------------------------------------- find_or_create_show
-- card-entry resolves a deal's show by name+date match against existing rows.
-- No match does not block the deal: it creates the show flagged for review,
-- same principle as an unresolvable card falling through to a plain row
-- rather than stopping entry. Matches by case-insensitive name plus the
-- occurrence falling within [starts_on, coalesce(ends_on, starts_on)], so a
-- multi-day show still resolves on its second or third day.
create or replace function find_or_create_show(p_name text, p_occurred_on date)
returns bigint
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  select id into v_id
  from shows
  where user_id = auth.uid()
    and lower(name) = lower(btrim(p_name))
    and p_occurred_on between starts_on and coalesce(ends_on, starts_on)
  order by starts_on desc
  limit 1;

  if v_id is not null then
    return v_id;
  end if;

  -- A deal is being recorded here now, so the show was attended, not merely
  -- planned. needs_review flags it for a human to fill in venue/city/state.
  insert into shows (name, starts_on, status, needs_review)
  values (btrim(p_name), p_occurred_on, 'attended', true)
  returning id into v_id;

  return v_id;
end;
$$;

-- ------------------------------------------------------------- attach_show
-- Retro-fits show_id onto a transaction written through the CLI, mirroring
-- attach_transaction() for deals. Refuses a transaction that already
-- carries deal_id: show-level expenses are the ones with no deal, and a
-- deal-linked row is attributed to the show through deals.show_id instead
-- — see the comment on record_trade() below.
create or replace function attach_show(p_show_id bigint, p_transaction_id bigint)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from shows where id = p_show_id and user_id = auth.uid()) then
    raise exception 'show % not found', p_show_id;
  end if;

  update transactions
     set show_id = p_show_id
   where id = p_transaction_id and user_id = auth.uid() and deal_id is null;

  if not found then
    raise exception 'transaction % not found, or already belongs to a deal', p_transaction_id;
  end if;
end;
$$;

-- --------------------------------------------------------------- open_deal
-- Replaces the Phase 6 version: p_event_name (free text) becomes p_show_id
-- (foreign key). Signature changed, so the old overload is dropped first —
-- CREATE OR REPLACE cannot change a function's parameter list.
drop function if exists open_deal(date, text, bigint, text);

create function open_deal(
  p_occurred_on     date   default current_date,
  p_show_id         bigint default null,
  p_counterparty_id bigint default null,
  p_notes           text   default null
) returns bigint
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  insert into deals (occurred_on, show_id, counterparty_id, notes)
  values (coalesce(p_occurred_on, current_date), p_show_id, p_counterparty_id, p_notes)
  returning id into v_id;
  return v_id;
end;
$$;

-- -------------------------------------------------------------- record_trade
-- Replaces the Phase 6 version: p_event_name (free text) becomes p_show_id
-- (foreign key), same reasoning as open_deal above. The cash-leg description
-- still names the show — looked up from shows.name — so the ledger stays
-- readable without a stored, driftable copy of the name.
drop function if exists record_trade(bigint[], text[], numeric[], numeric, text, platform, date, text, bigint, text, bigint);

create function record_trade(
  p_out_card_ids    bigint[]  default '{}'::bigint[],
  p_in_titles       text[]    default '{}'::text[],
  p_in_est_values   numeric[] default null,
  p_cash_amount     numeric   default 0,
  p_cash_direction  text      default null,
  p_platform        platform  default 'card_show',
  p_occurred_on     date      default current_date,
  p_show_id         bigint    default null,
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
  v_show_name    text;
  i              int;
begin
  if v_dir is not null and v_dir not in ('paid', 'received') then
    raise exception 'p_cash_direction must be ''paid'' or ''received'', got %', p_cash_direction;
  end if;
  if v_cash < 0 then
    raise exception 'cash amount must be positive; direction is carried by p_cash_direction, not by the sign';
  end if;

  if v_cash > 0 and v_dir is null then
    v_needs_review := true;
  end if;

  if p_show_id is not null then
    select name into v_show_name from shows
     where id = p_show_id and user_id = auth.uid();
  end if;

  if p_deal_id is null then
    insert into deals (occurred_on, counterparty_id, show_id, notes)
    values (v_on, p_counterparty_id, p_show_id, p_notes)
    returning id into v_deal_id;
  else
    select id into v_deal_id from deals
     where id = p_deal_id and user_id = auth.uid();
    if not found then
      raise exception 'deal % not found', p_deal_id;
    end if;
  end if;

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

  if v_null_basis > 0 then
    v_needs_review := true;
  end if;

  -- show_id is deliberately not set here: this transaction's deal_id already
  -- points at a deal that carries show_id, and show_summary attributes
  -- deal cash through that join. transactions.show_id is reserved for
  -- show-level expenses that have no deal at all (see comment on the column).
  if v_cash > 0 and v_dir is not null then
    insert into transactions (
      occurred_on, type, platform, description, qty, item_amount, deal_id, notes
    ) values (
      v_on,
      case when v_dir = 'paid' then 'purchase'::txn_type else 'sale'::txn_type end,
      p_platform,
      coalesce(v_show_name, 'deal') || ' — deal ' || v_deal_id
        || case when v_dir = 'paid' then ' (cash out)' else ' (cash in)' end,
      1, v_cash, v_deal_id, p_notes
    ) returning id into v_txn_id;
  end if;

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

  if v_in_count > 0 then
    v_total_basis := v_carried
                     + case when v_dir = 'paid'     then v_cash else 0 end
                     - case when v_dir = 'received' then v_cash else 0 end;
    if v_total_basis < 0 then
      v_total_basis  := 0;
      v_needs_review := true;
    end if;

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
      if i = v_in_count then
        v_alloc := v_total_basis - v_running;
      end if;
      v_running := v_running + v_alloc;

      v_est := case
                 when p_in_est_values is not null
                  and coalesce(array_length(p_in_est_values, 1), 0) >= i
                 then p_in_est_values[i]
               end;

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

-- ---------------------------------------------------------------- deal_summary
-- Replaces the Phase 6 version. Same output shape — the column is still
-- called event_name so the web app's existing query needs no change — but it
-- is now sourced from the join instead of the dropped free-text column.
create or replace view deal_summary with (security_invoker = on) as
select
  d.id                                            as deal_id,
  d.occurred_on,
  s.name                                          as event_name,
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
left join shows  s on s.id = d.show_id
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

-- event_name is dropped only now that deal_summary no longer references it.
-- Do not leave both columns: a free-text label beside a foreign key is a
-- second source of truth that drifts within a month.
alter table deals drop column event_name;
