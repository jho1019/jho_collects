import type { NextRequest } from "next/server";
import { ebayContext } from "@/lib/ebay-api/context";
import { filterStatus, fromTrading, inventoryListings, mergeListings, parseSource, parseStatus, type Listing } from "@/lib/ebay-api/listings";
import { apiRoute, intParam } from "@/lib/ebay-api/respond";
import { getActiveListings } from "@/lib/ebay-api/trading";

// GET /api/ebay/listings?source=all|inventory|trading&status=active|unpublished|all&limit=50&offset=0
//
// source=inventory sees only Inventory-API-created listings; trading sees all
// active listings (incl. CDP / Seller Hub); all (default) merges both.
export const maxDuration = 60;

export const GET = apiRoute(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const source = parseSource(sp.get("source"));
  const status = parseStatus(sp.get("status"));
  const limit = intParam(sp, "limit", 50, 1, 500);
  const offset = intParam(sp, "offset", 0, 0, 100_000);
  const ctx = ebayContext();
  const env = ctx.config.environment;

  const [inv, trading] = await Promise.all([
    source === "trading" ? Promise.resolve<Listing[]>([]) : inventoryListings(ctx.userRest, env),
    source === "inventory"
      ? Promise.resolve<Listing[]>([])
      : getActiveListings({ endpoint: ctx.config.endpoints.trading, fetch: ctx.fetch, token: ctx.userToken }).then((t) => fromTrading(t, env)),
  ]);
  const all = filterStatus(mergeListings(inv, trading), status);
  return {
    source,
    status,
    total: all.length,
    limit,
    offset,
    listings: all.slice(offset, offset + limit),
    note: source !== "trading"
      ? "The Inventory API only returns listings created through it; listings made in Card Dealer Pro or Seller Hub appear only via source=trading."
      : undefined,
  };
});
