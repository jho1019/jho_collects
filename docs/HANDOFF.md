# Card business ledger — handoff

Personal P&L and tax system for a sports card reselling business.
Supabase + Postgres, natural-language entry through Claude Code, web dashboard.

## Read in this order

1. `DECISIONS.md` — the architecture and *why*. Read before changing anything.
2. `PHASES.md` — the build plan. Six phases, each with an exit check.
3. `CLAUDE.md` — project instructions; belongs at the repo root.
4. `reference/` — real-world findings that cost real effort to discover.

## Contents

```
CLAUDE.md                              project instructions for Claude Code
DECISIONS.md                           architecture + rationale
PHASES.md                              phased plan with exit checks
schema/001_core.sql                    tables, generated columns, RLS, views
schema/002_buyers_and_import.sql       buyers, import fields, buyer_summary
schema/003_cards.sql                   card inventory, fuzzy lookup, sell_card()
schema/004_card_aliases.sql            nicknames; replaces find_cards + sell_card
schema/005_opening_stock.sql           pre-ledger cards, add_opening_stock()
skills/card-entry/SKILL.md             natural-language entry routing
importers/parse_ebay.py                transaction report parser (tested)
reference/ebay-report-notes.md         file quirks, fee structure, gotchas
reference/verification-fixtures.md     known-good numbers to test against
```

## State of the code

- **`parse_ebay.py`** — run against a real August 2026 report. Reproduces
  eBay's own figures exactly. Parses only; the loader is Phase 2.
- **The SQL** — never executed. No Postgres was available where it was
  written. Expect syntax fixes on first apply. The *arithmetic* inside it was
  verified by porting to SQLite and running the fixtures.
- **Everything else** — unbuilt.

## Open decisions

Backfill scope is settled: the ledger starts **August 1, 2026**. See the
Phase 2 note — this is a partial tax year and needs an opening inventory row.

Also settled: Claude Code reaches Supabase via the **MCP connector**, and the
dashboard runs **locally now, Vercel later** — built deployable from the first
commit.

Nothing is blocking Phase 0.
