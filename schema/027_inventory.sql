-- 027_inventory.sql — inventory fields on `cards`, the PC guard, bulk lots.
--
-- Additive. Nothing here touches `transactions`, so net_cash and every cash
-- figure are unchanged. Safe to run twice: every step is guarded (IF NOT
-- EXISTS, duplicate_object, a pg_constraint lookup, or drop-and-recreate of a
-- trigger / policy). Apply after 024 and 025 are recorded in
-- supabase_migrations.schema_migrations — see docs/schema-migrations.md.
--
-- Numbering: 026_profit_views.sql is a separate, unapplied file and stays as
-- it is. This is 027 so the two never collide.
--
-- Adds on cards:
--   location                  — physical box / binder / case
--   cdp_sku                   — Card Dealer Pro SKU (unique per owner)
--   intent (hold / sell)      — splits investment holds from cards waiting
--                               to be listed; null for pc
--   cards_pc_guard trigger    — a pc card can never be listed or sold
--
-- New tables (owner-only RLS, TO authenticated):
--   bulk_lots        — the $1 / $3 / $5 / $6-20 boxes, one row per bucket
--                      per location
--   bulk_lot_events  — count adjustments. Counts only, never cash.
--
-- Deliberately NOT changed: tracked_inventory and the tax views. Whether
-- bulk-lot cost basis rolls into ending inventory / COGS is an open decision
-- (docs/DECISIONS.md); until it is made, bulk_lots feeds no money figure.

-- ------------------------------------------------------------------ location
alter table cards add column if not exists location text;

comment on column cards.location is
  'Physical whereabouts: box, binder, case. Free text. Display and filtering only.';

-- ------------------------------------------------------------------- cdp_sku
-- Two SKUs, two systems. `sku` (003) is the eBay Custom label: the join key
-- for the transaction-report import, the sold-order sync and ebay_listings.
-- `cdp_sku` is whatever Card Dealer Pro assigned when the card was scanned.
-- They may be equal for a card CDP listed on eBay, but neither is derived from
-- the other and neither is overwritten by the other.
alter table cards add column if not exists cdp_sku text;

comment on column cards.sku is
  'eBay Custom label. Join key for the transaction-report import, the sold-order sync and ebay_listings. Unique per owner when set. Not the Card Dealer Pro SKU — that is cdp_sku.';
comment on column cards.cdp_sku is
  'Card Dealer Pro SKU, as assigned at scan time. Unique per owner when set. Independent of sku (the eBay Custom label); never copied into it automatically.';

create unique index if not exists cards_cdp_sku_uniq
  on cards (user_id, cdp_sku) where cdp_sku is not null;

-- Card Dealer Pro's market price needs no new column: it goes in the existing
-- est_value with est_value_source = 'cdp' and est_valued_on = the scan date.
-- A rough market value, like every est_value — never a cost, never a comp.
comment on column cards.est_value is
  'Market/comp estimate for the dashboard only. Never a cost. Never rolls into COGS, purchases or ending inventory. Card Dealer Pro''s market price lands here with est_value_source = ''cdp'' (est_valued_on = scan date) — a rough value, not a comp.';

-- -------------------------------------------------------------------- intent
-- status says where a card IS (held / listed / sold / traded). intent says
-- what the owner means to DO with a held card: 'hold' = an investment hold,
-- 'sell' = waiting to be listed. Null = not decided. A pc card is never for
-- sale, so its intent is always null (cards_intent_null_for_pc).
alter table cards add column if not exists intent text;

comment on column cards.intent is
  'Owner''s plan for a business card: hold (investment) or sell (waiting to be listed). Null = undecided. Always null when category = ''pc''.';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.cards'::regclass and conname = 'cards_intent_check') then
    alter table cards add constraint cards_intent_check
      check (intent is null or intent in ('hold', 'sell'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.cards'::regclass and conname = 'cards_intent_null_for_pc') then
    alter table cards add constraint cards_intent_null_for_pc
      check (intent is null or category <> 'pc');
  end if;
end $$;

-- ------------------------------------------------------------------ PC guard
-- A personal-collection card is never listed and never sold. Blocked outright,
-- with no owner override: to sell a PC card, change its category first (an
-- explicit, visible decision that also moves it into tracked_inventory).
--
-- A trigger rather than a CHECK only so the error can say what to do. The
-- condition is row-local either way. It also covers every writer: sell_card()
-- and ebay_close_card_for_sale() fail on a pc card, as does the dashboard's
-- transaction-report import closing a card by SKU. 'traded' stays allowed —
-- a PC card can leave in a trade without being sold.
--
-- SECURITY INVOKER (the default), pinned search_path like every other
-- function in this schema. SQLSTATE 23514 (check_violation) so callers can
-- treat it like the constraint it effectively is.
create or replace function cards_pc_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.category = 'pc' and new.status in ('listed', 'sold') then
    raise exception using
      errcode = 'check_violation',
      message = format('card %s is personal collection (category pc) and cannot be %s',
                       new.id, new.status),
      hint    = 'Change the card''s category from pc first, then list or sell it.';
  end if;
  return new;
end;
$$;

comment on function cards_pc_guard() is
  'BEFORE INSERT OR UPDATE on cards: rejects category = pc with status listed or sold (SQLSTATE 23514). No override — change category first.';

drop trigger if exists cards_pc_guard on cards;
create trigger cards_pc_guard
  before insert or update on cards
  for each row execute function cards_pc_guard();

-- ----------------------------------------------------------------- bulk_lots
-- The price-bucket boxes ($1 / $3 / $5 / $6-20). A bulk lot is deliberately
-- NOT a set of card rows (003: cards are opt-in) — it is a count and a unit
-- price per box. Not inventory_counts either: that is the year-end tax count.
create table if not exists bulk_lots (
  id               bigint generated always as identity primary key,
  user_id          uuid not null default auth.uid() references auth.users (id),
  bucket           text not null check (bucket in ('1', '3', '5', '6_20')),
  card_count       int not null default 0 check (card_count >= 0),
  unit_price       numeric(10,2) not null check (unit_price >= 0),
  total_value      numeric(12,2) generated always as (card_count * unit_price) stored,
  total_cost       numeric(10,2) check (total_cost >= 0),
  location         text,
  last_counted_on  date,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Target of bulk_lot_events' composite FK, so an event cannot point at
  -- another owner's lot.
  constraint bulk_lots_id_user_uniq unique (id, user_id)
);

comment on table bulk_lots is
  'Price-bucket boxes, one row per (owner, bucket, location). Counts and asking prices only: no row here is a cash event, and nothing reads it into tracked_inventory or tax views (cost-basis treatment is undecided).';
comment on column bulk_lots.bucket is
  'Price bucket: ''1'', ''3'', ''5'' dollar boxes, or ''6_20'' for the $6-20 box.';
comment on column bulk_lots.card_count is
  'Cards currently in the box. Adjusted alongside a bulk_lot_events row; recount resets it.';
comment on column bulk_lots.unit_price is
  'Asking price per card. For bucket 6_20 it is the average. Never a cost.';
comment on column bulk_lots.total_value is
  'Generated: card_count * unit_price. Asking value, not a cost and not income. Never write to it.';
comment on column bulk_lots.total_cost is
  'What the cards in the box cost, if known. Null = unknown. Informational until the bulk-lot cost basis decision is made.';
comment on column bulk_lots.location is
  'Physical box. Null and '''' are the same location for uniqueness.';
comment on column bulk_lots.last_counted_on is
  'Date of the last physical recount.';

create unique index if not exists bulk_lots_bucket_location_uniq
  on bulk_lots (user_id, bucket, coalesce(location, ''));

-- updated_at maintenance. Named for this table rather than a generic
-- set_updated_at: no other table in this schema uses a trigger for it, and a
-- shared name would invite reuse with different semantics.
create or replace function bulk_lots_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bulk_lots_set_updated_at on bulk_lots;
create trigger bulk_lots_set_updated_at
  before update on bulk_lots
  for each row execute function bulk_lots_set_updated_at();

-- ----------------------------------------------------------- bulk_lot_events
-- Count adjustments, one row per change. COUNTS ONLY, NEVER CASH: when a box
-- sells at a show, the money is a normal sale row in `transactions` (the
-- ledger), and the event links to it through transaction_id. Nothing sums
-- bulk_lot_events into any P&L figure.
-- The writer updates bulk_lots.card_count in the same transaction; there is no
-- trigger doing it, so a recount can set the absolute number directly.
create table if not exists bulk_lot_events (
  id              bigint generated always as identity primary key,
  user_id         uuid not null default auth.uid() references auth.users (id),
  lot_id          bigint not null,
  delta           int not null check (delta <> 0),
  reason          text not null check (reason in ('scan_add', 'show_sale', 'recount')),
  amount          numeric(10,2),
  occurred_on     date not null default current_date,
  transaction_id  bigint references transactions (id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now(),
  constraint bulk_lot_events_lot_fk foreign key (lot_id, user_id)
    references bulk_lots (id, user_id) on delete cascade
);

comment on table bulk_lot_events is
  'Adjustments to bulk_lots.card_count. Counts only, never cash: a show sale of box cards is a sale row in transactions, linked here by transaction_id.';
comment on column bulk_lot_events.delta is
  'Signed change in card count. Nonzero: +n for scan_add, -n for show_sale, the correction for recount.';
comment on column bulk_lot_events.amount is
  'Context only (e.g. what the cards went for). Not a ledger amount; never sum into P&L. The money is the linked transactions row.';
comment on column bulk_lot_events.transaction_id is
  'The ledger row for a show_sale. Null for scan_add / recount, or when the sale row is deleted.';

create index if not exists bulk_lot_events_lot_occurred
  on bulk_lot_events (lot_id, occurred_on);

-- ---------------------------------------------------------------------- RLS
-- Owner only, TO authenticated (the 026 spec's tidy-up pattern, applied from
-- the start on new tables). anon gets nothing at all; authenticated keeps
-- row-level DML gated by the policies, but not TRUNCATE (which RLS does not
-- check).
alter table bulk_lots       enable row level security;
alter table bulk_lot_events enable row level security;

drop policy if exists own_bulk_lots on bulk_lots;
create policy own_bulk_lots on bulk_lots
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists own_bulk_lot_events on bulk_lot_events;
create policy own_bulk_lot_events on bulk_lot_events
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all      on table bulk_lots, bulk_lot_events from anon;
revoke truncate on table bulk_lots, bulk_lot_events from authenticated;
grant select, insert, update, delete on table bulk_lots, bulk_lot_events to authenticated;
