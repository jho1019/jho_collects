import { describe, expect, it } from "vitest";
import { cdpBatchNumber, intish, isoDate, parseInventoryCsv, toCents, InventoryParseError } from "../parse";
import { cdpCsv, row } from "./helpers";

describe("parseInventoryCsv — layouts", () => {
  it("header on the first line", () => {
    const p = parseInventoryCsv(cdpCsv([row({ title: "A" }), row({ title: "B" })]));
    expect(p.layout).toBe("header_first");
    expect(p.headerLine).toBe(1);
    expect(p.rows.map((r) => [r.line, r.title])).toEqual([[2, "A"], [3, "B"]]);
  });

  it("title row above the header (batch-...-export)", () => {
    const p = parseInventoryCsv(cdpCsv([row({ title: "A" })], { titleRow: "batch-1611837-export" }));
    expect(p.layout).toBe("title_row");
    expect(p.titleRow).toBe("batch-1611837-export");
    expect(p.headerLine).toBe(2);
    expect(p.rows[0]).toMatchObject({ line: 3, title: "A" });
    expect(cdpBatchNumber(p)).toBe("1611837");
  });

  it("batch number from front-image URLs when there is no title row", () => {
    const p = parseInventoryCsv(cdpCsv([
      row({ front_image: "https://storage.googleapis.com/cdp-batches-prod/72012-1611699/1-front.jpg" }),
      row({ front_image: "https://media.cdn.collx.app/c/1-front.jpg" }),
    ]));
    expect(cdpBatchNumber(p)).toBe("1611699");
  });

  it("rejects a file with no header", () => {
    expect(() => parseInventoryCsv("a,b,c\n1,2,3\n")).toThrow(InventoryParseError);
  });

  it("skips and counts blank-title rows, keeping their sku and Bowser's bucket", () => {
    const p = parseInventoryCsv(cdpCsv([row({ title: "A" }), row({ title: "", sku: "241", bucket: "MISSING VALUE" }), row({ title: "  " })], { extra: ["bucket"] }));
    expect(p.rows).toHaveLength(1);
    expect(p.skippedBlank).toEqual([
      { line: 3, sku: "241", bucketHint: "MISSING VALUE" },
      { line: 4, sku: expect.any(String), bucketHint: null },
    ]);
  });

  it("reads Bowser's extra columns as hints only", () => {
    const p = parseInventoryCsv(cdpCsv([row({ bucket: "PC", pc_flag: "Yes" })], { extra: ["bucket", "pc_flag"] }));
    expect(p.rows[0].hints).toEqual({ bucket: "PC", pc_flag: "Yes" });
    expect(p.extraColumns).toEqual([]);
  });
});

describe("normalization", () => {
  it("integer-valued floats -> integer strings (year, card_number, sku, grade_number)", () => {
    const p = parseInventoryCsv(cdpCsv([row({
      year: "1996.0", card_number: "11.0", sku: "290.0", grade_number: "7.0", graded: "Yes", grader: "PSA", purchase_price: "0.0",
    })]));
    expect(p.rows[0]).toMatchObject({ year: "1996", cardNumber: "11", sku: "290", gradeNumber: "7", purchaseCents: 0, graded: true });
  });
  it("keeps real decimals and alphanumerics", () => {
    expect(intish("2.5")).toBe("2.5");
    expect(intish("65b")).toBe("65b");
    expect(intish("02")).toBe("02");
    expect(intish("TS13V")).toBe("TS13V");
  });
  it("money to cents, float noise rounded", () => {
    expect(toCents("24.990000000000002")).toBe(2499);
    expect(toCents("7.6000000000000005")).toBe(760);
    expect(toCents("$1,234.50")).toBe(123450);
    expect(toCents(null)).toBeNull();
    expect(toCents("n/a")).toBeNaN();
  });
  it("dates", () => {
    expect(isoDate("2026-11-28")).toBe("2026-11-28");
    expect(isoDate("9/3/2026")).toBe("2026-09-03");
    expect(isoDate("garbage")).toBeNull();
  });
  it("sport lower-cased; graded inferred from grader/cert", () => {
    const p = parseInventoryCsv(cdpCsv([row({ category: "BASEBALL", graded: "", grader: "SGC", certification_number: "123.0" })]));
    expect(p.rows[0]).toMatchObject({ sport: "baseball", graded: true, certNumber: "123" });
  });
  it("unparseable market price -> null with a warning", () => {
    const p = parseInventoryCsv(cdpCsv([row({ market_price: "call" })]));
    expect(p.rows[0].marketCents).toBeNull();
    expect(p.rows[0].warnings[0]).toMatch(/market_price "call"/);
  });
});
