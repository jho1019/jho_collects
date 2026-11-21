import { describe, expect, it } from "vitest";
import { moneyCell, parsePrice } from "../money";

describe("parsePrice", () => {
  it.each([
    [12, "12.00"], ["12.3", "12.30"], [12.34, "12.34"], ["0.99", "0.99"], ["007.5", "7.50"],
  ])("accepts %j -> %s", (input, out) => {
    expect(parsePrice(input)).toBe(out);
  });
  it.each([0, "0", "0.00", -1, "-1", "12.345", 12.345, "abc", "", null, undefined, NaN, Infinity, "1e3", "1,000", true, "123456789"])(
    "rejects %j",
    (input) => {
      expect(() => parsePrice(input)).toThrow(/price/);
    },
  );
});

describe("moneyCell", () => {
  it("parses spreadsheet money and returns null for junk", () => {
    expect(moneyCell("$1,234.5")).toBe("1234.50");
    expect(moneyCell("")).toBeNull();
    expect(moneyCell("n/a")).toBeNull();
  });
});
