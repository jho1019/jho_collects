import type { NextRequest } from "next/server";
import { ebayContext } from "@/lib/ebay-api/context";
import { actorFrom, endListing, parseIdKind } from "@/lib/ebay-api/price";
import { apiRoute, readJson } from "@/lib/ebay-api/respond";
import { supabaseAuditStore, supabaseListingStore } from "@/lib/ebay-api/store";

// POST /api/ebay/listings/{id}/end[?by=sku]   body: {"reason": "sold at a show"}
// Withdraws the offer (ends the eBay listing, keeps the offer and inventory
// item so it can be republished). Logged to listing_events.
export const POST = apiRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const by = parseIdKind(req.nextUrl.searchParams.get("by"));
  const body = await readJson(req);
  const ctx = ebayContext();
  return endListing(
    { rest: ctx.userRest, audit: supabaseAuditStore(ctx.db), environment: ctx.config.environment, listings: supabaseListingStore(ctx.db, ctx.env) },
    { id, by, reason: body.reason, actor: actorFrom(req.headers) },
  );
});
