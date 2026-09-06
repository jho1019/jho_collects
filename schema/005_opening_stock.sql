-- 005_opening_stock.sql — cards owned before the ledger began.
--
-- `cards` IS the collection. status='held' is what you currently own. This
-- migration only adds a way to distinguish cards that predate Aug 1 2026 from
-- cards acquired through a recorded transaction.
--
-- WHY THIS MATTERS. Opening-stock cards were paid for with money the ledger
-- never saw. Their cost is already represented by the 2025 row in
-- `inventory_counts` (see PHASES Phase 2). If anything ever sums
-- cards.acquisition_cost into purchases, that cost is counted twice and 2026
-- profit is understated. The flag makes the boundary explicit rather than
-- relying on acquisition_transaction_id being null — which is ALSO true for a
-- card pulled from a bulk lot that WAS recorded.

alter table cards
  add column is_opening_stock boolean not null default false;

comment on column cards.is_opening_stock is
  'Owned before the ledger start date. Cost lives in inventory_counts, not in transactions. Never roll acquisition_cost for these rows into purchases.';

create index cards_opening_stock
  on cards (user_id, is_opening_stock) where is_opening_stock;

-- Opening stock has no acquiring transaction, by definition.
alter table cards add constraint opening_stock_has_no_transaction
  check (not is_opening_stock or acquisition_transaction_id is null);

-- ------------------------------------------------------- inventory view
-- Replaces the version in 003. Splits tracked stock by origin so the year-end
-- count can be reconciled without double-counting.
create or replace view tracked_inventory as
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
where user_id = auth.uid() and status <> 'sold';

-- --------------------------------------------------------- bulk seeding
-- Add a card you already own. Writes NO transaction: the money predates the
-- ledger. Safe to call in a loop when seeding an existing collection.
create or replace function add_opening_stock(
  p_title   text,
  p_cost    numeric default null,
  p_sku     text    default null,
  p_player  text    default null,
  p_year    text    default null,
  p_set     text    default null,
  p_parallel text   default null,
  p_grader  text    default null,
  p_grade   text    default null,
  p_notes   text    default null
) returns bigint
language plpgsql as $$
declare
  v_id bigint;
begin
  insert into cards (
    title, sku, player, year, set_name, parallel, grader, grade,
    acquisition_cost, is_opening_stock, status, notes
  ) values (
    p_title, nullif(btrim(coalesce(p_sku,'')),''), p_player, p_year, p_set,
    p_parallel, p_grader, p_grade, p_cost, true, 'held', p_notes
  ) returning id into v_id;
  return v_id;
end;
$$;
