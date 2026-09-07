---
name: ebay-import
description: Import an eBay Seller Hub transaction report (CSV) into the ledger — the weekly or ad-hoc sales load. Use whenever the user attaches or points to an eBay transaction / payments report, or says "import my eBay sales", "load last week's eBay export", "here's the transaction report". Runs the Phase 2 loader with a dry-run preview and a post-import health check. Not for CollX, manual single sales, purchases or expenses — those are card-entry.
---

# eBay report import

The importer already exists and is idempotent: `importers/parse_ebay.py`
(parse only, no database) and `importers/load_ebay.py` (writes `transactions`
and `buyers`, closes matching `cards` by SKU, applies orphan shipping labels).
This skill is the wrapper around it: get the file onto disk, dry-run, confirm,
load, verify.

Read `docs/reference/ebay-report-notes.md` if you have not this session — it
explains every file quirk the parser already handles.

## Step 1 — Get the CSV onto disk under `imports/`

The report carries buyer PII (names, cities, ZIPs). `imports/` is gitignored;
keep the file there, and never paste buyer PII into the repo, a commit, a
report file, or anywhere outside `imports/`.

The user supplies the file one of three ways — handle all of them:

1. **Attached to this conversation as a file** — if the harness exposes a real
   filesystem path for the attachment, copy it into `imports/`. If it is
   surfaced to you as text content, treat it as case 2.
2. **Pasted as text** — `Write` the content **verbatim** to
   `imports/<name>.csv`. Do not reformat it, reorder rows, drop the notes
   preamble, change `--` nulls, strip the BOM, or "clean" anything. The parser
   expects the raw export (`Aug 31, 2026` dates, footer rows and all) and
   finds the header by content, not line number.
3. **A path the user typed** — use it, but copy the file into `imports/` too
   so the run is reproducible later.

Name the saved file `transaction_report_<start>_<end>.csv`, taking the date
range from the original eBay filename when you have it, otherwise from the
min/max row dates after Step 2.

If you cannot obtain the real file bytes (e.g. it is too large to paste), stop
and ask the user to drop it into `imports/` themselves and give you the path.
Do not proceed with a partial or retyped file.

## Step 2 — Parse only, show the totals

```
python importers/parse_ebay.py "imports/<name>.csv"
```

Touches no database. Prints the parsed row count and the verified totals (item
subtotal, shipping charged, order proceeds, eBay fees, shipping labels, net
cash). Sanity-check before writing anything:

- **"No header row found"** → this is not a transaction report. The **Orders
  report** looks similar and has *no fee data* — importing it hides ~31% of
  revenue in costs. Ask for the Transaction report: Seller Hub → Payments →
  Reports → Transaction report.
- **Fees near zero**, or far below ~13% of buyer payment → almost certainly
  the wrong report or a truncated file. Stop and check.
- Note any `ignored N` (Payout / Charge / Transfer / Hold / Reserve rows —
  expected, they are cash movement) and any `orphan label(s)`.

## Step 3 — Dry-run the load

```
python importers/load_ebay.py "imports/<name>.csv" --dry-run
```

Runs the whole load in one transaction, then rolls back. Show the summary:

| | |
|---|---|
| buyers upserted | 3 |
| transactions inserted | 5 |
| already present | 0 |
| cards closed by SKU | 1 |
| orphan labels applied | 1 |
| orphan labels UNRESOLVED | 0 |

**"already present" > 0 is normal.** The loader is idempotent on
`(user_id, platform, source_ref)`, so re-importing a week that overlaps a
prior import is a safe no-op. With a weekly cadence the ranges *will* overlap
— do not try to trim dates to avoid it.

## Step 4 — Confirm, then load for real

Ask with `AskUserQuestion`:

1. **Confirm & import** — re-run the exact command without `--dry-run`.
2. **Re-check** — inspect first: `python importers/parse_ebay.py
   "imports/<name>.csv" --json imports/<name>.rows.json`, open specific rows or
   the report notes, then dry-run again.
3. **Cancel** — leave the file in `imports/`, write nothing.

On confirm, run the load and report the same summary table, then Step 5.

## Step 5 — Verify after loading

- **UNRESOLVED orphan labels** — a shipping label whose order has no matching
  transaction (the order predates the ledger, or is absent). Name the order
  refs; that label cost was skipped, not applied. Often fine for an old order
  — surface it so the user decides.
- **`import_health`** — query it (MCP `execute_sql`, or the dashboard banner):

  ```sql
  select * from import_health;
  ```

  It lists tax years holding rows whose `fees_estimated` is still true. After a
  clean transaction-report import it returns **no rows**. If it returns any,
  say so plainly — real fees are missing and the Schedule C figures are not
  safe to file yet.

## Step 6 — Report back

One block: the date range imported, rows inserted vs. already present, cards
closed by SKU, any UNRESOLVED labels, and whether `import_health` is clean.
Add the net-cash position if useful: `select sum(net_cash) from transactions`.

## Notes

- Never estimate or hardcode an eBay fee. Fees come only from this report; the
  parser sets `fees_estimated = false` and never guesses.
- Never run the real load without a `--dry-run` immediately before it.
- The loader reads `.env.local` (`DATABASE_URL`, `OWNER_USER_ID`, `DB_SSL_*`).
  If it reports one missing, stop — that is setup, not an import problem.
- CollX sales, manual one-off sales, purchases and expenses go through
  `card-entry`, not this skill.
