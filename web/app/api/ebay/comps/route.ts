import type { NextRequest } from "next/server";
import { parseCompQuery, searchActive } from "@/lib/ebay-api/browse";
import { getComps } from "@/lib/ebay-api/comps";
import { ebayContext } from "@/lib/ebay-api/context";
import { fetchOrders } from "@/lib/ebay-api/fulfillment";
import { insightsForRequest, insightsRest, searchSold } from "@/lib/ebay-api/insights";
import { apiRoute, boolParam } from "@/lib/ebay-api/respond";

// GET /api/ebay/comps?q=...&grader=PSA&grade=10&graded=true|false&category_id=261328&limit=50&exclude_outliers=true[&insights=0]
// Sold signal: own sales (primary). Marketplace Insights only when
// EBAY_INSIGHTS_ENABLED=true; then ?insights=0 skips it for one request.
export const maxDuration = 30;

export const GET = apiRoute(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const q = parseCompQuery(sp);
  const excludeOutliers = boolParam(sp, "exclude_outliers", true);
  const ctx = ebayContext();
  const useInsights = insightsForRequest(sp, ctx.env);
  return getComps({
    browse: (query) => searchActive(ctx.appRest, query),
    sold: useInsights ? (query) => searchSold(insightsRest(ctx.config, ctx.fetch), query) : null,
    ownOrders: (days) => fetchOrders(ctx.userRest, { field: "creationdate", since: new Date(Date.now() - days * 86_400_000) }),
  }, q, excludeOutliers);
});
