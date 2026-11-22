import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spec 16.1: the shell's full bar starts at a shell-only nav breakpoint
// (1280px) while lg stays at 1180 for page layout grids; the account-menu
// theme control is the compact 32px size, the sheets keep 44px.
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const css = read("../../app/globals.css");
const shell = read("../AppShell.tsx");
const toggle = read("../ThemeToggle.tsx");

describe("shell breakpoints (spec 16.1a)", () => {
  it("adds a 1280px nav breakpoint and leaves lg at 1180", () => {
    expect(css).toMatch(/--breakpoint-nav:\s*1280px;/);
    expect(css).toMatch(/--breakpoint-lg:\s*1180px;/);
  });

  it("drives the top bar's full cluster from nav, not lg", () => {
    expect(shell).not.toMatch(/\blg:/);
    expect(shell).toContain("nav:text-[13px]");
    expect(shell).toMatch(/className="hidden nav:block">\s*<ThemeToggle \/>/);
    expect(shell).toContain('className="hidden md:block nav:hidden"');
  });
});

describe("account-menu theme control (spec 16.1b)", () => {
  it("uses the compact segmented size in the account menu only", () => {
    expect(shell.match(/size="compact"/g)).toHaveLength(1);
    expect(shell).toContain('<ThemeToggle variant="segmented" size="compact" />');
  });

  it("compact is 32px, default stays 44px", () => {
    expect(toggle).toMatch(/size === "compact" \? "min-h-8 py-1\.5 text-\[12px\]" : "min-h-11 text-\[13px\]"/);
  });
});

describe("Deals badge on amber sheet cells (spec 16.1c)", () => {
  it("uses on-amber text when the cell is active, red when idle", () => {
    expect(shell).toContain('active ? "text-on-amber" : "text-neg"');
  });
});
