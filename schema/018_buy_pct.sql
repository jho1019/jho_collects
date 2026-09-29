-- 018_buy_pct.sql — configurable buy percentage, and flip-only settings become nullable.
--
-- pc target: max_all_in = comp * buy_pct (default 0.80). All-in means price +
-- shipping + tax, so the listing price backs shipping and tax out of it.
-- flip is unchanged: it keeps its rate/fee/postage/margin formula.
--
-- The four flip-only columns become nullable so pc-only use needs no invented
-- fee figures. A flip item with any of them null gets a null target, never a
-- wrong one.

alter table pricing_settings
  add column buy_pct numeric not null default 0.80
    check (buy_pct > 0 and buy_pct <= 1);

alter table pricing_settings
  alter column ebay_fee_rate  drop not null,
  alter column ebay_fixed_fee drop not null,
  alter column resale_postage drop not null,
  alter column flip_margin    drop not null;

comment on column pricing_settings.buy_pct is
  'Fraction of the latest comp to pay, all-in, for pc items. Default 0.80. max_price still overrides.';

create or replace view buying_targets with (security_invoker = on) as
select
  b.id, b.title, b.purpose, b.set_name, b.card_number, b.search_url, b.priority,
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
      round(lc.price * (1 - ps.ebay_fee_rate) - ps.ebay_fixed_fee
            - ps.resale_postage - lc.price * ps.flip_margin, 2)   -- null if any setting is null
    else round(lc.price * coalesce(ps.buy_pct, 0.80), 2)
  end as max_all_in
) t on true
where b.status = 'hunting'
  and b.user_id = auth.uid();

-- Seed from real receipts: tax is 9.75% of item price only (shipping untaxed);
-- inbound shipping median across four orders is ~5.90. Flip fields stay null.
insert into pricing_settings (user_id, sales_tax_rate, buy_shipping)
values ('d06f7566-5ba9-4ce1-a747-ccde85a910cd', 0.0975, 5.90)
on conflict (user_id) do nothing;
