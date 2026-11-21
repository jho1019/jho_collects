import type { NextRequest } from "next/server";
import { ebayContext } from "@/lib/ebay-api/context";
import { assertOfferId } from "@/lib/ebay-api/offers";
import { apiRoute, intParam } from "@/lib/ebay-api/respond";
import { recentPriceChanges } from "@/lib/ebay-api/store";

// GET /api/ebay/price-changes?limit=50&offer_id=...  — the audit log, newest first.
export const GET = apiRoute(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const limit = intParam(sp, "limit", 50, 1, 500);
  const offerId = sp.get("offer_id");
  const ctx = ebayContext();
  return { price_changes: await recentPriceChanges(ctx.db, ctx.config.environment, limit, offerId ? assertOfferId(offerId) : undefined) };
});
