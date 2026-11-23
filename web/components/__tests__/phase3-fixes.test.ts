import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spec 17.3 / 17.4 follow-ups that are layout or wiring, checked at source
// level (the unit suite runs in node, no DOM).
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("inventory (17.3 #1, #3)", () => {
  const inv = read("../CardInventory.tsx");
  it("filter input is wide enough for the full placeholder at sm+", () => {
    expect(inv).toContain('placeholder="filter title / player / set / sku"');
    expect(inv).toContain("w-full sm:w-[296px] sm:shrink-0");
  });
  it("strip reads filtered stats, and the unfiltered summary otherwise", () => {
    expect(inv).toContain("inventoryStats(rows, filter, missingCost)");
    expect(inv).not.toMatch(/\{summary\.cards_on_hand\}/);
  });
  it("no cost tag does not depend on status", () => {
    expect(inv).toMatch(/\{c\.acquisition_cost == null && \(\s*<span className="tg tg-amber">no cost<\/span>/);
  });
});

describe("buying at 390 (17.3 #2)", () => {
  it("mobile board uses a minmax(0,1fr) track and rows can shrink", () => {
    expect(read("../../app/(app)/buying/page.tsx")).toContain(
      'className="board bd grid min-w-0 grid-cols-1 gap-2.5 sm:hidden"',
    );
    const row = read("../BuyingTargetCard.tsx");
    expect(row).toContain('className="cellrow min-w-0 !p-0"');
    expect(row).toContain("min-w-0 flex-1 truncate");
  });
});

describe("data import Cancel (X4)", () => {
  const io = read("../DataIO.tsx");
  it("plain btn next to Commit that clears preview, csv, name and the file input", () => {
    expect(io).toMatch(/onClick=\{cancel\}[^>]*className="btn"/);
    expect(io).toMatch(/function cancel\(\) \{\s*reset\(\);\s*setCsv\(""\);\s*setFileName\(""\);\s*if \(fileRef\.current\) fileRef\.current\.value = "";/);
    expect(io).toContain("ref={fileRef}");
  });
});

describe("people dates (17.4 #4)", () => {
  it("mobile last-order date does not wrap mid-token", () => {
    expect(read("../BuyerList.tsx")).toContain(
      '<b className="whitespace-nowrap font-medium tabular-nums text-ink">{b.last_order_on ?? "—"}</b>',
    );
  });
});

describe("calendar day sheet (C10)", () => {
  const cal = read("../Calendar.tsx");
  it("sheet below sm: scrim, rounded top, 3px amber border, docked above the tab bar", () => {
    expect(cal).toContain('role="dialog"');
    expect(cal).toContain("rounded-t-xl border-t-[3px] border-amber");
    expect(cal).toContain('aria-label="Close day detail"');
    expect(cal).toMatch(/e\.key === "Escape"\) onClose\(\)/);
    expect(cal).toContain("style={{ bottom: ABOVE_TABS }}");
  });
  it("keeps one amber release dot (17.1 Q1)", () => {
    expect(cal.match(/className="cal-dot"/g)).toHaveLength(1);
  });
});
