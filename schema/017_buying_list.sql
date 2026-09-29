-- 017_buying_list.sql — buying list, comps, and target prices.
--
-- A list of cards to buy, what they are worth, and the most to pay. Phase 14's
-- eBay scanner scans for these and compares against buying_targets.

create table buying_list (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references auth.users (id),

  title          text not null,
  player         text,
  year           int,
  set_name       text,
  card_number    text,
  parallel       text,
  grader         text,
  grade_min      numeric,               -- 9 means PSA 9 or better

  purpose        text not null default 'pc',      -- pc | flip
  max_price      numeric(10,2),         -- manual all-in ceiling; wins over the formula
  search_url     text,
  priority       smallint,
  status         text not null default 'hunting', -- hunting | bought | dropped
  bought_card_id bigint references cards (id),
  notes          text,
  created_at     timestamptz not null default now()
);

create table comps (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references auth.users (id),
  buying_list_id bigint not null references buying_list (id),
  price          numeric(10,2) not null,
  source         text,                  -- 'ebay sold', '130point', 'card ladder'
  observed_on    date not null default current_date,
  notes          text,
  created_at     timestamptz not null default now()
);

create table pricing_settings (
  user_id         uuid primary key default auth.uid() references auth.users (id),
  ebay_fee_rate   numeric not null,     -- final value fee, as a fraction
  ebay_fixed_fee  numeric(10,2) not null,
  resale_postage  numeric(10,2) not null,
  sales_tax_rate  numeric not null,     -- charged on your purchases
  flip_margin     numeric not null,     -- target profit, fraction of comp
  buy_shipping    numeric(10,2) not null -- assumed inbound shipping, for target_listing_price
);

comment on column buying_list.purpose is
  'Free text (pc | flip), not an enum — same one-way-door reasoning as releases.drop_type.';
comment on column buying_list.status is
  'Free text (hunting | bought | dropped). Only hunting rows appear in buying_targets.';
comment on column buying_list.max_price is
  'Manual all-in ceiling (price + shipping + tax). Overrides both purpose formulas.';
comment on table comps is
  'Observations with dates, never a single overwritten value — the history is what says whether a card is rising or falling. Targets use the most recent.';
comment on column pricing_settings.buy_shipping is
  'Not in the original Phase 13 spec. target_listing_price needs a stated shipping cost, and it has to live somewhere.';

alter table buying_list     enable row level security;
alter table comps           enable row level security;
alter table pricing_settings enable row level security;

create policy own_buying_list on buying_list
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy own_comps on comps
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy own_pricing_settings on pricing_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index buying_list_user_status on buying_list (user_id, status);
create index buying_list_set on buying_list (user_id, set_name) where set_name is not null;
create index comps_item_latest on comps (buying_list_id, observed_on desc, created_at desc);

-- ---------------------------------------------------------------- buying_targets
-- One row per hunting item. No comp and no max_price => null targets, never zero.
-- flip: comp*(1-fee) - fixed - postage - comp*margin. Seller fees are the
-- seller's cost, so pc has none: max_all_in = comp.
create view buying_targets with (security_invoker = on) as
select
  b.id,
  b.title,
  b.purpose,
  b.set_name,
  b.card_number,
  b.search_url,
  b.priority,
  lc.price                                   as latest_comp,
  lc.observed_on                             as comp_date,
  (current_date - lc.observed_on)            as comp_age_days,
  coalesce((current_date - lc.observed_on) > 30, false) as is_stale,
  t.max_all_in,
  case when t.max_all_in is not null and ps.user_id is not null
       then round((t.max_all_in - ps.buy_shipping) / (1 + ps.sales_tax_rate), 2)
  end                                        as target_listing_price,
  (b.max_price is not null)                  as is_manual
from buying_list b
left join lateral (
  select c.price, c.observed_on
  from comps c
  where c.buying_list_id = b.id
  order by c.observed_on desc, c.created_at desc, c.id desc
  limit 1
) lc on true
left join pricing_settings ps on ps.user_id = b.user_id
left join lateral (
  select case
    when b.max_price is not null then b.max_price
    when lc.price is null then null
    when b.purpose = 'flip' then
      case when ps.user_id is null then null
           else round(lc.price * (1 - ps.ebay_fee_rate) - ps.ebay_fixed_fee
                      - ps.resale_postage - lc.price * ps.flip_margin, 2)
      end
    else lc.price
  end as max_all_in
) t on true
where b.status = 'hunting'
  and b.user_id = auth.uid();

comment on view buying_targets is
  'Bought/dropped items are excluded by the status filter. Everything compares all-in; target_listing_price converts back to the number seen on a listing at ps.buy_shipping.';

-- ------------------------------------------------------------ buying_set_progress
-- Owned out of total per set. Total excludes dropped rows. Owned cards must
-- exist as buying_list rows with status = 'bought' to count.
create view buying_set_progress with (security_invoker = on) as
select
  b.set_name,
  count(*) filter (where b.status = 'bought')  as owned,
  count(*)                                      as total
from buying_list b
where b.set_name is not null
  and b.status <> 'dropped'
  and b.user_id = auth.uid()
group by b.set_name;
