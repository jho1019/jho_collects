// Inventory stats strip (spec 17.1 Q2 / 17.3 #3). The strip follows the
// active filters (status, text, ?cost=missing) so its numbers match the table.
// With no filter on it is the full set, read from the tracked_inventory view
// exactly as before.
//
// Filtered, the same view rule is applied client-side to the visible rows:
// business inventory only (category <> 'pc'), on hand = not sold / traded.
// The one exception is an explicit sold / traded status (or ?cost=missing,
// which is sold-only): those rows are never on hand, so the strip counts the
// rows themselves and the first tile is labelled with that status instead of
// showing a row of zeros next to a non-empty table.

export type StatsCard = {
  status: "held" | "listed" | "sold" | "traded";
  acquisition_cost: string | number | null;
  is_opening_stock: boolean;
  /** cards.category (025). Missing = treat as business. */
  category?: string | null;
};

export type InventoryStats = {
  /** First-tile label: "On hand", or "Sold" / "Traded" for an exited filter. */
  label: string;
  cards_on_hand: number;
  opening_stock_cards: number;
  acquired_since_start: number;
  cards_without_cost: number;
  known_cost_basis: number;
  opening_cost_basis: number;
  acquired_cost_basis: number;
};

export type StatusFilter = "all" | StatsCard["status"];

// Sum in integer cents: money is numeric(10,2), never float arithmetic.
const cents = (v: string | number) => Math.round(Number(v) * 100);

export function inventoryStats(
  rows: StatsCard[],
  status: StatusFilter,
  missingCost: boolean,
): InventoryStats {
  const exited: "sold" | "traded" | null =
    status === "sold" || status === "traded" ? status : missingCost ? "sold" : null;

  const scope = rows.filter(
    (c) =>
      (c.category ?? "business") !== "pc" &&
      (exited ? c.status === exited : c.status !== "sold" && c.status !== "traded"),
  );

  let opening = 0;
  let without = 0;
  let known = 0;
  let openingBasis = 0;
  let acquiredBasis = 0;
  for (const c of scope) {
    if (c.is_opening_stock) opening++;
    if (c.acquisition_cost == null) {
      without++;
      continue;
    }
    const v = cents(c.acquisition_cost);
    known += v;
    if (c.is_opening_stock) openingBasis += v;
    else acquiredBasis += v;
  }

  return {
    label: exited === "sold" ? "Sold" : exited === "traded" ? "Traded" : "On hand",
    cards_on_hand: scope.length,
    opening_stock_cards: opening,
    acquired_since_start: scope.length - opening,
    cards_without_cost: without,
    known_cost_basis: known / 100,
    opening_cost_basis: openingBasis / 100,
    acquired_cost_basis: acquiredBasis / 100,
  };
}

/**
 * Strip for the dashboard board's ?group= / ?price=missing views (spec 18).
 * Those rows are already narrowed server-side to on-hand cards with the
 * board's group predicate, PC included, so the strip counts exactly the rows
 * shown. inventoryStats would drop PC (tracked_inventory excludes it) and put
 * a row of zeros next to a full ?group=pc table.
 */
export function shownStats(rows: StatsCard[]): InventoryStats {
  let opening = 0;
  let without = 0;
  let openingBasis = 0;
  let acquiredBasis = 0;
  for (const c of rows) {
    if (c.is_opening_stock) opening++;
    if (c.acquisition_cost == null) {
      without++;
      continue;
    }
    if (c.is_opening_stock) openingBasis += cents(c.acquisition_cost);
    else acquiredBasis += cents(c.acquisition_cost);
  }
  return {
    label: "On hand",
    cards_on_hand: rows.length,
    opening_stock_cards: opening,
    acquired_since_start: rows.length - opening,
    cards_without_cost: without,
    known_cost_basis: (openingBasis + acquiredBasis) / 100,
    opening_cost_basis: openingBasis / 100,
    acquired_cost_basis: acquiredBasis / 100,
  };
}

/** True when any strip-affecting filter is on. */
export function isFiltered(status: StatusFilter, q: string, missingCost: boolean) {
  return status !== "all" || q.trim() !== "" || missingCost;
}
