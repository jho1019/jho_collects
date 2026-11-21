import type { EbayErrorItem } from "./errors";
import { chunk, type EbayRest } from "./http";
import type { InventoryItemPayload } from "./cdp/payloads";

// Sell Inventory API — inventory items.
//
// IMPORTANT LIMITATION: the Inventory API only sees listings that were
// CREATED through the Inventory API (or migrated into it with
// bulkMigrateListing). Listings made in Card Dealer Pro's own eBay push,
// in Seller Hub, or through File Exchange do NOT appear here. That is why
// listings.ts also reads the legacy Trading API (trading.ts).

export const BULK_MAX = 25;

export interface BulkRowResult {
  key: string;
  ok: boolean;
  statusCode?: number;
  errors: string[];
  warnings: string[];
}

export function errorText(errs: EbayErrorItem[] | undefined): string[] {
  return (errs ?? []).map((e) =>
    [e.errorId, e.longMessage || e.message].filter((x) => x !== undefined && x !== "").join(": "));
}

/** POST /sell/inventory/v1/bulk_create_or_replace_inventory_item, 25 per call. */
export async function bulkCreateOrReplaceInventoryItems(
  rest: EbayRest,
  items: InventoryItemPayload[],
): Promise<BulkRowResult[]> {
  const out: BulkRowResult[] = [];
  for (const part of chunk(items, BULK_MAX)) {
    const r = await rest.call<{ responses?: {
      statusCode?: number; sku?: string; errors?: EbayErrorItem[]; warnings?: EbayErrorItem[];
    }[] }>("POST", "/sell/inventory/v1/bulk_create_or_replace_inventory_item", {
      body: { requests: part },
      context: "bulk create inventory items",
    });
    const bySku = new Map((r?.responses ?? []).map((x) => [x.sku, x]));
    for (const it of part) {
      const x = bySku.get(it.sku);
      out.push({
        key: it.sku,
        ok: Boolean(x && x.statusCode !== undefined && x.statusCode < 300 && !x.errors?.length),
        statusCode: x?.statusCode,
        errors: x ? errorText(x.errors) : ["no response from eBay for this SKU"],
        warnings: errorText(x?.warnings),
      });
    }
  }
  return out;
}

export interface InventoryItemSummary {
  sku: string;
  title?: string;
  quantity?: number;
  condition?: string;
  imageUrls?: string[];
}

/** GET /sell/inventory/v1/inventory_item, paginated to the end (capped). */
export async function listAllInventoryItems(rest: EbayRest, maxItems = 2000): Promise<InventoryItemSummary[]> {
  const out: InventoryItemSummary[] = [];
  const limit = 100;
  for (let offset = 0; offset < maxItems; offset += limit) {
    const r = await rest.call<{ total?: number; inventoryItems?: {
      sku: string; condition?: string;
      product?: { title?: string; imageUrls?: string[] };
      availability?: { shipToLocationAvailability?: { quantity?: number } };
    }[] }>("GET", "/sell/inventory/v1/inventory_item", { query: { limit, offset }, context: "list inventory items" });
    const page = r?.inventoryItems ?? [];
    for (const i of page) {
      out.push({
        sku: i.sku,
        title: i.product?.title,
        quantity: i.availability?.shipToLocationAvailability?.quantity,
        condition: i.condition,
        imageUrls: i.product?.imageUrls,
      });
    }
    if (page.length < limit || offset + limit >= (r?.total ?? 0)) break;
  }
  return out;
}
