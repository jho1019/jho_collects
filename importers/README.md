# Importers

## eBay transaction report → ledger

Two steps. Get the file from **Seller Hub → Payments → Reports → Transaction
report** (90 days max per pull). See `../docs/reference/ebay-report-notes.md`
for file quirks.

```bash
# 1. inspect — parse only, no database, prints the verified totals
python importers/parse_ebay.py "path/to/Transaction_report_YYYYMMDD_YYYYMMDD.csv"

# 2. load — writes to the ledger. --dry-run connects, counts, rolls back.
python importers/load_ebay.py  "path/to/Transaction_report_YYYYMMDD_YYYYMMDD.csv" --dry-run
python importers/load_ebay.py  "path/to/Transaction_report_YYYYMMDD_YYYYMMDD.csv"
```

Keep the CSV outside the repo (it carries buyer PII). `.gitignore` blocks
`*.csv` anyway.

### What the loader does

- **sale / refund rows** — insert with
  `ON CONFLICT (user_id, platform, source_ref) DO NOTHING`. Re-importing an
  overlapping range is a safe no-op; a transaction is an immutable cash event.
- **buyers** — upsert on `(user_id, platform, platform_username)`. Widens the
  first/last-seen window, refreshes name and city/state from the latest row.
- **orphan shipping labels** — a label whose order has no line item in this
  file belongs to a prior month's order (see the report notes). The loader
  `UPDATE`s that existing transaction's `shipping_cost`, apportioned by item
  subtotal for multi-item orders, guarded by an `[orphan-label <order>]` note
  marker so a re-run never double-adds. If no matching transaction exists
  (e.g. the order predates the ledger), it is reported as UNRESOLVED and
  skipped.
- **SKU → card close** — eBay's `Custom label` column is `cards.sku`. For each
  imported eBay sale, a held/listed tracked card with a matching sku is marked
  `sold` and linked to that transaction. Runs on every import regardless of
  whether the row was inserted, so a card created *after* its sale was
  imported still links on the next run. `--` labels don't link (fine).

Fees are taken only from the report — nothing here estimates them.
`fees_estimated` stays `false`; `import_health` should have no rows.

### Config

Reads `../.env.local`: `DATABASE_URL`, `OWNER_USER_ID`, and the optional
`DB_SSL_*` knobs (same as `scripts/check_connection.py`).
