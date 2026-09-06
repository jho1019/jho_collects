# Card business ledger — project instructions

Personal P&L system for a sports card reselling business (eBay seller
`jho_sportscards`, also sells on CollX). Tracks cash flow, produces Schedule C
figures at year end, and shows a dashboard.

Read `docs/DECISIONS.md` before changing the data model. The choices there were
argued out and reversing one silently will produce numbers that look fine and
are wrong.

## Domain vocabulary

- **Ledger** — the single `transactions` table. Every purchase, sale, refund
  and expense is one typed row. There are no separate sales/purchases tables
  and there should not be.
- **Net cash** — what actually moved in or out. Generated column.
- **Buyer paid total** — what the buyer was charged, including shipping and
  sales tax. This is what a 1099-K reports. Generated column. Not income.
- **COGS** — beginning inventory + purchases − ending inventory. Requires the
  annual physical count in `inventory_counts`.
- **eSE** — eBay Standard Envelope, the cheap tracked mailer used for most
  cards under $20.

## Money rules that are easy to get wrong

1. **Sales tax is not income.** eBay collects and remits it; the seller never
   holds it. It is excluded from `net_cash` and included in `buyer_paid_total`.
2. **eBay charges its final value fee on the full buyer payment, sales tax
   included.** Verified at ~13.25% of `Total Price` on real data. So fees are
   paid on money never received. Do not compute fees off item price.
3. **The FVF fixed component varies** ($0.30 under ~$10, $0.40 above). Never
   hardcode it — always read the actual value from the transaction report.
4. **Payout, Charge, Transfer, Hold and Reserve rows are cash movement**
   between the eBay balance and the bank. They are neither income nor expense.
   Summing `Net amount` across all rows double-counts: a shipping label the
   balance couldn't cover appears as both a `Shipping label` (−5.72) and a
   `Charge` (+5.72).
5. **Money is `numeric(10,2)`, never float.**

## Natural-language entry

The owner types things like "bought 15 cards for $10 at the show today" or
"sold the Wembanyama for $45 on eBay". Parse into a ledger row and insert.

- Default `platform` to `card_show` for purchases, ask if ambiguous.
- Default date to today; accept "yesterday", "9/3", "last Saturday".
- If a required field is missing, **insert anyway with `needs_review = true`**
  rather than blocking with questions. Cleanup happens in batch.
- Purchases have no `shipping_charged` or `sales_tax_collected` — a CHECK
  constraint enforces this. Money paid to receive cards goes in
  `shipping_cost`.
- Never invent fee amounts. eBay fees come from the transaction report import.

### Selling a named card

"sold michael jordan psa 10 for $70" refers to a specific object, not just a
cash amount. The flow is:

1. `select * from find_cards('michael jordan psa 10')`.
2. **Exactly one match** — call `sell_card(...)`. Confirm what was matched in
   the reply so a wrong match is caught immediately.
3. **Several matches** — show them all and ask which. Quote the fields that
   distinguish them: year, set, parallel, grade, acquisition cost, acquired
   date. Never guess, and never pick the highest similarity score silently.
   **After they choose, offer to save what they said as a nickname**
   (`name_card`). This is the main way aliases accumulate — every
   disambiguation should make the next one unnecessary.
4. **No match** — still record the cash. Insert a plain sale row with
   `needs_review = true` and say the card was not found. Never block the entry;
   a sale at a card show is real whether or not it was catalogued.

`find_cards` returns `match_type`. **`'alias'` means do not ask which card** —
an active alias resolves to exactly one card by database constraint. Asking
anyway wastes the point of having named it. `'fuzzy'` means apply the rules
above.

Use `sell_card()` — it writes the transaction, closes the card, and retires its
nicknames atomically. Never do those as two separate calls.

### Nicknames

"call that one the jordan" → `name_card(card_id, 'the jordan')`.

Nicknames name a **card**, never a transaction. They are unique among unsold
cards, so `name_card` will refuse a name already in use and say which card
holds it. Selling a card frees its nicknames for reuse.

### Opening stock

Cards owned before Aug 1 2026 go in via `add_opening_stock()`. It writes **no
transaction** — that money predates the ledger and its cost lives in
`inventory_counts`. Never create a purchase row for them; it double-counts.

### Creating cards

Opt-in. Create a card row for anything worth finding by name later: graded
slabs, individually listed cards, anything expensive. Do **not** create rows
for bulk-lot commons — that lot stays a single cash row, which is the whole
point of the design.

`acquisition_cost` may be null (a card pulled from a bulk lot has no
meaningful individual cost). That is expected, not an error.

## Non-negotiables

- Never write to `net_cash`, `buyer_paid_total` or `running_total`. Generated.
- Never `INSERT` a row that has a `source_ref` without `ON CONFLICT DO NOTHING`.
- Never expose the Supabase service-role key to the browser, in any
  environment including local development.
- **Never issue an `UPDATE` or `DELETE` without a `WHERE` clause.** MCP access
  is unrestricted SQL against tax records on a tier with no backups.
- Prefer `SELECT` for exploration. Writes should go through the entry path so
  validation runs.
- Buyer PII (names, cities) is under RLS. Do not log it or write it to files
  committed to the repo.
