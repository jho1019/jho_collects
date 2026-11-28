// ============================================================================
// Personal-collection (PC) rules.                         EDIT THE LIST BELOW
// ============================================================================
//
// One list, shared by
//   * the Card Dealer Pro inventory importer (lib/inventory-import/plan.ts):
//     a PC match always becomes a `cards` row with category 'pc', intent null,
//     even when CDP values it at $3;
//   * the CDP -> eBay listing import (lib/ebay-api/cdp/import.ts): a PC match is
//     skipped (reason 'personal_collection') before anything is sent to eBay.
//
// Rules are evaluated IN ORDER and the first match wins:
//   kind 'not_pc'  an explicit exception: "this looks like it might be PC or
//                  needs review, but it is business". Listed first so it stops
//                  the review rule from firing on a known business hold.
//   kind 'pc'      personal collection.
//   kind 'review'  not decided automatically; the importer flags the row
//                  (`review_kobe`) and leaves it out of the commit until an
//                  override settles it.
// No match = business.
//
// Source: specs/026_inventory_requirements.md section 4 (Nov 27 2026).
// To add a player, copy one of the player rules. Every rule has a unit test in
// __tests__/pc-rules.test.ts — add one with it.
// ============================================================================

/** The fields a rule can look at. Every field is optional free text. */
export interface PcInput {
  title?: string | null;
  player?: string | null;
  year?: string | null;
  /** Set name as exported, e.g. "2025 Topps Heritage" or just "Topps". */
  set?: string | null;
  cardNumber?: string | null;
  /** Parallel / subset / variation text. */
  parallel?: string | null;
  graded?: boolean | null;
  grader?: string | null;
  grade?: string | null;
  /** ISO date (YYYY-MM-DD) the card was bought, if known. */
  purchaseDate?: string | null;
}

export type PcKind = "pc" | "not_pc" | "review";

export interface PcRule {
  id: string;
  kind: PcKind;
  /** Plain-English statement of the rule, shown in reports. */
  description: string;
  test: (c: PcInput) => boolean;
  /** Optional extra note attached to a match (e.g. a known data-quality quirk). */
  note?: (c: PcInput) => string | null;
}

export interface PcVerdict {
  kind: PcKind | "none";
  ruleId: string | null;
  description: string | null;
  note: string | null;
}

// ------------------------------------------------------------------ helpers

const lc = (s?: string | null) => (s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const has = (s: string | null | undefined, needle: string) => lc(s).includes(needle);

/** Player match: the player column, or the title when CDP left player blank. */
const playerIs = (c: PcInput, needle: string) => has(c.player, needle) || (!c.player && has(c.title, needle));

/** First 4-digit year from year, then set, then title. "2008-09" -> 2008. */
export function pcYear(c: PcInput): number | null {
  for (const s of [c.year, c.set, c.title]) {
    const m = /\b(19|20)\d{2}\b/.exec(s ?? "");
    if (m) return Number(m[0]);
  }
  return null;
}

/** Set name with years removed: "2008-09 Topps" -> "topps". */
const setCore = (c: PcInput) => lc(c.set).replace(/\b(19|20)\d{2}(-\d{2,4})?\b/g, "").replace(/\s+/g, " ").trim();

const isGraded = (c: PcInput) => Boolean(c.graded || (c.grader ?? "").trim());
const graderIs = (c: PcInput, g: string) => lc(c.grader).trim() === g;
const gradeIs = (c: PcInput, g: string) => {
  const v = (c.grade ?? "").trim().replace(/\.0+$/, "");
  return v === g;
};
const cardNoIs = (c: PcInput, n: string) => (c.cardNumber ?? "").trim().replace(/^#/, "").replace(/\.0+$/, "") === n;

/** Kobe slabs bought after this date are flagged for review, not auto-PC. */
export const KOBE_REVIEW_AFTER = "2026-11-27";

// -------------------------------------------------------------------- RULES

export const PC_RULES: PcRule[] = [
  // ---- explicit business exceptions (first, so nothing below overrides them)
  {
    id: "kobe_1996_topps_138_psa7_business",
    kind: "not_pc",
    description: "1996-97 Topps #138 Kobe Bryant PSA 7 is a business hold, not PC",
    test: (c) =>
      playerIs(c, "kobe bryant") && pcYear(c) === 1996 && setCore(c) === "topps" &&
      cardNoIs(c, "138") && graderIs(c, "psa") && gradeIs(c, "7"),
  },

  // ---- personal collection
  {
    id: "player_ohtani",
    kind: "pc",
    description: "any Shohei Ohtani",
    test: (c) => playerIs(c, "ohtani"),
  },
  {
    id: "player_roki_sasaki",
    kind: "pc",
    description: "any Roki Sasaki",
    test: (c) => playerIs(c, "roki sasaki"),
  },
  {
    id: "player_yamamoto",
    kind: "pc",
    description: "any Yamamoto (Yoshinobu Yamamoto), matched on player",
    test: (c) => has(c.player, "yamamoto"),
  },
  {
    id: "set_2025_topps_heritage",
    kind: "pc",
    description: "2025 Topps Heritage (any card in the set; 2026 Heritage is business)",
    test: (c) => pcYear(c) === 2025 && (has(c.set, "topps heritage") || (!c.set && has(c.title, "topps heritage"))),
  },
  {
    id: "kobe_2008_topps_orange_psa25",
    kind: "pc",
    description: "2008-09 Topps Kobe Bryant Orange PSA 2.5",
    // Raw-read copies match too: CDP is known to read this slab as raw
    // (spec 4: "Kobe Orange PSA 2.5 read as raw"). A slab of it at any OTHER
    // grade is not this card and falls through to the review rule.
    test: (c) =>
      playerIs(c, "kobe bryant") && pcYear(c) === 2008 && setCore(c) === "topps" &&
      (has(c.parallel, "orange") || has(c.title, "orange")) &&
      (!isGraded(c) || (graderIs(c, "psa") && gradeIs(c, "2.5"))),
    note: (c) => (isGraded(c) ? null : "CDP read this as raw; the PC copy is the PSA 2.5 slab (known rescan). Grader/grade not filled in — check the slab."),
  },

  // ---- review
  {
    id: "kobe_slab_after_2026_11_27",
    kind: "review",
    description: `any other graded Kobe Bryant bought after ${KOBE_REVIEW_AFTER}: review, not auto-PC`,
    test: (c) => playerIs(c, "kobe bryant") && isGraded(c) && Boolean(c.purchaseDate) && c.purchaseDate! > KOBE_REVIEW_AFTER,
  },
];

/** First matching rule wins. No match = business ("none"). */
export function classifyPc(c: PcInput, rules: PcRule[] = PC_RULES): PcVerdict {
  for (const r of rules) {
    if (r.test(c)) return { kind: r.kind, ruleId: r.id, description: r.description, note: r.note?.(c) ?? null };
  }
  return { kind: "none", ruleId: null, description: null, note: null };
}

export const isPersonalCollection = (c: PcInput) => classifyPc(c).kind === "pc";
