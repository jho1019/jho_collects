import { ebayContext } from "@/lib/ebay-api/context";
import { apiRoute } from "@/lib/ebay-api/respond";
import { tokenStatus } from "@/lib/ebay-api/tokens";

// GET /api/ebay/oauth/status — connected?, scopes, expiries. No secret values.
export const GET = apiRoute(async () => {
  const ctx = ebayContext();
  const t = await ctx.tokenStore.load(ctx.config.environment);
  return { environment: ctx.config.environment, marketplace_id: ctx.config.marketplaceId, ...tokenStatus(t) };
});
