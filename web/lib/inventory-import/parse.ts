import { parseCsvRows } from "../csv";

// ============================================================================
// Card Dealer Pro INVENTORY export -> normalized rows.        Pure, no I/O.
// ============================================================================
//
// This is CDP's plain inventory export (title, market_price, player, ... sku),
// NOT the eBay File Exchange export that lib/ebay-api/cdp/mapping.ts reads for
// listings. The two share only the RFC-4180 tokenizer (lib/csv.ts); the FX
// header grammar (C:/CD: prefixes, *Action) does not apply here.
//
// Layouts accepted:
//   header on line 1                         (most exports)
//   a title row ("batch-1611837-export") above the header
// The header is the first of the first five rows containing both `title` and
// `market_price`. Rows with a blank title are blank scans: skipped and counted.
//
// Normalization:
//   integer-valued floats -> integer strings for year, card_number, sku,
//     grade_number ("1996.0" -> "1996", "290.0" -> "290"); "2.5" stays.
//   money -> integer cents, rounded ("24.990000000000002" -> 2499).
//   dates -> ISO YYYY-MM-DD (accepts M/D/YYYY).
// ============================================================================

export const CDP_COLUMNS = [
  "title", "description", "sale_price", "market_price", "category", "matched", "year", "brand", "set",
  "subset", "player", "card_number", "attributes", "team", "variation", "condition", "graded", "grader",
  "certification_number", "grade_name", "grade_number", "purchase_date", "purchase_price", "note",
  "cabinet", "shelf", "box", "row", "section", "sku", "front_image", "back_image",
] as const;

/** Columns Bowser Jr. adds when he pre-processes a file. Hints only — never used for decisions. */
export const HINT_COLUMNS = ["cdp_value", "bucket", "value_bucket", "pc_flag", "pc_reason", "qty", "missing_value_flag", "duplicate_flag"] as const;

export interface InvRow {
  /** 1-based physical line in the file. */
  line: number;
  title: string;
  /** market_price in cents; null when blank or unparseable. */
  marketCents: number | null;
  /** Raw market_price cell when it could not be parsed (blank -> null). */
  marketRaw: string | null;
  sport: string | null;
  year: string | null;
  brand: string | null;
  set: string | null;
  subset: string | null;
  player: string | null;
  cardNumber: string | null;
  attributes: string | null;
  team: string | null;
  variation: string | null;
  condition: string | null;
  graded: boolean;
  grader: string | null;
  certNumber: string | null;
  gradeName: string | null;
  gradeNumber: string | null;
  purchaseDate: string | null;
  /** purchase_price in cents; null when blank. 0 is kept as 0 here (plan maps it to unknown). */
  purchaseCents: number | null;
  note: string | null;
  cabinet: string | null;
  shelf: string | null;
  box: string | null;
  row: string | null;
  section: string | null;
  sku: string | null;
  frontImage: string | null;
  hints: Partial<Record<(typeof HINT_COLUMNS)[number], string>>;
  warnings: string[];
}

export interface BlankRow {
  line: number;
  sku: string | null;
  /** Bowser Jr.'s `bucket` hint for the row, if the file has one. */
  bucketHint: string | null;
}

export interface ParsedInventory {
  layout: "header_first" | "title_row";
  /** The title row text when present, e.g. "batch-1611837-export". */
  titleRow: string | null;
  headerLine: number;
  rows: InvRow[];
  skippedBlank: BlankRow[];
  missingColumns: string[];
  extraColumns: string[];
}

export class InventoryParseError extends Error {}

const blank = (v: string | undefined) => !v || !v.trim();
const cell = (v: string | undefined) => (blank(v) ? null : v!.trim());

/** "1996.0" -> "1996"; "65b", "2.5", "02" unchanged. */
export function intish(v: string | null): string | null {
  if (v === null) return null;
  const m = /^(-?\d+)\.0+$/.exec(v.trim());
  return m ? String(Number(m[1])) : v.trim();
}

/** Money cell -> cents. Accepts "$1,234.5", "24.990000000000002". Blank -> null; junk -> NaN. */
export function toCents(v: string | null): number | null {
  if (v === null) return null;
  const s = v.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

export function centsToMoney(c: number): string {
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** YYYY-MM-DD or M/D/YYYY (also with time suffix) -> YYYY-MM-DD; else null. */
export function isoDate(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

const yes = (v: string | null) => /^(y|yes|true|1)$/i.test(v ?? "");

export function parseInventoryCsv(text: string): ParsedInventory {
  const all = parseCsvRows(text);
  if (!all.length) throw new InventoryParseError("CSV is empty");

  const lower = (r: string[]) => r.map((c) => c.trim().toLowerCase());
  let h = -1;
  for (let i = 0; i < Math.min(5, all.length); i++) {
    const cols = lower(all[i]);
    if (cols.includes("title") && cols.includes("market_price")) { h = i; break; }
  }
  if (h < 0) throw new InventoryParseError("no CDP header row (needs `title` and `market_price`) in the first 5 rows");

  const header = lower(all[h]);
  const idx = new Map(header.map((c, i) => [c, i]));
  const missingColumns = CDP_COLUMNS.filter((c) => !idx.has(c));
  const required = ["title", "market_price", "sku"];
  const missingRequired = required.filter((c) => !idx.has(c));
  if (missingRequired.length) throw new InventoryParseError(`missing required column(s): ${missingRequired.join(", ")}`);
  const known = new Set<string>([...CDP_COLUMNS, ...HINT_COLUMNS]);
  const extraColumns = header.filter((c) => c && !known.has(c));

  const rows: InvRow[] = [];
  const skippedBlank: BlankRow[] = [];
  for (let r = h + 1; r < all.length; r++) {
    const cells = all[r];
    if (cells.every((c) => blank(c))) continue;
    const get = (name: string) => cell(cells[idx.get(name) ?? -1]);
    const line = r + 1;
    const sku = intish(get("sku"));
    const title = get("title");
    if (!title) { skippedBlank.push({ line, sku, bucketHint: get("bucket") }); continue; }

    const warnings: string[] = [];
    const marketRawCell = get("market_price");
    let marketCents = toCents(marketRawCell);
    if (Number.isNaN(marketCents)) { warnings.push(`market_price "${marketRawCell}" is not a number`); marketCents = null; }
    let purchaseCents = toCents(get("purchase_price"));
    if (Number.isNaN(purchaseCents)) { warnings.push(`purchase_price "${get("purchase_price")}" is not a number; treated as unknown`); purchaseCents = null; }
    const pd = get("purchase_date");
    const purchaseDate = isoDate(pd);
    if (pd && !purchaseDate) warnings.push(`purchase_date "${pd}" not understood; ignored`);

    const grader = get("grader");
    const certNumber = intish(get("certification_number"));
    const hints: InvRow["hints"] = {};
    for (const k of HINT_COLUMNS) { const v = get(k); if (v !== null) hints[k] = v; }

    rows.push({
      line, title,
      marketCents, marketRaw: marketRawCell,
      sport: get("category")?.toLowerCase() ?? null,
      year: intish(get("year")),
      brand: get("brand"),
      set: get("set"),
      subset: get("subset"),
      player: get("player"),
      cardNumber: intish(get("card_number")),
      attributes: get("attributes"),
      team: get("team"),
      variation: get("variation"),
      condition: get("condition"),
      graded: yes(get("graded")) || Boolean(grader) || Boolean(certNumber),
      grader,
      certNumber,
      gradeName: get("grade_name"),
      gradeNumber: intish(get("grade_number")),
      purchaseDate,
      purchaseCents,
      note: get("note"),
      cabinet: get("cabinet"), shelf: get("shelf"), box: get("box"), row: get("row"), section: get("section"),
      sku,
      frontImage: get("front_image"),
      hints,
      warnings,
    });
  }

  return {
    layout: h === 0 ? "header_first" : "title_row",
    titleRow: h > 0 ? all[0].filter((c) => !blank(c)).join(",").trim() || null : null,
    headerLine: h + 1,
    rows,
    skippedBlank,
    missingColumns,
    extraColumns,
  };
}

/**
 * The CDP batch number, for a default batch id. Taken from the title row
 * ("batch-1611837-export") or the most common batch in the front-image URLs
 * (".../cdp-batches-prod/72012-1611699/..."). Null if neither is present.
 */
export function cdpBatchNumber(p: ParsedInventory): string | null {
  const t = /batch-(\d+)/i.exec(p.titleRow ?? "");
  if (t) return t[1];
  const counts = new Map<string, number>();
  for (const r of p.rows) {
    const m = /cdp-batches-prod\/\d+-(\d+)\//.exec(r.frontImage ?? "");
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [k, n] of counts) if (best === null || n > counts.get(best)!) best = k;
  return best;
}
