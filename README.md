# jho_collects

Personal P&L and tax system for a sports card reselling business
(eBay seller `jho_sportscards`, also CollX). Tracks cash flow, produces
Schedule C figures at year end, and shows a dashboard.

Stack: Supabase + Postgres, natural-language entry through Claude Code,
web dashboard (local now, Vercel later).

## Layout

```
CLAUDE.md              project instructions for Claude Code — read first
docs/
  DECISIONS.md         architecture + rationale — read before changing the data model
  PHASES.md            six-phase build plan, each with an exit check
  HANDOFF.md           original handoff notes
  reference/           real-world findings (eBay report quirks, known-good figures)
schema/                *.sql migrations, applied in order (Phase 1, 3.5)
importers/             parse_ebay.py — transaction report parser (tested)
skills/card-entry/     natural-language entry routing skill
scripts/               check_connection.py — Phase 0 connectivity check
```

## Setup

1. `cp .env.local.example .env.local` and fill it in — see **docs/PHASES.md, Phase 0**.
2. `python -m pip install -r requirements.txt`
3. `python scripts/check_connection.py` — both checks must pass before Phase 1.
   `REST` validates the publishable and secret keys; `SQL` runs `select now()`
   over the pooled connection. On a machine with TLS-inspecting antivirus, set
   `DB_SSL_ROOT_CERT` or `DB_SSL_INSECURE=1` in `.env.local` (see its comments).

`.env.local` is gitignored. The secret key and `DATABASE_URL` never reach the
browser.
