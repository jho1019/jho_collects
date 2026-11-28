import { describe, expect, it } from "vitest";
import { inventoryStats, isFiltered, shownStats, type StatsCard } from "../inventoryStats";

// Spec 17.3 #3: the strip follows status / text / ?cost=missing.
const card = (o: Partial<StatsCard>): StatsCard => ({
  status: "held",
  acquisition_cost: null,
  is_opening_stock: false,
  category: "business",
  ...o,
});

const cards: StatsCard[] = [
  card({ status: "held", acquisition_cost: "10.10", is_opening_stock: true }),
  card({ status: "listed", acquisition_cost: "20.20" }),
  card({ status: "held", acquisition_cost: null }),
  card({ status: "held", acquisition_cost: "99.00", category: "pc" }),
  card({ status: "sold", acquisition_cost: null }),
  card({ status: "sold", acquisition_cost: "5.00" }),
  card({ status: "traded", acquisition_cost: "7.00", is_opening_stock: true }),
];

describe("inventoryStats", () => {
  it("unfiltered rows mirror tracked_inventory: on hand, non-pc", () => {
    expect(inventoryStats(cards, "all", false)).toEqual({
      label: "On hand",
      cards_on_hand: 3,
      opening_stock_cards: 1,
      acquired_since_start: 2,
      cards_without_cost: 1,
      known_cost_basis: 30.3,
      opening_cost_basis: 10.1,
      acquired_cost_basis: 20.2,
    });
  });

  it("follows a held / listed status filter", () => {
    const s = inventoryStats(cards.filter((c) => c.status === "listed"), "listed", false);
    expect(s.cards_on_hand).toBe(1);
    expect(s.known_cost_basis).toBe(20.2);
    expect(s.cards_without_cost).toBe(0);
  });

  it("counts the rows themselves for sold / traded, labelled by status", () => {
    const sold = inventoryStats(cards.filter((c) => c.status === "sold"), "sold", false);
    expect(sold).toMatchObject({ label: "Sold", cards_on_hand: 2, cards_without_cost: 1, known_cost_basis: 5 });
    const traded = inventoryStats(cards.filter((c) => c.status === "traded"), "traded", false);
    expect(traded).toMatchObject({ label: "Traded", cards_on_hand: 1, opening_stock_cards: 1, opening_cost_basis: 7 });
  });

  it("?cost=missing matches the one-row table (the 17.1 Q2 screenshot case)", () => {
    const rows = [card({ status: "sold", acquisition_cost: null })];
    expect(inventoryStats(rows, "all", true)).toEqual({
      label: "Sold",
      cards_on_hand: 1,
      opening_stock_cards: 0,
      acquired_since_start: 1,
      cards_without_cost: 1,
      known_cost_basis: 0,
      opening_cost_basis: 0,
      acquired_cost_basis: 0,
    });
  });

  it("sums in cents, not floats", () => {
    const rows = [card({ acquisition_cost: "0.10" }), card({ acquisition_cost: "0.20" })];
    expect(inventoryStats(rows, "all", false).known_cost_basis).toBe(0.3);
  });

  it("a text filter that matches nothing on hand gives zeros, not the full set", () => {
    expect(inventoryStats([], "all", false).cards_on_hand).toBe(0);
  });
});

describe("shownStats (?group= / ?price=missing views, spec 18)", () => {
  it("?group=pc counts the PC rows shown, not a row of zeros", () => {
    const pc = [
      card({ category: "pc", acquisition_cost: "99.00" }),
      card({ category: "pc", status: "listed", acquisition_cost: null, is_opening_stock: true }),
    ];
    // inventoryStats excludes pc (tracked_inventory rule): the old mismatch.
    expect(inventoryStats(pc, "all", false).cards_on_hand).toBe(0);
    expect(shownStats(pc)).toEqual({
      label: "On hand",
      cards_on_hand: 2,
      opening_stock_cards: 1,
      acquired_since_start: 1,
      cards_without_cost: 1,
      known_cost_basis: 99,
      opening_cost_basis: 0,
      acquired_cost_basis: 99,
    });
  });

  it("matches the table length for a mixed price=missing view, summing in cents", () => {
    const rows = [
      card({ acquisition_cost: "0.10" }),
      card({ category: "pc", acquisition_cost: "0.20" }),
      card({ category: "riftbound" }),
    ];
    const s = shownStats(rows);
    expect(s.cards_on_hand).toBe(rows.length);
    expect(s.known_cost_basis).toBe(0.3);
    expect(s.cards_without_cost).toBe(1);
  });
});

describe("isFiltered", () => {
  it("is off only with status all, blank text and no cost filter", () => {
    expect(isFiltered("all", "  ", false)).toBe(false);
    expect(isFiltered("held", "", false)).toBe(true);
    expect(isFiltered("all", "jordan", false)).toBe(true);
    expect(isFiltered("all", "", true)).toBe(true);
  });
});
