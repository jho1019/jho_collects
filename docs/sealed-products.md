# Sealed products

Hobby boxes, blasters, megas, packs, hangers and cases. Schema in
`schema/028_sealed_products.sql`; types and pure helpers in
`web/lib/sealedProducts.ts`. Not applied to the live database yet.

New sealed stock goes in `sealed_products`, never in `cards`. `cards.category`
still has a `sealed` value from 025 ("resale stock tracked as its own line").
Nothing writes it now. It is left alone in this migration; whether to drop it
is an open question.

## One row per unit

Each row is one physical box or pack. There is no `qty` column.

- Status belongs to one box. Of four blasters, one can be held, one listed,
  one sold and one opened at the same time. A qty row would have to split, or
  end up half sold and half opened.
- Each unit has one `acquisition_cost` and one `sale_transaction_id`, the same
  as a card. Profit works the same way. There is no average cost to keep and
  no way to sell more than you have.
- Volume is small: boxes and packs, not thousands of raw cards.

"Bought 4 of this blaster for $110" is four rows that share a `lot_id`, each
costing $27.50. The writer supplies the `lot_id` (a uuid) and splits the cost.
`unitsForPurchase()` does both and puts any leftover cents on the first units
($100 for 3 is 33.34, 33.33, 33.33), so the units add back to the total.

There is no events table. A sale is an ordinary `transactions` row. Opening a
box is a status change on the unit.

## Columns

| Column | Meaning |
|---|---|
| `id`, `user_id` | Identity key; owner (defaults to `auth.uid()`). |
| `lot_id` | Same value on units bought together. Null = a standalone unit. |
| `sku` | eBay Custom label. Unique per owner when set. |
| `product_name` | As spoken: "2025 Prizm Basketball Hobby". Becomes the sale row's description. |
| `year`, `manufacturer`, `sport` | Free text. Used to tell two boxes apart. |
| `product_type` | `hobby`, `blaster`, `mega`, `pack`, `case`, `hanger`, `other`. |
| `category` | `business` (default) or `pc`. Its own check, not `card_category`, because that enum's `sealed` and `riftbound` mean nothing here. |
| `intent` | `hold` or `sell` for a business unit; null = undecided. Always null for `pc`. |
| `status` | `held`, `listed`, `sold`, `opened`. `sold` and `opened` are final. |
| `acquisition_cost`, `acquired_on` | What this one unit cost, and when. Null cost = unknown. |
| `acquisition_transaction_id` | The purchase row, if recorded. Units of a lot may share it. |
| `est_value`, `est_value_source`, `est_valued_on` | Market estimate for the dashboard. Never a cost, never COGS. Same as `cards.est_value`. |
| `location`, `notes` | Free text. |
| `list_channel`, `list_price`, `listed_on` | Where and for how much it is up. Never income. |
| `sale_transaction_id`, `exited_on` | The sale row and its date. Units sold together share one sale row. |
| `opened_on` | The day it was opened. Required when `status = 'opened'`. |
| `created_at`, `updated_at` | `updated_at` is kept by trigger `sealed_products_set_updated_at`. |
| `search_text` | Generated from name, year, manufacturer, sport, type. Trigram indexed. Never write. |

Constraints: `sold_products_have_a_sale`, `opened_products_have_opened_on`,
`sealed_products_intent_null_for_pc`, non-negative money, and
`unique (id, user_id)` so a later link table can point at a unit with a
composite FK (as `bulk_lot_events` does).

## Functions

All `SECURITY INVOKER`, pinned `search_path`, scoped to `auth.uid()`.
EXECUTE goes to `authenticated` only.

- `sell_sealed_product(p_id, p_item_amount, p_platform, …, p_deal_id)` —
  mirrors `sell_card()`. Locks the unit, rejects it if it is missing, sold or
  opened, writes one sale row (`qty = 1`, description = `product_name`), and
  marks the unit sold. One transaction.
- `sell_sealed_lot(p_lot_id, p_qty, p_item_amount, p_platform, …)` — "sold 2
  of the 4 blasters for $60". Locks held or listed units of that lot, lowest
  id first, and takes `p_qty`. Fewer on hand is an error. Writes ONE sale row
  with `qty = p_qty`, and every sold unit points at it, so that sale's cost is
  the sum of their `acquisition_cost`. `p_lot_id` must be set and `p_qty ≥ 1`.
  The description is the product name. If the units' names differ, it is the
  first name plus "+ N other".
- `open_sealed_product(p_id, p_opened_on, p_notes)` — see below.
- `find_sealed_products(q)` — held and listed units, ranked like `find_cards`
  (similarity or word similarity ≥ 0.5). Returns year, manufacturer, type,
  cost, acquired date, lot and status so two boxes can be told apart. Limit 10.

## Opening a box

`open_sealed_product()` sets `status = 'opened'` and `opened_on`, and appends
`p_notes` to `notes`. It writes no `transactions` row: opening moves no cash.
`acquisition_cost` stays on the unit. It creates and changes no `cards` row.
Spreading the box's cost onto the cards pulled from it is deferred; this
migration only records the opening.

## PC guard

Same rule as cards (027). Trigger `sealed_products_pc_guard` rejects
`category = 'pc'` with status `listed` or `sold`, SQLSTATE `23514`, no
override. The hint says to change the category first. Opening a PC box is
allowed. Because the rule is in the database, `sell_sealed_product()` and
`sell_sealed_lot()` fail on a PC unit and their sale row rolls back with it.
`sell_sealed_lot()` does not skip PC units in a lot: a lot is one purchase,
so a PC unit in it is a mistake, and the whole sale fails.

## RLS

Policy `own_sealed_products`, `for all to authenticated`, owner only on both
`using` and `with check`. `anon` has no privileges on the table or on
`sealed_inventory`. `authenticated` has select, insert, update and delete, but
not TRUNCATE (RLS does not check it).

## Profit and dashboard: integration points, not wired

- **Sale profit.** A sealed sale is a normal sale row, so `net_cash` and every
  cash figure already include it. `sale_profit` (026, unapplied) and
  `web/lib/dashboard/profit.ts` subtract only `cards.acquisition_cost` linked
  by `sale_transaction_id`. They should also sum
  `sealed_products.acquisition_cost` linked the same way. Until then a sealed
  sale has no linked cost, shows as `missing_cost`, and its profit is
  overstated.
- **On-hand value.** View `sealed_inventory` (security invoker, own rows) is
  on-hand business stock: `status in ('held', 'listed')` and not pc. Columns:
  `units_on_hand`, `units_held`, `units_listed`, `units_without_cost`,
  `units_without_price`, `known_cost_basis`, `estimated_value`.
  `estimated_value` adds only the estimates that exist and is null when there
  are none. A missing estimate is not $0. `sealedTotals()` is the client-side
  mirror.
- **COGS.** `tracked_inventory` and the tax views are unchanged, the same
  deferral as bulk lots. Whether on-hand sealed cost counts toward ending
  inventory is Johnny's call.
- **Dashboard.** The Inventory board (in progress, separate work) should later
  include sealed value in Selling / PC. Daisy designs that.

## UI needed (not built)

- Add / edit form: product name, year, manufacturer, sport, product type, how
  many to add, unit or total cost, acquired date, category, intent, location,
  estimated value.
- A sealed list, or a Sealed tab on Inventory, grouped by lot.
- Sell (one unit, or N from a lot) and Open actions.
- Sealed totals on the dashboard.

## Apply order

028 goes after 027, which is applied in prod. 026 stays unapplied and
untouched. 028 is not applied; it waits for Johnny's go-ahead. See
`docs/schema-migrations.md`.
