# Schema migrations: repo files vs. applied history

The files in `schema/` are numbered for reading order. The live database's
history (`supabase_migrations.schema_migrations`, written by Supabase's
`apply_migration`) does **not** use the same numbers. Trust this page, not a
naive file-number to version-name match.

Source: read-only dump of the live project on 2026-11-27
(`supabase_schema_2026-11-27.md`, outside the repo).

## Drift, summarized

| Repo file | Applied as | Note |
|---|---|---|
| `001`–`005` | `core_ledger_schema`, `buyers_and_import_fields`, `cards_inventory`, `card_aliases`, `opening_stock` | Unnumbered names. Two extra applied rows (`harden_view_security_invoker`, `harden_cards_schema`) have no repo file of their own. |
| `008` | `008_find_cards_word_similarity` **and** `008b_find_cards_btrim_alias` | One file, two applied rows. |
| `014` | `014_release_notifications` **and** `014b_release_notifications_hardening` | One file, two applied rows. |
| `015_shows.sql` | `015a` … `015i` | Split into nine rows on apply. |
| `017`, `019` | two applied rows each | `buying_list_tables` + `buying_targets_views`; `buying_list_image` + `buying_targets_image_path`. |
| `022_releases_image_purchase.sql` | `releases_image_purchase` (20260930021853) | Unnumbered. |
| `023_database_timezone.sql` | **`022_database_timezone`** (20261009082817) | Off by one. Last recorded migration. |
| `024_ebay_api.sql` | **not recorded** | Applied by hand in the SQL editor; objects are live. |
| `025_card_inventory_fields.sql` | **not recorded** | Applied by hand in the SQL editor; objects are live. |
| `026_profit_views.sql` | not applied | Separate work; still unapplied and untouched. |
| `027_inventory.sql` | applied | Applied in prod after the 2026-11-27 dump; its version is not copied here. |
| `028_sealed_products.sql` | not applied yet | Next file. Needs Johnny's go-ahead after its PR is reviewed. |

`schema_migrations` had 37 rows on 2026-11-27.

## Recording 024 and 025 as applied

> **Run at apply time, not now.** This writes to the live database. It only
> records history; it creates no objects (024 and 025 are already live).

Insert uses only `version`, `name`, `statements` — the columns every Supabase
version of this table has. Newer versions add `created_by`,
`idempotency_key` and `rollback` (the 2026-11-27 dump shows `created_by`
populated); all are nullable, so they are left out. Check first:

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'
order by ordinal_position;
```

The two versions are **synthetic**: chosen after the last recorded migration
(`20261009082817`) and before anything `apply_migration` will stamp for 027,
so history sorts in the order the objects were actually created. They do not
reflect when 024/025 were really run.

```sql
-- RUN AT APPLY TIME, NOT NOW. Records hand-applied 024 / 025; creates nothing.
insert into supabase_migrations.schema_migrations (version, name, statements)
values
  ('20261122000024', '024_ebay_api',
   array['-- applied by hand in SQL editor; see schema/024_ebay_api.sql']),
  ('20261122000025', '025_card_inventory_fields',
   array['-- applied by hand in SQL editor; see schema/025_card_inventory_fields.sql'])
on conflict (version) do nothing;

-- Expect the newest three to be 025, 024, then 022_database_timezone
-- (and 39 rows in total, if nothing else was applied since 2026-11-27).
select version, name from supabase_migrations.schema_migrations
order by version desc limit 3;
```

## Applying 027

Done: 027 is applied in prod. The steps stay as the record.

Order matters only for the history's readability; 027 itself is idempotent
and does not depend on the 024/025 rows existing.

1. Run the snippet above (record 024 and 025).
2. Apply `schema/027_inventory.sql` with Supabase `apply_migration`,
   name **`027_inventory`**, query = the file's contents verbatim. It stamps
   the current time as the version, which sorts after the synthetic
   `20261122…` rows.
3. Verify:
   ```sql
   select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'cards'
      and column_name in ('location', 'cdp_sku', 'intent');          -- 3 rows
   select tgname from pg_trigger where tgname = 'cards_pc_guard';    -- 1 row
   select tablename, policyname, roles from pg_policies
    where tablename in ('bulk_lots', 'bulk_lot_events');             -- 2 rows, {authenticated}
   ```

Do not re-apply 024 or 025 through `apply_migration`: they are live, and
recording them is the whole fix.

## Applying 028

Not applied. Waits for Johnny's go-ahead after the PR is reviewed.

1. Apply `schema/028_sealed_products.sql` with `apply_migration`, name
   **`028_sealed_products`**, query = the file's contents verbatim. It is
   idempotent and needs only 027 and the earlier files. 026 is not required.
2. Verify:
   ```sql
   select relrowsecurity from pg_class where relname = 'sealed_products';  -- true
   select policyname, roles from pg_policies
    where tablename = 'sealed_products';               -- own_sealed_products, {authenticated}
   select tgname from pg_trigger
    where tgname in ('sealed_products_pc_guard', 'sealed_products_set_updated_at');  -- 2 rows
   select * from sealed_inventory;                     -- one row, zeroes, estimated_value null
   ```

## New migrations from here

Name the file `NNN_description.sql` and apply it with `apply_migration` using
the same `NNN_description` name, so repo and history agree from 027 on.
