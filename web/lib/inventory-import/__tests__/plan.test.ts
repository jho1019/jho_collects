import { describe, expect, it } from "vitest";
import { parseOverrides, OverridesError, type Overrides } from "../overrides";
import { parseInventoryCsv } from "../parse";
import { bucketFor, contradiction, planImport, type Existing, type Mode, type PlanInput } from "../plan";
import { card, cdpCsv, row, type Cells } from "./helpers";

const EMPTY: Existing = { cards: [], bulk_lots: [] };

function plan(rows: Cells[], o: Partial<Omit<PlanInput, "parsed">> & { mode?: Mode; overrides?: Overrides } = {}) {
  return planImport({
    file: "t.csv", parsed: parseInventoryCsv(cdpCsv(rows, { extra: ["bucket", "pc_flag"] })), mode: o.mode ?? "bulk",
    existing: o.existing ?? EMPTY, overrides: o.overrides, valuedOn: "2026-11-27", batchId: "cdp-1",
    prior: o.prior, fuzzyThreshold: o.fuzzyThreshold,
  });
}
const ov = (d: unknown) => parseOverrides(d);

describe("bucket thresholds (round down)", () => {
  it.each([
    ["0.01", "1"], ["1.00", "1"], ["1.99", "1"], ["2.00", "3"], ["3.00", "3"], ["3.99", "3"],
    ["4.00", "5"], ["5.00", "5"], ["5.99", "5"], ["6.00", "6_20"], ["20.00", "6_20"], ["20.01", null],
  ])("$%s -> %s", (price, bucket) => {
    expect(bucketFor(Math.round(Number(price) * 100))).toBe(bucket);
  });

  it("bulk mode: <= $20 raw -> bulk; > $20 -> card (intent null); graded <= $20 -> card", () => {
    const p = plan([row({ market_price: "2.50" }), row({ market_price: "20.01" }), row({ market_price: "4", graded: "Yes", grader: "PSA", grade_number: "9" })]);
    expect(p.rows.map((r) => [r.outcome, r.bucket])).toEqual([["bulk", "3"], ["insert", null], ["insert", null]]);
    expect(p.rows[1].card).toMatchObject({ category: "business", intent: null });
    expect(p.rows[2].card).toMatchObject({ grader: "PSA", grade: "9" });
  });

  it("fixed unit prices for 1/3/5; 6_20 = average market price", () => {
    const p = plan([row({ market_price: "0.99" }), row({ market_price: "1.00" }), row({ market_price: "8.59" }), row({ market_price: "15.00" }), row({ market_price: "6.02" })]);
    expect(p.lots.map((l) => [l.bucket, l.delta, l.unit_price, l.resulting_total_value])).toEqual([
      ["1", 2, "1.00", "2.00"],
      ["6_20", 3, "9.87", "29.61"], // (8.59 + 15.00 + 6.02) / 3 = 9.87
    ]);
    expect(p.lots[1].batch_sum).toBe("29.61");
  });

  it("round down at the plan level: $1.99 -> $1 box at 1.00, $2.00 -> $3 box at 3.00, $5.99 -> $5 box", () => {
    const p = plan([row({ market_price: "1.99" }), row({ market_price: "2.00" }), row({ market_price: "3.99" }), row({ market_price: "5.99" }), row({ market_price: "6.00" })]);
    expect(p.lots.map((l) => [l.bucket, l.delta, l.unit_price])).toEqual([
      ["1", 1, "1.00"], ["3", 2, "3.00"], ["5", 1, "5.00"], ["6_20", 1, "6.00"],
    ]);
  });

  it("6_20 weighted average with the existing lot", () => {
    const existing: Existing = { cards: [], bulk_lots: [{ bucket: "6_20", location: null, card_count: 10, unit_price: "12.00" }] };
    const p = plan([row({ market_price: "6.00" }), row({ market_price: "10.00" })], { existing });
    // (10 * 12.00 + 16.00) / 12 = 11.333 -> 11.33
    expect(p.lots[0]).toMatchObject({ existing_count: 10, delta: 2, resulting_count: 12, unit_price: "11.33", resulting_total_value: "135.96" });
  });

  it("one lot per bucket per location (box, else cabinet/shelf/row/section)", () => {
    const p = plan([row({ box: "B1" }), row({ box: "B1" }), row({ box: "B2" }), row({ cabinet: "A", shelf: "2" })]);
    expect(p.lots.map((l) => [l.location, l.delta])).toEqual([["B1", 2], ["B2", 1], ["Cabinet A / Shelf 2", 1]]);
  });
});

describe("holds mode", () => {
  it("every card -> cards row with intent hold, regardless of price", () => {
    const p = plan([row({ market_price: "0.99" }), row({ market_price: "76.0" }), row({ market_price: "" })], { mode: "holds" });
    expect(p.rows.map((r) => [r.outcome, r.card?.intent])).toEqual([["insert", "hold"], ["insert", "hold"], ["insert", "hold"]]);
    expect(p.lots).toEqual([]);
    expect(p.rows[2].flags.find((f) => f.code === "missing_value")).toBeUndefined();
  });
  it("PC wins over holds: category pc, intent null", () => {
    const p = plan([row({ player: "Shohei Ohtani", market_price: "3" })], { mode: "holds" });
    expect(p.rows[0].card).toMatchObject({ category: "pc", intent: null });
  });
});

describe("PC in bulk mode", () => {
  it("a $3 Ohtani is a cards row (pc), not a $3 bulk card; 2026 Heritage at $2.50 goes to the $3 box", () => {
    const p = plan([
      row({ player: "Shohei Ohtani", market_price: "3.00" }),
      row({ title: "2026 Topps Heritage #144 Jacob Misiorowski", player: "Jacob Misiorowski", year: "2026", set: "2026 Topps Heritage", market_price: "2.50", bucket: "PC", pc_flag: "Yes" }),
    ]);
    expect(p.rows[0]).toMatchObject({ outcome: "insert", card: { category: "pc", intent: null } });
    expect(p.rows[1]).toMatchObject({ outcome: "bulk", bucket: "3" });
    expect(p.rows[1].bowser).toMatchObject({ bucket: "PC", ours: "$3", agrees_bucket: false, agrees_pc: false });
    expect(p.totals.bowser_disagreements).toBe(1);
  });

  it("Heritage PC is decided by year alone, never by Bowser's pc_flag", () => {
    const heritage = (year: string, pc_flag: string, sku: string) =>
      row({ title: `${year} Topps Heritage #1 Someone`, player: "Someone", year, set: `${year} Topps Heritage`, market_price: "2.22", pc_flag, sku });
    const p = plan([heritage("2026", "No", "218"), heritage("2026", "Yes", "219"), heritage("2025", "No", "344")]);
    expect(p.rows.map((r) => [r.cdp_sku, r.outcome, r.card?.category ?? null, r.bucket])).toEqual([
      ["218", "bulk", null, "3"], ["219", "bulk", null, "3"], ["344", "insert", "pc", null],
    ]);
    expect(p.rows[2].pc).toMatchObject({ kind: "pc", ruleId: "set_2025_topps_heritage" });
  });

  it("review_kobe excludes the row until an override settles it", () => {
    const kobe = row({ player: "Kobe Bryant", year: "1997", set: "1997-98 Fleer", graded: "Yes", grader: "PSA", grade_number: "8", purchase_date: "2026-12-01", market_price: "40", sku: "900" });
    const p = plan([kobe]);
    expect(p.rows[0]).toMatchObject({ outcome: "excluded", would_be: "insert" });
    expect(p.rows[0].flags.map((f) => f.code)).toContain("review_kobe");
    expect(p.totals.unresolved_blocking).toBe(1);
    const p2 = plan([kobe], { overrides: ov({ rows: [{ cdp_sku: "900", category: "pc" }] }) });
    expect(p2.rows[0]).toMatchObject({ outcome: "insert", card: { category: "pc", intent: null } });
    expect(p2.rows[0].flags.find((f) => f.code === "review_kobe")).toMatchObject({ resolved: true });
  });
});

describe("money and mapping", () => {
  it("purchase_price 0 / blank -> acquisition_cost null; non-zero kept; date -> acquired_on", () => {
    const p = plan([
      row({ market_price: "30", purchase_price: "0.0" }),
      row({ market_price: "30", purchase_price: "" }),
      row({ market_price: "30", purchase_price: "12.50", purchase_date: "2026-11-20" }),
    ]);
    expect(p.rows.map((r) => r.card!.acquisition_cost)).toEqual([null, null, "12.50"]);
    expect(p.rows[2].card!.acquired_on).toBe("2026-11-20");
  });

  it("market_price -> est_value (cdp, valued_on); never a cost; sku -> cdp_sku, never sku", () => {
    const p = plan([row({ market_price: "24.990000000000002", sku: "312.0" })]);
    expect(p.rows[0].card).toMatchObject({ est_value: "24.99", est_value_source: "cdp", est_valued_on: "2026-11-27", cdp_sku: "312", acquisition_cost: null });
    expect(p.rows[0].card).not.toHaveProperty("sku");
  });

  it("parallel = subset + variation; serial never invented; notes concise", () => {
    const p = plan([row({
      title: "2022 Donruss Optic #141 Shohei Ohtani Orange Prizm #/125", player: "Shohei Ohtani", subset: "Orange Prizm", variation: ": Image variation",
      attributes: "SN", note: "Luminence; ", market_price: "12",
    })]);
    expect(p.rows[0].card).toMatchObject({ parallel: "Orange Prizm, Image variation", serial_number: null, notes: "SN · numbered /125 · CDP note: Luminence" });
  });

  it("missing market price in bulk mode: flagged, not bucketed", () => {
    const p = plan([row({ market_price: "", sku: "258" })]);
    expect(p.rows[0]).toMatchObject({ outcome: "excluded", would_be: null, bucket: null });
    expect(p.rows[0].flags[0]).toMatchObject({ code: "missing_value", blocking: true, resolved: false });
    expect(p.lots).toEqual([]);
  });
});

describe("matching order", () => {
  const existing: Existing = {
    cards: [
      card({ id: 1, title: "by sku", cdp_sku: "500", grader: "PSA", cert_number: "111" }),
      card({ id: 2, title: "by cert", grader: "PSA", cert_number: "222", acquisition_cost: "105.00", list_price: "150.00", category: "business" }),
      card({ id: 3, title: "1996 Topps Kobe Bryant #138 PSA 7", player: "Kobe Bryant", year: "1996", set_name: "Topps", grader: "PSA", grade: "7", card_number: "138" }),
    ],
    bulk_lots: [],
  };

  it("cdp_sku beats cert", () => {
    const p = plan([row({ sku: "500", graded: "Yes", grader: "PSA", certification_number: "222", market_price: "50" })], { existing });
    expect(p.rows[0].match).toMatchObject({ card_id: 1, by: "cdp_sku" });
  });

  it("cert when no sku match; never overwrites cost / list price / category", () => {
    const p = plan([row({ sku: "501", graded: "Yes", grader: "PSA", grade_number: "10", certification_number: "222", market_price: "50", purchase_price: "80" })], { existing });
    expect(p.rows[0]).toMatchObject({ outcome: "update", match: { card_id: 2, by: "cert" } });
    expect(p.rows[0].fills).toEqual(expect.arrayContaining(["cdp_sku", "grade", "est_value"]));
    expect(p.rows[0].fills).not.toContain("acquisition_cost");
    expect(p.rows[0].fills).not.toContain("list_price");
    expect(p.rows[0].fills).not.toContain("category");
  });

  it("a bulk-priced rescan of a tracked card updates the card, not the bulk lot", () => {
    const p = plan([row({ sku: "500", market_price: "2.00" })], { existing });
    expect(p.rows[0]).toMatchObject({ outcome: "update", bucket: null });
    expect(p.lots).toEqual([]);
  });

  it("fuzzy title match -> possible_duplicate (excluded), not merged; score reported", () => {
    const p = plan([row({ title: "1996-97 Topps #138 Kobe Bryant PSA 7", player: "Kobe Bryant", year: "1996", set: "1996-97 Topps", card_number: "138", graded: "Yes", grader: "PSA", grade_number: "7", market_price: "86", sku: "291" })], { existing });
    expect(p.rows[0]).toMatchObject({ outcome: "excluded", would_be: "insert", match: null });
    expect(p.rows[0].candidates[0]).toMatchObject({ card_id: 3, source: "db" });
    expect(p.rows[0].candidates[0].score).toBeGreaterThan(0.6);
    expect(p.rows[0].flags.map((f) => f.code)).toContain("possible_duplicate");
  });

  it("contradicting year / grade never flags, however similar", () => {
    expect(contradiction({ year: "1998", grader: null } as never, card({ id: 9, title: "1996 Skybox Kobe", year: "1996" }))).toBe("year 1998 vs 1996");
    expect(contradiction({ year: "2025", grader: null } as never, card({ id: 9, title: "x", year: "2025", grader: "PSA", grade: "9" }))).toBe("raw vs graded");
  });

  it("matching a sold/traded card by sku blocks", () => {
    const p = plan([row({ sku: "700", market_price: "30" })], { existing: { cards: [card({ id: 7, title: "gone", cdp_sku: "700", status: "traded" })], bulk_lots: [] } });
    expect(p.rows[0].flags.map((f) => f.code)).toContain("matched_exited_card");
    expect(p.rows[0].outcome).toBe("excluded");
  });
});

describe("duplicates", () => {
  it("within the batch: same card twice -> duplicate_scan (bulk, both counted) / possible_duplicate (card)", () => {
    const same = { title: "SGA Dominance", player: "SGA", card_number: "22", year: "2023", set: "2023-24 Panini Prizm", subset: "Dominance" };
    const p = plan([row({ ...same, market_price: "1.99" }), row({ ...same, market_price: "1.99" })]);
    expect(p.rows[1].flags.map((f) => f.code)).toEqual(["duplicate_scan"]);
    expect(p.lots[0].delta).toBe(2);
    const p2 = plan([row({ ...same, market_price: "40" }), row({ ...same, market_price: "40" })]);
    expect(p2.rows.map((r) => r.outcome)).toEqual(["insert", "excluded"]);
  });

  it("duplicate cdp sku in the batch blocks", () => {
    const p = plan([row({ sku: "5" , market_price: "30"}), row({ sku: "5", market_price: "40" })]);
    expect(p.rows[1].flags.map((f) => f.code)).toContain("duplicate_sku");
  });

  it("across files (prior)", () => {
    const priorRow = row({ title: "Bronny", player: "Bronny James Jr.", card_number: "243", market_price: "2.00", year: "2024", set: "2024-25 Panini Prizm" });
    const prior = [{ name: "lowend.csv", rows: parseInventoryCsv(cdpCsv([priorRow])).rows }];
    const p = plan([{ ...priorRow, sku: "276" }], { prior });
    expect(p.rows[0].flags.map((f) => f.code)).toEqual(["duplicate_scan"]);
    expect(p.rows[0].candidates[0]).toMatchObject({ source: "prior_file", file: "lowend.csv" });
  });
});

describe("overrides win", () => {
  it("validates the document", () => {
    expect(() => ov({ rows: [{ action: "skip" }] })).toThrow(OverridesError);
    expect(() => ov({ rows: [{ cdp_sku: "1", category: "pc", intent: "hold" }] })).toThrow(/intent/);
    expect(() => ov({ bulk_counts: [{ bucket: "2", count: 1 }] })).toThrow(/bucket/);
    expect(() => ov({ nope: [] })).toThrow(/unknown top-level/);
  });

  it("force card row, force bucket, skip, category / intent / list price", () => {
    const p = plan([
      row({ sku: "1", market_price: "2.00" }),
      row({ sku: "2", market_price: "30.00" }),
      row({ sku: "3", market_price: "" }),
      row({ sku: "4", market_price: "5" }),
      row({ sku: "5", player: "Shohei Ohtani", market_price: "3" }),
    ], { overrides: ov({ rows: [
      { cdp_sku: "1", action: "card", intent: "sell", list_price: "4.99" },
      { cdp_sku: "2", action: "bulk", bucket: "6_20" },
      { cdp_sku: "3", action: "bulk", bucket: "1" },
      { cdp_sku: "4", action: "skip" },
      { cdp_sku: "5", category: "business", intent: "hold" },
    ] }) });
    expect(p.rows.map((r) => r.outcome)).toEqual(["insert", "bulk", "bulk", "skip", "insert"]);
    expect(p.rows[0].card).toMatchObject({ intent: "sell", list_price: "4.99" });
    expect(p.rows[2].bucket).toBe("1");
    expect(p.rows[4].card).toMatchObject({ category: "business", intent: "hold" });
    expect(p.totals.unresolved_blocking).toBe(0);
  });

  it("merge into an existing card id (resolves a possible duplicate)", () => {
    const existing: Existing = { cards: [card({ id: 9, title: "1996 Topps Kobe Bryant #138 PSA 7", player: "Kobe Bryant", year: "1996", set_name: "Topps", grader: "PSA", grade: "7", card_number: "138" })], bulk_lots: [] };
    const r = row({ title: "1996-97 Topps #138 Kobe Bryant PSA 7", player: "Kobe Bryant", year: "1996", set: "1996-97 Topps", card_number: "138", graded: "Yes", grader: "PSA", grade_number: "7", market_price: "86", sku: "291" });
    const p = plan([r], { mode: "holds", existing, overrides: ov({ rows: [{ cdp_sku: "291", action: "merge", card_id: 9 }] }) });
    expect(p.rows[0]).toMatchObject({ outcome: "update", match: { card_id: 9, by: "override" } });
    expect(p.rows[0].fills).toEqual(expect.arrayContaining(["cdp_sku", "intent", "est_value"]));
  });

  it("hand counts replace CDP bucket counts; 6_20 keeps the scanned average", () => {
    const p = plan([row({ market_price: "1" }), row({ market_price: "1" }), row({ market_price: "10" }), row({ market_price: "6" })],
      { overrides: ov({ bulk_counts: [{ bucket: "1", count: 25 }, { bucket: "6_20", count: 4 }, { bucket: "5", location: "B9", count: 3 }] }) });
    expect(p.lots.map((l) => [l.bucket, l.location, l.scanned, l.delta, l.hand_count, l.unit_price])).toEqual([
      ["1", null, 2, 25, true, "1.00"],
      ["5", "B9", 0, 3, true, "5.00"],
      ["6_20", null, 2, 4, true, "8.00"],
    ]);
    expect(p.lots[2].batch_sum).toBe("32");
  });

  it("a hand count of 0 adds nothing to that box (its cards were in an earlier count)", () => {
    const p = plan([row({ market_price: "2.50" }), row({ market_price: "8" })],
      { overrides: ov({ bulk_counts: [{ bucket: "3", count: 0 }, { bucket: "6_20", count: 0 }] }) });
    expect(p.lots).toEqual([]);
    expect(p.totals.bulk_cards_added).toBe(0);
    expect(p.warnings.filter((w) => /hand count 0/.test(w))).toHaveLength(2);
  });

  it("manual adds", () => {
    const p = plan([], { overrides: ov({ manual_adds: [{ title: "Acuna HRK Auto Purple", player: "Ronald Acuna Jr.", list_price: "199.99", intent: "sell" }] }) });
    expect(p.rows[0]).toMatchObject({ source: "manual", outcome: "insert", card: { title: "Acuna HRK Auto Purple", intent: "sell", list_price: "199.99", category: "business" } });
  });

  it("a manual add can name its est_value_source (grader/grade carried; source needs a value)", () => {
    const p = plan([], { overrides: ov({ manual_adds: [{
      title: "2008-09 Topps #24 Kobe Bryant Orange PSA 2.5", set_name: "2008-09 Topps", card_number: "24",
      grader: "PSA", grade: "2.5", category: "pc", intent: null, est_value: "600.00", est_value_source: "cdp",
    }] }) });
    expect(p.rows[0]).toMatchObject({ source: "manual", outcome: "insert", cdp_sku: null,
      card: { category: "pc", intent: null, grader: "PSA", grade: "2.5", cert_number: null, est_value: "600.00", est_value_source: "cdp" } });
    const bare = plan([], { overrides: ov({ manual_adds: [{ title: "x", est_value: "5" }] }) });
    expect(bare.rows[0].card?.est_value_source).toBeNull();
    expect(() => ov({ manual_adds: [{ title: "x", est_value_source: "cdp" }] })).toThrow(/est_value_source needs est_value/);
  });

  it("an override that matches nothing is reported", () => {
    const p = plan([row()], { overrides: ov({ rows: [{ cdp_sku: "nope", action: "skip" }] }) });
    expect(p.warnings[0]).toMatch(/matched no row/);
  });
});

describe("rerun awareness", () => {
  it("a batch whose marker is already in bulk_lot_events adds nothing in the dry run", () => {
    const existing: Existing = {
      cards: [], bulk_lots: [{ bucket: "1", location: null, card_count: 12, unit_price: "1.00" }],
      bulk_lot_events: [{ notes: "cdp-import:cdp-1:1:" }],
    };
    const p = plan([row({ market_price: "1" })], { existing });
    expect(p.lots[0]).toMatchObject({ already_applied: true, resulting_count: 12 });
    expect(p.totals.bulk_cards_added).toBe(0);
  });
});

describe("override safety", () => {
  it("an intent override on a row matching an existing pc card is rejected in the plan, not at apply time", () => {
    const existing: Existing = { cards: [card({ id: 5, title: "pc ohtani", cdp_sku: "77", category: "pc" })], bulk_lots: [] };
    const p = plan([row({ sku: "77", market_price: "30" })], { existing, overrides: ov({ rows: [{ cdp_sku: "77", intent: "sell" }] }) });
    expect(p.rows[0].outcome).toBe("excluded");
    expect(p.rows[0].flags.map((f) => f.code)).toContain("invalid_override");
  });
});
