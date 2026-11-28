# Card Dealer Pro inventory import

Loads a Card Dealer Pro (CDP) **inventory** export into `cards` and
`bulk_lots` (schema/027). Spec: `specs/026_inventory_requirements.md` §4.
Not the eBay listing import — that is `POST /api/ebay/import-cdp`, which reads
CDP's eBay File Exchange export and creates listings (docs/ebay-api.md).

```
CDP export ──> parse ──> plan ──> report (.md + .json)       dry run (default)
                 │         │
 snapshot.json ──┘         └──> <name>.commit.sql            --commit
 overrides.json ───────────┘     review, then apply through the Supabase
                                 connector (one execute_sql call) or psql
```

- Code: `web/lib/inventory-import/` (pure, no I/O, unit tested) and the CLI
  `web/scripts/cdp-inventory-import.ts`.
- **Nothing touches a database.** The CLI reads files and writes files. The
  commit is a SQL script someone reviews and applies. No service-role key or
  database URL is needed on the machine running it.
- Never touches `transactions`. Never sets a card `listed` or `sold`.

## Run it

From `web/`:

```bash
# 1. dry run (default): prints the markdown report, writes .md + .json
npx tsx scripts/cdp-inventory-import.ts \
  --file ~/Downloads/cdp_batch2_2026-11-27.csv \
  --existing snapshot.json \
  --out-dir ../inventory-out

# 2. holds batch
npx tsx scripts/cdp-inventory-import.ts --file holds.csv --mode holds --existing snapshot.json

# 3. with Johnny's decisions, files already applied today, and the commit SQL
npx tsx scripts/cdp-inventory-import.ts --file batch4.csv --existing snapshot.json \
  --overrides overrides.json \
  --prior lowend.csv --prior batch2.csv --prior holds.csv \
  --commit
```

`npm run inventory:import -- <args>` is the same command.

| option | default | |
|---|---|---|
| `--file` | — | the CDP export (either layout) |
| `--existing` | — | snapshot of the owner's cards / bulk lots (below) |
| `--mode` | `bulk` | `bulk` or `holds` |
| `--overrides` | — | JSON file, format below |
| `--prior` | — | a file applied before this one (repeatable) — cross-file duplicate check |
| `--valued-on` | date in the file name, else today | `est_valued_on` and the bulk event date |
| `--batch-id` | `cdp-<CDP batch number>` (title row or image URLs), else `sha-<hash>` | idempotency key for bulk increments |
| `--fuzzy-threshold` | `0.55` | trigram score that flags `possible_duplicate` |
| `--commit` | off | also write `<name>.commit.sql` |
| `--allow-flags` | off | with `--commit`: write the SQL despite unresolved flags; flagged rows are left out |
| `--user-id` | the one `user_id` in the snapshot | owner |

Exit code 2 = refused (`--commit` with unresolved blocking flags).

Keep CDP exports, snapshots, reports and SQL **outside the repo** (`*.csv` is
gitignored; the rest is tax data).

### The snapshot

The planner matches against existing rows, so it needs them. Run this through
the Supabase connector and save the single JSON value as `snapshot.json`
(replace the owner id):

```sql
select json_build_object(
  'cards', (select coalesce(json_agg(c), '[]') from (
      select id, user_id, sku, title, player, year, set_name, card_number, parallel,
             grader, grade, cert_number, sport, serial_number, cdp_sku, status, category,
             intent, location, est_value, est_value_source, est_valued_on,
             acquisition_cost, acquired_on, list_price, notes
        from cards where user_id = '<owner uuid>') c),
  'bulk_lots', (select coalesce(json_agg(l), '[]') from (
      select user_id, bucket, location, card_count, unit_price
        from bulk_lots where user_id = '<owner uuid>') l),
  'bulk_lot_events', (select coalesce(json_agg(e), '[]') from (
      select user_id, notes from bulk_lot_events
       where user_id = '<owner uuid>' and reason = 'scan_add' and notes like 'cdp-import:%') e)
) as snapshot;
```

`bulk_lot_events` is optional; with it, a dry run of a batch that was already
applied reports its bulk increments as "already applied".

### Applying the commit SQL

Read it first. Then apply it as **one** statement batch (the file is
`begin; … commit;`). It is idempotent: applying it twice changes nothing.

It writes the owner's `user_id` explicitly everywhere (under the connector
`auth.uid()` is null, so the `user_id default auth.uid()` columns would be
null) and stops at the top if that user does not exist.

## The rules

### Layouts and parsing

- Header on line 1, or a title row (`batch-1611837-export`) above it. The
  header is the first of the first five rows with `title` and `market_price`.
- Blank `title` = blank scan: skipped, counted, listed with its sku.
- Integer-valued floats are normalized (`1996.0` → `1996`, `sku 290.0` → `290`,
  `grade 7.0` → `7`); `2.5`, `65b`, `TS13V` are kept. Money is rounded to cents
  (`24.990000000000002` → `24.99`).
- Bowser Jr.'s extra columns (`bucket`, `pc_flag`, …) are hints only. The
  report lists every row where our result disagrees.

### Where a row goes (first match wins)

1. **Override** (`rows[]`): `skip`, `merge` into a card id, force `card`, force
   `bulk` (+ bucket); `category`, `intent`, `list_price`, `location`. An intent
   or an asking price implies a cards row.
2. **Exact match** on an existing card — `cdp_sku`, then `grader` + `cert_number`
   — → **update** that card (even if the price would put it in a bulk box).
3. **PC rule** (`web/lib/inventory-import/pc-rules.ts`) → cards row,
   `category = 'pc'`, `intent = null`, at any price.
4. **Mode**
   - `holds`: every card → cards row, `intent = 'hold'`, at any price.
   - `bulk`: graded, or `market_price > 20` → cards row, `intent = null`;
     `<= 20` raw → bulk lot; no `market_price` → flag `missing_value`.

Buckets **round down** (docs/DECISIONS.md, "Bulk buckets round down"): a
box's price must never overprice what is in it.

| market price | bucket | unit price |
|---|---|---|
| `< 2.00` | `1` | 1.00 |
| `2.00` – `3.99` | `3` | 3.00 |
| `4.00` – `5.99` | `5` | 5.00 |
| `6.00` – `20.00` | `6_20` | weighted average (below) |
| `> 20.00`, or graded | cards row | — |

The thresholds live in one constant, `BUCKET_THRESHOLDS` in
`web/lib/inventory-import/plan.ts`. For `6_20` the unit price is the average
market price, recomputed as a weighted average with what the lot already
holds: `(count × unit + Σ added) / (count + added)`, rounded to cents. One lot
per bucket per location.

### PC rules

One list, also used by the eBay listing import (which skips PC rows):

| id | kind | |
|---|---|---|
| `kobe_1996_topps_138_psa7_business` | not PC | the 1996-97 Topps #138 Kobe PSA 7 is a business hold |
| `player_ohtani` | PC | any Shohei Ohtani |
| `player_roki_sasaki` | PC | any Roki Sasaki |
| `player_yamamoto` | PC | "Yamamoto" in player |
| `set_2025_topps_heritage` | PC | year 2025 and set contains "Topps Heritage" |
| `kobe_2008_topps_orange_psa25` | PC | 2008-09 Topps Kobe Orange PSA 2.5 — also a raw-read copy (CDP reads that slab as raw), with a note |
| `kobe_slab_after_2026_11_27` | review | any other graded Kobe bought after 2026-11-27 → flag `review_kobe` |

2026 Heritage and raw Kobes are business (no rule). A 2026 Heritage *Ohtani*
is PC by the Ohtani rule. To change the list, edit `PC_RULES` and add a test in
`__tests__/pc-rules.test.ts`.

### Field mapping

| cards | from CDP |
|---|---|
| `title`, `player`, `year`, `set_name`, `card_number` | `title`, `player`, `year`, `set`, `card_number` |
| `parallel` | `subset`, `variation` (leading `: ` stripped), joined with `, ` |
| `grader`, `grade`, `cert_number` | `grader`, `grade_number` (else `grade_name`), `certification_number` — graded rows only |
| `sport` | `category`, lower-cased |
| `est_value`, `est_value_source`, `est_valued_on` | `market_price`, `'cdp'`, `--valued-on`. Never a cost. |
| `acquisition_cost` | `purchase_price` when non-zero; `0` / blank → null (unknown). An explicit $0 (pulled card) is set by hand. |
| `acquired_on` | `purchase_date` |
| `location` | `box`; else `Cabinet x / Shelf y / Row z / Section w`; else null |
| `cdp_sku` | `sku` (normalized). **`cards.sku` (the eBay label) is never written.** |
| `serial_number` | always null: `#/499` in a title is a print run, not the stamped number |
| `notes` | attributes, `numbered /N`, `CDP note: …` |
| `status` | `held` on insert; never changed on update |
| `category` | `pc` (PC rule) or `business`; never changed on update without an override |

### Updates

An exact match fills **only null fields**, plus: `est_value` is refreshed when
the card has none or its current one came from CDP (a hand/comp estimate is
kept); `location` is set when the scan has one. `acquisition_cost`,
`list_price` and `category` are never overwritten except by an explicit
override. Matching is redone at apply time (by `cdp_sku`, then grader + cert),
so the SQL is correct even if the database moved since the dry run.

### Duplicates and flags

| flag | blocks commit | meaning / how to resolve |
|---|---|---|
| `missing_value` | yes | bulk mode, no market price: not bucketed. Override `action: card`, `action: bulk` + `bucket`, or `skip`. |
| `review_kobe` | yes | graded Kobe bought after 2026-11-27. Override `category` or an `action`. |
| `possible_duplicate` | yes | fuzzy match against an existing held/listed card (trigram ≥ threshold, no contradiction), or the same card earlier in this file / a `--prior` file, for a row headed to a cards row. Override `merge` (card_id), `card` (insert anyway) or `skip`. |
| `duplicate_sku` | yes | the CDP sku appears twice. `skip` or `merge`. |
| `matched_exited_card` | yes | the sku/cert belongs to a sold/traded card. `skip`. |
| `missing_sku` | yes | no sku: a rerun could not recognise the row. `card` or `skip`. |
| `invalid_override` | yes | the override cannot be applied as written. |
| `pc`, `pc_note` | no | PC rule matched (and any note). |
| `duplicate_scan` | no | a bulk-bound card also earlier in this file / a prior file. Both are counted — a second copy, or a double scan; a hand count fixes it. |
| `category_differs` | no | an exact match whose existing category differs from the PC rules. Not changed; override if wanted. |

Fuzzy matching is pg_trgm `similarity()` between the would-be row's
`search_text` and existing cards' `search_text` (reimplemented in TypeScript;
checked against real pg_trgm in the local rehearsal). A candidate whose year,
card number, grader/grade or raw-vs-graded state **contradicts** the scan is
listed but never flagged — "1998-99 SkyBox Kobe" is not the "1996 Skybox
Kobe". Fuzzy matches are never merged automatically.

### Idempotency

- Cards: `UPDATE … WHERE` the apply-time key, then `INSERT … WHERE NOT EXISTS
  (same key) ON CONFLICT DO NOTHING`.
- Bulk lots: each increment writes a `bulk_lot_events` row (`scan_add`,
  `delta` = count added) whose `notes` is the marker
  `cdp-import:<batch id>:<bucket>:<location>`. If the marker already exists the
  increment is skipped (a `NOTICE` says so). Lots are upserted on
  `(user_id, bucket, coalesce(location, ''))`.

Re-running a batch with a **different** `--batch-id` would count it again.
Keep the default (the CDP batch number) unless you mean to.

## Overrides file

JSON. Every key is optional. Overrides win over everything.

Overrides files hold Johnny's decisions about real inventory and cost — tax
data — so they live **outside the repo**, next to the CDP exports and
snapshots, named after the export: e.g.
`<workdir>/inventory-import/overrides/cdp_batch4_2026-11-27.overrides.json`.
Never commit one.

```json
{
  "comment": "batch4 decisions, Johnny 11/27",
  "bulk_counts": [
    { "bucket": "1", "location": null, "count": 14, "note": "hand count of the $1 box adds" },
    { "bucket": "6_20", "location": "Box B", "count": 3, "unit_price": "9.00" }
  ],
  "rows": [
    { "cdp_sku": "291", "action": "merge", "card_id": 9, "note": "same Kobe PSA 7 slab" },
    { "cdp_sku": "312", "action": "card", "note": "Star Rubies, not the base MJ I paid $25 for" },
    { "cdp_sku": "258", "action": "bulk", "bucket": "6_20" },
    { "line": 20, "action": "skip" },
    { "cert_number": "12345678", "grader": "PSA", "list_price": "149.99" },
    { "cdp_sku": "331", "intent": "sell", "list_price": "79.99" },
    { "cdp_sku": "343", "category": "pc" }
  ],
  "manual_adds": [
    { "title": "Acuna HRK Auto Purple AC10", "player": "Ronald Acuna Jr.", "list_price": "199.99",
      "intent": "sell", "location": "Case 1" }
  ]
}
```

- `bulk_counts`: cards this batch **adds** to a (bucket, location), as Johnny
  counted them. Replaces the CDP count for that lot. For `6_20` the unit price
  input is the scanned cards' average × his count; `unit_price` is required
  only when the batch scanned no `6_20` cards there (if given while 6_20 cards
  were scanned, the scanned average wins). `count: 0` means "this batch adds
  nothing to that box" (its cards were already in an earlier count). When the
  lot is empty — the first file into a fresh `bulk_lots` — the increment *is*
  the box total. There is deliberately no absolute "set" mode: a hand count
  is always an increment guarded by the batch marker (docs/DECISIONS.md,
  "Hand counts stay increments"). An absolute box recount is a separate
  `recount` event, not this.
- `rows[]`: select by exactly one of `cdp_sku`, `cert_number` (+ optional
  `grader`), or `line` (physical line in the file). Decisions: `action`
  (`card` / `bulk` / `skip` / `merge`), `bucket` (with `bulk`), `card_id`
  (with `merge`), `category`, `intent` (`hold` / `sell` / `null`),
  `list_price`, `location`, `note`. A `pc` card cannot have an intent.
- `manual_adds[]`: cards not in CDP. `title` required; any cards field from
  the mapping table. Matched by `cdp_sku` / cert if given, else by exact
  title + set + number among non-CDP cards, so re-running does not duplicate.

An override that matches no row is listed in the report's warnings.
