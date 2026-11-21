import { parseCsvRows } from "@/lib/csv";
import { ApiError } from "../errors";

// ============================================================================
// Card Dealer Pro (CDP) export -> canonical rows.            ONE ISOLATED MODULE
// ============================================================================
//
// Based on a REAL CDP export (de-identified copy:
// lib/ebay-api/__tests__/fixtures/cdp_sample.csv). CDP exports eBay *File
// Exchange* (FX) format:
//
//   row 1   Info,Version=1.0.0,Template=fx_category_template_EBAY_US,,,   <- skipped
//   row 2   header
//   row 3+  data, Action = "Add"
//
// Header grammar (parsed generically, so new CDP columns need no code change):
//
//   *Name                         `*` = required by eBay FX (informational here)
//   *Action(SiteID=US|...)        the action column; matched by prefix
//   C:Name / *C:Name              item specific  -> product.aspects[Name]
//   CD:Name - (ID: 27502)         condition descriptor; value is a value ID
//   CDA:Name - (ID: 27503)        condition descriptor; value is free text
//                                 (sent as additionalInfo)
//   anything else                 a plain field, matched via FIELD_ALIASES
//
// Matching is case- and punctuation-insensitive ("Custom Label" == "CustomLabel"
// == "custom_label"). To support another export format, add header aliases
// to FIELD_ALIASES — nothing else should need to change.
//
// SHIPPING / PAYMENT / RETURNS / LOCATION COLUMNS ARE DELIBERATELY IGNORED.
// The CDP sample carries eBay Standard Envelope shipping, which Johnny will
// not use for these listings. Business policies come from config instead
// (see ../policies.ts). Ignored columns are reported as `ignoredColumns`.
// ============================================================================

export type CanonicalField =
  | "action" | "sku" | "category_id" | "title" | "subtitle" | "condition_id"
  | "description" | "format" | "duration" | "price" | "quantity" | "photos"
  | "best_offer_enabled" | "best_offer_auto_accept" | "best_offer_auto_decline"
  // structured card fields. In FX they arrive as C: aspects or CD: descriptors
  // and are ALSO read into these canonical slots for validation/linking.
  | "player" | "year" | "brand" | "set" | "card_number" | "parallel" | "team"
  | "sport" | "graded" | "grader" | "grade" | "cert_number" | "card_condition"
  | "features";

/**
 * canonical field -> accepted header names (compared after normalisation).
 * The first alias is the FX/CDP name seen in the real export.
 */
export const FIELD_ALIASES: Record<CanonicalField, string[]> = {
  action: ["Action"],
  sku: ["CustomLabel", "Custom Label", "SKU", "Custom label (SKU)"],
  category_id: ["Category", "Category ID", "CategoryID", "eBay Category"],
  title: ["Title", "Listing Title", "Item Title"],
  subtitle: ["Subtitle"],
  condition_id: ["ConditionID", "Condition ID"],
  description: ["Description", "Item Description", "Listing Description"],
  format: ["Format", "Listing Type", "ListingType"],
  duration: ["Duration", "Listing Duration"],
  price: ["StartPrice", "Start Price", "Price", "List Price", "Fixed Price"],
  quantity: ["Quantity", "Qty"],
  photos: ["PicURL", "Pic URL", "PictureURL", "Picture URL", "Picture URLs", "Image URL", "Image URLs", "Photos", "Photo URLs", "Item photo URL"],
  best_offer_enabled: ["BestOfferEnabled", "Best Offer Enabled", "Best Offer"],
  best_offer_auto_accept: ["BestOfferAutoAcceptPrice", "Best Offer Auto Accept Price", "Auto Accept Price"],
  best_offer_auto_decline: ["MinimumBestOfferPrice", "Minimum Best Offer Price", "Auto Decline Price"],
  player: ["Player/Athlete", "Player", "Athlete", "Player Name"],
  year: ["Season", "Year", "Year Manufactured"],
  brand: ["Manufacturer", "Brand"],
  set: ["Set", "Set Name"],
  card_number: ["Card Number", "Card #", "Card No", "Number"],
  parallel: ["Parallel/Variety", "Parallel", "Variation", "Variety"],
  team: ["Team"],
  sport: ["Sport"],
  graded: ["Graded", "Is Graded"],
  grader: ["Professional Grader", "Grader", "Grading Company", "Grading Service"],
  grade: ["Grade"],
  cert_number: ["Certification Number", "Cert Number", "Cert #", "Cert"],
  card_condition: ["Card Condition"],
  features: ["Features"],
};

/** Without these columns no row can be built. */
export const REQUIRED_FIELDS: CanonicalField[] = ["sku", "title", "price"];

/**
 * Shipping, payment, return and location columns. Never used — policies come
 * from config. Matched by normalised prefix so ShippingService-1:Cost etc. all hit.
 */
const IGNORED_PREFIXES = [
  "shipping", "dispatchtime", "paypal", "immediatepay", "paymentinstructions",
  "paymentprofile", "location", "postalcode", "returns", "returnprofile",
  "refundoption", "promotionalshipping", "takebackpolicy", "productcompliancepolicy",
  "additionaldetails",
];

export type ColumnKind = "action" | "field" | "aspect" | "descriptor";

export interface ParsedHeader {
  index: number;
  raw: string;
  kind: ColumnKind;
  /** Header with markers stripped: "Player/Athlete", "Grade", "CustomLabel". */
  name: string;
  required: boolean;
  /** Condition descriptor id from "- (ID: n)". */
  descriptorId?: string;
  /** CDA: descriptor whose value is free text (additionalInfo). */
  freeText?: boolean;
  canonical?: CanonicalField;
  ignored?: boolean;
}

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const ALIAS_INDEX: Map<string, CanonicalField> = (() => {
  const m = new Map<string, CanonicalField>();
  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as [CanonicalField, string[]][]) {
    for (const a of aliases) if (!m.has(norm(a))) m.set(norm(a), field);
  }
  return m;
})();

const DESCRIPTOR_RE = /^(.*?)\s*-\s*\(ID:\s*(\d+)\)\s*$/i;

export function parseHeader(raw: string, index: number): ParsedHeader {
  let s = raw.trim();
  const required = s.startsWith("*");
  if (required) s = s.slice(1).trim();

  if (/^action\b/i.test(s)) return { index, raw, kind: "action", name: "Action", required, canonical: "action" };

  const prefix = /^(CDA|CD|C):/i.exec(s);
  if (prefix) {
    const p = prefix[1].toUpperCase();
    const rest = s.slice(prefix[0].length).trim();
    if (p === "C") {
      return { index, raw, kind: "aspect", name: rest, required, canonical: ALIAS_INDEX.get(norm(rest)) };
    }
    const m = DESCRIPTOR_RE.exec(rest);
    const name = (m ? m[1] : rest).trim();
    return {
      index, raw, kind: "descriptor", name, required,
      descriptorId: m?.[2], freeText: p === "CDA",
      canonical: ALIAS_INDEX.get(norm(name)),
    };
  }
  const n = norm(s);
  const ignored = IGNORED_PREFIXES.some((p) => n.startsWith(p));
  return { index, raw, kind: "field", name: s, required, canonical: ignored ? undefined : ALIAS_INDEX.get(n), ignored };
}

export interface ColumnReport {
  /** canonical field -> header it was read from */
  mapped: Partial<Record<CanonicalField, string>>;
  aspects: string[];
  descriptors: { name: string; id: string | null; freeText: boolean }[];
  /** shipping/payment/return/location columns present but deliberately unused */
  ignoredColumns: string[];
  /** columns that matched nothing; harmless, listed so a renamed column is noticed */
  unmappedColumns: string[];
  missingRequired: CanonicalField[];
}

export interface DescriptorCell {
  name: string;
  id: string | null;
  freeText: boolean;
  value: string;
}

/** One data row, canonical. All values are trimmed strings; nothing parsed yet. */
export interface CdpRow {
  /** 1-based line number in the file, for error messages. */
  line: number;
  fields: Partial<Record<CanonicalField, string>>;
  /** Item specifics, in header order, empty values dropped. */
  aspects: Record<string, string[]>;
  descriptors: DescriptorCell[];
}

export interface ParsedCdp {
  columns: ColumnReport;
  rows: CdpRow[];
}

/** Aspect values: FX separates multiple values with `|`. */
export function splitMulti(v: string): string[] {
  return v.split("|").map((s) => s.trim()).filter(Boolean);
}

export function parseCdpCsv(text: string): ParsedCdp {
  const all = parseCsvRows(text);
  if (!all.length) throw new ApiError(400, "cdp_empty", "CSV is empty");

  // Skip FX "Info,..." preamble rows; the header is the first row that is not one.
  let h = 0;
  while (h < all.length && /^info$/i.test((all[h][0] ?? "").trim())) h++;
  if (h >= all.length) throw new ApiError(400, "cdp_no_header", "CSV has no header row");

  const headers = all[h].map((raw, i) => parseHeader(raw, i));
  const columns = reportColumns(headers);
  if (columns.missingRequired.length) {
    throw new ApiError(400, "cdp_missing_columns",
      `CSV is missing required column(s): ${columns.missingRequired.join(", ")}`, {
        missing: columns.missingRequired.map((f) => ({ field: f, accepted_headers: FIELD_ALIASES[f] })),
        unmapped_columns: columns.unmappedColumns,
        headers_seen: headers.map((x) => x.raw),
      });
  }

  // First header wins when several map to one canonical field (e.g. C:Season
  // and C:Year Manufactured both mean `year`; Season comes first in CDP).
  const firstFor = new Map<CanonicalField, number>();
  for (const hd of headers) if (hd.canonical && !firstFor.has(hd.canonical)) firstFor.set(hd.canonical, hd.index);

  const rows: CdpRow[] = [];
  for (let r = h + 1; r < all.length; r++) {
    const cells = all[r];
    if (cells.every((c) => !c.trim())) continue;
    const fields: CdpRow["fields"] = {};
    const aspects: CdpRow["aspects"] = {};
    const descriptors: DescriptorCell[] = [];
    for (const hd of headers) {
      const v = (cells[hd.index] ?? "").trim();
      if (hd.kind === "aspect" && v) aspects[hd.name] = splitMulti(v);
      if (hd.kind === "descriptor" && v) {
        descriptors.push({ name: hd.name, id: hd.descriptorId ?? null, freeText: Boolean(hd.freeText), value: v });
      }
      if (hd.canonical && firstFor.get(hd.canonical) === hd.index) fields[hd.canonical] = v;
      // fill a canonical slot from a later alias column if the first was blank
      else if (hd.canonical && v && !fields[hd.canonical]) fields[hd.canonical] = v;
    }
    rows.push({ line: r + 1, fields, aspects, descriptors });
  }
  return { columns, rows };
}

function reportColumns(headers: ParsedHeader[]): ColumnReport {
  const mapped: ColumnReport["mapped"] = {};
  for (const h of headers) if (h.canonical && !mapped[h.canonical]) mapped[h.canonical] = h.raw;
  return {
    mapped,
    aspects: headers.filter((h) => h.kind === "aspect").map((h) => h.name),
    descriptors: headers
      .filter((h) => h.kind === "descriptor")
      .map((h) => ({ name: h.name, id: h.descriptorId ?? null, freeText: Boolean(h.freeText) })),
    ignoredColumns: headers.filter((h) => h.ignored).map((h) => h.raw),
    unmappedColumns: headers.filter((h) => h.kind === "field" && !h.canonical && !h.ignored).map((h) => h.raw),
    missingRequired: REQUIRED_FIELDS.filter((f) => !mapped[f]),
  };
}
