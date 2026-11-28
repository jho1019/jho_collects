// Overrides: Johnny's decisions, applied on top of the CDP file. Overrides win
// over everything (PC rules, mode, price buckets, matching). JSON only; the
// format is documented in docs/inventory-import.md and validated here.

export type Bucket = "1" | "3" | "5" | "6_20";
export const BUCKETS: Bucket[] = ["1", "3", "5", "6_20"];
export type Category = "pc" | "business" | "riftbound" | "sealed";
const CATEGORIES: Category[] = ["pc", "business", "riftbound", "sealed"];
export type Intent = "hold" | "sell";

export interface BulkCountOverride {
  bucket: Bucket;
  location?: string | null;
  /** Cards this batch adds to the box, as Johnny counted them. Replaces the CDP count. */
  count: number;
  /** Required for 6_20 only when the batch scanned no 6_20 cards for this location. */
  unit_price?: string;
  note?: string;
}

export type RowAction = "card" | "bulk" | "skip" | "merge";

export interface RowOverride {
  // ---- selector: exactly one of cdp_sku, cert_number (+ optional grader), line
  cdp_sku?: string;
  cert_number?: string;
  grader?: string;
  line?: number;
  // ---- decisions
  /** card = force a cards row (also: "not a duplicate, insert it"); bulk = force a bulk bucket;
   *  skip = leave the row out; merge = fold into an existing card (card_id). */
  action?: RowAction;
  bucket?: Bucket;
  card_id?: number;
  category?: Category;
  /** null clears it; omit to leave the default. */
  intent?: Intent | null;
  /** Johnny's asking price -> cards.list_price. */
  list_price?: string;
  location?: string | null;
  note?: string;
}

export interface ManualAdd {
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
  cdp_sku?: string | null;
  location?: string | null;
  category?: Category;
  intent?: Intent | null;
  list_price?: string | null;
  est_value?: string | null;
  acquisition_cost?: string | null;
  acquired_on?: string | null;
  notes?: string | null;
}

export interface Overrides {
  bulk_counts: BulkCountOverride[];
  rows: RowOverride[];
  manual_adds: ManualAdd[];
}

export const NO_OVERRIDES: Overrides = { bulk_counts: [], rows: [], manual_adds: [] };

export class OverridesError extends Error {
  constructor(public problems: string[]) {
    super(`overrides file is invalid:\n  - ${problems.join("\n  - ")}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const MONEY = /^\d+(\.\d{1,2})?$/;
const money = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : typeof v === "string" ? v.trim().replace(/^\$/, "") : undefined);
const str = (v: unknown) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : undefined);

/** Validate an overrides document (already JSON.parse'd). Throws OverridesError listing every problem. */
export function parseOverrides(doc: unknown): Overrides {
  const problems: string[] = [];
  if (!isObj(doc)) throw new OverridesError(["top level must be an object with bulk_counts / rows / manual_adds"]);
  for (const k of Object.keys(doc)) {
    if (!["bulk_counts", "rows", "manual_adds", "comment", "$comment"].includes(k)) problems.push(`unknown top-level key "${k}"`);
  }
  const arr = (k: string) => {
    const v = doc[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) { problems.push(`${k} must be an array`); return []; }
    return v;
  };

  const bulk_counts: BulkCountOverride[] = [];
  arr("bulk_counts").forEach((b, i) => {
    const at = `bulk_counts[${i}]`;
    if (!isObj(b)) return problems.push(`${at} must be an object`);
    const bucket = str(b.bucket) as Bucket;
    if (!BUCKETS.includes(bucket)) problems.push(`${at}.bucket must be one of ${BUCKETS.join(", ")}`);
    if (typeof b.count !== "number" || !Number.isInteger(b.count) || b.count < 0) problems.push(`${at}.count must be a whole number >= 0`);
    const unit = b.unit_price === undefined ? undefined : money(b.unit_price);
    if (unit !== undefined && !MONEY.test(unit)) problems.push(`${at}.unit_price must be a price`);
    bulk_counts.push({
      bucket, count: b.count as number,
      location: b.location === undefined || b.location === null ? null : str(b.location) || null,
      ...(unit !== undefined ? { unit_price: unit } : {}),
      ...(typeof b.note === "string" ? { note: b.note } : {}),
    });
  });
  const seenLot = new Set<string>();
  for (const b of bulk_counts) {
    const k = `${b.bucket}|${b.location ?? ""}`;
    if (seenLot.has(k)) problems.push(`bulk_counts has two entries for bucket ${b.bucket} location ${b.location ?? "(none)"}`);
    seenLot.add(k);
  }

  const rows: RowOverride[] = [];
  arr("rows").forEach((r, i) => {
    const at = `rows[${i}]`;
    if (!isObj(r)) return problems.push(`${at} must be an object`);
    const sel = ["cdp_sku", "cert_number", "line"].filter((k) => r[k] !== undefined);
    if (sel.length !== 1) problems.push(`${at} needs exactly one selector: cdp_sku, cert_number (optionally with grader) or line`);
    const o: RowOverride = {};
    if (r.cdp_sku !== undefined) o.cdp_sku = str(r.cdp_sku);
    if (r.cert_number !== undefined) o.cert_number = str(r.cert_number);
    if (r.grader !== undefined) o.grader = str(r.grader);
    if (r.line !== undefined) {
      if (typeof r.line !== "number" || !Number.isInteger(r.line)) problems.push(`${at}.line must be a whole number`);
      o.line = r.line as number;
    }
    if (r.action !== undefined) {
      if (!["card", "bulk", "skip", "merge"].includes(r.action as string)) problems.push(`${at}.action must be card, bulk, skip or merge`);
      o.action = r.action as RowAction;
    }
    if (r.bucket !== undefined) {
      if (!BUCKETS.includes(str(r.bucket) as Bucket)) problems.push(`${at}.bucket must be one of ${BUCKETS.join(", ")}`);
      o.bucket = str(r.bucket) as Bucket;
      if (o.action && o.action !== "bulk") problems.push(`${at}.bucket only makes sense with action "bulk"`);
    }
    if (o.action === "merge") {
      if (typeof r.card_id !== "number" || !Number.isInteger(r.card_id)) problems.push(`${at}: action "merge" needs a numeric card_id`);
      o.card_id = r.card_id as number;
    } else if (r.card_id !== undefined) problems.push(`${at}.card_id only makes sense with action "merge"`);
    if (r.category !== undefined) {
      if (!CATEGORIES.includes(r.category as Category)) problems.push(`${at}.category must be one of ${CATEGORIES.join(", ")}`);
      o.category = r.category as Category;
    }
    if (r.intent !== undefined) {
      if (r.intent !== null && !["hold", "sell"].includes(r.intent as string)) problems.push(`${at}.intent must be hold, sell or null`);
      o.intent = r.intent as Intent | null;
    }
    if (o.category === "pc" && o.intent) problems.push(`${at}: a pc card cannot have an intent (cards_intent_null_for_pc)`);
    if (r.list_price !== undefined) {
      const m = money(r.list_price);
      if (!m || !MONEY.test(m)) problems.push(`${at}.list_price must be a price`);
      o.list_price = m;
    }
    if (r.location !== undefined) o.location = r.location === null ? null : str(r.location) || null;
    if (typeof r.note === "string") o.note = r.note;
    rows.push(o);
  });

  const manual_adds: ManualAdd[] = [];
  arr("manual_adds").forEach((m, i) => {
    const at = `manual_adds[${i}]`;
    if (!isObj(m)) return problems.push(`${at} must be an object`);
    if (typeof m.title !== "string" || !m.title.trim()) problems.push(`${at}.title is required`);
    const out: ManualAdd = { title: String(m.title ?? "").trim() };
    const textKeys = ["player", "year", "set_name", "card_number", "parallel", "grader", "grade", "cert_number", "sport",
      "serial_number", "cdp_sku", "location", "acquired_on", "notes"] as const;
    for (const k of textKeys) if (m[k] !== undefined && m[k] !== null) out[k] = str(m[k]) || null;
    for (const k of ["list_price", "est_value", "acquisition_cost"] as const) {
      if (m[k] === undefined || m[k] === null) continue;
      const v = money(m[k]);
      if (!v || !MONEY.test(v)) problems.push(`${at}.${k} must be a price`);
      out[k] = v;
    }
    if (m.category !== undefined) {
      if (!CATEGORIES.includes(m.category as Category)) problems.push(`${at}.category must be one of ${CATEGORIES.join(", ")}`);
      out.category = m.category as Category;
    }
    if (m.intent !== undefined) {
      if (m.intent !== null && !["hold", "sell"].includes(m.intent as string)) problems.push(`${at}.intent must be hold, sell or null`);
      out.intent = m.intent as Intent | null;
    }
    if (out.category === "pc" && out.intent) problems.push(`${at}: a pc card cannot have an intent`);
    if (out.acquired_on && !/^\d{4}-\d{2}-\d{2}$/.test(out.acquired_on)) problems.push(`${at}.acquired_on must be YYYY-MM-DD`);
    if (out.cert_number && !out.grader) problems.push(`${at}: cert_number needs grader (certs are unique per grader)`);
    for (const k of Object.keys(m)) {
      if (![...textKeys, "title", "list_price", "est_value", "acquisition_cost", "category", "intent"].includes(k as never)) {
        problems.push(`${at}: unknown key "${k}"`);
      }
    }
    manual_adds.push(out);
  });

  if (problems.length) throw new OverridesError(problems);
  return { bulk_counts, rows, manual_adds };
}
