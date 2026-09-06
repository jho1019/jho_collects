# eBay report notes

Findings from real exports, September 2026.

## Which report to pull

**Seller Hub → Payments → Reports → Transaction report.** 90 days max per
pull; eBay emails when it is ready. This one file is sufficient — it carries
buyer username, buyer name, ship-to city/state/zip, item ID, transaction ID,
item title, quantity, subtotal, shipping, tax, itemised fees, label costs and
payout dates.

**Do not use the Orders report for money.** It has 82 columns and *no* fee
data. Its only "Fee" columns are regulatory pass-throughs (`Mattress Recycling
Fee`, `Tire Recycling Fee`, `Lumber Fee`) that are always empty here. Importing
it alone hides roughly 31% of revenue in costs.

Its one advantage: `Tracking Number`, `Shipping Service` and
`Sold Via Promoted Listings` are clean fields. In the transaction report,
tracking and service are embedded in the `Description` free text
(`Tracking no. ESUS355334367 eBay Standard Envelope`).

## File format quirks

- UTF-8 BOM on the first byte.
- A notes/disclaimer preamble. Find the header by locating the row whose first
  cell is `Transaction creation date` — do not assume a line number.
- Nulls are the literal string `--`, not empty.
- Dates are `Aug 31, 2026`. The export is Pacific time; a late-December sale
  can shift tax year if parsed as UTC.
- Footer rows (`6 record(s) downloaded`, `Seller ID : ...`) must be dropped.

## Row types

`Order`, `Refund`, `Shipping label` feed the ledger.
`Payout`, `Charge`, `Transfer`, `Hold`, `Reserve` are cash movement — ignore.

A `Charge` paired with a `Shipping label` of equal magnitude means the balance
could not cover the label and eBay billed the bank directly. They net to zero.
Summing `Net amount` naively double-counts.

## The month-boundary orphan label

**Confirmed real.** Order `07-15112-65577` (Stephen Curry) sold Aug 31; its
label was purchased Sep 1. In the August-only file the order appears with no
label cost. eBay's own listings report, spanning Aug 6 - Sep 5, shows the
$0.78 and a net of $1.73 rather than $2.51.

The loader must `UPDATE` an existing transaction by `order_ref` when a label
arrives with no matching order in the current file.

## Fee structure

Final value fee is charged on the **full buyer payment including sales tax** —
verified at ~13.25% of `Total Price` across all five August orders. Fees are
paid on money never received.

The fixed component was $0.30 on orders under about $10 and $0.40 above.
Read it from the report; do not hardcode.

## Verified August 2026 figures

| | |
|---|---|
| Item subtotal | $50.03 |
| Shipping charged | $8.84 |
| Order proceeds | $58.87 |
| eBay fees | -$10.18 |
| Shipping labels | -$8.06 |
| Net cash | $40.63 |

All-in cost was 31% of proceeds. The parser reproduces every figure and matches
eBay's own per-item net on four of five rows — the fifth being the
orphan-label case above.
