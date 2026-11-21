// ============================================================================
// Trading-card condition -> eBay Inventory API condition + conditionDescriptors
// ============================================================================
//
// eBay's trading-card categories (261328 et al.) use exactly two conditions,
// each with REQUIRED condition descriptors:
//
//   Graded    conditionId 2750  Inventory enum LIKE_NEW
//     27501  Professional Grader      values: one value ID   (GRADER_IDS)
//     27502  Grade                    values: one value ID   (GRADE_IDS)
//     27503  Certification Number     additionalInfo: free text, <= 30 chars
//
//   Ungraded  conditionId 4000  Inventory enum USED_VERY_GOOD
//     40001  Card Condition           values: one value ID   (CARD_CONDITION_IDS)
//
// Verified from the real CDP export: an ungraded row carries ConditionID 4000
// and `CD:Card Condition - (ID: 40001)` = 400010 ("Near Mint or Better").
//
// ⚠ UNVERIFIED AGAINST LIVE eBAY ⚠
// Everything else here — the 2750/4000 -> enum mapping, and EVERY value ID in
// the three tables below other than 400010 — is from eBay's published docs as
// remembered, not checked against a live keyset. Before the first real
// GRADED publish, call the Metadata API
//   GET /sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies?filter=categoryIds:{261328}
// and compare. The tables are plain objects so correcting one is a one-line
// edit. An already-numeric value ID in the CSV is passed through untouched,
// so CDP's own IDs always win over these tables.
//
// A grader or grade that cannot be mapped FAILS that row's validation. It is
// never guessed, never defaulted.
// ============================================================================

export const CONDITION_GRADED = "2750";
export const CONDITION_UNGRADED = "4000";

export const DESCRIPTOR_GRADER = "27501";
export const DESCRIPTOR_GRADE = "27502";
export const DESCRIPTOR_CERT = "27503";
export const DESCRIPTOR_CARD_CONDITION = "40001";

/** Inventory API takes an enum, not the numeric condition ID. UNVERIFIED mapping. */
export const CONDITION_ENUM: Record<string, string> = {
  [CONDITION_GRADED]: "LIKE_NEW",
  [CONDITION_UNGRADED]: "USED_VERY_GOOD",
};

/** Keys are lower-case aliases (abbreviation and full name). UNVERIFIED value IDs. */
export const GRADER_IDS: Record<string, string> = {
  psa: "275010", "professional sports authenticator": "275010", "professional sports authenticator (psa)": "275010",
  bccg: "275011", "beckett collectors club grading": "275011",
  bvg: "275012", "beckett vintage grading": "275012",
  bgs: "275013", beckett: "275013", "beckett grading services": "275013", "beckett grading services (bgs)": "275013",
  csg: "275014", "certified sports guaranty": "275014",
  cgc: "275015", "certified guaranty company": "275015",
  sgc: "275016", "sportscard guaranty corporation": "275016", "sportscard guaranty": "275016",
  ksa: "275017", gma: "275018", hga: "275019",
  isa: "2750110", pca: "2750111", gsg: "2750112", pgs: "2750113", mnt: "2750114",
  tag: "2750115", "technical authentication & grading": "2750115",
  rare: "2750116", rcg: "2750117", ace: "2750119", cga: "2750120", tcg: "2750121", ark: "2750122",
  other: "2750123",
};

/**
 * Full "Professional Grader" aspect value for Browse `aspect_filter` (comps),
 * keyed by value ID. The STRINGS were verified live against production Browse
 * on 2026-11-21 (refinement.aspectDistributions, category 261328); the value
 * IDs they hang off are still the unverified ones above. Graders absent here
 * (PCA, ACE, ARK, other) did not appear in eBay's distribution.
 *
 * Exact strings matter: eBay silently IGNORES an aspect_filter value it does
 * not recognise (e.g. "PSA") and returns unfiltered results, so comps refuse a
 * grader with no entry here rather than send a raw value.
 */
export const GRADER_ASPECT_NAMES: Record<string, string> = {
  "275010": "Professional Sports Authenticator (PSA)",
  "275011": "Beckett Collectors Club Grading (BCCG)",
  "275012": "Beckett Vintage Grading (BVG)",
  "275013": "Beckett Grading Services (BGS)",
  "275014": "Certified Sports Guaranty (CSG)",
  "275015": "Certified Guaranty Company (CGC)",
  "275016": "Sportscard Guaranty Corporation (SGC)",
  "275017": "K Sportscard Authentication (KSA)",
  "275018": "Gem Mint Authentication (GMA)",
  "275019": "Hybrid Grading Approach (HGA)",
  "2750110": "International Sports Authentication (ISA)",
  "2750112": "Gold Standard Grading (GSG)",
  "2750113": "Platin Grading Service (PGS)",
  "2750114": "MNT Grading (MNT)",
  "2750115": "Technical Authentication & Grading (TAG)",
  "2750116": "Rare Edition (Rare)",
  "2750117": "Revolution Card Grading (RCG)",
  "2750120": "Card Grading Australia (CGA)",
  "2750121": "Trading Card Grading (TCG)",
};

/**
 * "Grade" aspect values for Browse, keyed by lower-case input. Verified live
 * 2026-11-21: "1".."10" in half steps, "Authentic", "Authentic Altered",
 * "Authentic - Trimmed". Same silent-ignore hazard as graders.
 */
export const GRADE_ASPECT_VALUES: Record<string, string> = {
  ...Object.fromEntries(Array.from({ length: 19 }, (_, i) => String(1 + i / 2)).map((g) => [g, g])),
  authentic: "Authentic",
  "authentic altered": "Authentic Altered",
  "authentic - trimmed": "Authentic - Trimmed",
};

/** Grade string -> value ID. UNVERIFIED. */
export const GRADE_IDS: Record<string, string> = {
  "10": "275020", "9.5": "275021", "9": "275022", "8.5": "275023", "8": "275024",
  "7.5": "275025", "7": "275026", "6.5": "275027", "6": "275028", "5.5": "275029",
  "5": "2750210", "4.5": "2750211", "4": "2750212", "3.5": "2750213", "3": "2750214",
  "2.5": "2750215", "2": "2750216", "1.5": "2750217", "1": "2750218",
  authentic: "2750219", "authentic altered": "2750220", "authentic - trimmed": "2750221",
  "authentic - coloured": "2750222",
};

/** Card Condition (ungraded). 400010 verified from the CDP export; the rest UNVERIFIED. */
export const CARD_CONDITION_IDS: Record<string, string> = {
  "near mint or better": "400010", "near mint": "400010", nm: "400010", "nm-mt": "400010",
  excellent: "400011", ex: "400011",
  "very good": "400012", vg: "400012",
  poor: "400013",
};

export interface ConditionDescriptor {
  name: string;
  values?: string[];
  additionalInfo?: string;
}

export interface ConditionInput {
  conditionId?: string;
  graded?: string;
  grader?: string;
  grade?: string;
  certNumber?: string;
  cardCondition?: string;
}

export interface ConditionResult {
  graded: boolean;
  conditionId: string;
  condition: string;
  conditionDescriptors: ConditionDescriptor[];
}

const yes = (v?: string) => /^(y|yes|true|1)$/i.test((v ?? "").trim());
const no = (v?: string) => /^(n|no|false|0)$/i.test((v ?? "").trim());

/** A value already in eBay's ID form for this descriptor ("275010" for 27501). */
function passThroughId(descriptor: string, v: string): string | null {
  return new RegExp(`^${descriptor}\\d{1,3}$`).test(v) ? v : null;
}

function normGrade(v: string): string {
  const t = v.trim().toLowerCase().replace(/^(gem\s*mint|gem\s*mt|mint|nm-mt|pristine|black label)\s*/i, "");
  const n = Number(t);
  return Number.isFinite(n) && t !== "" ? String(n) : t;
}

/** Returns the condition, or a list of human-readable errors. Never guesses. */
export function buildCondition(input: ConditionInput): { ok: true; value: ConditionResult } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const cid = input.conditionId?.trim() || "";
  if (cid && cid !== CONDITION_GRADED && cid !== CONDITION_UNGRADED) {
    errors.push(`ConditionID ${cid} is not a trading-card condition (expected ${CONDITION_GRADED} graded or ${CONDITION_UNGRADED} ungraded)`);
    return { ok: false, errors };
  }
  let graded: boolean;
  if (yes(input.graded)) graded = true;
  else if (no(input.graded)) graded = false;
  else if (cid) graded = cid === CONDITION_GRADED;
  else graded = Boolean(input.grader?.trim() || input.grade?.trim());

  if (cid && (cid === CONDITION_GRADED) !== graded) {
    errors.push(`Graded=${input.graded} contradicts ConditionID ${cid}`);
    return { ok: false, errors };
  }

  if (!graded) {
    const raw = input.cardCondition?.trim() ?? "";
    if (!raw) {
      errors.push(`ungraded card needs a Card Condition (descriptor ${DESCRIPTOR_CARD_CONDITION}), e.g. 400010 / "Near Mint or Better"`);
      return { ok: false, errors };
    }
    const id = passThroughId(DESCRIPTOR_CARD_CONDITION, raw) ?? CARD_CONDITION_IDS[raw.toLowerCase()];
    if (!id) {
      errors.push(`unknown Card Condition "${raw}"; use a value ID (4000xx) or one of: ${Object.keys(CARD_CONDITION_IDS).join(", ")}`);
      return { ok: false, errors };
    }
    return {
      ok: true,
      value: {
        graded: false,
        conditionId: CONDITION_UNGRADED,
        condition: CONDITION_ENUM[CONDITION_UNGRADED],
        conditionDescriptors: [{ name: DESCRIPTOR_CARD_CONDITION, values: [id] }],
      },
    };
  }

  const graderRaw = input.grader?.trim() ?? "";
  const gradeRaw = input.grade?.trim() ?? "";
  const graderId = graderRaw && (passThroughId(DESCRIPTOR_GRADER, graderRaw) ?? GRADER_IDS[graderRaw.toLowerCase()]);
  const gradeId = gradeRaw && (passThroughId(DESCRIPTOR_GRADE, gradeRaw) ?? GRADE_IDS[normGrade(gradeRaw)]);
  if (!graderRaw) errors.push(`graded card needs a Professional Grader (descriptor ${DESCRIPTOR_GRADER})`);
  else if (!graderId) errors.push(`unknown grader "${graderRaw}"; add it to GRADER_IDS in cdp/conditions.ts or pass the eBay value ID`);
  if (!gradeRaw) errors.push(`graded card needs a Grade (descriptor ${DESCRIPTOR_GRADE})`);
  else if (!gradeId) errors.push(`unknown grade "${gradeRaw}"; add it to GRADE_IDS in cdp/conditions.ts or pass the eBay value ID`);
  const cert = input.certNumber?.trim() ?? "";
  if (cert.length > 30) errors.push(`certification number is ${cert.length} chars; eBay allows 30`);
  if (errors.length) return { ok: false, errors };

  const descriptors: ConditionDescriptor[] = [
    { name: DESCRIPTOR_GRADER, values: [graderId as string] },
    { name: DESCRIPTOR_GRADE, values: [gradeId as string] },
  ];
  if (cert) descriptors.push({ name: DESCRIPTOR_CERT, additionalInfo: cert });
  return {
    ok: true,
    value: {
      graded: true,
      conditionId: CONDITION_GRADED,
      condition: CONDITION_ENUM[CONDITION_GRADED],
      conditionDescriptors: descriptors,
    },
  };
}
