import type { EbayEnvironment, Env } from "../config";
import { ApiError } from "../errors";
import { chunk, type EbayRest } from "../http";
import { BULK_MAX, bulkCreateOrReplaceInventoryItems } from "../inventory";
import { bulkCreateOffers, bulkPublishOffers } from "../offers";
import { resolvePolicies, type AccountLookup, type PolicyField, type ResolvedPolicies } from "../policies";
import { classifyPc, type PcInput } from "../../inventory-import/pc-rules";
import { GRADE_IDS, GRADER_IDS } from "./conditions";
import { parseCdpCsv, type ColumnReport } from "./mapping";
import { buildRow, findDuplicateSkus, type BuiltRow, type InventoryItemPayload, type OfferPayload } from "./payloads";

// CDP CSV -> eBay listings.
//
//   dry run (DEFAULT)  parse, map, validate, build the exact payloads, return
//                      them. Makes NO eBay calls and NO database writes.
//   real run           inventory items -> offers -> (publish=true) publish,
//                      25 per bulk call, per-row results. A failed chunk
//                      fails only its own rows. Then records sku/offer/listing
//                      in ebay_listings so the sold-order sync can find the card.
//
// Personal-collection rows are skipped BEFORE anything is built or sent:
// rows matching the shared PC rules (lib/inventory-import/pc-rules.ts), and
// rows whose SKU belongs to a cards row with category 'pc' (looked up by
// cdp_sku and eBay sku when a store is wired in). Status
// skipped_personal_collection, reason 'personal_collection'.
//
// Rows with Quantity 0 are reported and skipped (the Inventory API cannot
// publish them). Duplicate SKUs within one file are all rejected — which row
// "wins" would otherwise depend on chunk order.

export type RowStatus =
  | "ready"                 // dry run: would be sent
  | "invalid"
  | "skipped_zero_quantity"
  | "skipped_personal_collection" // PC rule or a pc card: never sent to eBay
  | "inventory_failed"
  | "offer_failed"
  | "offer_created"         // not published (publish=false)
  | "publish_failed"
  | "published";

export interface RowReport {
  line: number;
  sku: string;
  title: string;
  status: RowStatus;
  /** Why a row was skipped, when it was skipped for a reason other than quantity. */
  reason?: "personal_collection";
  /** PC rule id, or "pc_card:<id>" style detail for a database match. */
  pc_match?: string;
  errors: string[];
  warnings: string[];
  offerId?: string;
  listingId?: string;
  card_id?: number | null;
  payloads?: { inventoryItem: InventoryItemPayload; offer: OfferPayload };
}

export interface ImportReport {
  dry_run: boolean;
  publish: boolean;
  summary: Record<RowStatus | "rows", number>;
  columns: Omit<ColumnReport, "missingRequired">;
  policies: ResolvedPolicies;
  rows: RowReport[];
  warnings: string[];
}

export interface ListingLink {
  sku: string;
  offerId: string;
  listingId: string | null;
  title: string;
  price: string | null;
  status: "unpublished" | "published";
}

/** Persists sku/offer/listing links (ebay_listings). Returns sku -> card_id. */
export interface ListingLinkStore {
  upsert(environment: EbayEnvironment, links: ListingLink[]): Promise<Map<string, number | null>>;
}

/**
 * Which of these SKUs belong to a personal-collection card (cards.category =
 * 'pc'), matched on cards.cdp_sku or cards.sku. A read; used in dry runs too.
 */
export interface PersonalCollectionLookup {
  personalCollectionSkus(skus: string[]): Promise<Set<string>>;
}

export interface ImportDeps {
  environment: EbayEnvironment;
  marketplaceId: string;
  env: Env;
  /** ebay_config key/values. */
  config: Record<string, string>;
  /** Required for a real run; never used in a dry run. */
  rest?: EbayRest;
  lookup?: AccountLookup;
  links?: ListingLinkStore;
  /** Optional: skip rows whose SKU is a pc card in the database. */
  pcCards?: PersonalCollectionLookup;
}

export interface ImportOptions {
  dryRun: boolean;
  publish: boolean;
  overrides: Partial<Record<PolicyField, string | null | undefined>>;
}

/** Errors that mean "stop everything", not "this chunk failed". */
const FATAL = new Set(["ebay_not_connected", "ebay_reauth_required", "ebay_auth_failed", "misconfigured", "ebay_rate_limited"]);

export async function importCdp(csvText: string, opts: ImportOptions, deps: ImportDeps): Promise<ImportReport> {
  const parsed = parseCdpCsv(csvText);
  const policies = await resolvePolicies({
    overrides: opts.overrides,
    env: deps.env,
    config: deps.config,
    lookup: opts.dryRun ? null : deps.lookup ?? null,
  });

  const built = parsed.rows.map((r) => buildRow(r, policies, deps.marketplaceId));
  const dups = findDuplicateSkus(built);
  for (const b of built) if (dups.has(b.sku)) b.errors.push(`SKU ${b.sku} appears more than once in this file`);

  // Personal collection: by rule, then by the cards table. Checked first, so a
  // PC row is never sent even if it is otherwise valid.
  const pcRule = built.map((b) => classifyPc(pcInputOf(b)));
  const pcDb = deps.pcCards ? await deps.pcCards.personalCollectionSkus(cdpSkuCandidates(built.map((b) => b.sku))) : new Set<string>();
  const pcDbHit = (sku: string) => skuVariants(sku).find((s) => pcDb.has(s));

  const reports: RowReport[] = built.map((b, i) => {
    const dbHit = b.sku ? pcDbHit(b.sku) : undefined;
    if (pcRule[i].kind === "pc" || dbHit) {
      return {
        line: b.line,
        sku: b.sku,
        title: b.title,
        status: "skipped_personal_collection",
        reason: "personal_collection",
        pc_match: pcRule[i].kind === "pc" ? `rule:${pcRule[i].ruleId}` : `pc_card_sku:${dbHit}`,
        errors: [],
        warnings: [`personal collection (${pcRule[i].kind === "pc" ? pcRule[i].description : `cards row with sku ${dbHit} is category pc`}): not sent to eBay`],
      } satisfies RowReport;
    }
    if (pcRule[i].kind === "review") b.warnings.push(`PC review: ${pcRule[i].description}`);
    return {
      line: b.line,
      sku: b.sku,
      title: b.title,
      status: b.errors.length ? "invalid" : b.zeroQuantity ? "skipped_zero_quantity" : "ready",
      errors: b.errors,
      warnings: b.warnings,
      ...(b.inventoryItem && b.offer && !b.errors.length ? { payloads: { inventoryItem: b.inventoryItem, offer: b.offer } } : {}),
    } satisfies RowReport;
  });

  const { mapped, aspects, descriptors, ignoredColumns, unmappedColumns } = parsed.columns;
  const report: ImportReport = {
    dry_run: opts.dryRun,
    publish: opts.publish,
    summary: {} as ImportReport["summary"],
    columns: { mapped, aspects, descriptors, ignoredColumns, unmappedColumns },
    policies,
    rows: reports,
    warnings: [],
  };

  if (!opts.dryRun) await send(built, reports, report, opts, deps);
  report.summary = summarise(reports);
  return report;
}

async function send(built: BuiltRow[], reports: RowReport[], report: ImportReport, opts: ImportOptions, deps: ImportDeps) {
  if (!deps.rest) throw new ApiError(500, "internal_error", "import: no eBay client for a real run");
  if (report.policies.problems.length) {
    throw new ApiError(422, "policies_unresolved",
      "Cannot create listings until business policies and location are resolved. Nothing was sent to eBay.", {
        problems: report.policies.problems,
        resolved: report.policies,
      });
  }
  const rest = deps.rest;
  const idx = new Map(reports.map((r, i) => [r.sku, i]));
  const ready = built.filter((_, i) => reports[i].status === "ready");

  const failChunk = (skus: string[], status: RowStatus, err: unknown) => {
    if (err instanceof ApiError && FATAL.has(err.code)) throw err;
    const msg = err instanceof ApiError ? err.message : "unexpected error";
    for (const s of skus) {
      const r = reports[idx.get(s)!];
      r.status = status;
      r.errors.push(msg);
    }
  };

  // 1. inventory items
  const itemsOk: BuiltRow[] = [];
  for (const part of chunk(ready, BULK_MAX)) {
    try {
      const res = await bulkCreateOrReplaceInventoryItems(rest, part.map((b) => b.inventoryItem!));
      for (const x of res) {
        const r = reports[idx.get(x.key)!];
        r.warnings.push(...x.warnings);
        if (x.ok) itemsOk.push(part.find((b) => b.sku === x.key)!);
        else {
          r.status = "inventory_failed";
          r.errors.push(...x.errors);
        }
      }
    } catch (e) {
      failChunk(part.map((b) => b.sku), "inventory_failed", e);
    }
  }

  // 2. offers
  const offered: { sku: string; offerId: string }[] = [];
  for (const part of chunk(itemsOk, BULK_MAX)) {
    try {
      const res = await bulkCreateOffers(rest, part.map((b) => b.offer!));
      for (const x of res) {
        const r = reports[idx.get(x.key)!];
        r.warnings.push(...x.warnings);
        if (x.offerId) r.offerId = x.offerId;
        if (x.ok && x.offerId) {
          r.status = "offer_created";
          offered.push({ sku: x.key, offerId: x.offerId });
        } else {
          r.status = "offer_failed";
          r.errors.push(...x.errors);
          if (x.offerId) r.errors.push(`an offer already exists for this SKU (offerId ${x.offerId}); reprice it with POST /api/ebay/listings/${x.offerId}/price`);
        }
      }
    } catch (e) {
      failChunk(part.map((b) => b.sku), "offer_failed", e);
    }
  }

  // 3. publish
  if (opts.publish) {
    const bySku = new Map(offered.map((o) => [o.offerId, o.sku]));
    for (const part of chunk(offered.map((o) => o.offerId), BULK_MAX)) {
      try {
        const res = await bulkPublishOffers(rest, part);
        for (const x of res) {
          const r = reports[idx.get(bySku.get(x.key)!)!];
          r.warnings.push(...x.warnings);
          if (x.ok) {
            r.status = "published";
            r.listingId = x.listingId;
          } else {
            r.status = "publish_failed";
            r.errors.push(...x.errors);
          }
        }
      } catch (e) {
        failChunk(part.map((id) => bySku.get(id)!), "publish_failed", e);
      }
    }
  }

  // 4. link table. Best effort: the listings exist on eBay regardless, so a
  // failure here is a warning, not an import failure.
  const links: ListingLink[] = reports
    .filter((r) => r.offerId && (r.status === "offer_created" || r.status === "published" || r.status === "publish_failed"))
    .map((r) => ({
      sku: r.sku,
      offerId: r.offerId!,
      listingId: r.listingId ?? null,
      title: r.title,
      price: r.payloads?.offer.pricingSummary.price.value ?? null,
      status: r.status === "published" ? "published" : "unpublished",
    }));
  if (links.length && deps.links) {
    try {
      const cards = await deps.links.upsert(deps.environment, links);
      for (const r of reports) if (cards.has(r.sku)) r.card_id = cards.get(r.sku) ?? null;
    } catch {
      report.warnings.push("listings were created but recording them in ebay_listings failed; the sync will fall back to SKU/title matching");
    }
  }
}

// ------------------------------------------------------- personal collection

/** value ID -> short name, e.g. 275010 -> PSA, 2750215 -> 2.5. FX rows may carry either. */
const GRADER_BY_ID = new Map<string, string>();
for (const [name, id] of Object.entries(GRADER_IDS)) {
  const cur = GRADER_BY_ID.get(id);
  if (!cur || name.length < cur.length) GRADER_BY_ID.set(id, name);
}
const GRADE_BY_ID = new Map(Object.entries(GRADE_IDS).map(([g, id]) => [id, g]));

export function pcInputOf(b: BuiltRow): PcInput {
  const grader = b.card.grader?.trim();
  const grade = b.card.grade?.trim();
  return {
    title: b.title,
    player: b.card.player ?? null,
    year: b.card.year ?? null,
    set: b.card.set ?? null,
    cardNumber: b.card.cardNumber ?? null,
    parallel: b.card.parallel ?? null,
    graded: b.graded,
    grader: grader ? (GRADER_BY_ID.get(grader) ?? grader) : null,
    grade: grade ? (GRADE_BY_ID.get(grade) ?? grade) : null,
  };
}

/**
 * A CDP File Exchange CustomLabel is the CDP SKU plus a suffix ("203-19tvfa");
 * the inventory export carries the bare number ("203"), which is what
 * cards.cdp_sku holds. Look up both.
 */
export function skuVariants(sku: string): string[] {
  const m = /^(\d+)-/.exec(sku);
  return m ? [sku, m[1]] : [sku];
}
const cdpSkuCandidates = (skus: string[]) => [...new Set(skus.filter(Boolean).flatMap(skuVariants))];

function summarise(rows: RowReport[]): ImportReport["summary"] {
  const s = {
    rows: rows.length, ready: 0, invalid: 0, skipped_zero_quantity: 0, skipped_personal_collection: 0, inventory_failed: 0,
    offer_failed: 0, offer_created: 0, publish_failed: 0, published: 0,
  };
  for (const r of rows) s[r.status]++;
  return s;
}
