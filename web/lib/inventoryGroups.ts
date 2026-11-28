// The three on-hand inventory groups (spec 18). ONE definition, used by the
// dashboard Inventory board (lib/dashboard/inventoryBoard.ts) and by the
// /inventory ?group= / ?price=missing filters, so a segment and the page it
// links to always agree.
//
//   on hand  = status held | listed (sold / traded are excluded entirely)
//   PC       = category 'pc'
//   Holding  = category <> 'pc' AND intent = 'hold'
//   Selling  = category <> 'pc' AND intent is null or 'sell'
//
// intent is only ever 'hold' | 'sell' | null (schema/027 cards_intent_check);
// null means undecided and counts as Selling ("not hold intent"). Non-pc
// includes riftbound / sealed, the same `category <> 'pc'` rule as the
// tracked_inventory view. A missing category is business (cards.category
// defaults to 'business').

export type InventoryGroup = "selling" | "holding" | "pc";
export const INVENTORY_GROUPS: readonly InventoryGroup[] = ["selling", "holding", "pc"];

export type GroupableCard = {
  status: string;
  category?: string | null;
  intent?: string | null;
};

export function isOnHand(c: Pick<GroupableCard, "status">): boolean {
  return c.status === "held" || c.status === "listed";
}

/** The card's group, or null when it is not on hand (sold / traded). */
export function inventoryGroup(c: GroupableCard): InventoryGroup | null {
  if (!isOnHand(c)) return null;
  if ((c.category ?? "business") === "pc") return "pc";
  if (c.intent === "hold") return "holding";
  return "selling";
}

/** ?group= search param: selling | holding | pc, anything else is ignored. */
export function parseGroup(v: string | string[] | undefined): InventoryGroup | null {
  const s = Array.isArray(v) ? v[0] : v;
  return (INVENTORY_GROUPS as readonly string[]).includes(s ?? "") ? (s as InventoryGroup) : null;
}
