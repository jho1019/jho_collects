import type { EbayEnvironment } from "./config";
import { ApiError, EbayApiError } from "./errors";
import type { EbayRest } from "./http";
import { moneyCell, parsePrice } from "./money";
import { assertOfferId, assertSku, resolveOffer, updateOfferPrice, withdrawOffer, type Offer } from "./offers";

// Listing changes made on Yoshi's (or anyone's) behalf, every one audited.
//
//   updatePrice  -> price_changes   (succeeded AND failed attempts)
//   endListing   -> listing_events  (succeeded AND failed attempts)
//
// What is NOT logged: a request rejected by validation before anything was
// attempted (bad price, empty reason, malformed id). Nothing was tried, and
// price_changes.new_price is NOT NULL > 0, so there is no honest row to write.
//
// If eBay accepts a change but the audit insert then fails, the change is
// still reported as succeeded (it happened) with `audit_logged: false`, and
// the failure is logged server-side. Hiding a real change behind a 500 would
// invite a retry of something that already took effect.

export type IdKind = "offer" | "sku";

export interface PriceChangeRow {
  environment: EbayEnvironment;
  offer_id: string | null;
  sku: string | null;
  listing_id: string | null;
  old_price: string | null;
  new_price: string;
  currency: string;
  reason: string;
  status: "succeeded" | "failed";
  http_status: number | null;
  error: string | null;
  actor: string;
}

export interface ListingEventRow {
  environment: EbayEnvironment;
  action: "end";
  offer_id: string | null;
  sku: string | null;
  listing_id: string | null;
  reason: string;
  status: "succeeded" | "failed";
  http_status: number | null;
  error: string | null;
  actor: string;
}

export interface AuditStore {
  logPriceChange(row: PriceChangeRow): Promise<void>;
  logListingEvent(row: ListingEventRow): Promise<void>;
}

/** Optional: keep ebay_listings in step. Best effort. */
export interface ListingStateStore {
  setPrice(environment: EbayEnvironment, offerId: string, price: string): Promise<void>;
  markEnded(environment: EbayEnvironment, offerId: string): Promise<void>;
}

export interface ChangeDeps {
  rest: EbayRest;
  audit: AuditStore;
  environment: EbayEnvironment;
  listings?: ListingStateStore;
}

export const REASON_MAX = 500;

export function parseReason(input: unknown): string {
  const r = typeof input === "string" ? input.trim() : "";
  if (!r) throw new ApiError(400, "invalid_reason", "reason is required");
  if (r.length > REASON_MAX) throw new ApiError(400, "invalid_reason", `reason must be at most ${REASON_MAX} characters`);
  return r;
}

export function parseIdKind(v: string | null): IdKind {
  if (v === null || v === "" || v === "offer" || v === "offerId") return "offer";
  if (v === "sku") return "sku";
  throw new ApiError(400, "invalid_param", "by must be offer or sku");
}

function checkId(id: string, by: IdKind): string {
  return by === "offer" ? assertOfferId(id) : assertSku(id);
}

/** Status/message for an audit row. Built from our own error types only. */
function failure(err: unknown): { http_status: number | null; error: string } {
  if (err instanceof EbayApiError) return { http_status: err.upstreamStatus, error: err.message };
  if (err instanceof ApiError) return { http_status: err.status, error: err.message };
  return { http_status: null, error: "unexpected error" };
}

async function audited(write: () => Promise<void>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (e) {
    console.error("[ebay-api] audit log write failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

export async function updatePrice(
  deps: ChangeDeps,
  input: { id: string; by: IdKind; price: unknown; reason: unknown; actor: string },
) {
  const id = checkId(input.id, input.by);
  const price = parsePrice(input.price);
  const reason = parseReason(input.reason);

  let offer: Offer | undefined;
  try {
    offer = await resolveOffer(deps.rest, id, input.by);
    if (offer.price?.currency && offer.price.currency !== "USD") {
      throw new ApiError(409, "unsupported_currency", `offer is priced in ${offer.price.currency}; only USD is supported`);
    }
    await updateOfferPrice(deps.rest, offer, price);
  } catch (err) {
    await audited(() => deps.audit.logPriceChange({
      environment: deps.environment,
      offer_id: offer?.offerId ?? (input.by === "offer" ? id : null),
      sku: offer?.sku ?? (input.by === "sku" ? id : null),
      listing_id: offer?.listingId ?? null,
      old_price: moneyCell(offer?.price?.value),
      new_price: price,
      currency: "USD",
      reason,
      status: "failed",
      ...failure(err),
      actor: input.actor,
    }));
    throw err;
  }

  const row: PriceChangeRow = {
    environment: deps.environment,
    offer_id: offer.offerId,
    sku: offer.sku,
    listing_id: offer.listingId ?? null,
    old_price: moneyCell(offer.price?.value),
    new_price: price,
    currency: "USD",
    reason,
    status: "succeeded",
    http_status: 200,
    error: null,
    actor: input.actor,
  };
  const logged = await audited(() => deps.audit.logPriceChange(row));
  if (deps.listings) await audited(() => deps.listings!.setPrice(deps.environment, offer!.offerId, price));
  return {
    status: "succeeded" as const,
    offer_id: row.offer_id,
    sku: row.sku,
    listing_id: row.listing_id,
    old_price: row.old_price,
    new_price: price,
    currency: "USD",
    reason,
    audit_logged: logged,
  };
}

export async function endListing(
  deps: ChangeDeps,
  input: { id: string; by: IdKind; reason: unknown; actor: string },
) {
  const id = checkId(input.id, input.by);
  const reason = parseReason(input.reason);

  let offer: Offer | undefined;
  let listingId: string | undefined;
  try {
    offer = await resolveOffer(deps.rest, id, input.by);
    listingId = (await withdrawOffer(deps.rest, offer.offerId)).listingId ?? offer.listingId;
  } catch (err) {
    await audited(() => deps.audit.logListingEvent({
      environment: deps.environment,
      action: "end",
      offer_id: offer?.offerId ?? (input.by === "offer" ? id : null),
      sku: offer?.sku ?? (input.by === "sku" ? id : null),
      listing_id: offer?.listingId ?? null,
      reason,
      status: "failed",
      ...failure(err),
      actor: input.actor,
    }));
    throw err;
  }
  const logged = await audited(() => deps.audit.logListingEvent({
    environment: deps.environment,
    action: "end",
    offer_id: offer!.offerId,
    sku: offer!.sku,
    listing_id: listingId ?? null,
    reason,
    status: "succeeded",
    http_status: 200,
    error: null,
    actor: input.actor,
  }));
  if (deps.listings) await audited(() => deps.listings!.markEnded(deps.environment, offer!.offerId));
  return {
    status: "succeeded" as const,
    action: "end" as const,
    offer_id: offer.offerId,
    sku: offer.sku,
    listing_id: listingId ?? null,
    reason,
    audit_logged: logged,
  };
}

/** `x-actor` header names the caller in the audit log (e.g. "yoshi"). */
export function actorFrom(headers: Headers): string {
  const a = (headers.get("x-actor") ?? "").trim().replace(/[^\w.@-]/g, "").slice(0, 64);
  return a ? `api:${a}` : "api";
}
