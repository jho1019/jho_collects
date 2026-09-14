---
name: release-entry
description: Parse a pasted block of upcoming card/collectible product releases (product names alongside weekdays, times, or drop-mechanic markers like "(FCFS)", "(EQL?)", "(Preorder)") into the releases table, previewing the parsed batch before writing anything. Use when the user pastes a release schedule or list, usually with no other instruction — the paste itself is the request. Do not use for a single release mentioned in passing conversation, or for anything about cards already owned (that's card-entry).
---

# Release entry

A separate skill from `card-entry`, not a branch on it. Different subject —
upcoming products, not owned cards — and, more importantly, the opposite
write policy: `card-entry` writes additive rows straight through where it
can; this skill **never writes on the first turn**, always previews first.
Two opposite policies belong in two files, not one with a flag.

Read `docs/DECISIONS.md` before changing anything here.

## Trigger

A pasted block containing product names alongside weekday names, times, or
drop-mechanic markers — `(FCFS)`, `(EQL)`, `(Preorder)`. Usually pasted with
no instruction at all; the paste is the request.

**Not this skill:** a single release mentioned in conversation ("Topps
Update drops Monday, remind me"), or anything about cards already owned.

## Preview, then confirm, then write

**Never write on the first turn**, not even for a single release. Parse,
show the preview, stop.

A paste is five to fifteen rows parsed from loose text through several
inference steps, and one bad weekday resolution files a row into the past
where it is invisible. A batch is tedious to unpick row by row afterward;
the preview is cheap by comparison.

**Do not ask clarifying questions before previewing.** The preview *is* the
clarifying question — showing a parse and letting it be corrected beats
interrogating the user about a format they already pasted.

### Duplicate check runs before the preview

Query existing rows across the date range being parsed:

```sql
select id, release_on, title, url
from releases
where release_on between :range_start and :range_end;
```

A row already present — same `release_on` with a case-insensitive title
match, or the same `url` — is marked as existing in the preview and is not
inserted. Re-pasting a week with one addition must produce one new row, not
a second copy of the week. Pastes get re-sent after edits; assume it.

### Build the preview

A table in date order:

```
Date         Time (PT)  Title                                  Type   Flags
2026-09-14   9:00 AM    2026 Topps Update Series Baseball       FCFS   -
2026-09-15   9:00 AM    2026 Topps Neon Marvel                  FCFS   -
2026-09-17   8:00 AM    Topps Flagship Premier League 2026/27   FCFS   -
2026-09-17   9:00 AM    2025-26 Topps Definitive Basketball     EQL    type unconfirmed
```

Show resolved dates explicitly and times in Pacific — the entire point is
catching a weekday that resolved to the wrong week. Call out anything
*inferred* rather than *read*: a weekday inherited from the line above, a
category guessed from a title. That is where a parse goes wrong quietly.

Follow with one summary line: how many will be inserted, how many already
exist, how many carry `needs_review`.

Then ask once, for the whole batch, with `AskUserQuestion`: "Add these N
releases?" **Never per row.** A correction re-parses and re-previews the
entire batch — it carries no implicit confirmation of the rest. On a
decline, write nothing.

## Parsing rules

**Weekday resolution: next occurrence from today, inclusive.** Pasted on a
Monday, "Monday" means today.

**Dates within one paste never decrease.** Track the last resolved date; if
the next weekday named would land before it, advance a week. Without this, a
list running Thursday → Monday collapses into one week and files the tail in
the past.

**A line with no weekday inherits the last one seen.** That is how a second
release on the same day attaches correctly. An explicit date always wins
over an inherited weekday.

**Times: parse the zone as a region, never a fixed offset.** `EST`, `EDT`,
and `ET` all mean `America/New_York` wall-clock — let the date pick the
offset. Most of the year, "12 PM EST" is written during daylight time, so a
literal UTC-5 puts the drop an hour late, and an hour is the whole thing on a
first-come-first-served preorder.

`release_at` is the resulting timestamptz. `release_on` is the calendar day
in `America/Los_Angeles` — usually, but not always, the same day as the
source's local date. **No time in the line:** `release_at` is null,
`time_unconfirmed` is set, and `needs_review` is set.

**Drop type is the parenthesised group.** A trailing `?` sets
`drop_type_uncertain` — `(EQL?)` is `drop_type = 'EQL'` plus uncertain,
**never** flattened to a bare `EQL`. `Preorder` is a modifier, not a
mechanic: `(FCFS Preorder)` is `drop_type = 'FCFS'` with `Preorder` folded
into `notes`. An unrecognised mechanic is stored verbatim with
`needs_review = true`, never mapped onto a known value.

Documented `drop_type` values: `FCFS`, `EQL`, `raffle`, `queue`. The column
itself has no CHECK — see `schema/012_releases.sql` — but this skill only
ever writes one of these four, or an unrecognised value flagged for review.

**Remaining fields.**

- `title` — as written, year included.
- `manufacturer` — from an obvious leading brand (Topps, Panini, Bowman); null
  otherwise.
- `category` — inferred from the title (baseball, basketball, soccer,
  non-sport); null when it could plausibly be two sports.
- `url` — from a trailing link, if present.
- `status` — always `'upcoming'` on insert.

## Never

- Write before confirming, even for a single release.
- Invent a time. Missing is `release_at = null` plus `time_unconfirmed =
  true`, never a plausible default.
- Collapse `(EQL?)` to `EQL`, or drop a `?` anywhere.
- Re-insert a release that exists because the title differs only by
  punctuation — the duplicate check is case-insensitive on title for exactly
  this reason.
- Ask which week is meant. Resolve forward per the rules above and let the
  preview catch it.

## Writing the batch

There is no CLI for this table. Insert directly via SQL, one statement for
the confirmed batch, explicitly setting `user_id` — this table's
`default auth.uid()` only resolves under a real user session, and a direct
SQL connection has none, exactly like `scripts/entry.py`'s `OWNER_USER_ID`.
Read `OWNER_USER_ID` from `.env.local`.

```sql
insert into releases (
  user_id, release_on, release_at, time_unconfirmed,
  title, manufacturer, category, drop_type, drop_type_uncertain,
  url, notes, needs_review
) values
  (:owner, '2026-09-14', '2026-09-14 09:00:00-07', false,
   '2026 Topps Update Series Baseball', 'Topps', 'baseball', 'FCFS', false,
   null, null, false),
  (:owner, '2026-09-17', '2026-09-17 09:00:00-07', false,
   '2025-26 Topps Definitive Basketball', 'Topps', 'basketball', 'EQL', true,
   null, null, false);
```

Never `UPDATE` or `DELETE` without a `WHERE` clause — unchanged from the
project-wide rule, and irrelevant here anyway since this skill only inserts.

## Report back

One line: how many were inserted, how many already existed, and whether any
carry `needs_review` (and why — an unconfirmed time or mechanic).

> Added 3 releases (1 already existed: 2026 Topps Neon Marvel). The
> Definitive Basketball row is flagged — drop type EQL is unconfirmed.

## Worked example

Pasted on a Sunday:

```
Thursday
2026 Topps Update Series Baseball (FCFS) 12PM EST
2026 Topps Neon Marvel (FCFS) 12PM EST

Monday
Topps Flagship Premier League 2026/27 (FCFS) 8AM EST
2025-26 Topps Definitive Basketball (EQL?) 9AM EST Preorder
```

- "Thursday" resolves forward to the next Thursday from today (inclusive
  rule, but today is Sunday so this is 4 days out).
- Both Thursday lines inherit that date.
- "Monday" is later than Thursday within the same paste, so it resolves to
  the Monday *after* that Thursday — not the Monday that already passed.
- `12PM EST` on that Thursday's actual date resolves via `America/New_York`
  wall-clock — daylight or standard time depends on the date, not a
  hardcoded offset — and displays as the corresponding Pacific time on the
  calendar.
- Three rows get `drop_type = 'FCFS'`, `drop_type_uncertain = false`. The
  Definitive Basketball row gets `drop_type = 'EQL'`,
  `drop_type_uncertain = true`, and `Preorder` in `notes` — never folded into
  `drop_type`.
- Preview all four, ask once, write only on a yes.
- Re-pasting the identical block afterward reports 4 existing, 0 inserted.
