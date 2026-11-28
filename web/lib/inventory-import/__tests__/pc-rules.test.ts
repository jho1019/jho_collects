import { describe, expect, it } from "vitest";
import { classifyPc, PC_RULES, type PcInput } from "../pc-rules";

// One test per rule in PC_RULES, plus the spec's explicit NOT-PC cases.
const v = (c: PcInput) => classifyPc(c);

describe("PC rules — each rule", () => {
  it("player_ohtani: any Ohtani, any price, any year (even 2026 Heritage)", () => {
    expect(v({ player: "Shohei Ohtani", year: "2018", set: "2018 Leaf" })).toMatchObject({ kind: "pc", ruleId: "player_ohtani" });
    expect(v({ player: "Shohei Ohtani", year: "2026", set: "2026 Topps Heritage" })).toMatchObject({ kind: "pc", ruleId: "player_ohtani" });
    // falls back to the title when player is blank
    expect(v({ title: "2021 Topps Update Shohei Ohtani Redux" })).toMatchObject({ kind: "pc" });
  });

  it("player_roki_sasaki", () => {
    expect(v({ player: "Roki Sasaki", year: "2025", set: "2025 Topps Chrome" })).toMatchObject({ kind: "pc", ruleId: "player_roki_sasaki" });
  });

  it("player_yamamoto: matched on player only", () => {
    expect(v({ player: "Yoshinobu Yamamoto", set: "2024 Topps" })).toMatchObject({ kind: "pc", ruleId: "player_yamamoto" });
    expect(v({ player: "Lamine Yamal", title: "Yamamoto lookalike" })).toMatchObject({ kind: "none" });
  });

  it("set_2025_topps_heritage: any card in 2025 Topps Heritage", () => {
    expect(v({ player: "Hyeseong Kim", year: "2025", set: "2025 Topps Heritage", parallel: "Dark Blue Border" }))
      .toMatchObject({ kind: "pc", ruleId: "set_2025_topps_heritage" });
  });

  it("kobe_2008_topps_orange_psa25: the PSA 2.5, and the known raw-read rescan (with a note)", () => {
    const slab = v({ player: "Kobe Bryant", year: "2008", set: "2008-09 Topps", cardNumber: "24", parallel: "Orange", graded: true, grader: "PSA", grade: "2.5" });
    expect(slab).toMatchObject({ kind: "pc", ruleId: "kobe_2008_topps_orange_psa25", note: null });
    const raw = v({ title: "2008-09 Topps #24 Kobe Bryant Orange #/1199", player: "Kobe Bryant", year: "2008", set: "2008-09 Topps", parallel: "Orange", graded: false });
    expect(raw).toMatchObject({ kind: "pc", ruleId: "kobe_2008_topps_orange_psa25" });
    expect(raw.note).toMatch(/read this as raw/);
    // a different grade is not this card
    expect(v({ player: "Kobe Bryant", year: "2008", set: "2008-09 Topps", parallel: "Orange", graded: true, grader: "PSA", grade: "8" }).kind).toBe("none");
    // nor is a non-orange 2008 Topps Kobe, or Topps Chrome
    expect(v({ player: "Kobe Bryant", year: "2008", set: "2008-09 Topps", graded: false }).kind).toBe("none");
    expect(v({ player: "Kobe Bryant", year: "2008", set: "2008-09 Topps Chrome", parallel: "Orange Refractor" }).kind).toBe("none");
  });

  it("kobe_1996_topps_138_psa7_business: explicit business hold, even if bought later", () => {
    const k = { player: "Kobe Bryant", year: "1996", set: "1996-97 Topps", cardNumber: "138", graded: true, grader: "PSA", grade: "7" };
    expect(v(k)).toMatchObject({ kind: "not_pc", ruleId: "kobe_1996_topps_138_psa7_business" });
    expect(v({ ...k, purchaseDate: "2026-12-15" }).kind).toBe("not_pc");
    expect(v({ ...k, grade: "7.0" }).kind).toBe("not_pc");
  });

  it("kobe_slab_after_2026_11_27: other graded Kobes bought after Nov 27 2026 -> review", () => {
    const k = { player: "Kobe Bryant", year: "1997", set: "1997-98 Fleer", graded: true, grader: "PSA", grade: "8" };
    expect(v({ ...k, purchaseDate: "2026-11-28" })).toMatchObject({ kind: "review", ruleId: "kobe_slab_after_2026_11_27" });
    expect(v({ ...k, purchaseDate: "2026-11-27" }).kind).toBe("none"); // on the day = before the cutoff
    expect(v(k).kind).toBe("none"); // no purchase date
  });

  it("every rule has a test above", () => {
    expect(PC_RULES.map((r) => r.id)).toEqual([
      "kobe_1996_topps_138_psa7_business", "player_ohtani", "player_roki_sasaki", "player_yamamoto",
      "set_2025_topps_heritage", "kobe_2008_topps_orange_psa25", "kobe_slab_after_2026_11_27",
    ]);
  });
});

describe("PC rules — spec's NOT-PC cases", () => {
  it("2026 Topps Heritage is business (Misiorowski)", () => {
    expect(v({ player: "Jacob Misiorowski", year: "2026", set: "2026 Topps Heritage" }).kind).toBe("none");
  });
  it("raw Kobes are business", () => {
    expect(v({ player: "Kobe Bryant", year: "1997", set: "1997-98 Fleer", graded: false }).kind).toBe("none");
    expect(v({ player: "Kobe Bryant", year: "1996", set: "1996-97 Topps", cardNumber: "138", graded: false, purchaseDate: "2027-01-01" }).kind).toBe("none");
  });
  it("2024 Topps Heritage is not 2025 Heritage", () => {
    expect(v({ player: "Gunnar Henderson", year: "2024", set: "2024 Topps Heritage" }).kind).toBe("none");
  });
  it("accents and case do not matter", () => {
    expect(v({ player: "SHOHEI OHTANI" }).kind).toBe("pc");
    expect(v({ player: "José Ramírez", year: "2026", set: "2026 Topps Heritage" }).kind).toBe("none");
  });
});
