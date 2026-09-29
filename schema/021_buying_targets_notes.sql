-- 021_buying_targets_notes.sql — expose buying_list.notes through the view.
--
-- The column has existed since 017; buying_targets just never selected it.
-- The UI shows it as an expandable field under the card title ("why I want
-- this one"), not a new input path — notes are still written straight to
-- buying_list.

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
  (b.max_price is not null)                  as is_manual,
  b.image_path,
  b.notes
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
            - ps.resale_postage - lc.price * ps.flip_margin, 2)
    else round(lc.price * coalesce(ps.buy_pct, 0.80), 2)
  end as max_all_in
) t on true
where b.status = 'hunting'
  and b.user_id = auth.uid();
