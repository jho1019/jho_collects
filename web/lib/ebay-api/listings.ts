import type { EbayEnvironment } from "./config";
import { ApiError } from "./errors";
import { mapLimit, type EbayRest } from "./http";
import { listAllInventoryItems } from "./inventory";
import { getOffersBySku } from "./offers";
import type { TradingListing } from "./trading";

// Active listings, from two sources, normalised to one shape.
//
//   inventory  Inventory API: enumerate inventory items, then GET offers per
//              SKU (eBay has no "list all offers" call — sku is required).
//              Sees ONLY listings created through the Inventory API.
//   trading    Trading API GetMyeBaySelling ActiveList (trading.ts). Sees
//              every active listing, including ones made in CDP or Seller Hub.
//   all        both, merged on listing id and tagged with every source.
//
// Cost: `inventory` makes 1 + (items / 100) + one call per SKU, five at a
// time. Fine at this seller's scale; revisit if inventory grows past ~1000.

export type ListingSource = "inventory" | "trading";
export type ListingStatusFilter = "active" | "unpublished" | "all";

export interface Listing {
  sources: ListingSource[];
  listing_id: string | null;
  offer_id: string | null;
  sku: string | null;
  title: string | null;
  price: string | null;
  currency: string | null;
  quantity_available: number | null;
  status: string; // ACTIVE | UNPUBLISHED | ENDED | ...
  url: string | null;
}

export function itemUrl(env: EbayEnvironment, listingId: string): string {
  return env === "sandbox" ? `https://sandbox.ebay.com/itm/${listingId}` : `https://www.ebay.com/itm/${listingId}`;
}

export async function inventoryListings(rest: EbayRest, env: EbayEnvironment): Promise<Listing[]> {
  const items = await listAllInventoryItems(rest);
  const perSku = await mapLimit(items, 5, async (it) => ({ it, offers: await getOffersBySku(rest, it.sku) }));
  const out: Listing[] = [];
  for (const { it, offers } of perSku) {
    for (const o of offers) {
      const status = o.status === "PUBLISHED" ? o.listingStatus ?? "ACTIVE" : o.status ?? "UNPUBLISHED";
      out.push({
        sources: ["inventory"],
        listing_id: o.listingId ?? null,
        offer_id: o.offerId,
        sku: o.sku,
        title: it.title ?? null,
        price: o.price?.value ?? null,
        currency: o.price?.currency ?? null,
        quantity_available: o.availableQuantity ?? it.quantity ?? null,
        status,
        url: o.listingId ? itemUrl(env, o.listingId) : null,
      });
    }
  }
  return out;
}

export function fromTrading(items: TradingListing[], env: EbayEnvironment): Listing[] {
  return items.map((t) => ({
    sources: ["trading"],
    listing_id: t.itemId || null,
    offer_id: null,
    sku: t.sku,
    title: t.title,
    price: t.price,
    currency: t.currency,
    quantity_available: t.quantityAvailable ?? t.quantity,
    status: "ACTIVE",
    url: t.url ?? (t.itemId ? itemUrl(env, t.itemId) : null),
  }));
}

/** Merge on listing id. Inventory data wins (it has the offerId); sources are unioned. */
export function mergeListings(a: Listing[], b: Listing[]): Listing[] {
  const byListing = new Map<string, Listing>();
  const out: Listing[] = [];
  for (const l of [...a, ...b]) {
    if (!l.listing_id) {
      out.push(l);
      continue;
    }
    const prev = byListing.get(l.listing_id);
    if (!prev) {
      const copy = { ...l, sources: [...l.sources] };
      byListing.set(l.listing_id, copy);
      out.push(copy);
      continue;
    }
    for (const s of l.sources) if (!prev.sources.includes(s)) prev.sources.push(s);
    for (const k of ["offer_id", "sku", "title", "price", "currency", "quantity_available", "url"] as const) {
      if (prev[k] === null || prev[k] === undefined) (prev as unknown as Record<string, unknown>)[k] = l[k];
    }
  }
  return out;
}

export function filterStatus(ls: Listing[], status: ListingStatusFilter): Listing[] {
  if (status === "all") return ls;
  if (status === "unpublished") return ls.filter((l) => l.status === "UNPUBLISHED");
  return ls.filter((l) => l.status === "ACTIVE");
}

export function parseSource(v: string | null): "all" | ListingSource {
  if (!v || v === "all") return "all";
  if (v === "inventory" || v === "trading") return v;
  throw new ApiError(400, "invalid_param", "source must be all, inventory or trading");
}

export function parseStatus(v: string | null): ListingStatusFilter {
  if (!v || v === "active") return "active";
  if (v === "unpublished" || v === "all") return v;
  throw new ApiError(400, "invalid_param", "status must be active, unpublished or all");
}
