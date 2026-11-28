import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TIER_CAPTION } from "@/lib/dashboard/inventoryBoard";

// Spec 18 wiring, checked at source level (the unit suite runs in node, no DOM).
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("inventory board (spec 18)", () => {
  const board = read("../dashboard/InventoryBoard.tsx");
  const shell = read("../AppShell.tsx");
  const sheet = read("../BottomSheet.tsx");
  const score = read("../dashboard/Scoreboard.tsx");
  const css = read("../../app/(app)/dashboard/dashboard.css");

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

  it("popover header has a compact, named × Close control that refocuses Selling", () => {
    const header = board.slice(board.indexOf('aria-label="Selling breakdown"'), board.indexOf("{content}"));
    expect(header).toContain("Selling breakdown");
    expect(header).toContain('type="button"');
    expect(header).toContain('aria-label="Close"');
    expect(header).toMatch(/[×✕]/);
    expect(header).toContain("onClick={() => close(true)}");
    expect(header).toContain("flex items-center justify-between");
    expect(header).toContain("font-mono");
    expect(header).toContain("text-ink-muted hover:text-ink");
  });

  it("Escape / outside pointerdown are wired like AccountMenu", () => {
    for (const src of [board, shell]) {
      expect(src).toContain('if (e.key === "Escape")');
      expect(src).toContain("if (!wrapRef.current?.contains(e.target as Node))");
      expect(src).toContain('document.addEventListener("keydown", onKey);');
      expect(src).toContain('document.addEventListener("pointerdown", onDown);');
    }
    // Escape and × hand focus back to the opener; an outside click keeps its own focus.
    expect(board).toContain('if (e.key === "Escape") close(true);');
    expect(board).toContain("if (!wrapRef.current?.contains(e.target as Node)) close(false);");
    expect(board).toContain("if (refocus) openerRef.current?.focus();");
    expect(board).toContain("ref={openerRef}");
  });

  it("zero rows get sb-z (dimmed, not hidden)", () => {
    expect(board).toContain('r.count === 0 ? "sb-z" : ""');
    expect(board).toContain('r.kind === "missing" && r.count > 0 ? "sb-miss" : ""');
    expect(css).toMatch(/\.sb-bdt tr\.sb-z \{ opacity: 0\.5; \}/);
    expect(css).not.toMatch(/sb-z[^}]*(display:\s*none|visibility:\s*hidden)/);
  });

  it("footnote renders Daisy's exact copy", () => {
    const daisy =
      "Tiers: $1 under $2 · $3 $2–3.99 · $5 $4–5.99 · $6–20 · $20+. Missing price is counted, never valued at $0.";
    expect(board.replace("{m.selling.caption}", TIER_CAPTION)).toContain(daisy);
    expect(board).not.toContain("round down");
    expect(TIER_CAPTION).not.toContain("round down");
  });

  it("top row holds the profit hero and the board; line score is its own board", () => {
    expect(score).toContain('<div className="sb-herorow">');
    expect(score).toContain('className="board sb-board hero sb-lsb"');
  });
});
