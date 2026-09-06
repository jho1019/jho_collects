---
name: card-entry
description: Record sports card purchases, sales, expenses and nicknames in the Supabase ledger from natural language. Use whenever the user describes buying, selling, or spending money on cards ("sold my psa 10 jordan for $70", "bought 15 cards for $10 at the show", "picked up a Wemby rookie", "call that one the jordan"), or asks about their collection, cash position, or what they're holding. Also use for corrections to previously entered rows.
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
| "call that one the jordan" | naming | `name_card()` |
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
