import { describe, expect, it } from "vitest";
import {
  groupByLot,
  sealedTotals,
  splitUnitCost,
  unitsForPurchase,
  type SealedProduct,
} from "../sealedProducts";

type U = Pick<SealedProduct, "status" | "category" | "acquisition_cost" | "est_value" | "lot_id">;
const unit = (o: Partial<U>): U => ({
  status: "held",
  category: "business",
  acquisition_cost: null,
  est_value: null,
  lot_id: null,
  ...o,
});

describe("sealedTotals (mirrors the sealed_inventory view)", () => {
  const units: U[] = [
    unit({ acquisition_cost: "100.00", est_value: "150.00" }),
    unit({ status: "listed", acquisition_cost: "40.50" }),
    unit({ est_value: "20.25" }),
    unit({}),
    unit({ category: "pc", acquisition_cost: "500.00", est_value: "900.00" }),
    unit({ status: "sold", acquisition_cost: "60.00", est_value: "70.00" }),
    unit({ status: "opened", acquisition_cost: "80.00", est_value: "90.00" }),
  ];

  it("counts on-hand business units only; missing cost / estimate are counted, not $0", () => {
    expect(sealedTotals(units)).toEqual({
      units_on_hand: 4,
      units_held: 3,
      units_listed: 1,
      units_without_cost: 2,
      units_without_price: 2,
      known_cost_basis: 140.5,
      estimated_value: 170.25,
    });
  });

  it("estimated_value is null, not 0, when no unit has an estimate", () => {
    const t = sealedTotals([unit({ acquisition_cost: "10.00" })]);
    expect(t.estimated_value).toBeNull();
    expect(t.units_without_price).toBe(1);
  });

  it("an explicit $0 estimate is a real value", () => {
    expect(sealedTotals([unit({ est_value: 0 })]).estimated_value).toBe(0);
  });

  it("sums in cents, not floats", () => {
    const t = sealedTotals([unit({ acquisition_cost: "0.10" }), unit({ acquisition_cost: "0.20" })]);
    expect(t.known_cost_basis).toBe(0.3);
  });
});

describe("groupByLot", () => {
  it("groups by lot_id in first-seen order; null lot units stand alone", () => {
    const rows = [
      unit({ lot_id: "a" }),
      unit({ lot_id: null }),
      unit({ lot_id: "a", status: "sold" }),
      unit({ lot_id: "b" }),
      unit({ lot_id: null }),
      unit({ lot_id: "a", status: "opened" }),
      unit({ lot_id: "a", status: "listed" }),
    ];
    const g = groupByLot(rows);
    expect(g.map((x) => [x.lot_id, x.units.length, x.on_hand])).toEqual([
      ["a", 4, 2],
      [null, 1, 1],
      ["b", 1, 1],
      [null, 1, 1],
    ]);
  });
});

describe("splitUnitCost", () => {
  it("splits evenly when it can", () => {
    expect(splitUnitCost("100.00", 4)).toEqual(["25.00", "25.00", "25.00", "25.00"]);
  });
  it("puts leftover cents on the first units and adds back to the total", () => {
    const s = splitUnitCost(100, 3);
    expect(s).toEqual(["33.34", "33.33", "33.33"]);
    expect(s.reduce((a, v) => a + Math.round(Number(v) * 100), 0)).toBe(10000);
  });
  it("rejects a non-whole or zero qty and a negative total", () => {
    expect(() => splitUnitCost(10, 0)).toThrow();
    expect(() => splitUnitCost(10, 1.5)).toThrow();
    expect(() => splitUnitCost(-1, 2)).toThrow();
  });
});

describe("unitsForPurchase", () => {
  const base = { product_name: "2025 Donruss Football Blaster", product_type: "blaster" as const };

  it("one row per unit, sharing one generated lot_id, cost split", () => {
    const rows = unitsForPurchase(base, 4, "110.00");
    expect(rows).toHaveLength(4);
    const lots = new Set(rows.map((r) => r.lot_id));
    expect(lots.size).toBe(1);
    expect(rows[0].lot_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows.map((r) => r.acquisition_cost)).toEqual(["27.50", "27.50", "27.50", "27.50"]);
    expect(rows[0].product_name).toBe(base.product_name);
  });

  it("a single unit has no lot unless one is given", () => {
    expect(unitsForPurchase(base, 1, 30)[0].lot_id).toBeNull();
    expect(unitsForPurchase(base, 1, 30, "lot-x")[0].lot_id).toBe("lot-x");
  });

  it("an unknown total leaves every cost null, not $0", () => {
    expect(unitsForPurchase(base, 2, null).map((r) => r.acquisition_cost)).toEqual([null, null]);
  });

  it("rejects qty < 1", () => {
    expect(() => unitsForPurchase(base, 0, 10)).toThrow();
  });
});
