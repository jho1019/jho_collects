import { describe, expect, it } from "vitest";
import { BUCKET_THRESHOLDS } from "@/lib/inventory-import/plan";
import { inventoryGroup, parseGroup } from "@/lib/inventoryGroups";
import {
  MIN_SEGMENT_PCT,
  TIER_CAPTION,
  buildInventoryBoard,
  segmentWidths,
  tierFor,
  type BoardBulkLot,
  type BoardCard,
  type InventoryBoardModel,
} from "../inventoryBoard";
import { normalizeBoardCard, normalizeBulkLot, toCentsOrNull } from "../load";

let nextId = 1;
const card = (o: Partial<BoardCard>): BoardCard => ({
  id: nextId++,
  status: "held",
  category: "business",
  intent: null,
  acquisition_cost: null,
  est_value: null,
  ...o,
});
const many = (n: number, o: Partial<BoardCard>) => Array.from({ length: n }, () => card(o));

/** The Selling breakdown total must be the Selling segment, exactly. */
function expectTotalIsSelling(m: InventoryBoardModel) {
  expect(m.selling.total.valueCents).toBe(m.groups.selling.valueCents);
  expect(m.selling.total.count).toBe(m.groups.selling.cards);
}

// Shaped like production on 28 Nov 2026 (cross-checked by SQL): per-card
// values are made up, the totals are real.
function liveFixture(): { cards: BoardCard[]; bulk: BoardBulkLot[] } {
  const selling = [
    card({ intent: "sell", est_value: 150 }), // $1.50  -> $1
    card({ intent: null, est_value: 399 }), // $3.99  -> $3
    card({ intent: "sell", est_value: 800 }), // $8.00  -> $6–20
    card({ intent: null, status: "listed", est_value: 15000 }), // $150 -> $20+
    ...many(6, { intent: null }), // unpriced, no cost
  ];
  const holding = [
    ...many(41, { intent: "hold", est_value: 3900 }),
    card({ intent: "hold", est_value: 3783, acquisition_cost: 5683 }), // "card 9": −$19.00
    card({ intent: "hold", acquisition_cost: 6452 }), // unpriced, cost only
  ];
  const pc = [
    ...many(16, { category: "pc", est_value: 6000 }),
    card({ category: "pc", est_value: 11627, acquisition_cost: 627 }), // "card 8": +$110.00
    ...many(10, { category: "pc", acquisition_cost: 6000 }), // unpriced, cost only
  ];
  const gone = [
    card({ status: "sold", est_value: 99999, acquisition_cost: 100 }),
    card({ status: "traded", category: "pc", est_value: 5000 }),
  ];
  // Bulk split across two locations to prove per-bucket summing.
  const bulk: BoardBulkLot[] = [
    { bucket: "1", card_count: 20, total_value: 2000, location: "Box A" },
    { bucket: "1", card_count: 7, total_value: 700, location: "Box B" },
    { bucket: "3", card_count: 17, total_value: 5100, location: "Box A" },
    { bucket: "5", card_count: 6, total_value: 3000, location: null },
    { bucket: "6_20", card_count: 4, total_value: 4000, location: "Box A" },
    { bucket: "6_20", card_count: 3, total_value: 2671, location: "Box B" },
  ];
  return { cards: [...selling, ...holding, ...pc, ...gone], bulk };
}

describe("buildInventoryBoard: live-shaped fixture", () => {
  const { cards, bulk } = liveFixture();
  const m = buildInventoryBoard(cards, bulk);

  it("groups: Selling includes bulk, Holding and PC are singles", () => {
    expect(m.groups.selling).toEqual({ valueCents: 33820, cards: 67, valuedCards: 4, missingPrice: 6 });
    expect(m.groups.holding).toEqual({ valueCents: 163683, cards: 43, valuedCards: 42, missingPrice: 1 });
    expect(m.groups.pc).toEqual({ valueCents: 107627, cards: 27, valuedCards: 17, missingPrice: 10 });
    expect(m.totalCents).toBe(305130);
  });

  it("missing price, known cost and gap", () => {
    expect(m.missingPrice).toBe(17);
    expect(m.singles).toBe(80);
    expect(m.cost).toEqual({ knownCents: 72762, withCost: 13, singles: 80 });
    expect(m.gap).toEqual({ cents: 9100, cards: 2 });
  });

  it("bulk summed across locations per bucket, counted once", () => {
    expect(m.bulk.buckets.map((b) => [b.label, b.count, b.valueCents])).toEqual([
      ["$1", 27, 2700],
      ["$3", 17, 5100],
      ["$5", 6, 3000],
      ["$6–20", 7, 6671],
    ]);
    expect(m.bulk).toMatchObject({ cards: 57, valueCents: 17471 });
    // Holding and PC never see bulk; the board total holds it once.
    expect(m.totalCents - m.groups.holding.valueCents - m.groups.pc.valueCents).toBe(16349 + 17471);
  });

  it("selling breakdown rows and total", () => {
    const row = (k: string) => m.selling.rows.find((r) => r.key === k)!;
    expect(row("tier-1")).toMatchObject({ count: 1, valueCents: 150 });
    expect(row("tier-3")).toMatchObject({ count: 1, valueCents: 399 });
    expect(row("tier-5")).toMatchObject({ count: 0, valueCents: 0 });
    expect(row("tier-6_20")).toMatchObject({ count: 1, valueCents: 800 });
    expect(row("tier-20_plus")).toMatchObject({ count: 1, valueCents: 15000 });
    expect(row("box-6_20")).toMatchObject({ label: "$6–20 box", count: 7, valueCents: 6671 });
    expect(row("missing")).toEqual({ key: "missing", label: "missing price", kind: "missing", count: 6, valueCents: null });
    expect(m.selling.total).toEqual({ count: 67, valueCents: 33820 });
    expectTotalIsSelling(m);
  });

  it("segments are proportional and sum to 100", () => {
    const w = m.segments.map((s) => s.widthPct);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    expect(w[0]).toBeCloseTo((33820 / 305130) * 100, 6);
    expect(m.segments.map((s) => s.key)).toEqual(["selling", "holding", "pc"]);
  });

  it("is JSON-serializable (crosses the server/client boundary)", () => {
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});

describe("buildInventoryBoard: rules", () => {
  it("null est_value is never $0: counted as a card, not as value", () => {
    const m = buildInventoryBoard([card({}), card({ est_value: 0 }), card({ est_value: 500 })], []);
    expect(m.groups.selling).toEqual({ valueCents: 500, cards: 3, valuedCards: 2, missingPrice: 1 });
    expect(m.missingPrice).toBe(1);
    // An explicit $0.00 estimate is a price (tier $1), the null one is "missing".
    expect(m.selling.rows.find((r) => r.key === "tier-1")!.count).toBe(1);
    expect(m.selling.rows.find((r) => r.key === "missing")!.valueCents).toBeNull();
  });

  it("gap only over cards with both a cost and a value", () => {
    const m = buildInventoryBoard(
      [
        card({ est_value: 10000 }), // value only
        card({ acquisition_cost: 5000 }), // cost only
        card({ est_value: 2000, acquisition_cost: 1500 }), // +5.00
        card({ intent: "hold", est_value: 1000, acquisition_cost: 1200 }), // −2.00
      ],
      [],
    );
    expect(m.gap).toEqual({ cents: 300, cards: 2 });
    expect(m.cost).toEqual({ knownCents: 7700, withCost: 3, singles: 4 });
  });

  it("no card with both: gap is null, not $0", () => {
    const m = buildInventoryBoard([card({ est_value: 100 }), card({ acquisition_cost: 100 })], []);
    expect(m.gap).toBeNull();
  });

  it("bulk is excluded from cost and the singles count", () => {
    const m = buildInventoryBoard([card({ acquisition_cost: 100 })], [{ bucket: "5", card_count: 10, total_value: 5000 }]);
    expect(m.cost).toEqual({ knownCents: 100, withCost: 1, singles: 1 });
    expect(m.groups.selling.cards).toBe(11);
  });

  it("all-unvalued: zero value, every card missing, total still matches Selling", () => {
    const m = buildInventoryBoard([...many(3, {}), ...many(2, { intent: "hold" }), ...many(4, { category: "pc" })], []);
    expect(m.totalCents).toBe(0);
    expect(m.missingPrice).toBe(9);
    expect(m.segments.every((s) => s.widthPct === 0)).toBe(true);
    expect(m.selling.total).toEqual({ count: 3, valueCents: 0 });
    expectTotalIsSelling(m);
  });

  it("empty: zeros everywhere, all rows still present", () => {
    const m = buildInventoryBoard([], []);
    expect(m.totalCents).toBe(0);
    expect(m.gap).toBeNull();
    expect(m.selling.rows).toHaveLength(5 + 4 + 1);
    expect(m.selling.total).toEqual({ count: 0, valueCents: 0 });
    expectTotalIsSelling(m);
  });

  it("bulk only: Selling is the boxes", () => {
    const m = buildInventoryBoard([], [{ bucket: "3", card_count: 4, total_value: 1200 }]);
    expect(m.groups.selling).toMatchObject({ valueCents: 1200, cards: 4 });
    expect(m.segments.map((s) => s.widthPct)).toEqual([100, 0, 0]);
    expectTotalIsSelling(m);
  });

  it("rejects an unknown bulk bucket instead of dropping its value", () => {
    expect(() => buildInventoryBoard([], [{ bucket: "9" as "1", card_count: 1, total_value: 900 }])).toThrow(/bucket/);
  });
});

describe("tiers (round down, importer thresholds)", () => {
  const cases: [number, string][] = [
    [199, "1"],
    [200, "3"],
    [399, "3"],
    [400, "5"],
    [599, "5"],
    [600, "6_20"],
    [2000, "6_20"],
    [2001, "20_plus"],
  ];
  it.each(cases)("%i cents -> %s", (cents, tier) => {
    expect(tierFor(cents)).toBe(tier);
  });

  it("boundary fixture lands in the right rows and the total is Selling", () => {
    const m = buildInventoryBoard(
      cases.map(([v]) => card({ est_value: v })),
      [{ bucket: "1", card_count: 2, total_value: 200 }],
    );
    const counts = Object.fromEntries(m.selling.rows.map((r) => [r.key, [r.count, r.valueCents]]));
    expect(counts["tier-1"]).toEqual([1, 199]);
    expect(counts["tier-3"]).toEqual([2, 599]);
    expect(counts["tier-5"]).toEqual([2, 999]);
    expect(counts["tier-6_20"]).toEqual([2, 2600]);
    expect(counts["tier-20_plus"]).toEqual([1, 2001]);
    expect(counts["box-1"]).toEqual([2, 200]);
    expectTotalIsSelling(m);
    expect(m.selling.total).toEqual({ count: 10, valueCents: 199 + 599 + 999 + 2600 + 2001 + 200 });
  });

  it("caption matches the importer's thresholds", () => {
    expect(BUCKET_THRESHOLDS.floors).toEqual([["6_20", 600], ["5", 400], ["3", 200]]);
    expect(BUCKET_THRESHOLDS.maxCents).toBe(2000);
    expect(TIER_CAPTION).toBe("Tiers: $1 under $2 · $3 $2–3.99 · $5 $4–5.99 · $6–20 · $20+.");
  });
});

describe("segmentWidths", () => {
  it("gives a tiny non-zero group the minimum and still sums to 100", () => {
    const w = segmentWidths([100000, 1, 0]);
    expect(w[1]).toBe(MIN_SEGMENT_PCT);
    expect(w[2]).toBe(0);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
  });
  it("all zero -> all zero (empty bar state)", () => {
    expect(segmentWidths([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("inventory group predicate (shared with /inventory)", () => {
  it("on hand only; pc by category; holding by intent; everything else selling", () => {
    expect(inventoryGroup({ status: "held", category: "pc", intent: null })).toBe("pc");
    expect(inventoryGroup({ status: "listed", category: "business", intent: "hold" })).toBe("holding");
    expect(inventoryGroup({ status: "held", category: "business", intent: "sell" })).toBe("selling");
    expect(inventoryGroup({ status: "held", category: "business", intent: null })).toBe("selling");
    expect(inventoryGroup({ status: "held", category: "riftbound", intent: "hold" })).toBe("holding");
    expect(inventoryGroup({ status: "listed", category: "sealed", intent: null })).toBe("selling");
    expect(inventoryGroup({ status: "held", category: null, intent: null })).toBe("selling");
    expect(inventoryGroup({ status: "sold", category: "business", intent: "sell" })).toBeNull();
    expect(inventoryGroup({ status: "traded", category: "pc", intent: null })).toBeNull();
  });
  it("parseGroup accepts the three groups only", () => {
    expect(parseGroup("selling")).toBe("selling");
    expect(parseGroup(["pc", "holding"])).toBe("pc");
    expect(parseGroup("sold")).toBeNull();
    expect(parseGroup("PC")).toBeNull();
    expect(parseGroup(undefined)).toBeNull();
  });
});

describe("loader normalization", () => {
  it("numeric strings become cents; null stays null, never 0", () => {
    expect(
      normalizeBoardCard({ id: "7", status: "held", category: "pc", intent: null, acquisition_cost: "12.30", est_value: null }),
    ).toEqual({ id: 7, status: "held", category: "pc", intent: null, acquisition_cost: 1230, est_value: null });
    expect(
      normalizeBoardCard({ id: 8, status: "listed", category: null, intent: "sell", acquisition_cost: null, est_value: "0.00" }),
    ).toMatchObject({ acquisition_cost: null, est_value: 0 });
    expect(toCentsOrNull("")).toBeNull();
    expect(toCentsOrNull(19.99)).toBe(1999);
  });
  it("bulk rows: numeric strings to cents and ints", () => {
    expect(normalizeBulkLot({ bucket: "6_20", card_count: "7", total_value: "66.71" })).toEqual({
      bucket: "6_20",
      card_count: 7,
      total_value: 6671,
    });
  });
});
