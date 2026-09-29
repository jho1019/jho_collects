-- 019_buying_list_image.sql — a picture per buying-list item.
--
-- The row stores only the storage path, never the bytes. The bucket is
-- private; the app reads through short-lived signed URLs under the owner's
-- own session, so the service-role key never reaches the browser. Objects
-- live under <user_id>/..., and the policy keys off that first folder.

alter table buying_list add column image_path text;

comment on column buying_list.image_path is
  'Path inside the private card-images bucket, e.g. <user_id>/buying/11.webp. Null = no image.';

insert into storage.buckets (id, name, public)
values ('card-images', 'card-images', false)
on conflict (id) do nothing;

create policy own_card_images_read on storage.objects
  for select to authenticated
  using (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- buying_targets gains image_path as its last column (create or replace can
-- only append). Body otherwise identical to 018.
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
  b.image_path
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
