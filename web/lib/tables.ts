// Metadata for the CSV import/export page. `generated` columns are dropped on
// import (Postgres re-derives them); `conflictTarget` is what an import
// dedupes / upserts on. Mirrors scripts/restore.py.

export type TableName =
  | "transactions"
  | "buyers"
  | "cards"
  | "inventory_counts";

export const TABLES: Record<
  TableName,
  { columns: string[]; generated: string[]; conflictTarget: string }
> = {
  transactions: {
    columns: [
      "id", "user_id", "occurred_on", "type", "platform", "description", "qty",
      "item_amount", "shipping_charged", "sales_tax_collected", "platform_fees",
      "shipping_cost", "other_cost", "expense_category", "needs_review", "notes",
      "created_at", "buyer_paid_total", "net_cash", "source_ref", "order_ref",
      "sales_record_number", "item_number", "buyer_id", "ship_to_name",
      "ship_to_city", "ship_to_state", "ship_to_zip", "ship_to_country",
      "shipping_service", "tracking_number", "promoted_listing", "fees_estimated",
    ],
    generated: ["buyer_paid_total", "net_cash"],
    conflictTarget: "id",
  },
  buyers: {
    columns: [
      "id", "user_id", "platform", "platform_username", "display_name",
      "relay_email", "phone", "last_city", "last_state", "last_country",
      "first_seen_on", "last_seen_on", "notes", "created_at",
    ],
    generated: [],
    conflictTarget: "id",
  },
  cards: {
    columns: [
      "id", "user_id", "sku", "title", "player", "year", "set_name",
      "card_number", "parallel", "grader", "grade", "status",
      "acquisition_transaction_id", "acquisition_cost", "acquired_on",
      "sale_transaction_id", "sold_on", "notes", "created_at", "search_text",
      "is_opening_stock",
    ],
    generated: ["search_text"],
    conflictTarget: "id",
  },
  inventory_counts: {
    columns: [
      "user_id", "tax_year", "counted_on", "cards_on_hand", "cost_basis",
      "method", "notes",
    ],
    generated: [],
    conflictTarget: "user_id,tax_year",
  },
};

export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

// CSV cell -> value for a PostgREST insert. Empty -> null; True/False (either
// case) -> boolean; everything else passes through as a string and PostgREST
// casts it.
export function coerce(v: string): string | boolean | null {
  if (v === "") return null;
  if (v === "true" || v === "True") return true;
  if (v === "false" || v === "False") return false;
  return v;
}
