import { ApiError, type EbayErrorItem } from "./errors";
import { chunk, usd, type Amount, type EbayRest } from "./http";
import { BULK_MAX, errorText, type BulkRowResult } from "./inventory";
import type { OfferPayload } from "./cdp/payloads";

// Sell Inventory API — offers: create, publish, read, reprice, withdraw.

export interface Offer {
  offerId: string;
  sku: string;
  marketplaceId?: string;
  format?: string;
  status?: string; // PUBLISHED | UNPUBLISHED
  availableQuantity?: number;
  price?: Amount;
  listingId?: string;
  listingStatus?: string; // ACTIVE | ENDED | ...
  soldQuantity?: number;
  categoryId?: string;
}

interface RawOffer {
  offerId: string;
  sku: string;
  marketplaceId?: string;
  format?: string;
  status?: string;
  availableQuantity?: number;
  categoryId?: string;
  pricingSummary?: { price?: Amount };
  listing?: { listingId?: string; listingStatus?: string; soldQuantity?: number };
}

function toOffer(o: RawOffer): Offer {
  return {
    offerId: o.offerId,
    sku: o.sku,
    marketplaceId: o.marketplaceId,
    format: o.format,
    status: o.status,
    availableQuantity: o.availableQuantity,
    price: o.pricingSummary?.price,
    listingId: o.listing?.listingId,
    listingStatus: o.listing?.listingStatus,
    soldQuantity: o.listing?.soldQuantity,
    categoryId: o.categoryId,
  };
}

/** Path segments from callers are restricted before they reach a URL. */
export function assertOfferId(id: string): string {
  if (!/^\d{1,20}$/.test(id)) throw new ApiError(400, "invalid_offer_id", "offerId must be numeric");
  return id;
}

export function assertSku(sku: string): string {
  if (!sku || sku.length > 50 || /[\s/?#%\\]/.test(sku)) throw new ApiError(400, "invalid_sku", "invalid SKU");
  return sku;
}

export interface CreatedOffer extends BulkRowResult {
  offerId?: string;
}

/** POST /sell/inventory/v1/bulk_create_offer, 25 per call. */
export async function bulkCreateOffers(rest: EbayRest, offers: OfferPayload[]): Promise<CreatedOffer[]> {
  const out: CreatedOffer[] = [];
  for (const part of chunk(offers, BULK_MAX)) {
    const r = await rest.call<{ responses?: {
      statusCode?: number; sku?: string; offerId?: string; errors?: EbayErrorItem[]; warnings?: EbayErrorItem[];
    }[] }>("POST", "/sell/inventory/v1/bulk_create_offer", { body: { requests: part }, context: "bulk create offers" });
    const bySku = new Map((r?.responses ?? []).map((x) => [x.sku, x]));
    for (const o of part) {
      const x = bySku.get(o.sku);
      // eBay error 25002 "offer already exists" carries the existing offerId
      // in its parameters; surface it so the caller can see what to reprice.
      const existing = x?.errors?.flatMap((e) => e.parameters ?? []).find((p) => p.name === "offerId")?.value;
      out.push({
        key: o.sku,
        ok: Boolean(x?.offerId && (x.statusCode ?? 200) < 300 && !x.errors?.length),
        statusCode: x?.statusCode,
        offerId: x?.offerId ?? existing,
        errors: x ? errorText(x.errors) : ["no response from eBay for this SKU"],
        warnings: errorText(x?.warnings),
      });
    }
  }
  return out;
}

export interface PublishedOffer extends BulkRowResult {
  listingId?: string;
}

/** POST /sell/inventory/v1/bulk_publish_offer, 25 per call. */
export async function bulkPublishOffers(rest: EbayRest, offerIds: string[]): Promise<PublishedOffer[]> {
  const out: PublishedOffer[] = [];
  for (const part of chunk(offerIds, BULK_MAX)) {
    const r = await rest.call<{ responses?: {
      statusCode?: number; offerId?: string; listingId?: string; errors?: EbayErrorItem[]; warnings?: EbayErrorItem[];
    }[] }>("POST", "/sell/inventory/v1/bulk_publish_offer", {
      body: { requests: part.map((offerId) => ({ offerId })) },
      context: "bulk publish offers",
    });
    const byId = new Map((r?.responses ?? []).map((x) => [x.offerId, x]));
    for (const id of part) {
      const x = byId.get(id);
      out.push({
        key: id,
        ok: Boolean(x?.listingId && (x.statusCode ?? 200) < 300 && !x.errors?.length),
        statusCode: x?.statusCode,
        listingId: x?.listingId,
        errors: x ? errorText(x.errors) : ["no response from eBay for this offer"],
        warnings: errorText(x?.warnings),
      });
    }
  }
  return out;
}

/** GET /sell/inventory/v1/offer/{offerId} */
export async function getOffer(rest: EbayRest, offerId: string): Promise<Offer> {
  const r = await rest.call<RawOffer>("GET", `/sell/inventory/v1/offer/${assertOfferId(offerId)}`, { context: "get offer" });
  return toOffer(r);
}

/** GET /sell/inventory/v1/offer?sku=  (sku is REQUIRED by eBay; there is no list-all). */
export async function getOffersBySku(rest: EbayRest, sku: string): Promise<Offer[]> {
  const r = await rest.call<{ offers?: RawOffer[] }>("GET", "/sell/inventory/v1/offer", {
    query: { sku: assertSku(sku), marketplace_id: rest.marketplaceId, limit: 25 },
    context: "get offers by sku",
  }).catch((e) => {
    // eBay answers 404 (errorId 25713) when a SKU has no offers.
    if (e instanceof ApiError && e.status === 404) return { offers: [] as RawOffer[] };
    throw e;
  });
  return (r?.offers ?? []).map(toOffer);
}

/** Resolve a caller-supplied id: an offerId, or a SKU with exactly one offer on this marketplace. */
export async function resolveOffer(rest: EbayRest, id: string, by: "offer" | "sku"): Promise<Offer> {
  if (by === "offer") return getOffer(rest, id);
  const offers = (await getOffersBySku(rest, id)).filter((o) => !o.marketplaceId || o.marketplaceId === rest.marketplaceId);
  if (!offers.length) throw new ApiError(404, "offer_not_found", `no offer for SKU ${id}`);
  if (offers.length > 1) {
    throw new ApiError(409, "ambiguous_sku", `SKU ${id} has ${offers.length} offers; use the offerId`, {
      offer_ids: offers.map((o) => o.offerId),
    });
  }
  return offers[0];
}

/**
 * Change an offer's price. Uses bulk_update_price_quantity with one offer,
 * because PUT /offer/{id} REPLACES the whole offer (omitting a field clears
 * it) — a price-only change through it is an easy way to wipe policies.
 */
export async function updateOfferPrice(rest: EbayRest, offer: Offer, price: string): Promise<void> {
  const r = await rest.call<{ responses?: { statusCode?: number; offerId?: string; errors?: EbayErrorItem[] }[] }>(
    "POST", "/sell/inventory/v1/bulk_update_price_quantity", {
      body: { requests: [{ sku: offer.sku, offers: [{ offerId: offer.offerId, price: usd(price) }] }] },
      context: "update price",
    });
  const x = r?.responses?.find((y) => y.offerId === offer.offerId) ?? r?.responses?.[0];
  if (!x || (x.statusCode ?? 200) >= 300 || x.errors?.length) {
    throw new ApiError(400, "ebay_update_failed",
      `update price: ${errorText(x?.errors).join("; ") || "eBay did not confirm the change"}`,
      { upstream_status: x?.statusCode, ebay_errors: x?.errors });
  }
}

/** POST /sell/inventory/v1/offer/{offerId}/withdraw — ends the listing, keeps the offer. */
export async function withdrawOffer(rest: EbayRest, offerId: string): Promise<{ listingId?: string }> {
  const r = await rest.call<{ listingId?: string }>("POST", `/sell/inventory/v1/offer/${assertOfferId(offerId)}/withdraw`, {
    context: "withdraw offer",
  });
  return { listingId: r?.listingId };
}
