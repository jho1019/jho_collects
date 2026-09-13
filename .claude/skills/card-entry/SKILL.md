---
name: card-entry
description: Record sports card purchases, sales, trades, expenses and nicknames in the Supabase ledger from natural language. Use whenever the user describes buying, selling, trading, or spending money on cards ("sold my psa 10 jordan for $70", "bought 15 cards for $10 at the show", "traded the allen and the nacua plus 95 for an ohtani", "swapped him two rookies for a slab", "bought some dollar bin stuff and sold him the daniels", "picked up a Wemby rookie", "call that one the jordan"), or asks about their collection, cash position, deals at a show, or what they're holding. Also use for corrections to previously entered rows.
---

# Card ledger entry

Turn what the user said into the right database writes. Read
`docs/DECISIONS.md` before changing any table.

There is no `purchases` table. Purchases, sales, refunds and expenses are all
rows in `transactions`, distinguished by `type`.

## Step 1 — Classify the intent

**First, is this a purchase or a sale?** That split decides everything
downstream — the CLI subcommand, whether card resolution (Step 2) runs, and
whether the confirmation flow in Step 3 applies. Money going *out* to acquire
cards or supplies is a purchase or expense; money coming *in* from a buyer is a
sale. Refunds and corrections attach to whichever side they adjust.

| They said | Intent | Writes to |
|---|---|---|
| "sold my psa 10 jordan for $70" | sale of a named card | `sell_card()` → `transactions` + `cards` + `card_aliases` |
| "sold a card for $15 on eBay" | sale, card not identified | `transactions` only |
| "bought 15 cards for $10 at the show" | bulk purchase | `transactions` only — **no card rows** |
| "picked up a Wemby rookie for $40" | purchase worth tracking | `transactions` + `cards` |
| "I already own a 1986 Fleer Jordan PSA 8" | opening stock | `add_opening_stock()` — **no transaction** |
| "traded the allen and the nacua plus $95 for an ohtani" | deal — cards both ways | `record_trade()` → `deals` + `transactions` + `cards` |
| "bought dollar bin stuff and sold him the daniels" | deal — two legs, one vendor | `open_deal()` + `sell_card(…, p_deal_id)` + `record_trade()` |
| "call that one the jordan" | naming | `name_card()` |
| "bought two cards for my PC" | purchase for the personal collection | `transactions`, description prefixed `[PC]` |
| "bought $30 of toploaders" | expense | `transactions`, type `expense` |
| "how much am I up?" / "what am I holding?" | query | read-only |
| "that jordan sale was $75 not $70" | correction | `update` the existing row |

If genuinely ambiguous between two intents, ask. If merely missing a detail,
proceed and flag — see Step 4. **Exception: every purchase, sale and expense
checks its required fields up front and previews before writing — see Step 3.**

## Step 2 — Resolve the card

Only for intents that reference a specific card. Call `find_cards(<phrase>)`.

1. **`match_type = 'alias'`** — exactly one card, guaranteed by a unique index.
   Do **not** ask which. Go to the Step 3 preview — an alias hit still previews
   now, it just skips the "which card?" question.
2. **One fuzzy match** — go to the Step 3 preview, and name what you matched in
   the preview so a wrong match is caught on the spot.
3. **Several fuzzy matches** — list them and ask which *before* previewing.
   Quote only the fields that actually differ between them (year, set,
   parallel, grade, acquisition cost, acquired date). Listing identical fields
   is noise. Never pick the top score silently.
4. **No match** — do not block. Fall through to a plain CLI `sale` row with
   `needs_review = true` (the Step 3 preview still applies) and say the card
   wasn't found. A sale at a card show is real whether or not it was
   catalogued.

After resolving via case 3, **offer to save the phrase they used** as a
nickname (`name_card`). This is how the vocabulary grows — every
disambiguation should make the next one unnecessary.

## Step 2.5 — Deals (trades and multi-leg show events)

Skip this unless the utterance is a deal. If it is, this section replaces
Step 3 — the confirmation rules here are the ones that apply.

**Trigger:** any utterance describing both *giving* and *getting*, or two legs
with one counterparty. "Traded X for Y" is the obvious case. "Bought some
dollar bin stuff and sold him the Daniels" is the same event — one vendor, two
legs — and must not file as two unrelated rows.

A deal is **one counterparty**. Several legs with the same vendor are one deal;
a different vendor is a different deal.

### One transaction row per cash movement

Not one per deal, and not one per card. `record_trade()` writes **one**
transaction for the cash leg only — `purchase` if cash went out, `sale` if it
came in. Never a negative purchase. The cards that moved are not a transaction
at all: they are card rows linked by `disposed_deal_id` and `acquired_deal_id`.

Never net a deal down to a single row. Receipts and purchases land on different
Schedule C lines and carry opposite `net_cash` signs. `deal_summary` reports
the per-deal net as a query result, which is where that number belongs.

### Basis carries over at cost, never at market

The received card's basis is the cash paid plus the **cost basis** of the cards
given up — not their comp value. Cards given up at a $100 comp that cost $30
carry $30. Comps go in `est_value` and never touch `acquisition_cost`.
`record_trade()` does this arithmetic — do not pre-compute it and pass a total.

### Required — do not write without these

1. **Cash direction.** `purchase` versus `sale`. Cannot be inferred: "gave him
   $95" and "he gave me $95" differ only in this. **Never default it.**
   Ambiguous phrasing ("we settled up $95") earns a round trip.
2. **Cash amount**, if there is a cash leg. Unrecoverable later. If missing,
   write the deal and the card legs, skip the transaction row, and let the deal
   carry `needs_review` — do not insert a placeholder amount.
3. **Identity of each outgoing card, resolved to exactly one row** via the
   Step 2 ladder. Irreversible: the wrong card marked `traded` leaves inventory
   and corrupts the basis carried forward.
4. **A title string for each incoming card.** Free text — "ohtani bowman rookie
   pitching psa 9" is enough. Every structured field can be backfilled later;
   an uncaptured card cannot be reconstructed.

**Never ask for:** date (default today; parse only if stated), counterparty,
event name, comp or sticker value, grade, set, parallel, or per-card
allocation.

### Confirmation splits by direction

- **Disposals get exactly one confirmation.** List the outgoing cards by the
  fields that identify them and wait for a yes. This is the irreversible half.
- **Acquisitions write straight through.** They are additive and trivially
  corrected.

A typical trade should cost **one** round trip, not three. This is happening
standing at someone's table.

### Unresolvable outgoing cards are the common case

`cards` is nearly empty, so most cards named at a table will not resolve. The
fallback must be the first thing that works: create the row from the title
alone with `add_opening_stock(title, null)`, then pass that id straight to
`record_trade()` as outgoing. That records the inventory movement honestly and
leaves the basis gap visible — the deal comes back flagged, and the received
card's `acquisition_cost` stays null rather than claiming a cost of zero.

### Calling it

```sql
select record_trade(
  p_out_card_ids   => array[<card ids>],   -- become status 'traded'
  p_in_titles      => array['<title>'],
  p_in_est_values  => array[<comp>],       -- optional; never a cost
  p_cash_amount    => 95.00,
  p_cash_direction => 'paid',              -- or 'received'. NEVER guessed.
  p_occurred_on    => date '2026-09-09',
  p_event_name     => '<show or vendor>'
);
```

For a sale that is part of a deal, pass the deal through
`sell_card(..., p_deal_id => <id>)` so the cash row and the card both attach.
`open_deal()` starts an empty deal; `attach_transaction(deal_id, txn_id)`
retro-fits grouping onto a row that already exists.

Read a deal back with `deal_summary` — one row per deal, with the net and a
derived kind. Never store that net.

## Step 3 — Preview and confirm every cash entry

A purchase, sale or expense is never written straight through: check its
required fields, show exactly what will be written, and let the user confirm,
extend, or retry.

### Required fields must be in the prompt

The deliberate exception to the "insert anyway with `needs_review`" rule in
Step 1 — for a purchase, sale or expense, a missing *required* field blocks
entry.

| intent | required in the prompt | defaulted, not required |
|---|---|---|
| purchase | amount paid, quantity | `occurred_on` = today, `platform` = `card_show` |
| sale | amount, platform | `occurred_on` = today, quantity = 1 |
| expense | amount, category | `occurred_on` = today, `platform` = `na` |

- **Quantity** (purchase) is 1 only when a single card is unmistakably meant
  ("picked up a Wemby rookie for $40"); "bought some cards for $10" is missing
  it.
- **Platform** (sale) is `ebay`, `collx`, `card_show`, `local`, `lcs`,
  `online` or `other`. It drives fees, so a sale with no stated venue is
  missing it — ask, don't default.
- **Category** (expense) is `supplies`, `postage_shipping`, `subscriptions`,
  `fees`, `mileage`, `equipment` or `other`. A named item resolves it
  ("toploaders" → `supplies`, "eBay Store plan" → `subscriptions`); a vague
  spend ("$30 on business stuff") does not — ask.

**A required field is missing** → do not preview and do not write. Name the
missing field(s), ask the user to supply them or restate the transaction, then
re-check and continue.

**All required fields present** → build the preview, then offer the three
actions.

### Build the preview

**Cash rows through the CLI** — purchase, expense, and a sale of an
unidentified or unmatched card. Run the CLI command with `--dry-run` and show
the parsed row as a table:

| field | value |
|---|---|
| type | purchase |
| platform | card_show |
| qty | 15 |
| item_amount | 10.00 |
| occurred_on | 2026-09-06 |
| description | 15-card bulk lot, card show |
| needs_review | false |

Include any cost field that is non-zero (`shipping_cost`, `other_cost`,
`shipping_charged`, `sales_tax_collected`, `platform_fees`); omit the zero
ones. The `--dry-run` output ends with `net cash position: <now> -> <if
written>` — quote that pair as-is; never compute a projected position yourself.

**A named card through `sell_card()`** — there is no `--dry-run` for the RPC,
so assemble the preview from the `find_cards` result:

| field | value |
|---|---|
| card | 2022-23 Panini Mosaic #92 Stephen Curry Reactive Blue (raw) |
| match | alias "reactive blue curry" — or: fuzzy, score 0.71 |
| sale price | 45.00 |
| platform | ebay |
| on confirm | closes card #128, retires nicknames "reactive blue curry", "the curry" |

For an eBay sale, note that the final value fee is not set here — it arrives
with the transaction-report import. Never invent it.

### Offer three actions

Ask with `AskUserQuestion`:

1. **Confirm & write** — for a CLI row, re-run the exact command without
   `--dry-run`. For a named card, call `sell_card(card_id, amount, platform)`.
   Then report per Step 5.
2. **Add more fields** — propose the optional fields that would sharpen the row
   and are currently defaulted or blank: `occurred_on`, `description`,
   `platform` (purchase, if it defaulted), `shipping_cost` (postage/label you
   paid), `shipping_charged` / `sales_tax_collected` (sale — what the buyer was
   charged), a `needs_review` note. Collect values, re-preview, ask again.
3. **Re-enter** — the parse is wrong. The free-text box on the question is
   where the user retypes the transaction; parse from scratch and preview
   again.

### Still stop and ask, regardless

- Several fuzzy card matches — list them and ask which *before* previewing
  (Step 2, case 3).
- A sale amount off by an order of magnitude from the card's acquisition cost
  — call it out in the preview and wait for an explicit yes.
- A correction to an existing row — confirm the before/after values first.

### Write immediately, no preview

- Adding opening stock (`add_opening_stock`) — no transaction, no cash moved.
- Naming a card (`name_card`).

State what you wrote afterwards either way. That is the safety net for the
write, and cheaper than another question.

## Step 4 — Write

**Write path.** Plain cash rows (purchase, sale of an unidentified card,
refund, expense) go through the CLI, which mirrors the CHECK constraints and
returns readable errors:

```
python scripts/entry.py purchase --amount 10 --qty 15 [--date today] [--description "..."]
python scripts/entry.py sale     --amount 45 --platform collx [--description "..."]
python scripts/entry.py expense  --amount 30 --category supplies
python scripts/entry.py review        # list rows flagged needs_review
```

Add `--dry-run` to see the parsed row without writing. Resolve relative dates
("last Saturday") to `YYYY-MM-DD` yourself; the CLI takes `today`, `yesterday`,
`N days ago`, `YYYY-MM-DD`, `M/D`. Card-object intents (`sell_card`,
`add_opening_stock`, `name_card`) are RPC calls, not the CLI.

- Missing *optional* fields → write with `needs_review = true`, or surface them
  through "Add more fields" in the Step 3 preview. Never interrogate for one
  that can be cleaned up later in batch. *Required* fields are the exception —
  Step 3 blocks on those.
- Use `sell_card()` for card sales. It writes the transaction, closes the card
  and retires its nicknames atomically. Never do those as separate calls.
- Purchases carry no `shipping_charged` or `sales_tax_collected` — a CHECK
  constraint enforces it. Money paid to *receive* cards goes in
  `shipping_cost`.
- **"For my PC" means the personal collection — prefix the description with
  `[PC]`.** A card kept rather than resold is still an ordinary `purchase` row
  on whatever platform it was bought. Do **not** ask how to handle it; this is
  a standing instruction, and asking re-opens a settled decision. The marker is
  text only: the row still counts in `tax_summary.purchases` and therefore in
  COGS, so it is **not** excluded from Schedule C by the marker alone. Mention
  that only if the user asks about tax accuracy for these rows.
- Never invent eBay fees. They arrive via the transaction report import. A
  card-show sale genuinely has no fees; leave them zero.
- Never write to `net_cash`, `buyer_paid_total` or `running_total`. Generated.
- Never `UPDATE` or `DELETE` without a `WHERE` clause.

## Step 5 — Report back

One line. Amount, what it was matched to, and the new cash position if it
moved. Mention `needs_review` only when you set it.

> Recorded: sold **1986 Fleer #57 Michael Jordan PSA 10** for $70.00 at a card
> show. Net cash position is now $312.40.

## Worked examples

**"bought 15 cards for $10"** — purchase, platform `card_show`, qty 15,
`item_amount` 10. No card rows: this is a bulk lot and per-card entry is
exactly what the design avoids. Both required fields (amount, quantity) are
present → `--dry-run`, show the table, ask (Confirm & write / Add more fields /
Re-enter) before writing.

**"bought some cards at the show"** — a purchase missing amount and quantity.
Don't dry-run and don't write. Ask for the amount paid and how many cards, and
wait.

**"sold my psa 10 michael jordan for $70"** — one alias match on "psa 10
michael jordan", so no "which card?" question. But `platform` is required and
wasn't given — stop and ask where it sold. Told "ebay": preview the card, $70,
`ebay`, and that confirming closes the card and retires "psa 10 michael
jordan"; on **Confirm & write**, `sell_card(card_id, 70, 'ebay')`.

**"sold the jordan for $70 on collx"** — amount and platform present. Two fuzzy
matches: a 1986 Fleer PSA 10 acquired for $220 and a 1988 Fleer PSA 9 acquired
for $40. Show both with year, set, grade and cost; ask which. After they pick,
preview (card, $70, `collx`), then the three actions; on confirm
`sell_card(...)`. Then offer to save "the jordan" as a nickname.

**"sold a card for $15 on ebay"** — a sale with no card named. Amount and
platform present, so don't block. `sale --amount 15 --platform ebay
--dry-run`, show the table, offer the three actions.

**"sold a jordan for $700"** — matched card acquired for $40. Amount is
plausible but off by an order of magnitude — call it out in the preview and
wait for an explicit yes, not merely a click of one of the three actions.

**"bought $30 of toploaders"** — expense. Amount $30; "toploaders" resolves the
category to `supplies`. Both required fields satisfied →
`expense --amount 30 --category supplies --dry-run`, preview, three actions.

**"spent $30 on business stuff"** — expense missing a usable category. Don't
preview; ask what the $30 was for.
