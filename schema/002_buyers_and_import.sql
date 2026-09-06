-- Addendum to schema.sql — buyers, and the fields the eBay import needs.
-- Derived from a real Orders report (82 columns, Sep 2026).

-- ------------------------------------------------------------- buyers
-- Separate table. Identity is stable and repeats across orders; the
-- shipping address is a fact about one order and is snapshotted there.
create table buyers (
  id                bigint generated always as identity primary key,
  user_id           uuid not null default auth.uid() references auth.users (id),

  platform          platform not null,
  platform_username text not null,     -- 'jayssportscards_ca'. The stable key.

  display_name      text,              -- last-seen real name
  relay_email       text,              -- @members.ebay.com proxy; rotates, never a key
  phone             text,

  -- Last-known location. Useful for filtering; not the shipping record.
  last_city         text,
  last_state        text,
  last_country      text,

  first_seen_on     date,
  last_seen_on      date,
  notes             text,
  created_at        timestamptz not null default now(),

  unique (user_id, platform, platform_username)
);

alter table buyers enable row level security;
create policy own_buyers on buyers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index on buyers (user_id, last_state);
create index on buyers (user_id, platform, last_seen_on desc);

-- ------------------------------------ transaction fields for the import
alter table transactions
  -- Dedupe key. eBay's Transaction ID is unique per LINE ITEM; Order Number
  -- is shared when a buyer takes several cards at once. Key on the line item
  -- so a 3-card order becomes 3 rows, then group by order_ref to split fees.
  add column source_ref           text,
  add column order_ref            text,
  add column sales_record_number  integer,
  add column item_number          text,          -- eBay listing id

  add column buyer_id             bigint references buyers (id),

  -- Address as it was for THIS order. Buyers move; the shipment didn't.
  add column ship_to_name         text,
  add column ship_to_city         text,
  add column ship_to_state        text,
  add column ship_to_zip          text,
  add column ship_to_country      text,

  add column shipping_service     text,          -- 'eBay Standard Envelope...'
  add column tracking_number      text,
  add column promoted_listing     boolean not null default false,

  -- TRUE when a row came from an Orders report, which carries no fee data.
  -- Anything still true at year end means the tax figures are wrong.
  add column fees_estimated       boolean not null default false;

create unique index transactions_source_ref_uniq
  on transactions (user_id, platform, source_ref)
  where source_ref is not null;

create index on transactions (user_id, buyer_id);
create index on transactions (user_id, order_ref);

-- --------------------------------------------------------------- views

-- The buyer list to filter and sort in the app.
create view buyer_summary as
select
  b.id,
  b.platform,
  b.platform_username,
  b.display_name,
  b.last_city,
  b.last_state,
  b.first_seen_on,
  b.last_seen_on,
  count(t.id)                                    as order_count,
  count(distinct t.order_ref)                    as distinct_orders,
  coalesce(sum(t.item_amount), 0)                as lifetime_item_value,
  coalesce(sum(t.buyer_paid_total), 0)           as lifetime_gross,
  coalesce(sum(t.net_cash), 0)                   as lifetime_net,
  round(coalesce(avg(t.item_amount), 0), 2)      as avg_item_price,
  max(t.occurred_on)                             as last_order_on,
  (count(distinct t.order_ref) > 1)              as is_repeat_buyer
from buyers b
left join transactions t
  on t.buyer_id = b.id and t.type = 'sale'
where b.user_id = auth.uid()
group by b.id, b.platform, b.platform_username, b.display_name,
         b.last_city, b.last_state, b.first_seen_on, b.last_seen_on;

-- Rows whose fees were never filled in. Should be empty before you file.
create view import_health as
select
  extract(year from occurred_on)::int as tax_year,
  count(*)                            as rows_missing_fees,
  sum(item_amount + shipping_charged) as revenue_at_risk
from transactions
where user_id = auth.uid() and fees_estimated
group by 1;
