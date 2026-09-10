-- 006_deals.sql — multi-leg, in-person transactions (structure only).
--
-- A card show deal is ONE event with ONE counterparty and several legs. Before
-- this migration the schema had no concept of that event, so two things were
-- impossible: a card could not leave inventory without being sold (card_status
-- was held|listed|sold, and 'sold' requires a sale_transaction_id), and trade
-- consideration paid in cards had nowhere to go.
--
-- THE RULE THIS ENFORCES: one transaction row per CASH movement. Not one per
-- deal, not one per card. Deals GROUP transaction rows; they never replace
-- them. Never net a deal down to a single row — receipts and purchases land on
-- different Schedule C lines and carry opposite net_cash signs.
--
-- The part of a trade that is not a cash movement does not belong in
-- `transactions` at all. It is card rows linked by disposed_deal_id and
-- acquired_deal_id.
--
-- Structure only. The views and functions live in 007_deal_functions.sql and
-- must be applied after this file commits — see the note on card_status below.

-- ------------------------------------------------------------------ deals
create table deals (
  id              bigint generated always as identity primary key,
  user_id         uuid not null default auth.uid() references auth.users (id),

  occurred_on     date not null default current_date,
  counterparty_id bigint references buyers (id),
  event_name      text,
  notes           text,
  needs_review    boolean not null default false,
  created_at      timestamptz not null default now()
);

-- NO check constraints here, deliberately. A deal opened at a table before
-- anything has been agreed must be allowed to sit completely empty.

comment on table deals is
  'One in-person event with one counterparty. Groups transaction rows and card movements; never replaces them. A deal is one counterparty — a different vendor is a different deal.';
comment on column deals.counterparty_id is
  'References buyers. That table now holds counterparties who are also sellers; the name is a known misnomer kept for now.';

alter table deals enable row level security;
create policy own_deals on deals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index deals_user_date on deals (user_id, occurred_on);

-- ----------------------------------------------------------- transactions
alter table transactions add column deal_id bigint references deals (id);

comment on column transactions.deal_id is
  'The deal this cash movement belongs to. Nullable: most rows are not part of a deal, and show-level costs (admission, table fees) stay unattached until a show grouping exists.';

create index transactions_deal on transactions (deal_id) where deal_id is not null;

-- Non-cash consideration. OPEN QUESTION for a preparer: barter is technically
-- a disposition at fair market value. Basis-carryover with no cash event is the
-- treatment that fits a cash-in/cash-out ledger with periodic inventory, and is
-- what record_trade() implements. If a preparer rules that gross receipts must
-- include the FMV of goods received, that figure goes HERE — excluded from
-- net_cash, included in tax_summary. Added now because the column is cheap
-- today and a migration against tax records later. Unused until that ruling.
alter table transactions add column non_cash_consideration numeric(10,2);

comment on column transactions.non_cash_consideration is
  'Unused pending a preparer ruling on barter/FMV. Never include in net_cash. See PHASES.md Phase 6.';

-- ------------------------------------------------------------------ cards
alter table cards add column acquired_deal_id bigint references deals (id);
alter table cards add column disposed_deal_id bigint references deals (id);

-- Comp / sticker value. NOT cost. This feeds the dashboard's estimated
-- inventory value and must never touch acquisition_cost, COGS or any tax
-- figure. Recording a $100 comp as cost on a card that cost $30 overstates
-- ending inventory, which understates COGS and overstates profit.
alter table cards add column est_value        numeric(10,2);
alter table cards add column est_value_source text;
alter table cards add column est_valued_on    date;

comment on column cards.est_value is
  'Market/comp estimate for the dashboard only. Never a cost. Never rolls into COGS, purchases or ending inventory.';

create index cards_acquired_deal on cards (acquired_deal_id) where acquired_deal_id is not null;
create index cards_disposed_deal on cards (disposed_deal_id) where disposed_deal_id is not null;

-- ------------------------------------------------- sold_on -> exited_on
-- `cards` has zero rows, so this rename is free today and expensive later.
-- Two nullable date columns where exactly one is ever set is a defect waiting
-- to happen. One exit date; `status` records HOW it exited.
alter table cards rename column sold_on to exited_on;

comment on column cards.exited_on is
  'The day the card left inventory, however it left. status says how: sold or traded.';

-- ------------------------------------------------------- card_status
-- MUST BE THE LAST STATEMENT IN THIS FILE, and nothing above may reference
-- 'traded'. Postgres will not let a new enum value be USED in the same
-- transaction that adds it. 007_deal_functions.sql uses it and therefore has
-- to be applied separately, after this file commits.
alter type card_status add value if not exists 'traded';
