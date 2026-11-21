import { ebayContext } from "@/lib/ebay-api/context";
import { probeInsights } from "@/lib/ebay-api/insights";
import { apiRoute } from "@/lib/ebay-api/respond";

// GET /api/ebay/insights/probe — does this keyset have Marketplace Insights?
// One item_sales/search call with limit=1. Read-only, safe to run any time.
export const GET = apiRoute(async () => {
  const ctx = ebayContext();
  const t = await ctx.tokenStore.load(ctx.config.environment).catch(() => null);
  return probeInsights(ctx.config, ctx.fetch, t?.scopes ?? null);
});
