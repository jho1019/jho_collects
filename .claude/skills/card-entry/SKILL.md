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
proceed and flag — see Step 4. **Exception: purchases and expenses check their
required fields up front — see Step 3.**

## Step 2 — Resolve the card

Only for intents that reference a specific card. Call `find_cards(<phrase>)`.

1. **`match_type = 'alias'`** — exactly one card, guaranteed by a unique index.
   Do **not** ask which. Proceed.
2. **One fuzzy match** — proceed, but name what you matched in your reply so a
   wrong match is caught on the spot.
3. **Several fuzzy matches** — list them and ask. Quote only the fields that
   actually differ between them (year, set, parallel, grade, acquisition cost,
   acquired date). Listing identical fields is noise. Never pick the top score
   silently.
4. **No match** — do not block. Record the cash as a plain `transactions` row
   with `needs_review = true` and say the card wasn't found. A sale at a card
   show is real whether or not it was catalogued.

After resolving via case 3, **offer to save the phrase they used** as a
nickname (`name_card`). This is how the vocabulary grows — every
disambiguation should make the next one unnecessary.

## Step 3 — Confirm, but only when it's worth a turn

Confirmation costs a round trip. The user is often standing in a convention
hall on a phone — so outside purchases and expenses, keep it to the cases
below.

### Purchases and expenses — always preview and confirm

**Required fields must be in the prompt.** This is the deliberate exception to
the "insert anyway with `needs_review`" rule in Step 1: for a purchase or
expense, a missing *required* field blocks entry.

| intent | required in the prompt | defaulted, not required |
|---|---|---|
| purchase | amount paid, quantity | `occurred_on` = today, `platform` = `card_show` |
| expense | amount, category | `occurred_on` = today, `platform` = `na` |

Take quantity as 1 only when a single card is unmistakably meant ("picked up a
Wemby rookie for $40"); "bought some cards for $10" is missing quantity.
Expense categories: `supplies`, `postage_shipping`, `subscriptions`, `fees`,
`mileage`, `equipment`, `other`.

- **All required fields present** → run the CLI with `--dry-run`, show the
  parsed row, and offer the three actions below.
- **A required field is missing** → do not dry-run and do not write. Name the
  missing field(s), ask the user to supply them or restate the transaction,
  then re-check the answer and continue.

Once the required fields are in hand, run the CLI command with `--dry-run` to
parse it, then show the user exactly what will be written, as a table:

| field | value |
|---|---|
| type | purchase |
| platform | card_show |
| qty | 15 |
| item_amount | 10.00 |
| occurred_on | 2026-09-06 |
| description | 15-card bulk lot, card show |
| needs_review | false |

Include any cost field that is non-zero (`shipping_cost`, `other_cost`); omit
the zero ones. The `--dry-run` output ends with `net cash position: <now> ->
<if written>` — quote that pair as-is; do not compute a projected position
yourself. Then ask with `AskUserQuestion`, offering these actions:

1. **Confirm & write** — re-run the exact same command without `--dry-run`,
   then report per Step 5.
2. **Add more fields** — propose the optional fields that would sharpen the row
   and are currently defaulted or blank: `occurred_on` (if it fell back to
   today), `description`, `platform` (if it defaulted to `card_show`),
   `shipping_cost` (postage paid to *receive* the cards), a `needs_review`
   note. Collect the user's values, re-preview the updated row, ask again.
3. **Re-enter** — the parse is wrong. The free-text box on the question is
   where the user retypes the transaction; parse that from scratch and preview
   again.

### Confirm before writing when (sales and card objects)
- The card was chosen from several fuzzy matches
- The action closes a card (`sell_card`) and the match came from fuzzy, not alias
- An amount looks wrong by an order of magnitude versus that card's
  acquisition cost
- It's a correction to an existing row

### Write immediately, no confirmation, when
- An alias hit on a sale — the match is unambiguous by construction
- Adding opening stock

State what you wrote afterwards either way. That is the safety net for
un-confirmed writes, and it's cheaper than a question.

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

- Missing optional fields → write anyway with `needs_review = true`. Never
  interrogate for a field that can be cleaned up later in batch.
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

**"sold my psa 10 michael jordan for $70"** — one alias match on "psa 10
michael jordan". `sell_card(card_id, 70, 'card_show')`. No confirmation
needed; report what was written.

**"sold the jordan for $70"** — two fuzzy matches, a 1986 Fleer PSA 10 bought
for $220 and a 1988 Fleer PSA 9 bought for $40. Show both with year, set,
grade and cost. Ask. After they pick, write, then offer to save "the jordan"
as a nickname for that card.

**"bought 15 cards for $10"** — purchase row, platform `card_show`, qty 15,
`item_amount` 10. No card rows: this is a bulk lot and per-card entry is
exactly what the design avoids. Both required fields (amount, quantity) are
present, so run `--dry-run`, show the parsed row as a table, and ask
(Confirm & write / Add more fields / Re-enter) before writing.

**"bought some cards at the show"** — a purchase missing amount and quantity.
Don't dry-run and don't write. Reply that you need the amount paid and how
many cards, and wait for the answer.

**"sold a jordan for $700"** — matched card cost $40. The amount is plausible
but off by an order of magnitude versus cost. Confirm before writing.
