import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spec 18 wiring, checked at source level (the unit suite runs in node, no DOM).
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("inventory board (spec 18)", () => {
  const board = read("../dashboard/InventoryBoard.tsx");
  const shell = read("../AppShell.tsx");
  const sheet = read("../BottomSheet.tsx");
  const score = read("../dashboard/Scoreboard.tsx");

  it("More / Menu and the Selling breakdown share one BottomSheet", () => {
    expect(shell).toContain('<BottomSheet title={title} onClose={onClose}>');
    expect(board).toContain('<BottomSheet title="Selling breakdown" onClose={closeSheet}>');
    expect(sheet).toContain('className="fixed inset-0 z-40 md:hidden"');
    expect(sheet).toContain("rounded-t-xl border-t-[3px] border-amber");
  });

  it("Selling is a dialog button; Holding and PC are links to the filtered page", () => {
    expect(board).toContain('aria-haspopup="dialog"');
    expect(board).toContain("aria-expanded={open}");
    expect(board).toContain("`/inventory?group=${k}`");
    expect(board).toContain('href="/inventory?price=missing"');
    expect(board).toContain('href="/inventory?group=selling"');
  });

  it("popover is AccountMenu-styled and hidden below md", () => {
    expect(board).toContain("z-40 mt-2 hidden w-[300px] max-w-full rounded-[6px] border border-line bg-board");
    expect(board).toContain("md:block");
  });

  it("top row holds the profit hero and the board; line score is its own board", () => {
    expect(score).toContain('<div className="sb-herorow">');
    expect(score).toContain('className="board sb-board hero sb-lsb"');
  });
});
