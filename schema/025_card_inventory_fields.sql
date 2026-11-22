-- 025_card_inventory_fields.sql — inventory detail on `cards`.
--
-- Additive. Nothing here touches `transactions`, so net_cash and every cash
-- figure are unchanged. Run in the Supabase SQL editor after 024. Safe to run
-- twice: every step is guarded (IF NOT EXISTS, duplicate_object, or a check
-- of the current definition).
--
-- Adds:
--   sport, serial_number, cert_number      — identifying detail
--   category (pc / business / riftbound / sealed)
--   list_channel, list_price, listed_on    — where and for how much it is up
--
-- And changes two derived objects:
--   tracked_inventory — excludes category = 'pc'
--   search_text       — also covers sport and serial_number

-- ------------------------------------------------------- identifying detail
alter table cards add column if not exists sport         text;
alter table cards add column if not exists serial_number text;
alter table cards add column if not exists cert_number   text;

comment on column cards.sport is
  'Free text: basketball, baseball, football, pokemon. Display and filtering only.';
comment on column cards.serial_number is
  'Print-run numbering exactly as stamped, e.g. ''23/99''. Text, not a number: ''1/1'' and ''23/99'' are both the whole value.';
comment on column cards.cert_number is
  'Grading company certificate number. Unique per owner and grader while set; null for raw cards.';

-- A cert number identifies one physical slab. Scoped by grader because PSA and
-- BGS number independently. A null grader makes rows distinct under the index
-- (Postgres treats nulls as unequal), so a cert with no grader is unchecked —
-- record the grader with the cert.
create unique index if not exists cards_cert_uniq
  on cards (user_id, grader, cert_number) where cert_number is not null;

-- ----------------------------------------------------------------- category
do $$
begin
  create type card_category as enum ('pc', 'business', 'riftbound', 'sealed');
exception when duplicate_object then null;
end $$;

alter table cards
  add column if not exists category card_category not null default 'business';

comment on column cards.category is
  'What the card is FOR. pc = personal collection: kept, never business inventory, excluded from tracked_inventory. business = bought to resell (the default). riftbound / sealed = resale stock tracked as their own lines.';

create index if not exists cards_category on cards (user_id, category);

-- ------------------------------------------------------------------ listing
alter table cards add column if not exists list_channel platform;
alter table cards add column if not exists list_price   numeric(10,2);
alter table cards add column if not exists listed_on    date;

comment on column cards.list_channel is
  'Where the card is listed (ebay, collx, ...). Null when not listed. Reuses the platform enum from 001.';
comment on column cards.list_price is
  'Current asking price. Never income and never a cost — the sale row in transactions is the only money that counts.';
comment on column cards.listed_on is
  'Date the current listing went up.';

-- ------------------------------------------------------ tracked_inventory
-- Replaces the 007 version (which replaced 005's). Same column list, same
-- security_invoker, so CREATE OR REPLACE is sufficient. The only change is
-- `category <> 'pc'`: a personal-collection card is not held for sale, so it is
-- not business inventory and must not prop up ending inventory / COGS.
-- category is NOT NULL, so `<>` cannot silently drop rows on a null.
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
where user_id = auth.uid()
  and status not in ('sold', 'traded')
  and category <> 'pc';

-- -------------------------------------------------------------- search_text
-- A generated column's expression cannot be altered in place: drop it and add
-- it back. Safe here because
--   * nothing tracks a dependency on it — no view reads it, and find_cards
--     (008) / ebay_find_cards (024) are non-atomic SQL bodies resolved at call
--     time;
--   * dropping it drops cards_search_trgm, which is recreated right after;
--   * find_cards scores with word_similarity as well as similarity (008), so a
--     longer haystack does not push short phrases below the threshold;
--   * the DO block is one statement, so a failure part-way leaves the old
--     column in place.
-- The column moves to the end of the table. Nothing reads cards positionally:
-- `select * into v_card` and `cards%rowtype` both expand against the current
-- definition, and web/lib/tables.ts lists columns by name.
-- Guarded on the current expression so a second run is a no-op.
do $$
begin
  if not exists (
    select 1
    from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.cards'::regclass
      and a.attname = 'search_text'
      and a.attgenerated = 's'
      and pg_get_expr(d.adbin, d.adrelid) like '%serial_number%'
  ) then
    alter table cards drop column if exists search_text;
    alter table cards add column search_text text
      generated always as (
        coalesce(title, '')      || ' ' || coalesce(player, '')   || ' ' ||
        coalesce(year, '')       || ' ' || coalesce(set_name, '') || ' ' ||
        coalesce(parallel, '')   || ' ' || coalesce(grader, '')   || ' ' ||
        coalesce(grade, '')      || ' ' || coalesce(sport, '')    || ' ' ||
        coalesce(serial_number, '')
      ) stored;
  end if;
end $$;

create index if not exists cards_search_trgm
  on cards using gin (search_text gin_trgm_ops);

comment on column cards.search_text is
  'Generated haystack for find_cards: title, player, year, set, parallel, grader, grade, sport, serial number. Never write to it.';
