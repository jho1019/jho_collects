# Phases

Each phase ends in something verifiable. Do not start the next until the
current one's exit check passes.

---

## Phase 0 — Foundations

Repo, Supabase project, credentials.

- Create the Supabase project. Note the project URL, `anon` key and
  `service_role` key.
- `.env.local` with `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`. Add `.env*` to `.gitignore` before the first
  commit, not after.
- Create the single owner account via Supabase Auth. Record its user UUID —
  everything is scoped to it by RLS.

- Configure the **Supabase MCP connector** for Claude Code. It authenticates
  with a Supabase personal access token (`sbp_...`) passed as
  `SUPABASE_ACCESS_TOKEN`, stored in the Claude Code MCP config, not in this
  repo.
  - **Token: `claude-code-mcp`, expires 2026-12-31.** Supabase forces an
    expiry on personal access tokens. When the MCP connector starts failing
    to authenticate around end of 2026, generate a new token at
    <https://supabase.com/dashboard/account/tokens> and update the connector
    config — the old token cannot be viewed again, only replaced.
- **Verify the MCP write path works from the phone before building on it.**
  The primary use case is entering a purchase from a card show. If the
  connector turns out to be desktop-only, fall back to a small CLI script in
  the repo invoked by Claude Code — same SQL, different transport. Find this
  out now, not in Phase 3.

**Exit check:** a script authenticates and runs `select now()`. Separately, an
insert issued through the MCP connector from a phone session lands in the
database.

---

## Phase 1 — Schema

Apply `schema/001_core.sql` then `schema/002_buyers_and_import.sql`.

- Enums, `transactions`, `inventory_counts`, `buyers`.
- Generated columns `net_cash` and `buyer_paid_total`.
- CHECK constraints (sales-only fields, expenses need a category).
- RLS policies on all three tables.
- Views: `ledger_running`, `daily_position`, `dashboard_windows`,
  `tax_summary`, `buyer_summary`, `import_health`.

The SQL was written but never executed — expect syntax fixes on first apply.
The arithmetic inside it was verified against known-good figures.

### Backups come first, not last

Originally Phase 5. Moved here because the MCP connector gives Claude Code
arbitrary SQL against a database holding tax records, on a tier that keeps
**zero backups**. One `UPDATE` without a `WHERE` clause is unrecoverable.

Stand up the nightly CSV dump to off-platform storage before any real data
exists. The same job doubles as the keep-alive that stops the free tier
pausing after 7 idle days.

**Exit check:** insert the three fixture rows in
`reference/verification-fixtures.md`. `net_cash` must total −47.00 and
`tax_summary` must return net profit −47.00. Then confirm the CHECK constraint
rejects a purchase carrying sales tax. A backup file exists off-platform.

---

## Phase 2 — eBay import

`importers/parse_ebay.py` is written and tested against a real report. It
parses; it does not yet load.

Build the loader:

- Insert with `ON CONFLICT (user_id, platform, source_ref) DO NOTHING`, so
  re-importing an overlapping date range is a safe no-op.
- **Orphan shipping labels.** A label whose `order_ref` has no matching order
  in the same file belongs to a prior month's order. It must `UPDATE` that
  existing row's `shipping_cost`, not be dropped. This is a confirmed real
  case, not hypothetical — see `reference/ebay-report-notes.md`.
- Upsert `buyers` on `(platform, platform_username)`, updating
  `last_seen_on`, `display_name` and last-known city/state.
- Link `transactions.buyer_id`.
- Multi-item orders: split order-level costs by item subtotal share. The
  parser does this; verify against a real multi-item order when one occurs.

### Ledger start date: August 1, 2026

The ledger begins Aug 1 2026. eBay sales record numbers in the August file run
113-118, implying roughly 112 earlier sales on the account — an unknown share
of them inside tax year 2026.

Two things follow:

- **Opening inventory is required.** Add an `inventory_counts` row for
  `tax_year = 2025` holding the cost of all unsold stock on hand Aug 1 2026.
  The `tax_summary` view reads beginning inventory as the prior year's ending
  row, so without it COGS ignores every card bought before August and
  overstates 2026 profit.

  **Derive this number, don't guess it.** Seed the existing collection first
  (Phase 3.5), then read `tracked_inventory`:

  ```sql
  select opening_cost_basis, cards_without_cost from tracked_inventory;
  ```

  `opening_cost_basis` is the known cost of seeded opening stock. Add an
  estimate covering `cards_without_cost` plus any untracked bulk, and write the
  total into `inventory_counts` for 2025. Record how the estimate was reached
  in the `method` column — future-you will want to know.
- **Pre-August 2026 gross receipts are outside this system.** Opening inventory
  fixes the cost side only. Revenue from Jan-Jul 2026 still has to reach the
  2026 return from somewhere. Either backfill it (transaction reports pull 90
  days at a time, so roughly three more downloads) or reconcile it separately
  at filing time.

**Exit check:** import the August report. `tax_summary` for 2026 shows gross
receipts $63.94, fees $10.18, labels $8.06. Re-run the same import and row
count is unchanged. Confirm beginning inventory for 2026 is non-zero.

---

## Phase 3 — Natural-language entry

The owner types into Claude Code from a phone. Claude Code parses and writes.

- A CLI entry point that takes structured arguments and inserts one row.
  Validation mirrors the CHECK constraints so errors are readable, not
  Postgres exceptions.
- `--dry-run` that prints the parsed row without writing.
- Missing fields → insert with `needs_review = true`. Do not interrogate.
- A `review` command listing flagged rows so they can be cleaned in batch.
- CollX sales are entered this way; CollX Pro has no sales export.

**Exit check:** "bought 15 cards for $10 at the show today" produces a correct
purchase row from a phone session. A malformed entry fails with a clear message
and writes nothing.

---

## Phase 3.5 — Card inventory

Apply `schema/003_cards.sql`. Individually tracked cards, so a sale can be
spoken by name rather than as a bare amount.

- `find_cards()` uses `pg_trgm` similarity. Tune the threshold against real
  titles — too loose returns noise, too tight misses "jordan psa10".
- `sell_card()` writes the transaction and closes the card atomically.
- **Link eBay imports by SKU.** The `Custom label` column in the transaction
  report already carries values like `105-16o5eb`. Match it to `cards.sku` on
  import and card closure becomes automatic for eBay sales, leaving manual
  entry only for card shows. Some rows have `--` (no SKU) — those stay
  unlinked and are fine.
- Cards remain **opt-in**. Bulk lots create no card rows.

Then apply `schema/004_card_aliases.sql` for nicknames. It replaces
`find_cards` with an alias-aware version and `sell_card` with one that retires
nicknames on sale — apply 003 first, then 004.

**Exit check:** two cards both titled "Michael Jordan PSA 10" from different
sets. "sold michael jordan psa 10 for $70" returns both and asks which. After
choosing, the card is `sold`, one sale transaction exists, and net cash moves
by exactly $70. Selling it again fails.

Then: nickname one of them "the jordan". `find_cards('the jordan')` returns a
single row with `match_type = 'alias'` and no prompt. Naming a second card the
same thing fails. After that card sells, the name is free again.

### Seeding the existing collection

Apply `schema/005_opening_stock.sql`, then seed manually via
`add_opening_stock()` — it sets `is_opening_stock` and writes no transaction,
which is the whole point.

**The trap it guards against:** these cards were paid for with money the ledger
never saw. Their cost belongs in `inventory_counts`, not in `transactions`.
Anything that rolls `cards.acquisition_cost` into purchases double-counts it
and understates 2026 profit. A CHECK constraint stops opening stock from
carrying an acquiring transaction.

Cost may be unknown for older holdings — leave it null. `tracked_inventory`
reports `cards_without_cost` so the gap is visible rather than silent.

**Do this before finalising the Phase 2 opening inventory number**, which is
derived from it.

### Skill

`skills/card-entry/SKILL.md` routes natural language to the right writes:
intent classification, the card-resolution ladder, and a confirmation policy
that only spends a round trip when ambiguity or irreversibility justifies it.
Install it in the Claude Code project.

## Phase 4 — Dashboard

Runs locally for now, deploys to Vercel later. **Build it deployable from the
first commit** — the migration is free if done from the start and a rewrite if
not:

- Config from environment variables only. No hardcoded `localhost`.
- **Authenticate with Supabase Auth and the `anon` key even locally, so RLS is
  active the whole time.** Developing against the `service_role` key bypasses
  RLS entirely and every query will break on deploy.
- The `service_role` key never reaches the browser, in any environment.

- Cumulative net cash line chart from `daily_position`. Dips below zero are
  normal and expected — they mean inventory was bought and not yet sold.
  Label the axis honestly: this is cash, not net worth.
- Position cards: net cash, estimated inventory value (manual input),
  adjusted position.
- Rolling windows from `dashboard_windows` (7 / 30 / 90 / 180 / 365 day).
- Buyer list from `buyer_summary`, filterable and sortable, with a repeat-buyer
  flag.
- `import_health` warning banner when any row still has `fees_estimated`.
- Card inventory list from `tracked_inventory`, filterable by status.
- **Margin by price band.** Real August data: all-in cost ran 31% of proceeds,
  and the fixed per-order fee plus label means a $1.00 card nets close to
  nothing. This chart is likely to change what gets listed individually versus
  bundled into lots.

**Exit check:** the chart matches `ledger_running` at three spot-checked dates.

---

## Phase 5 — Operations

- **Nightly cron that queries the DB and writes a CSV backup off-platform.**
  This solves two problems at once: the Supabase free tier pauses a project
  after 7 days without API activity, and the free tier keeps **zero backups**.
  These are tax records.
- CSV import/export in the app, with a preview-then-commit step. Include `id`
  in exports so a restore preserves row identity and dedupe still works.
- December reminder to run the inventory count. Without it COGS is guesswork
  and `tax_summary` returns `ending_inventory_missing = true`.
- **Renew the Supabase MCP access token before it expires (2026-12-31).**
  See Phase 0. When it lapses, Claude Code loses its write path to the
  database until a fresh token is generated and the connector reconfigured.

**Exit check:** a backup file lands off-platform on schedule, and restoring it
into an empty database reproduces the same `tax_summary` output.
