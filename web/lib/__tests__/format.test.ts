import { describe, expect, it } from "vitest";
import { axisUsd, signedUsd, signedUsdWhole, toneClass, usd } from "../format";

const M = "−";

describe("usd", () => {
  it("formats positives without a plus", () => {
    expect(usd(1234.5)).toBe("$1,234.50");
    expect(usd("12")).toBe("$12.00");
  });
  it("uses U+2212 for negatives", () => {
    expect(usd(-975.22)).toBe(`${M}$975.22`);
  });
  it("never prints a signed zero", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(-0)).toBe("$0.00");
    expect(usd(-0.004)).toBe("$0.00");
    expect(usd(null)).toBe("$0.00");
  });
});

describe("signedUsd", () => {
  it("carries an explicit sign", () => {
    expect(signedUsd(190)).toBe("+$190.00");
    expect(signedUsd("-120")).toBe(`${M}$120.00`);
  });
  it("zero is neutral", () => {
    expect(signedUsd(0)).toBe("$0.00");
    expect(signedUsd(-0.001)).toBe("$0.00");
  });
});

describe("signedUsdWhole", () => {
  it("rounds to whole dollars with a sign", () => {
    expect(signedUsdWhole(13.4)).toBe("+$13");
    expect(signedUsdWhole(-64)).toBe(`${M}$64`);
    expect(signedUsdWhole(0.2)).toBe("$0");
  });
});

describe("toneClass", () => {
  it("is pos/neg and neutral at zero", () => {
    expect(toneClass(1)).toBe("text-pos");
    expect(toneClass(-1)).toBe("text-neg");
    expect(toneClass(0)).toBe("");
    expect(toneClass(0, "text-ink-muted")).toBe("text-ink-muted");
  });
});

describe("axisUsd", () => {
  it("formats ticks", () => {
    expect(axisUsd(-900)).toBe(`${M}$900`);
    expect(axisUsd(0)).toBe("$0");
    expect(axisUsd(1200)).toBe("$1,200");
  });
});
