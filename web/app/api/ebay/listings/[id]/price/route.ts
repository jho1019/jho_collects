import type { NextRequest } from "next/server";
import { ebayContext } from "@/lib/ebay-api/context";
import { actorFrom, parseIdKind, updatePrice } from "@/lib/ebay-api/price";
import { apiRoute, readJson } from "@/lib/ebay-api/respond";
import { supabaseAuditStore, supabaseListingStore } from "@/lib/ebay-api/store";

// POST /api/ebay/listings/{id}/price            {id} = offerId (default)
// POST /api/ebay/listings/{id}/price?by=sku     {id} = SKU (must have exactly one offer)
// body: {"price": 12.5, "reason": "comps dropped"}   — every attempt logged to price_changes
export const POST = apiRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const by = parseIdKind(req.nextUrl.searchParams.get("by"));
  const body = await readJson(req);
  const ctx = ebayContext();
  return updatePrice(
    { rest: ctx.userRest, audit: supabaseAuditStore(ctx.db), environment: ctx.config.environment, listings: supabaseListingStore(ctx.db, ctx.env) },
    { id, by, price: body.price, reason: body.reason, actor: actorFrom(req.headers) },
  );
});
