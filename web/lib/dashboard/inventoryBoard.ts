// Dashboard Inventory + PC board (spec 18). Pure: rows in, a serializable
// model out. All money is integer cents. Today's snapshot; it never follows
// the dashboard's date range.
//
// Value rules
//   * est_value is an estimate (mostly Card Dealer Pro). A card without one is
//     flagged ("missing a price") and NEVER counted as $0: it adds to the card
//     counts, not to any value.
//   * Bulk boxes (bulk_lots, every location summed per bucket) count toward
//     Selling and nowhere else: Selling $ = valued selling singles + bulk
//     total_value; Selling cards = all selling singles + bulk card_count. The
//     footer bulk row is a summary of what is already inside Selling.
//
// Cost / gap choice
//   * cost = sum of acquisition_cost over the single cards that have one
//     (known costs only, all three groups), shown with "N of M cards have a
//     cost" where M = single cards. Bulk boxes have no cost basis
//     (bulk_lots.total_cost is unused and its cost-basis treatment is an open
//     decision in docs/DECISIONS.md), so bulk is excluded from cost and gap.
//   * gap = sum(est_value - acquisition_cost) over ONLY the cards that have
//     both. Comparing total value to known cost would set the value of 80
//     cards against the cost of 13 and read as a huge fake gain.

import { BUCKETS, type Bucket } from "@/lib/inventory-import/overrides";
import { bucketFor } from "@/lib/inventory-import/plan";
import { INVENTORY_GROUPS, inventoryGroup, type InventoryGroup } from "@/lib/inventoryGroups";

export type BoardCard = {
  id: number;
  status: string;
  category: string | null;
  intent: string | null;
  /** cents; null = no cost recorded */
  acquisition_cost: number | null;
  /** cents; null = no price (never $0) */
  est_value: number | null;
};

export type BoardBulkLot = {
  bucket: Bucket;
  card_count: number;
  /** cents (bulk_lots.total_value, generated card_count * unit_price) */
  total_value: number;
  location?: string | null;
};

export type GroupTotals = {
  /** Sum of est_value over cards that have one (+ bulk for Selling). */
  valueCents: number;
  /** All cards in the group (Selling includes bulk box cards). */
  cards: number;
  /** Single cards with an est_value. */
  valuedCards: number;
  /** Single cards with no est_value (bulk is always valued). */
  missingPrice: number;
};

export type Segment = {
  key: InventoryGroup;
  label: string;
  valueCents: number;
  /** Bar width in percent; 0 for an empty group, MIN_SEGMENT_PCT at least otherwise. */
  widthPct: number;
};

export type BreakdownRow = {
  key: string;
  label: string;
  kind: "tier" | "box" | "missing";
  count: number;
  /** null = no value to show ("—"), only for the missing-price row. */
  valueCents: number | null;
};

export type InventoryBoardModel = {
  groups: Record<InventoryGroup, GroupTotals>;
  segments: Segment[];
  /** Selling + Holding + PC (bulk is inside Selling). */
  totalCents: number;
  /** Single cards in the three groups (bulk excluded). */
  singles: number;
  cost: { knownCents: number; withCost: number; singles: number };
  /** null when no card has both a cost and a value. */
  gap: { cents: number; cards: number } | null;
  /** Single cards (three groups) with no est_value. */
  missingPrice: number;
  bulk: { buckets: { bucket: Bucket; label: string; count: number; valueCents: number }[]; cards: number; valueCents: number };
  /** The Selling breakdown panel; total equals the Selling segment exactly. */
  selling: { rows: BreakdownRow[]; total: { count: number; valueCents: number }; caption: string };
};

export const GROUP_LABEL: Record<InventoryGroup, string> = {
  selling: "Selling",
  holding: "Holding",
  pc: "PC",
};

export const BUCKET_LABEL: Record<Bucket, string> = { "1": "$1", "3": "$3", "5": "$5", "6_20": "$6–20" };

/** Smallest bar width a non-zero group gets, so a $3 PC still shows. */
export const MIN_SEGMENT_PCT = 3;

// Selling singles by est_value tier, ROUNDING DOWN, with the importer's own
// thresholds (BUCKET_THRESHOLDS / bucketFor in inventory-import/plan.ts,
// cents; a test pins TIER_CAPTION to those thresholds):
//   $1     under $2.00
//   $3     $2.00 – $3.99
//   $5     $4.00 – $5.99
//   $6–20  $6.00 – $20.00 inclusive
//   $20+   over $20.00 (bucketFor returns null)
export type Tier = Bucket | "20_plus";
export const TIERS: readonly Tier[] = [...BUCKETS, "20_plus"];
export const TIER_LABEL: Record<Tier, string> = { ...BUCKET_LABEL, "20_plus": "$20+" };
export const TIER_CAPTION =
  "Tiers round down: $1 under $2, $3 $2–3.99, $5 $4–5.99, $6–20 $6–20, $20+ over $20";

export function tierFor(cents: number): Tier {
  return bucketFor(cents) ?? "20_plus";
}

/** Proportional widths, a minimum for any non-zero group, summing to 100. */
export function segmentWidths(values: number[]): number[] {
  const total = values.reduce((s, v) => s + Math.max(v, 0), 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v > 0 ? (v / total) * 100 : 0));
  const small = raw.map((p) => p > 0 && p < MIN_SEGMENT_PCT);
  const bumped = small.filter(Boolean).length;
  const restRaw = raw.reduce((s, p, i) => (small[i] ? s : s + p), 0);
  const restScale = restRaw > 0 ? (100 - bumped * MIN_SEGMENT_PCT) / restRaw : 0;
  return raw.map((p, i) => (p === 0 ? 0 : small[i] ? MIN_SEGMENT_PCT : p * restScale));
}

export function buildInventoryBoard(cards: BoardCard[], bulkLots: BoardBulkLot[]): InventoryBoardModel {
  const empty = (): GroupTotals => ({ valueCents: 0, cards: 0, valuedCards: 0, missingPrice: 0 });
  const groups: Record<InventoryGroup, GroupTotals> = { selling: empty(), holding: empty(), pc: empty() };

  const tiers = new Map<Tier, { count: number; valueCents: number }>(
    TIERS.map((t) => [t, { count: 0, valueCents: 0 }]),
  );
  let singles = 0;
  let knownCost = 0;
  let withCost = 0;
  let gapCents = 0;
  let gapCards = 0;

  for (const c of cards) {
    const g = inventoryGroup(c);
    if (!g) continue; // sold / traded: not inventory
    singles++;
    const t = groups[g];
    t.cards++;
    if (c.est_value == null) {
      t.missingPrice++;
    } else {
      t.valuedCards++;
      t.valueCents += c.est_value;
      if (g === "selling") {
        const tier = tiers.get(tierFor(c.est_value))!;
        tier.count++;
        tier.valueCents += c.est_value;
      }
    }
    if (c.acquisition_cost != null) {
      withCost++;
      knownCost += c.acquisition_cost;
      if (c.est_value != null) {
        gapCards++;
        gapCents += c.est_value - c.acquisition_cost;
      }
    }
  }

  // Bulk: sum every location into its bucket, then into Selling only.
  const bulkBy = new Map<Bucket, { count: number; valueCents: number }>(
    BUCKETS.map((b) => [b, { count: 0, valueCents: 0 }]),
  );
  for (const l of bulkLots) {
    const b = bulkBy.get(l.bucket);
    if (!b) throw new Error(`bulk_lots: unknown bucket ${String(l.bucket)}`);
    b.count += l.card_count;
    b.valueCents += l.total_value;
  }
  const bulkBuckets = BUCKETS.map((b) => ({ bucket: b, label: BUCKET_LABEL[b], ...bulkBy.get(b)! }));
  const bulkCards = bulkBuckets.reduce((s, b) => s + b.count, 0);
  const bulkValue = bulkBuckets.reduce((s, b) => s + b.valueCents, 0);
  groups.selling.cards += bulkCards;
  groups.selling.valueCents += bulkValue;

  const totalCents = INVENTORY_GROUPS.reduce((s, g) => s + groups[g].valueCents, 0);
  const widths = segmentWidths(INVENTORY_GROUPS.map((g) => groups[g].valueCents));
  const segments = INVENTORY_GROUPS.map((g, i) => ({
    key: g,
    label: GROUP_LABEL[g],
    valueCents: groups[g].valueCents,
    widthPct: widths[i],
  }));

  const rows: BreakdownRow[] = [
    ...TIERS.map((t) => ({ key: `tier-${t}`, label: TIER_LABEL[t], kind: "tier" as const, ...tiers.get(t)! })),
    ...bulkBuckets.map((b) => ({
      key: `box-${b.bucket}`,
      label: `${b.label} box`,
      kind: "box" as const,
      count: b.count,
      valueCents: b.valueCents,
    })),
    { key: "missing", label: "missing price", kind: "missing", count: groups.selling.missingPrice, valueCents: null },
  ];
  const total = rows.reduce(
    (s, r) => ({ count: s.count + r.count, valueCents: s.valueCents + (r.valueCents ?? 0) }),
    { count: 0, valueCents: 0 },
  );

  return {
    groups,
    segments,
    totalCents,
    singles,
    cost: { knownCents: knownCost, withCost, singles },
    gap: gapCards > 0 ? { cents: gapCents, cards: gapCards } : null,
    missingPrice: INVENTORY_GROUPS.reduce((s, g) => s + groups[g].missingPrice, 0),
    bulk: { buckets: bulkBuckets, cards: bulkCards, valueCents: bulkValue },
    selling: { rows, total, caption: TIER_CAPTION },
  };
}
