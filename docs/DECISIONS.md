# Decisions and rationale

Why things are the way they are. Reversing one of these silently will produce
numbers that look plausible and are wrong.

## Cash in/out, not per-card cost basis

Bulk lots make per-card cost allocation arbitrary — a 15-card lot for $10 does
not meaningfully assign $0.67 to each card. So the ledger tracks cash movement,
and taxable profit is reconstructed once a year via the inventory count.

**Consequence:** net cash and net profit are different numbers and will
diverge. That is correct, not a bug.

## Taxes hang on one annual physical count

`COGS = beginning inventory + purchases − ending inventory`

Every December 31, count unsold cards and estimate what was *paid* for them
(cost, not market value). One row per year in `inventory_counts`. Without it
`tax_summary` cannot compute anything real, which is why it exposes an
`ending_inventory_missing` flag.

CollX Pro's collection CSV export helps with the count.

## One typed ledger, not separate tables

`type` is an enum on a single table. Views derive everything else. This keeps
the natural-language parser producing exactly one row shape, and makes the
running total a single window function.

Do not normalize into `sales` and `purchases`.

## Gross and net are both tracked

A 1099-K reports gross buyer payments — item price plus shipping charged plus
sales tax collected. That is larger than what reached the bank.
`buyer_paid_total` exists solely so the books can be tied to that form.
`net_cash` is the real money. Both are generated columns so they cannot drift.

Federal threshold for 2026 is $20,000 **and** 200 transactions (OBBBA made this
permanent in July 2025). Well above current volume — and irrelevant, because
profit is taxable from the first dollar and $400 of net self-employment
earnings triggers a filing obligation. Some states set lower thresholds;
California needs checking.

## Buyers are a separate table keyed on username

Identity is stable and repeats; addresses belong to a single order and are
snapshotted on the transaction row.

**Do not key on email.** eBay supplies relay addresses like
`12336671bddd5a9d6247@members.ebay.com` which rotate. `Buyer username` is the
stable identifier, scoped by platform so CollX buyers coexist.

Only city/state/zip are stored — no street addresses. They are not needed
(eBay prints the labels) and not holding them is the better default.

## Supabase over Google Sheets

Sheets was the original plan and was rejected late. It has no write path for an
agent — the Drive connector exposes only file-level tools (`read_file_content`,
`create_file`), no cell operations — so appending a row needed a GCP service
account and a custom script anyway. Supabase gives a REST API out of the box,
proper types, CHECK constraints, window functions, and a dashboard worth
looking at.

The spreadsheet version still exists and is a useful reference for the intended
outputs.

## Excel-safe formulas in the spreadsheet

If the workbook is ever used again: it deliberately avoids `QUERY`,
`ARRAYFORMULA`, `FILTER` and `XLOOKUP` so it round-trips between Excel and
Google Sheets without breaking. Keep it that way.

## Ledger starts August 1, 2026

Chosen because the eBay transaction report for August was already pulled and
verified. It is a partial tax year — see the Phase 2 note on opening inventory
and the Jan-Jul revenue gap. Anyone reading `tax_summary` for 2026 should know
it covers five months of activity, not twelve.

## Claude Code reaches Supabase through the MCP connector

Chosen over CLI scripts for directness. The tradeoff is that Claude Code gets
arbitrary SQL against financial records, so:

- The CHECK constraints and generated columns are now **load-bearing safety**,
  not decoration. They are the only thing between a malformed agent query and
  bad data. Do not relax them for convenience.
- Backups moved from Phase 5 to Phase 1 as a direct result.
- Prefer read-only MCP access for exploration, reserving writes for entry.

## Dashboard: local now, Vercel later

Built deployable from the first commit. The trap avoided is developing against
the `service_role` key locally, which bypasses RLS — everything works until
deploy, then nothing does. Use Supabase Auth and the `anon` key in every
environment.

## Cards are a separate table, and optional

A transaction is an immutable cash event; a card is a mutable object with a
lifecycle (held → listed → sold). Folding them together would mean updating a
purchase row with a sale price, collapsing two cash events on two different
dates into one and destroying the timeline the chart is built on. Bulk lots
break it further: "15 cards for $10" is one row containing no findable
individual card.

So `cards` links to `transactions` by foreign key and never replaces it.
`transactions` stays the sole source of cash truth.

**Cards are opt-in on purpose.** The original requirement was that bulk buys
should not need per-card entry, and that still holds. Create a card row only
for something worth finding by name later. `acquisition_cost` is nullable
because a card pulled from a bulk lot has no meaningful individual cost.

`tracked_inventory` gives a floor for the year-end count, not a replacement —
untracked bulk stock is invisible to it.

## Nicknames are a table, not a column, and point at cards

A single `nickname` column would force exact recall of whichever string was
chosen — barely better than recalling the full title. One card needs several
names because it gets called different things on different days.

The real value is accumulation: each disambiguation records what was actually
said, so the same phrase resolves instantly next time. A column cannot get
smarter with use.

Active aliases are unique per user, which is what allows an alias hit to skip
disambiguation entirely — it resolves to exactly one card by construction. The
unique index is partial on `retired_at` so selling a card frees its nicknames;
there will eventually be another "the jordan".

Aliases link to `cards`, never to `transactions`. A transaction is a cash event
that already happened and has no ongoing identity to name.

## Free tier constraints

Projects pause after 7 days without API activity, and the free tier retains
**zero backups**. Phase 5's nightly job addresses both with one cron.
