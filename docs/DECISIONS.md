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

## Deals group cash rows; they never replace them

One transaction row per **cash movement** — not one per deal, and not one per
card. A deal with money moving both directions is two rows sharing a `deal_id`.

Netting a deal down to a single row destroys two figures to save one. Receipts
and purchases land on different Schedule C lines and carry opposite `net_cash`
signs. `deal_summary` computes the per-deal net as a query result, which is the
only place that number belongs — it is never stored, because a stored total
goes stale the moment another leg is attached.

A deal is **one counterparty**. Several legs with the same vendor are one deal;
a different vendor is a different deal.

## Trade basis carries over at cost, never at market value

The received card's basis is the cash paid plus the **cost basis** of the cards
given up. Cards given up at a $100 comp that cost $30 carry $30, so a trade of
those two plus $95 cash produces a basis of $125, not $195.

Recording market value overstates ending inventory, which understates COGS and
overstates profit — the same double-count the `is_opening_stock` flag guards
against, arriving by a different route. Comp and sticker values are still worth
capturing, but they live in `cards.est_value` and feed only the dashboard's
estimated inventory value.

**Open question for a preparer:** barter is technically a disposition at fair
market value. Basis-carryover with no cash event is the treatment that fits a
cash-in/cash-out ledger with periodic inventory, but confirm it before filing.
`transactions.non_cash_consideration` exists, nullable and unused, so that
ruling costs a backfill rather than a migration against tax records.

## A card can leave inventory without being sold

`card_status` gained `traded`. Previously `sold` was the only exit and it
requires a `sale_transaction_id`, so a traded-away card had to either invent a
receipt that never happened or sit in ending inventory forever.

A traded card carries `exited_on` and `disposed_deal_id` with
`sale_transaction_id` left null. That is exactly what keeps `net_cash` honest.
`find_cards` and `tracked_inventory` both exclude traded cards — otherwise a
card given away stays sellable and keeps counting as stock on hand.

## No `trade` value on `txn_type`

Cash moves in two directions and `purchase`/`sale` already cover both; a
trade's cash leg is an ordinary purchase or sale. The part of a trade that is
not a cash movement does not belong in `transactions` at all.

Concretely: `net_cash` is generated from a `CASE` on `type`. A `trade` value
would need arithmetic — zero leaves the cash with nowhere to live, and anything
else re-encodes direction that `purchase`/`sale` already carry. Postgres has no
`ALTER TYPE ... DROP VALUE` and `txn_type` is load-bearing for `tax_summary`,
so this would be a one-way door.

## `sold_on` became `exited_on`

Two nullable date columns where exactly one is ever set is a defect waiting to
happen. One exit date, with `status` recording how it exited. Done while
`cards` had zero rows, which made it free.

## Show-level expenses stay unattached to any deal

Admission and table fees have no counterparty, so they belong to the show
rather than to any one deal. They are `expense` rows with a null `deal_id`.
Per-show P&L is therefore incomplete by design until a show-level grouping
exists; inventing one inside `deals` would corrupt what a deal means.

## `buyers` now holds counterparties who also sell

A deal's counterparty is a vendor you bought from as often as someone you sold
to. The table name is a known misnomer, kept for now — renaming to
`counterparties` costs 5 rows if it ever becomes worth doing.

## Colour tokens live in `@theme`, not a Tailwind config file

Tailwind v4 is CSS-first — `tailwind.config.js` is gone. The eight tokens
(`page`, `surface`, `brand`, `brand-soft`, `accent`, `accent-ink`, `ink`,
`ink-muted`) are defined once in `app/globals.css` and nowhere else. Do not
add a config file to hold them; that would be a second source of truth for
the same eight values, and Tailwind v4 would ignore it for utility generation
anyway.

## `accent` and `brand-soft` are fills and borders, never text

Measured against the page background, `accent` (2.8) and `brand-soft` (2.3)
both fail AA for text. They read fine as shapes — chart bars, badge fills,
dividers — and fail as words. A dollar figure, a label, or any other text
rendered in either is a defect, not a style choice.

## Positive is brand blue, negative is accent ink; every figure carries a sign

The palette has no green. Blue against rose stays distinguishable under
deuteranopia, where red against green does not — but blue alone doesn't
*read* as positive the way green would. The mitigation is that every money
figure carries an explicit sign (`usd()`'s locale formatter already prints
the minus), so colour is emphasis on top of an unambiguous number, never the
only carrier of meaning.

## The chart reads the same CSS custom properties as the rest of the UI

`recharts` takes colour props, not classes, but SVG `fill`/`stroke` accept
`var(--color-brand)` directly. The palette is not forked into a TypeScript
constants file for the chart's sake — two copies of eight colours drift, and
the copy nobody remembers to update is the one that ships wrong.

## Authenticated routes live under `app/(app)/`

The route group's layout owns the sidebar and the auth redirect; `app/login/`
sits outside it under the same root layout. Putting the nav in the root
layout would wrap a signed-out user's login screen in chrome for a dashboard
they can't see yet. Route groups add no URL segment, so `/data` and friends
are unaffected by living inside the group.

## `/people` supersedes "Buyers" in the UI; the table name stays

The nav label and page heading say "People" — the table now holds show
counterparties bought *from* as often as buyers sold *to*, and the nav is
where a fresh surface can just not repeat an old misnomer. Renaming the
`buyers` table itself is still not worth a migration for 5 rows; see the
Phase 6 entry above.

## No Review screen; `needs_review` surfaces as counts and row markers instead

A dedicated review page would be a second place deals live, competing with
`/deals` for which one is current. A nav badge (count of `needs_review`
deals) plus an inline marker on the affected row does the same job — surface
the gap where the data already lives — without a screen whose only content is
"go look at rows that live somewhere else."

## Day detail is hover-for-summary, click-to-pin

A recharts tooltip unmounts the instant the pointer leaves the plot area, so
anything interactive inside it — an expander, a scrollable list — has nowhere
for the pointer (or a keyboard user) to go on the way to it. Tooltips are not
interactive surfaces; two mechanisms replace the one that was asked for.
Hovering gets a richer but still non-interactive tooltip. Clicking pins the
day's full entry list in an ordinary panel below the chart, which can be
scrolled, selected, and reached with a keyboard — because it's just DOM, not
a tooltip.

## Ledger pagination is server-side via URL search params

`?rows=10&page=2`, read by the Server Component and turned into `.range()`.
Client-side slicing — fetch everything, paginate in React — is the obvious
shortcut and the wrong call: the eBay importer adds a quarter of rows at a
time, and a ledger that eventually holds thousands of rows should not ship
every one to the browser to display ten. Paging through the URL also makes a
page linkable and survives a refresh.

## Ledger ordering is `occurred_on desc, id desc` everywhere

The tiebreaker is not optional. Without `id` as a second sort key, same-day
rows can reorder between two `.range()` calls and a row lands on two pages or
none — a paginated query has no other way to guarantee a stable cut.

## `running_total` comes from the view and is never recomputed from a page

`ledger_running` computes it as a window function across the *whole* ledger,
so every row carries the correct cumulative figure regardless of which page
it lands on. Recomputing it from only the visible page would be wrong the
moment there's a page before it.

## Calendar indicators show daily net movement, not cumulative position

A day cell shows what happened *that day* — the same shape as a
`daily_cash.net_movement` row — never the running total. A cumulative figure
on every cell would repeat almost the same number 30 times and tell you
nothing about which day actually moved money; the whole point of a calendar
view is the day-by-day shape, which a running total erases.

## Phase 7's colour rule stands on the calendar

No green, no red — positive is `--color-brand`, negative is
`--color-accent-ink`, same as everywhere else. The day cell itself shows a
bar, not a figure: it grows *above* a centre line for a positive day and
*below* it for a negative one, so direction — not colour — is what actually
carries the sign, and the rule holds even in greyscale. Colour is layered on
top for emphasis. The exact signed figure (`+146.00`, `−95.00`) is revealed
on hover or click, never printed in the cell itself — a compact calendar has
no room for thirty numbers at once, and the bar is the point. A day with
nothing in it gets no bar at all, not a zero — zero and "no data" are
different facts and a bare `0.00` would claim the first when it means the
second. A release on a day gets its own dot, independent of the bar; the two
are different kinds of fact and were never meant to share one indicator.

## `releases.drop_type` is text

Same reasoning as `deals` in Phase 6: Postgres has no
`ALTER TYPE ... DROP VALUE`, and drop mechanics change often enough that a
one-way door is the wrong shape. The release-entry skill validates against a
documented set (`FCFS`, `EQL`, `raffle`, `queue`); the column itself does
not.

## Weekday-only input resolves forward, and dates never decrease within a paste

"Monday" in a pasted release list means the next Monday from today,
inclusive of today. Within one paste, resolved dates never go backward — if
the next named weekday would land before the last one resolved, it advances
a week instead. Without both rules a list spanning a weekend (e.g. Thursday
through Monday) collapses into a single week and silently files the tail in
the past, where a calendar view will never surface it.

## Eastern times are parsed as `America/New_York` wall-clock, never a fixed offset

`EST`, `EDT`, and `ET` all mean the same wall-clock zone; the date in
question picks daylight vs. standard time, not the literal three-letter
abbreviation. A hardcoded UTC-5 is wrong for roughly eight months of the
year, and an hour is the entire outcome on a first-come-first-served
preorder.

## Release notifications run in Postgres via `pg_cron`, not on Vercel

Vercel Hobby cron runs at most once a day and fires anywhere inside the
scheduled hour — it cannot support a pre-drop ping. `pg_cron` runs as a
background worker inside Supabase and `pg_net` makes the outbound call, so
nothing touches the Next.js app: no route, no deploy, no traffic.

## The notifier polls a lead window; it does not schedule one job per release

A poll every 15 minutes checking for releases inside a 45-minute lead window
needs no DST handling, leaves no orphaned per-release job when a date
changes, and self-heals a missed run. **The lead window must stay longer
than the poll interval** — at 45/15 every release passes through the window
on at least two runs; shrink the window below the interval and drops fall
silently between ticks. `release_at > now()` is what stops the very first
run from firing every past release at once.

## The Discord webhook URL lives only in Supabase Vault, never in the repo

Inserted by hand with `vault.create_secret(...)`, once, outside of any
migration file. `schema/014_release_notifications.sql` reads it by name from
`vault.decrypted_secrets`; the value itself is never committed, logged, or
written to a table column. It is a bearer credential — anyone holding the
URL can post to the channel.

## `notify_upcoming_releases()` is `SECURITY DEFINER`, filters `user_id` explicitly, and is not grantable to `anon`/`authenticated`

`pg_cron` runs with no authenticated session, so `auth.uid()` is null and
RLS would silently return zero rows — the function looks up the (single)
owner's `auth.users.id` itself instead of relying on the `own_releases`
policy. Being `SECURITY DEFINER` means it bypasses RLS entirely, which is
also why `EXECUTE` is revoked from `anon` and `authenticated`: left granted,
any signed-in or anonymous caller could hit
`/rest/v1/rpc/notify_upcoming_releases` directly and fire the Discord
webhook on demand. `search_path` is pinned to `public, vault, net` on the
same grounds — a definer-rights function must not resolve an unqualified
name to something a lower-privileged role planted.

## Delivery is fire-and-forget; a failed Discord post is not retried

`pg_net.http_post` is asynchronous — it returns a request id immediately, so
a failed delivery isn't visible at the moment `notified_at` is written, and
that release is never retried. Accepted for a personal ledger. If it ever
matters, the fix is storing the request id and reconciling against
`net._http_response` on a later run — not built, because nothing today
depends on delivery being guaranteed.
