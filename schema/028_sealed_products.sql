-- 028_sealed_products.sql — sealed product inventory: boxes, blasters, packs.
--
-- Additive. Sales write ordinary `transactions` sale rows through the
-- functions below, exactly like sell_card(); nothing here changes how
-- net_cash or any existing figure is computed. Safe to run twice: every step
-- is guarded (IF NOT EXISTS, duplicate_object, a pg_constraint lookup, or
-- drop-and-recreate of a trigger / policy / view).
--
-- Numbering: 026_profit_views.sql is still unapplied and stays as it is.
-- 027_inventory.sql is applied. This is 028; apply it after 027, under the
-- apply_migration name 028_sealed_products — see docs/schema-migrations.md.
--
-- One row per physical unit, not one row per product with a qty column.
-- Status belongs to one box: one can be held, one listed, one sold and one
-- opened at the same time without splitting rows. Each unit has one cost and
-- one sale, the same as a card. Buying four of a blaster is four rows that
-- share a lot_id. See docs/sealed-products.md.
--
-- Adds:
--   sealed_product_status enum   — held / listed / sold / opened
--   sealed_products              — one row per unit, owner-only RLS
--   sealed_products_pc_guard     — a pc unit can never be listed or sold
--   sell_sealed_product()        — sell one unit (mirrors sell_card)
--   sell_sealed_lot()            — sell N units of a lot as ONE sale row
--   open_sealed_product()        — record an opening; writes no cash
--   find_sealed_products()       — fuzzy lookup of on-hand units
--   sealed_inventory view        — on-hand business units: counts, cost, value
--
-- Deliberately NOT changed: cards (its unused 'sealed' category value stays),
-- tracked_inventory, the tax views, and 026's sale_profit. Whether on-hand
-- sealed cost rolls into ending inventory / COGS is an open decision; until
-- it is made, sealed_inventory is the only view that reads this table.

-- -------------------------------------------------------------------- status
do $$
begin
  create type sealed_product_status as enum ('held', 'listed', 'sold', 'opened');
exception when duplicate_object then null;
end $$;

-- ----------------------------------------------------------- sealed_products
create table if not exists sealed_products (
  id                         bigint generated always as identity primary key,
  user_id                    uuid not null default auth.uid() references auth.users (id),

  lot_id                     uuid,
  sku                        text,

  product_name               text not null,
  year                       text,
  manufacturer               text,
  sport                      text,
  product_type               text not null
    check (product_type in ('hobby', 'blaster', 'mega', 'pack', 'case', 'hanger', 'other')),

  category                   text not null default 'business'
    check (category in ('business', 'pc')),
  intent                     text check (intent is null or intent in ('hold', 'sell')),
  status                     sealed_product_status not null default 'held',

  acquisition_cost           numeric(10,2) check (acquisition_cost >= 0),
  acquired_on                date,
  acquisition_transaction_id bigint references transactions (id) on delete set null,

  est_value                  numeric(10,2) check (est_value >= 0),
  est_value_source           text,
  est_valued_on              date,

  location                   text,
  notes                      text,

  list_channel               platform,
  list_price                 numeric(10,2) check (list_price >= 0),
  listed_on                  date,

  sale_transaction_id        bigint references transactions (id) on delete set null,
  exited_on                  date,
  opened_on                  date,

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  search_text                text generated always as (
    coalesce(product_name, '') || ' ' || coalesce(year, '')         || ' ' ||
    coalesce(manufacturer, '') || ' ' || coalesce(sport, '')        || ' ' ||
    coalesce(product_type, '')
  ) stored,

  constraint sold_products_have_a_sale check (
    status <> 'sold' or sale_transaction_id is not null
  ),
  constraint opened_products_have_opened_on check (
    status <> 'opened' or opened_on is not null
  ),
  -- Target for a later events / link table's composite FK, so a child row
  -- can never point at another owner's unit (same pattern as bulk_lots).
  constraint sealed_products_id_user_uniq unique (id, user_id)
);

-- Added separately and guarded so the name is fixed and a second run is a
-- no-op. Same rule as cards_intent_null_for_pc: a pc unit is never for sale.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.sealed_products'::regclass
                    and conname = 'sealed_products_intent_null_for_pc') then
    alter table sealed_products add constraint sealed_products_intent_null_for_pc
      check (intent is null or category <> 'pc');
  end if;
end $$;

comment on table sealed_products is
  'Sealed product (hobby boxes, blasters, packs), ONE ROW PER PHYSICAL UNIT. There is no qty column: four of a blaster is four rows sharing a lot_id. Not cards: new sealed stock never goes in cards. A sale is an ordinary transactions sale row linked by sale_transaction_id; opening a unit writes no cash.';
comment on column sealed_products.lot_id is
  'Groups units bought together. The writer supplies one uuid for the whole purchase. Null = a standalone unit. sell_sealed_lot() sells N units of one lot as a single sale.';
comment on column sealed_products.sku is
  'eBay Custom label, as on cards.sku. Unique per owner when set.';
comment on column sealed_products.product_name is
  'Free text, as spoken: "2025 Prizm Basketball Hobby". Used as the sale row description.';
comment on column sealed_products.product_type is
  'hobby, blaster, mega, pack, case, hanger or other.';
comment on column sealed_products.category is
  'What the unit is FOR. business = bought to resell (the default). pc = personal collection: never listed, never sold, intent always null. Plain text check, not card_category — that enum also has sealed and riftbound, which mean nothing here.';
comment on column sealed_products.intent is
  'Owner''s plan for a business unit: hold (investment) or sell (waiting to be listed). Null = undecided. Always null when category = ''pc''.';
comment on column sealed_products.status is
  'Where the unit IS: held, listed, sold (has a sale row) or opened (ripped; opened_on set). sold and opened are both final.';
comment on column sealed_products.acquisition_cost is
  'What this one unit cost. For a lot, the writer splits the purchase across its units. Null = unknown. Stays on the row after the unit is opened.';
comment on column sealed_products.acquisition_transaction_id is
  'The purchase row the unit came from, if recorded. Several units of a lot may share it.';
comment on column sealed_products.est_value is
  'Market/comp estimate for the dashboard only. Never a cost. Never rolls into COGS, purchases or ending inventory. Same meaning as cards.est_value.';
comment on column sealed_products.location is
  'Physical whereabouts: shelf, closet, case. Free text. Display and filtering only.';
comment on column sealed_products.list_channel is
  'Where the unit is listed (ebay, collx, ...). Null when not listed. Reuses the platform enum from 001.';
comment on column sealed_products.list_price is
  'Current asking price. Never income and never a cost — the sale row in transactions is the only money that counts.';
comment on column sealed_products.sale_transaction_id is
  'The sale row. Set by sell_sealed_product() / sell_sealed_lot(). Units sold together share one.';
comment on column sealed_products.exited_on is
  'The day the unit was sold. Null for an opened unit — see opened_on.';
comment on column sealed_products.opened_on is
  'The day the unit was opened. Required when status = opened. Opening is not a cash event.';
comment on column sealed_products.search_text is
  'Generated haystack for find_sealed_products: product name, year, manufacturer, sport, product type. Never write to it.';

create index if not exists sealed_products_status
  on sealed_products (user_id, status);
create index if not exists sealed_products_lot
  on sealed_products (user_id, lot_id) where lot_id is not null;
create unique index if not exists sealed_products_sku_uniq
  on sealed_products (user_id, sku) where sku is not null;
create index if not exists sealed_products_search_trgm
  on sealed_products using gin (search_text gin_trgm_ops);

-- updated_at maintenance. Named for this table, like bulk_lots_set_updated_at.
create or replace function sealed_products_set_updated_at()
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

drop trigger if exists sealed_products_set_updated_at on sealed_products;
create trigger sealed_products_set_updated_at
  before update on sealed_products
  for each row execute function sealed_products_set_updated_at();

-- ------------------------------------------------------------------ PC guard
-- Same rule as cards_pc_guard (027): a personal-collection unit is never
-- listed and never sold, with no override. Change its category first.
-- Opening a pc box is allowed — that is what PC boxes are for.
-- The trigger covers every writer, so sell_sealed_product() and
-- sell_sealed_lot() fail on a pc unit and their sale row rolls back with it.
create or replace function sealed_products_pc_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.category = 'pc' and new.status in ('listed', 'sold') then
    raise exception using
      errcode = 'check_violation',
      message = format('sealed product %s is personal collection (category pc) and cannot be %s',
                       new.id, new.status),
      hint    = 'Change the unit''s category from pc first, then list or sell it.';
  end if;
  return new;
end;
$$;

comment on function sealed_products_pc_guard() is
  'BEFORE INSERT OR UPDATE on sealed_products: rejects category = pc with status listed or sold (SQLSTATE 23514). No override — change category first. Opening is allowed.';

drop trigger if exists sealed_products_pc_guard on sealed_products;
create trigger sealed_products_pc_guard
  before insert or update on sealed_products
  for each row execute function sealed_products_pc_guard();

-- ------------------------------------------------------- sell_sealed_product
-- Mirrors sell_card() (007): the sale row and the status change happen in one
-- transaction. Never do them as two calls.
create or replace function sell_sealed_product(
  p_id               bigint,
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
security invoker
set search_path = public, pg_temp
as $$
declare
  v_unit   sealed_products%rowtype;
  v_txn_id bigint;
begin
  select * into v_unit from sealed_products
   where id = p_id and user_id = auth.uid()
   for update;

  if not found then
    raise exception 'sealed product % not found', p_id;
  end if;
  if v_unit.status = 'sold' then
    raise exception 'sealed product % is already sold (%)', p_id, v_unit.exited_on;
  end if;
  if v_unit.status = 'opened' then
    raise exception 'sealed product % was opened on % and cannot be sold', p_id, v_unit.opened_on;
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
    p_occurred_on, 'sale', p_platform, v_unit.product_name, 1,
    p_item_amount, p_shipping_charged, p_sales_tax,
    p_platform_fees, p_shipping_cost, p_notes, p_deal_id
  ) returning id into v_txn_id;

  -- A pc unit fails here (sealed_products_pc_guard), rolling back the insert.
  update sealed_products
     set status              = 'sold',
         sale_transaction_id = v_txn_id,
         exited_on           = p_occurred_on
   where id = p_id;

  return v_txn_id;
end;
$$;

-- ----------------------------------------------------------- sell_sealed_lot
-- Sells p_qty units of one lot as ONE sale row with qty = p_qty: "sold 2 of
-- the 4 blasters for $60" is one cash movement. Every sold unit points at that
-- row, so its cost later is the sum of their acquisition_cost.
--
-- Units are taken held-or-listed, lowest id first. pc units are NOT skipped:
-- a lot is one purchase and should not mix categories, so a pc unit in it is
-- a mistake worth seeing, and the guard rejects the whole sale.
--
-- Description: the product_name when every unit taken shares it (the usual
-- case); otherwise the lowest-id unit's name plus ' + N other', so a mixed
-- lot is visible on the ledger rather than labelled as one product.
create or replace function sell_sealed_lot(
  p_lot_id           uuid,
  p_qty              int,
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
security invoker
set search_path = public, pg_temp
as $$
declare
  v_ids    bigint[];
  v_names  text[];
  v_desc   text;
  v_txn_id bigint;
begin
  if p_lot_id is null then
    raise exception 'lot_id is required (units with no lot are sold one at a time with sell_sealed_product)';
  end if;
  if p_qty is null or p_qty < 1 then
    raise exception 'qty must be at least 1 (got %)', p_qty;
  end if;
  if p_deal_id is not null
     and not exists (select 1 from deals where id = p_deal_id and user_id = auth.uid()) then
    raise exception 'deal % not found', p_deal_id;
  end if;

  select array_agg(u.id order by u.id), array_agg(u.product_name order by u.id)
    into v_ids, v_names
    from (select id, product_name from sealed_products
           where user_id = auth.uid()
             and lot_id = p_lot_id
             and status in ('held', 'listed')
           order by id
           limit p_qty
           for update) u;

  if coalesce(array_length(v_ids, 1), 0) < p_qty then
    raise exception 'lot % has % unit(s) on hand, cannot sell %',
      p_lot_id, coalesce(array_length(v_ids, 1), 0), p_qty;
  end if;

  if (select count(distinct n) from unnest(v_names) n) = 1 then
    v_desc := v_names[1];
  else
    v_desc := format('%s + %s other', v_names[1], p_qty - 1);
  end if;

  insert into transactions (
    occurred_on, type, platform, description, qty,
    item_amount, shipping_charged, sales_tax_collected,
    platform_fees, shipping_cost, notes, deal_id
  ) values (
    p_occurred_on, 'sale', p_platform, v_desc, p_qty,
    p_item_amount, p_shipping_charged, p_sales_tax,
    p_platform_fees, p_shipping_cost, p_notes, p_deal_id
  ) returning id into v_txn_id;

  update sealed_products
     set status              = 'sold',
         sale_transaction_id = v_txn_id,
         exited_on           = p_occurred_on
   where id = any (v_ids);

  return v_txn_id;
end;
$$;

-- ------------------------------------------------------- open_sealed_product
-- Records that a unit was opened. Writes NO transactions row: opening moves
-- no cash. acquisition_cost stays on the row. Spreading that cost onto the
-- cards pulled from it is deferred, so no cards row is created or touched.
-- Allowed for pc units.
create or replace function open_sealed_product(
  p_id        bigint,
  p_opened_on date default current_date,
  p_notes     text default null
) returns bigint
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_unit sealed_products%rowtype;
begin
  select * into v_unit from sealed_products
   where id = p_id and user_id = auth.uid()
   for update;

  if not found then
    raise exception 'sealed product % not found', p_id;
  end if;
  if v_unit.status = 'sold' then
    raise exception 'sealed product % is already sold (%) and cannot be opened', p_id, v_unit.exited_on;
  end if;
  if v_unit.status = 'opened' then
    raise exception 'sealed product % was already opened on %', p_id, v_unit.opened_on;
  end if;

  update sealed_products
     set status    = 'opened',
         opened_on = coalesce(p_opened_on, current_date),
         notes     = case
                       when p_notes is null then notes
                       when notes is null or notes = '' then p_notes
                       else notes || E'\n' || p_notes
                     end
   where id = p_id;

  return p_id;
end;
$$;

-- ------------------------------------------------------ find_sealed_products
-- Unsold, unopened candidates ranked like find_cards (008): whole-string
-- similarity or word_similarity >= 0.5, with enough detail to tell two boxes
-- of the same product apart.
create or replace function find_sealed_products(q text)
returns table (
  id bigint, sku text, product_name text, year text, manufacturer text,
  sport text, product_type text, category text, status sealed_product_status,
  acquisition_cost numeric, acquired_on date, lot_id uuid, score real
)
language sql stable
security invoker
set search_path = public, pg_temp
as $$
  select s.id, s.sku, s.product_name, s.year, s.manufacturer, s.sport,
         s.product_type, s.category, s.status, s.acquisition_cost,
         s.acquired_on, s.lot_id,
         greatest(similarity(s.search_text, q), word_similarity(q, s.search_text)) as score
  from sealed_products s
  where s.user_id = auth.uid()
    and s.status in ('held', 'listed')
    and (s.search_text % q or word_similarity(q, s.search_text) >= 0.5)
  order by score desc, s.acquired_on desc nulls last, s.id
  limit 10;
$$;

-- Postgres grants EXECUTE to PUBLIC on creation (014's lesson): revoke from
-- public and anon explicitly, then grant to authenticated.
revoke execute on function sell_sealed_product(bigint, numeric, platform, date, numeric, numeric, numeric, numeric, text, bigint) from public, anon;
revoke execute on function sell_sealed_lot(uuid, int, numeric, platform, date, numeric, numeric, numeric, numeric, text, bigint) from public, anon;
revoke execute on function open_sealed_product(bigint, date, text) from public, anon;
revoke execute on function find_sealed_products(text) from public, anon;
grant  execute on function sell_sealed_product(bigint, numeric, platform, date, numeric, numeric, numeric, numeric, text, bigint) to authenticated;
grant  execute on function sell_sealed_lot(uuid, int, numeric, platform, date, numeric, numeric, numeric, numeric, text, bigint) to authenticated;
grant  execute on function open_sealed_product(bigint, date, text) to authenticated;
grant  execute on function find_sealed_products(text) to authenticated;

-- ---------------------------------------------------------- sealed_inventory
-- On-hand business sealed stock for the current owner: held or listed, not
-- pc. The integration point for the dashboard and for any later COGS
-- decision. Kept separate from tracked_inventory on purpose.
-- estimated_value sums only the est_values that exist: a missing estimate is
-- unknown, not $0, and units_without_price says how many are missing.
-- known_cost_basis follows tracked_inventory (0 when nothing is known);
-- units_without_cost says how many are missing.
create or replace view sealed_inventory with (security_invoker = on) as
select
  count(*)                                         as units_on_hand,
  count(*) filter (where status = 'held')          as units_held,
  count(*) filter (where status = 'listed')        as units_listed,
  count(*) filter (where acquisition_cost is null) as units_without_cost,
  count(*) filter (where est_value is null)        as units_without_price,
  coalesce(sum(acquisition_cost), 0)               as known_cost_basis,
  sum(est_value)                                   as estimated_value
from sealed_products
where user_id = auth.uid()
  and status in ('held', 'listed')
  and category <> 'pc';

comment on view sealed_inventory is
  'On-hand business sealed units (held/listed, not pc) for the current owner. estimated_value is null when no unit has an estimate, never a stand-in 0. Not part of tracked_inventory or any tax view.';

revoke all    on table sealed_inventory from anon;
grant  select on table sealed_inventory to authenticated;

-- ---------------------------------------------------------------------- RLS
-- Owner only, TO authenticated, as 027. anon gets nothing; authenticated
-- keeps row-level DML gated by the policy, but not TRUNCATE (which RLS does
-- not check).
alter table sealed_products enable row level security;

drop policy if exists own_sealed_products on sealed_products;
create policy own_sealed_products on sealed_products
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all      on table sealed_products from anon;
revoke truncate on table sealed_products from authenticated;
grant select, insert, update, delete on table sealed_products to authenticated;
