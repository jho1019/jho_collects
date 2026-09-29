Phase 13 — Buying list and target prices

A list of cards to buy, what they are worth, and the most you should pay. Built so Phase 14's eBay scanner has something to scan for and a number to compare against.

Why the daily digest is not in this phase

The digest is only useful once it has live listings to report. Without scanning, it would send the same unchanged list every morning — and a notification that says nothing new trains you to mute the channel, which then costs you the release alerts from Phase 10 as well. It ships in Phase 14, alongside the scanner that gives it something to say.

Schema

`schema/017_buying_list.sql`

```sql
create table buying_list (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid(),

  title         text not null,          -- 'Shohei Ohtani 2018 Topps Chrome RC'
  player        text,
  year          int,
  set_name      text,
  card_number   text,
  parallel      text,                   -- 'Sapphire'
  grader        text,
  grade_min     numeric,                -- 9 means PSA 9 or better

  purpose       text not null default 'pc',   -- pc | flip
  max_price     numeric,                -- manual override; wins over the formula
  search_url    text,                   -- an eBay saved search, as a link
  priority      smallint,
  status        text not null default 'hunting', -- hunting | bought | dropped
  bought_card_id bigint references cards(id),
  notes         text,
  created_at    timestamptz not null default now()
);

create table comps (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid(),
  buying_list_id bigint not null references buying_list(id),
  price        numeric not null,
  source       text,                    -- 'ebay sold', '130point', 'card ladder'
  observed_on  date not null default current_date,
  notes        text,
  created_at   timestamptz not null default now()
);

create table pricing_settings (
  user_id          uuid primary key default auth.uid(),
  ebay_fee_rate    numeric not null,    -- final value fee, as a fraction
  ebay_fixed_fee   numeric not null,    -- per-order fee
  resale_postage   numeric not null,    -- what shipping a sold card costs you
  sales_tax_rate   numeric not null,    -- charged on your purchases
  flip_margin      numeric not null     -- target profit, fraction of comp
);
```

RLS on all three, matching existing tables. `purpose` and `status` are text, not enums, per the Phase 6 rule.

Comps are rows, not a column on `buying_list`. A comp is an observation on a date; overwriting it destroys the history that tells you whether a card is rising or falling. Target price uses the most recent.

`set_name` plus `card_number` is how set completion works. Finishing a Heritage set is a group of `buying_list` rows sharing a set, and "what's left" is the ones still `hunting`. No separate checklist table.

`bought_card_id` closes the loop: when an item is bought, it points at the `cards` row that fulfilled it.

Target price

`buying_targets` view — one row per `hunting` item: latest comp, comp age, target all-in, and target listing price.

**Purpose changes the formula entirely.**

For `flip`, the ceiling is what leaves you your margin after selling it again:

```
max_all_in = comp × (1 − ebay_fee_rate) − ebay_fixed_fee − resale_postage − comp × flip_margin
```

For `pc`, there is no resale, so **seller fees do not apply to you at all.** eBay's final value fee is charged to the seller. A card you are buying to keep costs you its price, shipping, and sales tax — nothing else.

```
max_all_in = comp
```

`max_price`, when set, overrides both.

**Everything compares all-in.** The number to hold a listing against is price plus shipping plus sales tax, since that is what leaves your account. The view also reports the listing price that corresponds to the target at a stated shipping cost, because that is the number you actually see on a listing:

```
target_listing_price = (max_all_in − shipping) / (1 + sales_tax_rate)
```

A comp older than 30 days marks the target stale. A stale target still shows; it just says so.

Fee settings come from your own data

No screenshots needed. Every eBay sale already carries `platform_fees` from the transaction report import, so your real fee structure is in the database.

Measured across five sales so far, fees run to 17.3% of gross. **Do not use that as a flat rate.** It is inflated by the fixed per-order fee landing on $10 sales, where 40 cents is several percent on its own. On a $200 card the same fee structure is a much smaller share. The model has to be rate plus fixed fee, and both should be refit as the sales history grows past a handful of small orders.

Seed `pricing_settings` from eBay's published fee schedule for trading cards and your actual postage, then check it against the transaction data periodically.

Comp skill

`.claude/skills/comp-entry/SKILL.md`

Two entry paths. A single figure — "comp for the Yamamoto sapphire PSA 10 is $180" — writes one `comps` row. A pasted set of sold prices writes one row per observation.

When deriving a single comp from several sales, **use the median, not the mean.** Sold prices on a single card carry outliers in both directions: a best-offer accepted far below ask, a bidding war, a mislabelled grade. One outlier moves a mean a long way and a median barely at all.

Resolve the item by title against existing rows. No match: offer to add it to the buying list, since a comp for a card you are not tracking usually means you meant to track it.

Single-item entry writes through. A pasted batch previews first — the Phase 11 rule.

App

A `/buying` route, reachable from the More sheet on mobile and the sidebar on desktop. Grouped by purpose, then by set. Each row: title, latest comp with its age, target all-in, target listing price, and the saved search as a tappable link.

A Heritage set group shows progress — owned out of total — since that is the question set completion asks.

Seed data

The graded Shohei rookies, from your existing list. The Yamamoto and Sasaki sapphire rookies. The Heritage set's remaining card numbers.

None are pre-filled here. Titles, grades and set year come from you; an invented checklist entry is a card you will hunt for that does not exist.

Exit check

Fixture settings, **invented for the test and not real fee figures**: fee rate 0.15, fixed fee 0.40, resale postage 1.00, tax rate 0.0925, flip margin 0.20, shipping 5.00.

- A `flip` item with a $100 comp has `max_all_in = 63.60` and a target listing price of `53.64`.
- A `pc` item with a $180 comp has `max_all_in = 180.00` and a target listing price of `160.18`. No seller fee appears anywhere in its figures.
- A `max_price` of $150 on the same `pc` item overrides the formula and the target becomes 150.00.
- An item whose latest comp is 31 days old reports its target as stale, and still shows it.
- Entering three comps of $170, $180 and $400 through the skill as a batch previews first, and the derived comp is $180, not $250.
- An item with no comps shows no target rather than zero.
- Marking an item `bought` with a `bought_card_id` removes it from `buying_targets`.
- A set group shows owned out of total.

Decisions to record in DECISIONS.md

- Seller fees apply only to cards bought to resell. A card bought to keep costs price, shipping and tax.
- Targets compare against all-in cost, never listing price alone.
- Comps are observations with dates, not a single overwritten value.
- Derived comps use the median.
- Fees are modelled as rate plus fixed fee, fitted to real sales, never a flat percentage.
- The daily digest waits for live listings. A digest with nothing new is noise.

Not in this phase

Scanning eBay, the daily digest, Card Ladder integration, reconnecting the older PSA and eBay sales project, bidding or sniping of any kind, and the logo and display artwork.

Parked for feasibility — decide before Phase 14

**eBay scanning.** The legitimate route is eBay's Browse API, which needs a developer account and application keys, and searches by query rather than by your saved searches — as far as I know, saved searches are not exposed to the API, so the scanner would query from `buying_list` fields and `search_url` stays a convenience link. Runs as a Supabase Edge Function, since OAuth token handling is far easier in TypeScript than PL/pgSQL, triggered by the Phase 10 `pg_cron` pattern.

**Card Ladder.** As far as I know it has no public API. Scraping it would likely breach its terms. Manual comps with a source column is the honest version until that changes; verify before building anything.

**Old PSA/eBay sales project.** Find it first. Its data model decides whether it feeds `comps` directly or needs reshaping, and that cannot be specified blind.

**Auction sniper.** The risk here is not technical. Programmatic bidding through eBay's API is, as far as I know, restricted to approved partners, and automating bids any other way — scripted browser sessions against your login — risks the account under eBay's rules on automated access. The account at risk is `jho_sportscards`, which is also your selling account. A suspension would take the business with it. Third-party sniping services exist that operate within eBay's rules; evaluate one before writing any bidding code.
