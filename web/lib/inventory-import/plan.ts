import { NO_OVERRIDES, type Bucket, type Category, type Intent, type ManualAdd, type Overrides, type RowOverride } from "./overrides";
import { centsToMoney, intish, type BlankRow, type InvRow, type ParsedInventory } from "./parse";
import { classifyPc, type PcInput, type PcVerdict } from "./pc-rules";
import { searchText, similarity } from "./trigram";

// ============================================================================
// classify + match + plan.                                    Pure, no I/O.
// ============================================================================
//
// Input: parsed CDP rows, the batch mode, the owner's existing cards and bulk
// lots (a snapshot), and Johnny's overrides. Output: a Plan — every row's
// outcome (insert / update / bulk / skip / excluded), the bulk-lot increments,
// flags and totals. The SQL emitter (sql.ts) and the reports (report.ts) only
// read a Plan; nothing here touches a database.
//
// Precedence, highest first:
//   1. overrides (rows[] by cdp_sku / cert / line; bulk_counts; manual_adds)
//   2. exact match against an existing card (cdp_sku, then grader+cert) -> update
//   3. PC rules (pc-rules.ts)              -> cards row, category pc, intent null
//   4. mode: holds                         -> cards row, intent 'hold'
//            bulk: graded or > $20         -> cards row, intent null
//                  <= $20                  -> bulk_lots increment
//                  no market price         -> flag missing_value
// Fuzzy title matches never merge on their own; they flag possible_duplicate.
// ============================================================================

export type Mode = "bulk" | "holds";
export const DEFAULT_FUZZY_THRESHOLD = 0.55;
const CANDIDATE_FLOOR = 0.45; // near-misses shown for context, never flagged

export interface ExistingCard {
  id: number;
  title: string;
  player?: string | null;
  year?: string | null;
  set_name?: string | null;
  card_number?: string | null;
  parallel?: string | null;
  grader?: string | null;
  grade?: string | null;
  cert_number?: string | null;
  sport?: string | null;
  serial_number?: string | null;
  sku?: string | null;
  cdp_sku?: string | null;
  status: string;
  category: string;
  intent?: string | null;
  location?: string | null;
  est_value?: number | string | null;
  est_value_source?: string | null;
  est_valued_on?: string | null;
  acquisition_cost?: number | string | null;
  acquired_on?: string | null;
  list_price?: number | string | null;
  notes?: string | null;
}

export interface ExistingLot {
  bucket: Bucket;
  location: string | null;
  card_count: number;
  unit_price: number | string;
}

export interface Existing {
  cards: ExistingCard[];
  bulk_lots: ExistingLot[];
  /** Optional: bulk_lot_events notes, so a dry run can tell a batch was already applied. */
  bulk_lot_events?: { notes: string | null }[];
}

/** A cards row as it would be written. Money as "12.34" strings. */
export interface CardDraft {
  title: string;
  player: string | null;
  year: string | null;
  set_name: string | null;
  card_number: string | null;
  parallel: string | null;
  grader: string | null;
  grade: string | null;
  cert_number: string | null;
  sport: string | null;
  serial_number: string | null;
  cdp_sku: string | null;
  location: string | null;
  category: Category;
  intent: Intent | null;
  list_price: string | null;
  est_value: string | null;
  est_value_source: "cdp" | null;
  est_valued_on: string | null;
  acquisition_cost: string | null;
  acquired_on: string | null;
  notes: string | null;
}

export type FlagCode =
  | "missing_value" | "review_kobe" | "possible_duplicate" | "duplicate_sku" | "missing_sku"
  | "matched_exited_card" | "invalid_override"
  // non-blocking
  | "pc" | "duplicate_scan" | "category_differs" | "pc_note";

export const BLOCKING: Record<FlagCode, boolean> = {
  missing_value: true, review_kobe: true, possible_duplicate: true, duplicate_sku: true, missing_sku: true,
  matched_exited_card: true, invalid_override: true,
  pc: false, duplicate_scan: false, category_differs: false, pc_note: false,
};

export interface Flag {
  code: FlagCode;
  blocking: boolean;
  /** A blocking flag the row's override settles. Resolved flags do not exclude the row. */
  resolved: boolean;
  message: string;
}

export interface Candidate {
  card_id: number;
  title: string;
  status: string;
  score: number;
  source: "db" | "batch" | "prior_file";
  /** Why a high-scoring db candidate was NOT flagged (different year, number, grade...). */
  contradiction?: string | null;
  file?: string;
  line?: number;
  cdp_sku?: string | null;
}

export type Outcome = "insert" | "update" | "bulk" | "skip" | "excluded";

export interface PlanRow {
  source: "cdp" | "manual";
  line: number | null;
  cdp_sku: string | null;
  title: string;
  market_price: string | null;
  outcome: Outcome;
  /** For excluded rows: what the row would become once its flags are resolved. */
  would_be: "insert" | "update" | "bulk" | null;
  bucket: Bucket | null;
  location: string | null;
  card: CardDraft | null;
  match: { card_id: number; by: "cdp_sku" | "cert" | "override"; title: string; status: string } | null;
  /** For updates: fields that would change, judged against the snapshot. */
  fills: string[];
  /** Best trigram score against existing held/listed cards (for the report), and close candidates. */
  best_score: number | null;
  candidates: Candidate[];
  pc: PcVerdict;
  flags: Flag[];
  warnings: string[];
  override: RowOverride | null;
  bowser: { bucket: string | null; pc_flag: string | null; ours: string; agrees_bucket: boolean | null; agrees_pc: boolean | null } | null;
}

export interface LotPlan {
  bucket: Bucket;
  location: string | null;
  /** Cards CDP scanned into this lot. */
  scanned: number;
  /** Cards this batch adds (Johnny's count when overridden). */
  delta: number;
  hand_count: boolean;
  existing_count: number;
  existing_unit_price: string | null;
  resulting_count: number;
  /** Unit price after the increment (weighted average for 6_20). */
  unit_price: string;
  resulting_total_value: string;
  /** Sum of market prices added (6_20 weighted-average input). Up to 4 dp. */
  batch_sum: string;
  skus: string[];
  /** Idempotency key written to bulk_lot_events.notes. */
  marker: string;
  /** The snapshot already has this marker: the SQL will skip the increment. */
  already_applied: boolean;
}

export interface Plan {
  batch_id: string;
  file: string;
  mode: Mode;
  valued_on: string;
  fuzzy_threshold: number;
  layout: ParsedInventory["layout"];
  header_line: number;
  rows_read: number;
  skipped_blank: (BlankRow & { bowser_bucket: string | null })[];
  rows: PlanRow[];
  lots: LotPlan[];
  totals: {
    rows_read: number;
    skipped_blank: number;
    inserts: number;
    updates: number;
    bulk_rows: number;
    bulk_cards_added: number;
    skipped_by_override: number;
    excluded: number;
    pc: number;
    manual_adds: number;
    insert_est_value: string;
    bulk_value_added: string;
    flags: Partial<Record<FlagCode, number>>;
    unresolved_blocking: number;
    bowser_disagreements: number;
  };
  warnings: string[];
}

export interface PriorFile {
  name: string;
  rows: InvRow[];
}

export interface PlanInput {
  file: string;
  parsed: ParsedInventory;
  mode: Mode;
  existing: Existing;
  overrides?: Overrides;
  valuedOn: string;
  batchId: string;
  /** Files applied BEFORE this one, for cross-file duplicate detection. */
  prior?: PriorFile[];
  fuzzyThreshold?: number;
}

// ------------------------------------------------------------------ helpers

export function bucketFor(cents: number): Bucket | null {
  if (cents <= 100) return "1";
  if (cents <= 300) return "3";
  if (cents <= 500) return "5";
  if (cents <= 2000) return "6_20";
  return null;
}
const FIXED_UNIT: Record<Exclude<Bucket, "6_20">, number> = { "1": 100, "3": 300, "5": 500 };

const toCentsNum = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === "" ? null : Math.round(Number(v) * 100);

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function locationOf(r: Pick<InvRow, "box" | "cabinet" | "shelf" | "row" | "section">): string | null {
  if (r.box) return r.box;
  const parts = ([["Cabinet", r.cabinet], ["Shelf", r.shelf], ["Row", r.row], ["Section", r.section]] as const)
    .filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(" / ") : null;
}

/** subset + variation. CDP writes variations as ": Running"; strip the colon. */
export function parallelOf(subset: string | null, variation: string | null): string | null {
  const v = (variation ?? "").replace(/^[\s:]+/, "").trim() || null;
  const s = subset?.trim() || null;
  if (s && v && lc(s).includes(lc(v))) return s;
  return [s, v].filter(Boolean).join(", ") || null;
}

function notesOf(r: InvRow, pc: PcVerdict): string | null {
  const parts: string[] = [];
  if (r.attributes) parts.push(r.attributes.trim());
  const run = /#\/(\d+)\b/.exec(r.title);
  if (run) parts.push(`numbered /${run[1]}`);
  const note = r.note?.replace(/[;\s]+$/, "").trim();
  if (note) parts.push(`CDP note: ${note}`);
  if (pc.kind === "pc" && pc.note) parts.push(pc.note);
  return parts.length ? parts.join(" · ") : null;
}

export function pcInputOf(r: InvRow): PcInput {
  return {
    title: r.title, player: r.player, year: r.year, set: r.set, cardNumber: r.cardNumber,
    parallel: parallelOf(r.subset, r.variation), graded: r.graded, grader: r.grader,
    grade: r.gradeNumber ?? r.gradeName, purchaseDate: r.purchaseDate,
  };
}

/** Identity for duplicate detection: a slab by grader+cert; otherwise the descriptive fields. */
export function identityKey(r: InvRow): string {
  if (r.certNumber) return `cert|${lc(r.grader)}|${lc(r.certNumber)}`;
  return ["card", r.year, r.set, r.cardNumber, r.player, parallelOf(r.subset, r.variation), r.grader, r.gradeNumber ?? r.gradeName]
    .map(lc).join("|");
}

function draftFromRow(r: InvRow, mode: Mode, pc: PcVerdict, ov: RowOverride | null, valuedOn: string): CardDraft {
  const category: Category = ov?.category ?? (pc.kind === "pc" ? "pc" : "business");
  let intent: Intent | null;
  if (ov && "intent" in ov) intent = ov.intent ?? null;
  else if (category === "pc") intent = null;
  else intent = mode === "holds" ? "hold" : null;
  const est = r.marketCents === null ? null : centsToMoney(r.marketCents);
  return {
    title: r.title,
    player: r.player,
    year: r.year,
    set_name: r.set,
    card_number: r.cardNumber,
    parallel: parallelOf(r.subset, r.variation),
    grader: r.graded ? r.grader : null,
    grade: r.graded ? (r.gradeNumber ?? r.gradeName) : null,
    cert_number: r.certNumber,
    sport: r.sport,
    serial_number: null, // never invented: "#/499" is a print run, not the stamped number
    cdp_sku: r.sku,
    location: ov && "location" in ov ? ov.location ?? null : locationOf(r),
    category,
    intent,
    list_price: ov?.list_price ?? null,
    est_value: est,
    est_value_source: est === null ? null : "cdp",
    est_valued_on: est === null ? null : valuedOn,
    acquisition_cost: r.purchaseCents ? centsToMoney(r.purchaseCents) : null, // 0 / blank = unknown
    acquired_on: r.purchaseDate,
    notes: notesOf(r, pc),
  };
}

function draftFromManual(m: ManualAdd, valuedOn: string): CardDraft {
  const category = m.category ?? "business";
  return {
    title: m.title,
    player: m.player ?? null, year: m.year ?? null, set_name: m.set_name ?? null, card_number: m.card_number ?? null,
    parallel: m.parallel ?? null, grader: m.grader ?? null, grade: m.grade ?? null, cert_number: m.cert_number ?? null,
    sport: m.sport ?? null, serial_number: m.serial_number ?? null, cdp_sku: m.cdp_sku ? intish(m.cdp_sku) : null,
    location: m.location ?? null,
    category,
    intent: category === "pc" ? null : m.intent ?? null,
    list_price: m.list_price ?? null,
    est_value: m.est_value ?? null,
    est_value_source: null,
    est_valued_on: m.est_value ? valuedOn : null,
    acquisition_cost: m.acquisition_cost ?? null,
    acquired_on: m.acquired_on ?? null,
    notes: m.notes ?? "added by hand (inventory import overrides)",
  };
}

/** Fields an update fills when the existing value is null. category is never filled. */
export const FILLABLE = [
  "player", "year", "set_name", "card_number", "parallel", "grader", "grade", "cert_number", "sport",
  "serial_number", "cdp_sku", "acquisition_cost", "acquired_on", "notes",
] as const;

function fillsFor(card: CardDraft, ex: ExistingCard, ov: RowOverride | null): string[] {
  const out: string[] = [];
  const isNull = (v: unknown) => v === null || v === undefined || v === "";
  for (const f of FILLABLE) if (isNull(ex[f]) && !isNull(card[f])) out.push(f);
  const exCat = ov?.category ?? ex.category;
  if (ov && "intent" in ov) { if ((ex.intent ?? null) !== (ov.intent ?? null)) out.push("intent"); }
  else if (exCat !== "pc" && isNull(ex.intent) && card.intent) out.push("intent");
  if (ov?.category && ov.category !== ex.category) out.push("category");
  if (card.est_value !== null && (isNull(ex.est_value) || ex.est_value_source === "cdp")) {
    if (toCentsNum(ex.est_value) !== toCentsNum(card.est_value) || ex.est_valued_on !== card.est_valued_on) out.push("est_value");
  }
  if (card.location && card.location !== ex.location) out.push("location");
  if (ov?.list_price && toCentsNum(ex.list_price) !== toCentsNum(ov.list_price)) out.push("list_price");
  return out;
}

/**
 * Hard contradictions between a draft and an existing card: when both sides
 * state a year, card number, grader or grade and they differ, or one is graded
 * and the other raw, the two cannot be the same physical card however similar
 * the titles. Such candidates are still reported, never flagged.
 */
export function contradiction(d: CardDraft, ex: ExistingCard): string | null {
  const y = (s: string | null | undefined) => /\b(19|20)\d{2}\b/.exec(s ?? "")?.[0] ?? null;
  const dy = y(d.year) ?? y(d.set_name);
  const ey = y(ex.year) ?? y(ex.set_name) ?? y(ex.title);
  if (dy && ey && dy !== ey) return `year ${dy} vs ${ey}`;
  const n = (s: string | null | undefined) => lc(s).replace(/^#/, "") || null;
  if (n(d.card_number) && n(ex.card_number) && n(d.card_number) !== n(ex.card_number)) return `#${d.card_number} vs #${ex.card_number}`;
  const dg = Boolean(d.grader), eg = Boolean(ex.grader);
  if (dg !== eg) return dg ? "graded vs raw" : "raw vs graded";
  if (dg && eg && (lc(d.grader) !== lc(ex.grader) || lc(d.grade) !== lc(ex.grade))) return `${d.grader} ${d.grade} vs ${ex.grader} ${ex.grade}`;
  return null;
}

function findOverride(r: InvRow, rows: RowOverride[]): RowOverride | null {
  return rows.find((o) =>
    (o.line !== undefined && o.line === r.line) ||
    (o.cdp_sku !== undefined && r.sku !== null && intish(o.cdp_sku) === r.sku) ||
    (o.cert_number !== undefined && r.certNumber !== null && lc(o.cert_number) === lc(r.certNumber) &&
      (o.grader === undefined || lc(o.grader) === lc(r.grader)))) ?? null;
}

const bucketLabel: Record<Bucket, string> = { "1": "$1", "3": "$3", "5": "$5", "6_20": "$6-20" };

function oursLabel(p: PlanRow): string {
  const target = p.outcome === "excluded" ? p.would_be : p.outcome;
  if (p.flags.some((f) => f.code === "missing_value" && !f.resolved)) return "MISSING VALUE";
  if (target === "bulk" && p.bucket) return bucketLabel[p.bucket];
  if (p.card?.category === "pc") return "PC";
  if (target === "insert" || target === "update") return p.card && p.market_price && Number(p.market_price) > 20 ? "OVER $20" : "CARD";
  return p.outcome.toUpperCase();
}

const normBowserBucket = (b: string | null) => (b ?? "").trim().toUpperCase().replace(/\s+/g, " ");

// --------------------------------------------------------------------- plan

export function planImport(input: PlanInput): Plan {
  const { parsed, mode, existing, valuedOn, batchId } = input;
  const overrides = input.overrides ?? NO_OVERRIDES;
  const threshold = input.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
  const warnings: string[] = [];

  const bySku = new Map<string, ExistingCard>();
  const byCert = new Map<string, ExistingCard>();
  for (const c of existing.cards) {
    if (c.cdp_sku) bySku.set(c.cdp_sku, c);
    if (c.cert_number) byCert.set(`${lc(c.grader)}|${lc(c.cert_number)}`, c);
  }
  const live = existing.cards.filter((c) => c.status === "held" || c.status === "listed")
    .map((c) => ({ c, hay: searchText(c) }));
  const byId = new Map(existing.cards.map((c) => [c.id, c]));

  const usedOverrides = new Set<RowOverride>();
  const rows: PlanRow[] = [];
  const seenSku = new Map<string, number>();
  const seenIdentity = new Map<string, InvRow>();

  for (const r of parsed.rows) {
    const ov = findOverride(r, overrides.rows);
    if (ov) usedOverrides.add(ov);
    const pc = classifyPc(pcInputOf(r));
    const card = draftFromRow(r, mode, pc, ov, valuedOn);
    const flags: Flag[] = [];
    const rowWarnings = [...r.warnings];
    const flag = (code: FlagCode, message: string, resolved = false) =>
      flags.push({ code, blocking: BLOCKING[code], resolved: BLOCKING[code] && resolved, message });

    const p: PlanRow = {
      source: "cdp", line: r.line, cdp_sku: r.sku, title: r.title,
      market_price: r.marketCents === null ? null : centsToMoney(r.marketCents),
      outcome: "insert", would_be: null, bucket: null, location: card.location, card, match: null, fills: [],
      best_score: null, candidates: [], pc, flags, warnings: rowWarnings, override: ov, bowser: null,
    };

    if (card.category === "pc" && card.intent) flag("invalid_override", "a pc card cannot have an intent");
    if (pc.kind === "pc") {
      flag("pc", `PC rule ${pc.ruleId}: ${pc.description}${ov?.category && ov.category !== "pc" ? ` (overridden: category ${ov.category})` : ""}`);
      if (pc.note) flag("pc_note", pc.note);
    }

    // ---- 1. override actions that end the decision here
    if (ov?.action === "skip") {
      p.outcome = "skip";
      p.card = null;
      rows.push(p);
      continue;
    }

    // ---- 2. intended destination
    let dest: "card" | "bulk" | "missing" = "card";
    if (ov?.action === "merge") {
      dest = "card";
    } else if (ov?.action === "card") {
      dest = "card";
    } else if (ov?.action === "bulk") {
      dest = "bulk";
      p.bucket = ov.bucket ?? (r.marketCents !== null ? bucketFor(r.marketCents) : null);
      if (!p.bucket) flag("invalid_override", r.marketCents === null
        ? "action bulk on a row with no market price needs a bucket"
        : `action bulk, but market price ${p.market_price} is over $20; give a bucket`);
    } else if (card.category === "pc") {
      dest = "card";
    } else if (ov?.intent || ov?.list_price) {
      dest = "card"; // an intent or an asking price only exists on a cards row
    } else if (mode === "holds") {
      dest = "card";
    } else if (r.graded) {
      dest = "card";
    } else if (r.marketCents === null) {
      dest = "missing";
    } else {
      const b = bucketFor(r.marketCents);
      if (b) { dest = "bulk"; p.bucket = b; } else dest = "card";
    }

    if (pc.kind === "review") {
      flag("review_kobe", `${pc.description} — set category or an action in overrides`, Boolean(ov?.category || ov?.action));
    }
    if (dest === "missing") {
      flag("missing_value", "no market_price: not bucketed (bulk mode). Override with action card, or action bulk + bucket, or skip.");
    }
    if (mode === "holds" && r.marketCents === null) rowWarnings.push("no market_price: est_value left null");
    if (!r.sku) flag("missing_sku", "no CDP sku: re-running the import could not recognise this row", ov?.action === "card");

    // ---- 3. exact match (cdp_sku, then grader+cert), or the merge target
    let matched: ExistingCard | null = null;
    let by: "cdp_sku" | "cert" | "override" | null = null;
    if (ov?.action === "merge") {
      matched = byId.get(ov.card_id!) ?? null;
      by = "override";
      if (!matched) flag("invalid_override", `merge target card ${ov.card_id} is not in the snapshot`);
    } else {
      if (r.sku && bySku.has(r.sku)) { matched = bySku.get(r.sku)!; by = "cdp_sku"; }
      else if (r.certNumber && r.grader && byCert.has(`${lc(r.grader)}|${lc(r.certNumber)}`)) {
        matched = byCert.get(`${lc(r.grader)}|${lc(r.certNumber)}`)!; by = "cert";
      }
    }

    // ---- 4. fuzzy score against live cards (always computed, for the report)
    const needle = searchText(card);
    const scored = live.map(({ c, hay }) => ({ c, s: similarity(hay, needle) })).sort((a, b) => b.s - a.s);
    p.best_score = scored.length ? round3(scored[0].s) : null;
    p.candidates = scored.filter((x) => x.s >= CANDIDATE_FLOOR && x.c.id !== matched?.id).slice(0, 3)
      .map((x) => ({ card_id: x.c.id, title: x.c.title, status: x.c.status, score: round3(x.s), source: "db" as const, contradiction: contradiction(card, x.c) }));

    if (matched) {
      p.match = { card_id: matched.id, by: by!, title: matched.title, status: matched.status };
      p.fills = fillsFor(card, matched, ov);
      if (dest === "bulk" || dest === "missing") {
        rowWarnings.push(`already tracked as card ${matched.id}; updated there, not counted into a bulk lot`);
        p.bucket = null;
        flags.splice(0, flags.length, ...flags.filter((f) => f.code !== "missing_value"));
      }
      dest = "card";
      if (matched.status !== "held" && matched.status !== "listed") {
        flag("matched_exited_card", `matches card ${matched.id} by ${by}, which is ${matched.status}; skip it or fix the sku/cert`);
      }
      const finalCat = ov?.category ?? matched.category;
      if (finalCat === "pc" && ov?.intent) flag("invalid_override", `card ${matched.id} is pc; it cannot get intent ${ov.intent} without changing category`);
      if (finalCat !== card.category) {
        flag("category_differs", `card ${matched.id} is category ${matched.category}; import would say ${card.category}. Category is never changed by import — use an override.`);
      }
    } else {
      const hits = p.candidates.filter((c) => c.source === "db" && c.score >= threshold && !c.contradiction);
      if (hits.length) {
        flag("possible_duplicate",
          `fuzzy match ${hits.map((h) => `card ${h.card_id} "${h.title}" (${h.score})`).join("; ")} — not merged. Override: merge (card_id), card (insert anyway) or skip.`,
          Boolean(ov?.action && ov.action !== "merge"));
      }
    }

    // ---- 5. duplicates within this batch
    if (r.sku) {
      const first = seenSku.get(r.sku);
      if (first !== undefined) flag("duplicate_sku", `cdp sku ${r.sku} already on line ${first}`, ov?.action === "merge");
      else seenSku.set(r.sku, r.line);
    }
    const key = identityKey(r);
    const twin = seenIdentity.get(key);
    if (twin) {
      p.candidates.unshift({ card_id: 0, title: twin.title, status: "in batch", score: 1, source: "batch", line: twin.line, cdp_sku: twin.sku });
      if (dest === "card" && !matched) {
        flag("possible_duplicate", `same card as line ${twin.line} (sku ${twin.sku}) in this file`, Boolean(ov?.action));
      } else {
        flag("duplicate_scan", `same card as line ${twin.line} (sku ${twin.sku}) in this file; both counted — a second copy, or a double scan?`);
      }
    } else seenIdentity.set(key, r);

    // ---- 6. duplicates against files applied before this one
    for (const pf of input.prior ?? []) {
      const hit = pf.rows.find((x) => identityKey(x) === key || (r.sku !== null && x.sku === r.sku));
      if (!hit) continue;
      p.candidates.unshift({ card_id: 0, title: hit.title, status: "prior file", score: 1, source: "prior_file", file: pf.name, line: hit.line, cdp_sku: hit.sku });
      const sameSku = r.sku !== null && hit.sku === r.sku;
      if (sameSku) flag("duplicate_sku", `cdp sku ${r.sku} is also on ${pf.name} line ${hit.line}`, ov?.action === "merge");
      else if (dest === "card" && !matched) flag("possible_duplicate", `same card as ${pf.name} line ${hit.line} (sku ${hit.sku})`, Boolean(ov?.action));
      else flag("duplicate_scan", `same card as ${pf.name} line ${hit.line} (sku ${hit.sku}); both counted — a second copy, or a double scan?`);
    }

    // ---- 7. outcome
    const intended: "insert" | "update" | "bulk" = matched ? "update" : dest === "bulk" ? "bulk" : "insert";
    if (intended === "bulk") p.card = null;
    if (dest === "missing" && !matched) p.card = card; // shown in the report; not written until resolved
    const blocked = flags.some((f) => f.blocking && !f.resolved);
    if (blocked) { p.outcome = "excluded"; p.would_be = dest === "missing" ? null : intended; }
    else p.outcome = intended;

    // ---- 8. Bowser Jr.'s hints, compared (never used for the decision)
    if (r.hints.bucket !== undefined || r.hints.pc_flag !== undefined) {
      const ours = oursLabel(p);
      const theirs = r.hints.bucket ?? null;
      const ourPc = card.category === "pc";
      p.bowser = {
        bucket: theirs, pc_flag: r.hints.pc_flag ?? null, ours,
        agrees_bucket: theirs === null ? null : normBowserBucket(theirs) === normBowserBucket(ours),
        agrees_pc: r.hints.pc_flag === undefined ? null : /^y/i.test(r.hints.pc_flag) === ourPc,
      };
    }
    rows.push(p);
  }

  // ---- manual adds
  for (const m of overrides.manual_adds) {
    const card = draftFromManual(m, valuedOn);
    const flags: Flag[] = [];
    let matched: ExistingCard | null = null;
    let by: "cdp_sku" | "cert" | null = null;
    if (card.cdp_sku && bySku.has(card.cdp_sku)) { matched = bySku.get(card.cdp_sku)!; by = "cdp_sku"; }
    else if (card.cert_number && card.grader && byCert.has(`${lc(card.grader)}|${lc(card.cert_number)}`)) {
      matched = byCert.get(`${lc(card.grader)}|${lc(card.cert_number)}`)!; by = "cert";
    }
    const needle = searchText(card);
    const scored = live.map(({ c, hay }) => ({ c, s: similarity(hay, needle) })).sort((a, b) => b.s - a.s);
    const p: PlanRow = {
      source: "manual", line: null, cdp_sku: card.cdp_sku, title: card.title, market_price: card.est_value,
      outcome: matched ? "update" : "insert", would_be: null, bucket: null, location: card.location, card,
      match: matched ? { card_id: matched.id, by: by!, title: matched.title, status: matched.status } : null,
      fills: matched ? fillsFor(card, matched, null) : [],
      best_score: scored.length ? round3(scored[0].s) : null,
      candidates: scored.filter((x) => x.s >= CANDIDATE_FLOOR && x.c.id !== matched?.id).slice(0, 3)
        .map((x) => ({ card_id: x.c.id, title: x.c.title, status: x.c.status, score: round3(x.s), source: "db" as const })),
      pc: classifyPc({ title: card.title, player: card.player, year: card.year, set: card.set_name, cardNumber: card.card_number, parallel: card.parallel, graded: Boolean(card.grader), grader: card.grader, grade: card.grade }),
      flags, warnings: [], override: null, bowser: null,
    };
    if (p.pc.kind === "pc" && card.category !== "pc") {
      flags.push({ code: "category_differs", blocking: false, resolved: false, message: `PC rule ${p.pc.ruleId} matches, but the manual add says category ${card.category} (manual adds win)` });
    }
    rows.push(p);
  }

  for (const o of overrides.rows) if (!usedOverrides.has(o)) warnings.push(`override matched no row: ${JSON.stringify(o)}`);

  // ---- bulk lots
  const applied = new Set((existing.bulk_lot_events ?? []).map((e) => e.notes).filter(Boolean) as string[]);
  const lots = planLots(rows, existing.bulk_lots, overrides, batchId, warnings, applied);

  // ---- skipped blank rows (with Bowser's bucket for comparison)
  const skipped_blank = parsed.skippedBlank.map((b) => ({ ...b, bowser_bucket: b.bucketHint }));

  // ---- totals
  const flagsCount: Partial<Record<FlagCode, number>> = {};
  for (const r of rows) for (const f of r.flags) flagsCount[f.code] = (flagsCount[f.code] ?? 0) + 1;
  const sum = (xs: (string | null)[]) => xs.reduce((a, x) => a + (x ? Math.round(Number(x) * 100) : 0), 0);
  const totals: Plan["totals"] = {
    rows_read: parsed.rows.length + parsed.skippedBlank.length,
    skipped_blank: parsed.skippedBlank.length,
    inserts: rows.filter((r) => r.outcome === "insert").length,
    updates: rows.filter((r) => r.outcome === "update").length,
    bulk_rows: rows.filter((r) => r.outcome === "bulk").length,
    bulk_cards_added: lots.reduce((a, l) => a + (l.already_applied ? 0 : l.delta), 0),
    skipped_by_override: rows.filter((r) => r.outcome === "skip").length,
    excluded: rows.filter((r) => r.outcome === "excluded").length,
    pc: rows.filter((r) => r.card?.category === "pc" && (r.outcome === "insert" || r.outcome === "update" || r.outcome === "excluded")).length,
    manual_adds: rows.filter((r) => r.source === "manual").length,
    insert_est_value: centsToMoney(sum(rows.filter((r) => r.outcome === "insert").map((r) => r.card?.est_value ?? null))),
    bulk_value_added: centsToMoney(lots.reduce((a, l) => a + (l.already_applied ? 0 : Math.round(l.delta * Number(l.unit_price) * 100)), 0)),
    flags: flagsCount,
    unresolved_blocking: rows.reduce((a, r) => a + r.flags.filter((f) => f.blocking && !f.resolved).length, 0),
    bowser_disagreements: rows.filter((r) => r.bowser && (r.bowser.agrees_bucket === false || r.bowser.agrees_pc === false)).length,
  };

  return {
    batch_id: batchId, file: input.file, mode, valued_on: valuedOn, fuzzy_threshold: threshold,
    layout: parsed.layout, header_line: parsed.headerLine, rows_read: totals.rows_read,
    skipped_blank, rows, lots, totals, warnings,
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function planLots(rows: PlanRow[], existingLots: ExistingLot[], overrides: Overrides, batchId: string, warnings: string[], applied: Set<string>): LotPlan[] {
  type Acc = { bucket: Bucket; location: string | null; scanned: number; sumCents: number; skus: string[] };
  const acc = new Map<string, Acc>();
  const keyOf = (b: Bucket, loc: string | null) => `${b}|${loc ?? ""}`;
  for (const r of rows) {
    if (r.outcome !== "bulk" || !r.bucket) continue;
    const k = keyOf(r.bucket, r.location);
    const a = acc.get(k) ?? { bucket: r.bucket, location: r.location, scanned: 0, sumCents: 0, skus: [] };
    a.scanned++;
    a.sumCents += r.market_price ? Math.round(Number(r.market_price) * 100) : 0;
    if (r.cdp_sku) a.skus.push(r.cdp_sku);
    acc.set(k, a);
  }
  const hand = new Map(overrides.bulk_counts.map((b) => [keyOf(b.bucket, b.location ?? null), b]));
  for (const [k, b] of hand) if (!acc.has(k)) acc.set(k, { bucket: b.bucket, location: b.location ?? null, scanned: 0, sumCents: 0, skus: [] });

  const out: LotPlan[] = [];
  const order: Bucket[] = ["1", "3", "5", "6_20"];
  const sorted = [...acc.entries()].sort(([, a], [, b]) =>
    order.indexOf(a.bucket) - order.indexOf(b.bucket) || (a.location ?? "").localeCompare(b.location ?? ""));
  for (const [k, a] of sorted) {
    const h = hand.get(k);
    const delta = h ? h.count : a.scanned;
    let batchSum: number; // cents, possibly fractional
    if (a.bucket === "6_20") {
      if (a.scanned > 0) batchSum = (a.sumCents / a.scanned) * delta;
      else if (h?.unit_price) batchSum = Math.round(Number(h.unit_price) * 100) * delta;
      else { warnings.push(`bulk_counts for 6_20 ${a.location ?? "(no location)"}: no scanned cards and no unit_price; skipped`); continue; }
    } else batchSum = FIXED_UNIT[a.bucket] * delta;
    if (delta === 0) { warnings.push(`bucket ${a.bucket} ${a.location ?? "(no location)"}: hand count 0, nothing added`); continue; }
    const ex = existingLots.find((l) => l.bucket === a.bucket && (l.location ?? "") === (a.location ?? ""));
    const exCount = ex?.card_count ?? 0;
    const exUnit = ex ? Math.round(Number(ex.unit_price) * 100) : null;
    const marker = `cdp-import:${batchId}:${a.bucket}:${a.location ?? ""}`;
    const done = applied.has(marker);
    const resulting = done ? exCount : exCount + delta;
    const unit = done ? exUnit ?? 0 : a.bucket === "6_20"
      ? Math.round(((exCount * (exUnit ?? 0)) + batchSum) / resulting)
      : (ex ? exUnit! : FIXED_UNIT[a.bucket]);
    if (done) warnings.push(`bulk lot ${a.bucket} ${a.location ?? "(no location)"}: batch ${batchId} already applied (marker in bulk_lot_events); the SQL will skip it`);
    out.push({
      bucket: a.bucket, location: a.location, scanned: a.scanned, delta, hand_count: Boolean(h),
      existing_count: exCount, existing_unit_price: exUnit === null ? null : centsToMoney(exUnit),
      resulting_count: resulting, unit_price: centsToMoney(unit), resulting_total_value: centsToMoney(unit * resulting),
      batch_sum: (batchSum / 100).toFixed(4).replace(/\.?0+$/, ""),
      skus: a.skus,
      marker,
      already_applied: done,
    });
  }
  return out;
}
