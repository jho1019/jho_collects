// Sealed product inventory (schema/028_sealed_products.sql). Types and pure
// helpers only; no database access. One row per physical unit: "bought 4 of
// this blaster" is four rows sharing a lot_id. See docs/sealed-products.md.

export type SealedProductStatus = "held" | "listed" | "sold" | "opened";
export type SealedProductType =
  | "hobby"
  | "blaster"
  | "mega"
  | "pack"
  | "case"
  | "hanger"
  | "other";
export type SealedProductCategory = "business" | "pc";
export type SealedProductIntent = "hold" | "sell";

export const SEALED_PRODUCT_TYPES: readonly SealedProductType[] = [
  "hobby", "blaster", "mega", "pack", "case", "hanger", "other",
];

type Money = string | number;

/** A sealed_products row. Money columns arrive as numeric strings from PostgREST. */
export type SealedProduct = {
  id: number;
  user_id: string;
  lot_id: string | null;
  sku: string | null;
  product_name: string;
  year: string | null;
  manufacturer: string | null;
  sport: string | null;
  product_type: SealedProductType;
  category: SealedProductCategory;
  intent: SealedProductIntent | null;
  status: SealedProductStatus;
  acquisition_cost: Money | null;
  acquired_on: string | null;
  acquisition_transaction_id: number | null;
  est_value: Money | null;
  est_value_source: string | null;
  est_valued_on: string | null;
  location: string | null;
  notes: string | null;
  list_channel: string | null;
  list_price: Money | null;
  listed_on: string | null;
  sale_transaction_id: number | null;
  exited_on: string | null;
  opened_on: string | null;
  created_at: string;
  updated_at: string;
  /** Generated. Never write. */
  search_text: string;
};

// Sum in integer cents: money is numeric(10,2), never float arithmetic.
const cents = (v: Money) => Math.round(Number(v) * 100);

/** Held or listed: still physically on hand and sealed. */
export const isOnHand = (u: Pick<SealedProduct, "status">) =>
  u.status === "held" || u.status === "listed";

export type SealedTotals = {
  units_on_hand: number;
  units_held: number;
  units_listed: number;
  units_without_cost: number;
  units_without_price: number;
  known_cost_basis: number;
  /** Sum of the estimates that exist. null when no unit has one — never a stand-in 0. */
  estimated_value: number | null;
};

/**
 * Client-side mirror of the sealed_inventory view: on-hand business units
 * (held / listed, not pc). A missing cost or estimate is counted as missing,
 * not added as $0.
 */
export function sealedTotals(
  units: Pick<SealedProduct, "status" | "category" | "acquisition_cost" | "est_value">[],
): SealedTotals {
  const scope = units.filter((u) => u.category !== "pc" && isOnHand(u));
  let held = 0;
  let noCost = 0;
  let noPrice = 0;
  let cost = 0;
  let value: number | null = null;
  for (const u of scope) {
    if (u.status === "held") held++;
    if (u.acquisition_cost == null) noCost++;
    else cost += cents(u.acquisition_cost);
    if (u.est_value == null) noPrice++;
    else value = (value ?? 0) + cents(u.est_value);
  }
  return {
    units_on_hand: scope.length,
    units_held: held,
    units_listed: scope.length - held,
    units_without_cost: noCost,
    units_without_price: noPrice,
    known_cost_basis: cost / 100,
    estimated_value: value == null ? null : value / 100,
  };
}

export type SealedLot<U> = {
  /** null = a standalone unit (one group per unit). */
  lot_id: string | null;
  units: U[];
  on_hand: number;
};

/**
 * Groups units by lot_id, in first-seen order. Units with no lot_id are not
 * one lot: each is its own group.
 */
export function groupByLot<U extends Pick<SealedProduct, "lot_id" | "status">>(
  units: U[],
): SealedLot<U>[] {
  const groups: SealedLot<U>[] = [];
  const byLot = new Map<string, SealedLot<U>>();
  for (const u of units) {
    let g = u.lot_id == null ? undefined : byLot.get(u.lot_id);
    if (!g) {
      g = { lot_id: u.lot_id, units: [], on_hand: 0 };
      groups.push(g);
      if (u.lot_id != null) byLot.set(u.lot_id, g);
    }
    g.units.push(u);
    if (isOnHand(u)) g.on_hand++;
  }
  return groups;
}

/**
 * Splits a purchase total across `qty` units, in cents, so the unit costs add
 * back to exactly the total. The leftover cents go to the first units:
 * $100 for 3 → 33.34, 33.33, 33.33. Returns numeric(10,2) strings.
 */
export function splitUnitCost(total: Money, qty: number): string[] {
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`qty must be a whole number ≥ 1 (got ${qty})`);
  const t = cents(total);
  if (!Number.isFinite(t) || t < 0) throw new Error(`total must be ≥ 0 (got ${total})`);
  const base = Math.floor(t / qty);
  const extra = t - base * qty;
  return Array.from({ length: qty }, (_, i) => ((base + (i < extra ? 1 : 0)) / 100).toFixed(2));
}

export type SealedUnitInsert = Partial<
  Omit<SealedProduct, "id" | "user_id" | "created_at" | "updated_at" | "search_text">
> &
  Pick<SealedProduct, "product_name" | "product_type">;

/**
 * Rows to insert for "bought `qty` of this": one per unit, sharing one
 * lot_id when qty > 1, with the total cost split across them. A single unit
 * gets lot_id null unless one is given. A null total leaves every unit's
 * cost null (unknown), not $0.
 */
export function unitsForPurchase(
  base: Omit<SealedUnitInsert, "lot_id" | "acquisition_cost">,
  qty: number,
  totalCost: Money | null,
  lotId: string | null = qty > 1 ? crypto.randomUUID() : null,
): SealedUnitInsert[] {
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`qty must be a whole number ≥ 1 (got ${qty})`);
  const costs = totalCost == null ? null : splitUnitCost(totalCost, qty);
  return Array.from({ length: qty }, (_, i) => ({
    ...base,
    lot_id: lotId,
    acquisition_cost: costs ? costs[i] : null,
  }));
}
