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

**Revoking from `anon`/`authenticated` alone was not enough.** Postgres
grants `EXECUTE` to `PUBLIC` by default when a function is created, and
`anon`/`authenticated` inherit through that regardless of a direct revoke
naming them. Found while verifying Phase 11 via
`information_schema.routine_privileges` — the original Phase 10 revoke had
left `PUBLIC` still holding it. `EXECUTE` must be revoked from `public`
explicitly, every time, not just from the roles that happen to concern you.

## Delivery is fire-and-forget; a failed Discord post is not retried

`pg_net.http_post` is asynchronous — it returns a request id immediately, so
a failed delivery isn't visible at the moment `notified_at` is written, and
that release is never retried. Accepted for a personal ledger. If it ever
matters, the fix is storing the request id and reconciling against
`net._http_response` on a later run — not built, because nothing today
depends on delivery being guaranteed.

## Shows are stored one row per occurrence, with no recurrence engine

A weekly show is weekly until it is not — holidays, special editions,
changed hours. The dated row carries `status`, the actual `doors_at`,
notes, and the deals that hang off it, none of which a series definition
could hold. If repetition becomes tedious, the fix is a
`duplicate_show(id, new_date)` helper, not a recurrence rule engine.

## `admission_cost` and `table_cost` are planning estimates, never actual spend

They exist so a show can be evaluated before deciding whether to go. What
was actually paid is always a `transactions` row with that `show_id`. If
either column is ever read into a P&L figure, there are now two ledgers for
the same dollar and they will disagree — same trap `deals.event_name`
avoided by never storing a number that a query could compute instead.

## `deals.show_id` replaces `deals.event_name`, not supplements it

`event_name` was free text — the six original rows read like "LA card show
- deal 1" — which cannot be grouped or joined, only pattern-matched. A
foreign key next to a free-text label describing the same thing is a
second source of truth that drifts within a month, so `event_name` was
dropped the same migration `show_id` was backfilled onto every existing
deal. `deal_summary` still exposes a column called `event_name` for the
web app's sake, but it is now sourced from `shows.name` through the join,
never stored.

## Show-level expenses attach via `transactions.show_id` with a null `deal_id`

Admission, table fees, and parking have no counterparty, so forcing them
onto whichever deal happened to be recorded first at a show would be
wrong — a deal is one counterparty, and a door fee belongs to the show
itself. `show_summary` sums these separately from deal cash
(`unattached_net_cash`) and folds both into a true `net_cash`. The
deal-leg transaction `record_trade()` writes never carries `show_id`
itself — only `deal_id` — specifically so `show_summary` can filter
unattached expenses with `deal_id is null` and never double-count a deal's
cash through both paths.

## Calendar markers are distinguished by glyph and border, never by a new colour

Phase 7 spent the palette's colour budget on positive and negative cash,
and the greyscale rule (every signed figure must still read without
colour) means a colour-only marker fails regardless of budget. Shows and
releases are both small bordered badges — `S` and `R` — so the category is
legible from the glyph alone; the border colour reuses existing tokens
(`accent`/`accent-ink` for releases, `brand-soft`/`accent-ink` for shows)
to carry urgency, not identity. The glyph text itself always stays
`ink-muted`: `accent` and `brand-soft` still fail AA for text, the same
rule from Phase 7.

## An unresolved past show reads differently from an attended one

A show whose last day has passed but is still `status = 'planned'` is
missing a human decision (did it happen? was it skipped?), not a
completed record — so it renders with the same urgency border as a
flagged release rather than blending in with ordinary attended shows on
the calendar.

## `find_or_create_show()` never blocks a deal on a missing show

Resolving a deal's show is a name-plus-date match against existing rows.
No match does not stop the deal from being recorded — it creates the show
as `attended` (a deal is being recorded there right now, so it was
attended, whatever else about it is unknown) with `needs_review = true`,
same principle as an unresolvable card falling through to
`add_opening_stock` rather than blocking entry. The cash and the card
movement are real whether or not the show was catalogued in advance.

## Single-item entry writes through; batch entry previews first

An upcoming show stated conversationally ("Anaheim show next Wednesday,
$5 admission") is one row and writes immediately, same policy as
`card-entry`'s plain purchases and sales — the acknowledgement after
writing is the confirmation. This is deliberately the opposite of
`release-entry`, which previews every batch before writing anything
because a pasted list is many rows of inference at once and one bad
weekday resolution is easy to miss in a wall of text. One show stated in
conversation carries none of that risk, so the batch skill's caution would
just be friction here.

## Seller fees apply only to cards bought to resell

eBay's final value fee is charged to the seller. A card bought to keep
(`purpose = 'pc'`) costs price, shipping and sales tax — nothing else, so
its `max_all_in` is the comp times `pricing_settings.buy_pct` (default 0.80, configurable, all-in: price + shipping + tax). Only `flip` items subtract fees and margin, and those settings are nullable so pc-only use needs none.

## Targets compare against all-in cost, never listing price alone

What leaves the account is price + shipping + tax. `buying_targets` reports
`max_all_in`, and `target_listing_price` converts back to the number visible
on a listing at the assumed `pricing_settings.buy_shipping`.

## Comps are observations with dates, not a single overwritten value

A comp row is a price seen on a date. Overwriting destroys the history that
shows whether a card is rising or falling. Targets use the most recent; one
older than 30 days marks the target stale but still shows it.

## Derived comps use the median

Sold prices carry outliers in both directions; one moves a mean far and a
median barely. $170, $180, $400 derives $180, not $250.

## Fees are modelled as rate plus fixed fee, never a flat percentage

A flat share of gross is inflated by the fixed fee on small sales (17.3% over
the first five, mostly $10 orders). Refit both from `platform_fees` as
history grows.

## Shipping labels land on sale rows only, never on a refund

`net_cash` negates a refund row, so a label share on one turns a cost into
income: a sale and its refund in the same report used to net the label to
zero, and a return label booked as a gain. Both importers split a label over
the order's sale rows (the last row takes the rounding remainder, so the parts
sum exactly). An order with no sale in the file — a return label beside a
refund, or a label bought the day after the month closed — goes through the
orphan path onto the original sale. Refund amounts are stored positive
whatever sign eBay writes, because the ledger supplies the sign.
`importers/test_parse_ebay.py` checks all of it.

## The database clock is Pacific

`alter database postgres set timezone to 'America/Los_Angeles'`
(`schema/023`). Every `default current_date` reads it. On the UTC default,
anything entered after 5pm Pacific was dated tomorrow — wrong show matches,
and a Dec 31 evening sale in the next tax year.

## The daily digest waits for live listings

A digest with nothing new is noise, and a muted channel also costs the
Phase 10 release alerts. It ships in Phase 14 with the scanner.

## The eBay API lives in this repo, for now

Next.js route handlers under `web/app/api/ebay/*` on the existing Vercel
project, state in the existing Supabase (`schema/024`). A separate service
would mean a second deploy, a second secret store and a second copy of the
Supabase client for one user's traffic, and the sync needs the ledger tables
anyway. The cost of the choice is kept small instead: everything lives in
`web/lib/ebay-api/` behind injected `fetch` and storage interfaces, with no
Next.js imports outside the route files and `context.ts`, so it lifts out
into its own service whenever that starts paying for itself. See
`docs/ebay-api.md`.

## The service-role key exists only for `/api/ebay/*`

"Dashboard: local now, Vercel later" says anon key in every environment, and
for the dashboard that still holds — no page or server action touches the
service role. The eBay routes are the scoped exception: Yoshi, Vercel Cron
and eBay's callbacks are machines with no Supabase session, so `auth.uid()`
is null and the anon key sees nothing. Their tables (`schema/024`) are
RLS-locked with no policies and revoked from `anon`/`authenticated`, so the
refresh token cannot be read with the publishable key at all.
`web/lib/supabase/admin.ts` imports `server-only`, and the key has no
`NEXT_PUBLIC_` prefix, so it cannot reach a browser bundle. Never import it
from a page.

## The eBay API sync never writes ledger cash rows

The Seller Hub transaction report is the only source that carries real fees
and shipping-label costs, and both importers already load it idempotently on
`source_ref`. A second writer of eBay sale rows would have to either invent
fees (forbidden) or write fee-less rows the report later has to find and
merge — an `UPDATE` path against tax records keyed on an id equivalence
(Fulfillment `lineItemId` vs. the report's Transaction ID) nobody has
verified. Not writing at all removes the double-count by construction: there
is nothing to dedupe.

So the sync's job is the part the report cannot do well — deciding which
physical card sold — and it does it against the importer's row, joined on
`order_ref` + `item_number` (order number + listing id, both of which the
importers already store). `cards.status = 'sold'` requires a
`sale_transaction_id`, so a card whose sale has not been imported yet waits
as `pending_ledger` rather than being closed against nothing; the cost is
that a sold card can show as held for up to a week, until the next report
import. Matching follows the `CLAUDE.md` rules for a named card — SKU first,
then a single unambiguous `find_cards` hit, otherwise `needs_review`, never a
guess — because a cron run has nobody to ask.

`find_cards` and `sell_card` are scoped to `auth.uid()`, which is null under
the service role, so `schema/024` adds two service-role-only entry points:
`ebay_find_cards` (sets the JWT `sub` for one transaction and calls the
existing `find_cards`, keeping one definition of a match) and
`ebay_close_card_for_sale` (closes against an existing sale row, re-checks
everything under a lock, writes no transaction).

## A fulfillment policy is never auto-selected

Payment and return policies and the merchant location may be looked up when
the account has exactly one. The shipping policy may not: the only existing
one is eBay Standard Envelope, and "exactly one, so use it" would silently
list $50 cards on the $0.78 envelope service meant for cards under $20. A real CDP
import refuses until a fulfillment policy is configured; the dry run still
works and shows `fulfillmentPolicyId: null`.

## `cards.category` says what a card is for; `pc` is never business inventory

`schema/025` adds `category` (`pc`, `business`, `riftbound`, `sealed`),
not null, default `business`. It is a property of the **card**, set once,
rather than a status: a PC card can still be held, listed or sold, so folding
it into `card_status` would multiply every status by every category.

`tracked_inventory` excludes `category = 'pc'`. A personal-collection card is
not held for sale, so it is not inventory in the Schedule C sense, and counting
its cost toward the year-end floor would prop up ending inventory (understating
COGS) with cards the business does not own as stock. `riftbound` and `sealed`
stay in: they are resale stock, just tracked as separate lines.

Known asymmetry, not fixed here: a `[PC]` purchase is still an ordinary
`purchase` row (see the card-entry skill), so its cash still lands in
`tax_summary.purchases` and therefore COGS. COGS reads ending inventory from
`inventory_counts`, not from this view, so nothing changes automatically — but
a count that follows `tracked_inventory` and leaves PC out means PC spend is
expensed in full. Taking PC buys out of purchases is a `tax_summary` decision,
separate from this one.

`search_text` was rebuilt to include `sport` and `serial_number` (a generated
column cannot be altered, so it is dropped and re-added with its trigram
index). That is safe because `find_cards` also scores with `word_similarity`
(`008`), so a longer haystack does not push short phrases under the threshold.

## A `pc` card can never be listed or sold; a trigger blocks it outright

`schema/027` adds `cards_pc_guard`, a `BEFORE INSERT OR UPDATE` trigger that
rejects `category = 'pc'` with `status` `listed` or `sold` (SQLSTATE `23514`,
`check_violation`). There is no owner override: to sell a PC card, change its
category first. That makes "this is now stock" an explicit, visible edit, and
the same edit moves the card into `tracked_inventory`.

A trigger rather than a CHECK only so the error can say what to do; the rule
is row-local either way. Being in the database, it covers every writer:
`sell_card()` and `ebay_close_card_for_sale()` fail on a PC card (atomically —
`sell_card` leaves no orphan sale row), as does the dashboard's report import.
`traded` stays allowed: a PC card can leave in a trade. On top of the trigger,
the eBay code skips PC cards (sync lookups, CDP listing links, the report
import's close-by-SKU) and refuses to reprice an offer tied to one (409
`personal_collection`), so they fail early and legibly instead of hitting the
trigger.

## `cards.intent` separates investment holds from cards waiting to be listed

`held` covered both. `intent` (`hold` / `sell`, nullable = undecided) records
the plan without adding a status — status stays where the card *is*. It is
null whenever `category = 'pc'` (CHECK `cards_intent_null_for_pc`), because a
PC card is never for sale; putting an `intent = 'sell'` card into PC is
rejected rather than silently clearing it.

## `cdp_sku` is separate from `sku`

`sku` is the eBay Custom label, the join key for the report import, the sync
and `ebay_listings`. Card Dealer Pro assigns its own SKU at scan time. Reusing
one column for both would let a CDP scan overwrite the key the importer
matches on. `cdp_sku` is unique per owner when set; the two may hold the same
value for a CDP-listed card, but neither is derived from the other. CDP's
market price needs no column: it goes in `est_value` with
`est_value_source = 'cdp'` — a rough value, never a cost.

## Bulk lots are counts; their money stays on `transactions`

The $1 / $3 / $5 / $6–20 boxes live in `bulk_lots`, one row per (owner,
bucket, location), with `card_count`, `unit_price` and a generated
`total_value`. Not card rows (cards stay opt-in) and not `inventory_counts`
(that is the year-end tax count). Changes are logged in `bulk_lot_events`
(`scan_add` / `show_sale` / `recount`), which hold **counts only**: a box sale
at a show is an ordinary sale row in `transactions`, linked from the event by
`transaction_id`. `bulk_lot_events.amount` is context, never summed. The event
table references its lot by `(lot_id, user_id)` so an event can never point
at another owner's lot. No trigger applies `delta` to `card_count`; the writer
does it, so a recount can set the absolute figure.

Deferred: whether bulk-lot cost basis (`total_cost`) rolls into ending
inventory. Until decided, `bulk_lots` feeds no view, and `tracked_inventory`
and the tax views are unchanged.

Both new tables use policies `TO authenticated` (not `TO public`), revoke
everything from `anon` and `TRUNCATE` from `authenticated` — the tidy-up the
older tables are due, applied from the start here.

## The inventory migration is `027`, not `026`

`026_profit_views.sql` was already in the repo, unapplied, and stays as is.
Repo file numbers have never matched applied history (applied
`022_database_timezone` is repo `023`; 024 and 025 were run by hand and never
recorded). `docs/schema-migrations.md` maps them, has the snippet that records
024/025, and from 027 on the `apply_migration` name matches the file name.

## The CDP inventory import is a pure library plus a CLI that emits reviewable SQL

`web/lib/inventory-import/` parses, classifies and plans with no I/O; the CLI
(`web/scripts/cdp-inventory-import.ts`) reads a CDP export and a JSON snapshot
of existing cards, writes a dry-run report, and with `--commit` writes one
idempotent `begin; … commit;` script. Nobody's machine connects to the
database, and no service-role key or database URL is needed for it: Bowser Jr.
and Toad load data through the Supabase connector with SQL, so the natural
hand-off is a script they can read and apply as one call. No API route — it
would need the service-role key in a new place for no gain. The script writes
the owner's `user_id` explicitly (under the connector `auth.uid()` is null),
re-matches cards by `cdp_sku` / grader+cert at apply time, and never touches
`transactions`. Usage: `docs/inventory-import.md`.

## Bulk-mode card rows leave `intent` null

In a `bulk` batch, a card over $20 or graded becomes a cards row with
`intent = null` (undecided), not `'sell'`. A scan says what a card is worth,
not what Johnny means to do with it; `'sell'` would put it in the to-list
queue by default. `holds` batches set `'hold'` because the batch itself is
that decision. An override (`intent`, or an asking price) sets it per card.

## Import updates fill gaps; they never overwrite a hand-set value

An exact match (`cdp_sku`, then grader + cert) fills only null fields.
`acquisition_cost`, `list_price` and `category` are never overwritten, and
`status` is never touched. `est_value` is refreshed only when it is empty or
was itself CDP's (`est_value_source = 'cdp'`): a comp or a hand estimate is
better information than CDP's scan-time market price, so a rescan must not
replace it. An override can still set `category`, `intent` or `list_price`
explicitly.

## Fuzzy title matches flag; they never merge

A trigram match against an existing card is a `possible_duplicate` that blocks
the row until Johnny says merge, insert or skip. Merging on a similarity score
would silently fold two different cards into one — the same reason
`find_cards` never picks the top score on its own. Default threshold 0.55
(pg_trgm `similarity` on `search_text`), chosen on the real Nov 27 files:
it catches the rescanned 1996-97 Topps Kobe PSA 7 (0.711) and the 1996-97
SkyBox Jordan vs the $25 "1996 Skybox Premium Michael Jordan" (0.565). A
candidate whose year, card number, grader/grade or raw-vs-graded state
contradicts the scan is reported but not flagged: the raw 2025 Chrome Sasaki
(0.603 against the PSA 9 Sasaki) and the 1998-99 SkyBox Kobe (0.588 against
the 1996 one) are different cards.

## Bulk increments are guarded by a batch marker, not a count check

Each bulk-lot increment writes a `bulk_lot_events` row whose `notes` is
`cdp-import:<batch>:<bucket>:<location>`, and is skipped if that marker
exists. A rerun of the same batch therefore adds nothing, while a genuinely
new scan of more cards (a new batch id) still adds. The batch id defaults to
CDP's own batch number (title row or image URLs), so the same export always
maps to the same id. Hand counts in the overrides replace the batch's CDP
count (they are the increment, not an absolute recount; a recount is a
`recount` event).

## The 2008-09 Topps Kobe Orange matches PC even when CDP reads it raw

The spec names the PSA 2.5 as PC and notes that CDP reads that slab as raw.
A raw-read 2008-09 Topps Kobe Orange therefore matches the PC rule, with a
note on the card and in the report; a slab of it at another grade does not.
Misclassifying it as business would let a PC card reach eBay; the reverse
only keeps a card out of tracked inventory until someone looks. The grader
and grade are not filled in from the rule — the scan did not say them.

## One PC rule list, shared by the inventory import and the eBay listing import

`web/lib/inventory-import/pc-rules.ts` is the only place PC is defined for
imports. The inventory importer makes a matching row a `pc` card; the CDP
listing import (`/api/ebay/import-cdp`) skips it before building or sending
anything (`skipped_personal_collection`, reason `personal_collection`), and
also skips any row whose SKU is a `pc` card in the database (by `cdp_sku`,
including the numeric prefix of an FX label like `203-19tvfa`, or by eBay
`sku`). Rules are data — one ordered array, first match wins, a test per rule.
