-- 022_releases_image_purchase.sql — a product image and a "did I get it" record
-- per release, for the Releases tab.
--
-- image_path follows buying_list.image_path (019): the row stores only the
-- storage path inside the private card-images bucket, never the bytes. The
-- bucket and its read/write policies already exist (019, 020); uploads land at
-- <user_id>/releases/<id>.<ext>, which the same per-user-folder policy covers.

alter table releases
  add column image_path         text,
  add column purchased          boolean not null default false,
  add column quantity_purchased integer;

alter table releases
  add constraint releases_quantity_purchased_check
  check (quantity_purchased is null or (purchased and quantity_purchased > 0));

comment on column releases.image_path is
  'Path inside the private card-images bucket, e.g. <user_id>/releases/12.webp. Null = no image.';
comment on column releases.purchased is
  'Whether the owner actually managed to buy from this drop. Independent of status (free text, written by the release-entry skill) and not linked to any transactions row — see Phase 9 "not in this phase".';
comment on column releases.quantity_purchased is
  'How many units were bought. Null when not purchased or the count was not recorded; must be > 0 when set.';
