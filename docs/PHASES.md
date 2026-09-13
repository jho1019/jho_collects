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

---

## Phase 6 — Deals

Multi-leg, in-person transactions: trades, and cash deals that are
economically one event but currently land as unrelated rows.

### The problem this solves

A card show deal is one event with one counterparty and several legs. The
schema has no concept of that event, so two things are impossible today.

A card cannot leave inventory without being sold. `card_status` is
`held | listed | sold`, and `sold` requires a `sale_transaction_id`. Book a
traded-away card as sold and you invent receipts that never happened. Leave it
`held` and it sits in ending inventory forever, understating COGS. There is no
third option.

Trade consideration paid in cards has nowhere to go. A trade of two cards plus
$95 cash for one card can record the $95 as a purchase, and nothing else about
the deal is representable.

### One transaction row per cash movement

Not one per deal, and not one per card. A deal with money moving both
directions is two rows sharing a `deal_id`.

Never net a deal down to a single row. Receipts and purchases land on
different Schedule C lines and carry opposite `net_cash` signs; collapsing
them destroys both figures to save a row. `deal_summary` reports the per-deal
net as a query result, which is where that number belongs.

A deal is one counterparty. Several legs with the same vendor are one deal; a
different vendor is a different deal.

### Basis carries over; market value does not

The received card's cost basis is the cash paid plus the **cost basis** of the
cards given up — not their comp value. Cards given up at a $100 comp that cost
$30 carry $30. The received card's basis is $125, not $195.

Recording $195 overstates ending inventory, which understates COGS and
overstates profit. This is the same double-count that the `is_opening_stock`
comment on `cards` warns about, arriving by a different route.

Comp and sticker values are still worth capturing, but they belong to the
dashboard's estimated inventory value, not to cost. They go in the new
`est_value` columns and never touch `acquisition_cost`.

Open question for a preparer: barter is technically a disposition at fair
market value. Basis-carryover with no cash event is the treatment that fits a
cash-in/cash-out ledger with periodic inventory, but confirm it before filing.
If the answer is that gross receipts must include the fair market value of
goods received, the fix is a nullable `non_cash_consideration` column on
`transactions`, excluded from `net_cash` and included in `tax_summary` — not a
new `txn_type`. Ask before building this phase; the column is cheap now and a
migration later.

### Schema

Apply `schema/006_deals.sql`.

```sql
create table deals (
  id              bigint generated always as identity primary key,
  user_id         uuid not null default auth.uid(),
  occurred_on     date not null default current_date,
  counterparty_id bigint references buyers(id),
  event_name      text,
  notes           text,
  needs_review    boolean not null default false,
  created_at      timestamptz not null default now()
);

alter table transactions add column deal_id bigint references deals(id);

alter table cards add column acquired_deal_id  bigint references deals(id);
alter table cards add column disposed_deal_id  bigint references deals(id);
alter table cards add column est_value         numeric;
alter table cards add column est_value_source  text;
alter table cards add column est_valued_on     date;
```

Then, in its own statement — Postgres will not let a new enum value be used in
the transaction that adds it:

```sql
alter type card_status add value 'traded';
```

RLS policies on `deals` matching the existing three tables. Every new column is
nullable.

No CHECK constraints on `deals`. A deal opened at a table before anything has
been agreed must be allowed to sit empty.

### `txn_type` gains nothing

Do not add a `trade` value to `txn_type`. Cash moves in two directions and
`purchase` and `sale` cover both; a trade's cash leg is an ordinary purchase or
sale. The part of a trade that is not a cash movement does not belong in
`transactions` at all — it is card rows linked by `disposed_deal_id` and
`acquired_deal_id`.

Concretely: `net_cash` is generated from a `CASE` on `type`. A `trade` value
would need arithmetic. Zero leaves the cash with nowhere to live; anything else
re-encodes direction that `purchase`/`sale` already carry. Postgres has no
`ALTER TYPE ... DROP VALUE`, and `txn_type` is load-bearing for `tax_summary`,
so this is a one-way door.

### Rename `sold_on` to `exited_on`

`cards` has zero rows, so this is free today and expensive later. Two nullable
date columns where exactly one is ever set is a defect waiting to happen: one
exit date, with `status` recording how it exited. Update `sell_card()` and any
view referencing `sold_on`.

Do not store what the legs already say. No `kind`, `venue`, or `cash_delta`
column — kind is derivable from which legs attach, venue lives on
`transactions.platform`, and cash is a sum. A stored kind goes stale the moment
another leg is attached.

### View

`deal_summary` — one row per deal: `occurred_on`, `event_name`, counterparty
display name, summed `net_cash`, count of cards in, count of cards out, and a
derived kind (`trade` when both directions have cards, else `sale` /
`purchase` / `cash_only`). Left joins throughout; an empty deal returns a row
with zeroes.

This view is also the day-totals and per-show P&L query.

Show-level costs stay unattached for now. Admission and table fees have no
counterparty, so they belong to the show rather than to any deal — record them
as `expense` transactions with a null `deal_id`. Per-show P&L is therefore
incomplete by design until a show-level grouping exists. Do not invent one in
this phase.

### Functions

`open_deal()` — creates a deal from nothing. Every argument optional.

`attach_transaction(deal_id, transaction_id)` — sets `deal_id` on an existing
row.

`record_trade(...)` — atomic, and the reason this phase exists:

1. Sum `acquisition_cost` across the outgoing cards.
2. Write **one** transaction for the cash leg only — `purchase` if cash was
   paid out, `sale` if cash was received. Never a negative purchase.
3. Set outgoing cards to `status = 'traded'`, `disposed_deal_id`, `exited_on`.
   Leave `sale_transaction_id` null. This is what keeps `net_cash` honest.
4. Insert incoming cards with `acquired_deal_id` set and
   `acquisition_cost = cash paid + carried basis`, allocated pro-rata by
   `est_value` when several arrive, evenly when values are unknown.
5. If any outgoing card has a null `acquisition_cost`, write the row anyway
   with what is known and set `needs_review` on the deal. The gap must be
   visible, not silent — same principle as `cards_without_cost`.

### Skill branch

Extend `.claude/skills/card-entry/SKILL.md` with a deals branch.

Trigger: any utterance describing both giving and getting, or two legs with one
counterparty. "Traded X for Y" is the obvious case. "Bought some dollar bin
stuff and sold him the Daniels" is the same event and currently files as two
unrelated rows.

Required — do not write without these:

1. **Cash direction.** `purchase` versus `sale`. Cannot be inferred: "gave him
   $95" and "he gave me $95" differ only in `type`. Never default it.
   Ambiguous phrasing ("we settled up $95") earns a round trip.
2. **Cash amount**, if there is a cash leg. Unrecoverable later. If missing,
   write the deal and the card legs, skip the transaction row, flag the deal —
   do not insert a placeholder amount.
3. **Identity of each outgoing card, resolved to exactly one row.**
   Irreversible: the wrong card marked `traded` leaves inventory and corrupts
   the basis carried forward. Existing resolution ladder, confirm before
   disposal.
4. **A title string for each incoming card.** Free text. "ohtani bowman rookie
   pitching psa 9" suffices; every structured field can be backfilled, but an
   uncaptured card is unreconstructable.

Never ask for: date (default today; parse only if stated), counterparty, event
name, comp or sticker value, grade, set, parallel, or per-card allocation.

Confirmation policy splits by direction. Disposals are irreversible and get a
confirmation. Acquisitions are additive and trivially correctable — write them
straight through. A typical trade should cost one round trip, not three,
because this is happening standing at someone's table.

Unresolvable outgoing cards are the common case, not the edge case. `cards` is
empty, so nearly every card named at a table will fail to resolve. The fallback
must be the first thing that works: create the row from the title alone,
`acquisition_cost` null, `is_opening_stock = true`, immediately disposed to the
deal, deal flagged. Records the inventory movement honestly and leaves the
basis gap visible.

### Exit check

Fixture is the Anaheim show, 9 September 2026.

The three outgoing cards are seeded as opening stock with costs so the
arithmetic is deterministic. **These costs are invented for the fixture — they
are not real acquisition figures.** Jayden Daniels RPA `COST_DANIELS = 12.00`,
Josh Allen Winning Ticket PSA 9 `COST_ALLEN = 18.00`, Puka Nacua Rated Rookie
Pink PSA 9 `COST_NACUA = 12.00`.

Deal 1 — dollar-bin vendor, one counterparty, two legs. Sold the Daniels for
$146 cash. Bought 6 dollar-bin cards for $10.

Deal 2 — entrance vendor. Gave the Allen and the Nacua plus $95 cash, received
a Shohei Ohtani Bowman Rookie Pitching PSA 9.

Assert:

- Three transaction rows exist, not two and not five: `sale` 146.00 and
  `purchase` 10.00 both carrying Deal 1's `deal_id`, and `purchase` 95.00
  carrying Deal 2's. Deal 2 writes no transaction for the cards that moved.
- `deal_summary` returns two rows. Deal 1 nets +136.00, Deal 2 nets −95.00,
  and the two sum to **+41.00**. A total of +141.00 means a traded card was
  booked as sold.
- Three cards have `exited_on` set: the Daniels `sold` with a
  `sale_transaction_id`; the Allen and the Nacua `traded` with none.
- The Ohtani exists with
  `acquisition_cost = 95.00 + COST_ALLEN + COST_NACUA = 125.00`. Not 195.00.
- The Ohtani's `est_value` is 205.00 and appears in no cost or COGS figure.
- `deal_summary.cards_in` is 1 for Deal 2 and **0** for Deal 1 — bulk lots
  create no card rows under the Phase 3.5 rule. The day's informal count of
  seven cards in is deliberately not what the system reports.
- Re-running the fixture is either rejected or idempotent. It must not
  duplicate the cash legs.
- A second trade, with an outgoing card whose `acquisition_cost` is null,
  completes and sets `needs_review` on the deal. This is the path real entries
  will take.

Then: from a phone session, "traded the allen and the nacua plus 95 for an
ohtani bowman rookie psa 9" produces the deal, three card rows in the right
states, and one transaction — with exactly one confirmation prompt.

### Decisions to record in DECISIONS.md

- One transaction row per cash movement. Deals group rows; they never replace
  them.
- A deal is one counterparty.
- Trade basis carries over at cost, never at market value. Comps live in
  `est_value`.
- Cash received in a trade is a `sale`, not a negative purchase.
- No `trade` value on `txn_type`. Non-cash consideration, if it is ever
  needed, becomes a column excluded from `net_cash`.
- `deals` stores no derivable fields; `deal_summary` computes them.
- Show-level expenses stay unattached to any deal until a show grouping
  exists.
- `buyers` now holds counterparties who are also sellers. The name is a known
  misnomer, kept for now — renaming to `counterparties` costs 5 rows if it
  ever becomes worth doing.

### Not in this phase

Opening stock seeding beyond the fixture rows, the 2025 `inventory_counts`
row, Jan–Jul 2026 revenue backfill, a show-level grouping, per-show margin
reporting in the dashboard, and any `deals` UI. Deals are entered through the
skill; the dashboard reads `deal_summary` in a later phase.

## Phase 7 — Theme and navigation

Splits the single-page dashboard into routes, gives it a colour system, and
puts a left nav in front of it.

### Ship 011 first, separately

`record_trade()` double-counted cash received in a trade. It wrote a `sale`
transaction for the cash *and* subtracted the same amount from the received
card's carried basis — the same dollars charged against you twice.

The fix is `schema/011_record_trade_cash_in.sql`: delete the basis reduction,
keep the sale.

```sql
-- before
v_total_basis := v_carried
  + case when v_dir = 'paid' then v_cash else 0 end
  - case when v_dir = 'received' then v_cash else 0 end;

-- after
v_total_basis := v_carried
  + case when v_dir = 'paid' then v_cash else 0 end;
```

Booking the sale and carrying basis whole is the treatment that holds the
phase's central rule intact: one transaction row per cash movement. The
alternative — reducing basis and writing nothing — makes a cash-in trade
produce no transaction at all, which contradicts it.

With the subtraction gone, the `v_total_basis < 0` clamp becomes unreachable.
Left in place; it costs nothing and documents the intent. Deal 3 is the only
affected row and its received card's cost is null, so there is nothing to
backfill.

### What existed before this phase

`app/` had exactly three routes: `page.tsx`, `data/`, `login/`. Everything —
position cards, cash chart, ledger history, margin by band, card inventory,
buyer list — rendered on `/`. Any one of those sections cost a fetch of all
of them. `globals.css` held two variables and nothing else; there was no
token system to edit, only one to write.

### Colour system

Tailwind v4 is CSS-first — no `tailwind.config.js`. Tokens go in `@theme` in
`app/globals.css` and generate utilities (`bg-page`, `text-ink`)
automatically.

```css
@theme {
  --color-page:        #f5f0ee;  /* page background */
  --color-surface:     #ffffff;  /* cards, tables, nav */
  --color-brand:       #3b67b7;  /* primary, links, positive figures */
  --color-brand-soft:  #8ba1ca;  /* borders, dividers, inactive icons */
  --color-accent:      #d7728d;  /* fills, badges, chart bars */
  --color-accent-ink:  #a83e5c;  /* negative figures as TEXT */
  --color-ink:         #1c2436;  /* body text */
  --color-ink-muted:   #4a5568;  /* secondary text, labels */
}
```

Measured contrast against `--color-page`:

| token | ratio | use |
|---|---|---|
| `--color-ink` | 13.7 | body text |
| `--color-ink-muted` | 6.7 | labels, secondary |
| `--color-brand` | 4.9 | text, buttons, links |
| `--color-accent-ink` | 5.3 | negative figures |
| `--color-accent` | 2.8 | **fills only, never text** |
| `--color-brand-soft` | 2.3 | **borders only, never text** |

`#d7728d` and `#8ba1ca` both fail AA for text. They are shapes, not words. A
dollar figure rendered in `--color-accent` is a bug.

Two greys were sampled, `#f5f0ee` and `#f4eff0`. They differ by one RGB unit
and cannot carry a page-versus-card hierarchy. Only the first is a token;
card surfaces use white, which gives real separation.

### Positive and negative

The palette has no green. Positive figures use `--color-brand`, negative use
`--color-accent-ink`.

This is deliberate, not a workaround: blue against rose stays distinguishable
under deuteranopia, where red against green does not. The cost is that blue
does not *read* as positive on its own, so every figure carries an explicit
sign or arrow. Colour is emphasis here, never the only carrier of meaning.

### Chart colours

`recharts` takes colour props, not classes. SVG `fill` and `stroke` accept
`var(--color-brand)`, so the chart reads the same tokens as everything else.

The palette is not forked into a TypeScript constants file for the chart's
sake. Two copies drift, and the second copy is the one nobody updates.

### Routes

Six destinations. Five are new sections; the sixth (`/data`) already existed
and was reachable only by typing the URL.

| route | content | source |
|---|---|---|
| `/` | position cards, cash chart, ledger history | `PositionCards`, `CashChart`, `ledger_running`, `dashboard_windows` |
| `/deals` | per-deal and per-show view | `deal_summary` — net new, no component existed |
| `/inventory` | cards by status, tracked summary | `CardInventory`, `tracked_inventory` |
| `/insights` | margin by price band | `MarginByBand` |
| `/people` | buyer and vendor list | `BuyerList`, `buyer_summary` |
| `/data` | table CSV, eBay report | existing, unchanged |

Each route queries only its own views.

`/people`, not `/buyers`. That table now holds show vendors bought *from* as
well as buyers. The column comment on `deals.counterparty_id` already calls
the name a known misnomer; the nav label is where that stops propagating into
new surfaces.

### Nav

A left sidebar on `--color-surface`, fixed, with the five sections in the
order above. `/data` sits at the bottom, visually separated — it is a
utility, not a section.

The active item is marked with `--color-brand`: a left border and filled
background, plus a weight change — never colour alone. Inactive icons use
`--color-brand-soft`.

The sidebar lives in `app/(app)/layout.tsx`, not the root layout. The six
destinations moved under a route group, `app/(app)/`, and `login/` stayed
outside it. Putting the nav in the root layout would wrap a signed-out user
in chrome for a dashboard they can't see yet.

### Flag counts instead of a review page

There is no Review section. `needs_review` surfaces in two places instead: a
count badge on the Deals nav item, and a marker on the affected rows within
each screen.

Four of six deals carried the flag before this phase and nothing in the app
showed it — flagged rows were reachable only through `entry.py review`, which
meant they did not get reviewed.

### Decisions recorded in DECISIONS.md

- Tokens live in `@theme` in `globals.css`. Tailwind v4 has no config file;
  none was added.
- `--color-accent` and `--color-brand-soft` are fills and borders only, never
  text.
- Positive is brand blue, negative is accent ink, and every figure carries an
  explicit sign. Colour never carries meaning alone.
- The chart reads the same tokens as the UI. The palette is not duplicated in
  TypeScript.
- Authenticated routes live in the `(app)` route group so `/login` stays
  outside the nav layout.
- `/people` supersedes "Buyers" in the UI. The table name stays for now.

### Not in this phase

Dark mode — the palette is light-only and a half-built dark theme is worse
than none. A Taxes screen, a Review screen, sell-through and aging on
`/insights`, a deals entry UI (deals are still entered through the skill),
per-show grouping, and any change to `/data` beyond making it reachable.
