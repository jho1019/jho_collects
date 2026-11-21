import { INSIGHTS_SCOPE, SCOPE_BASE, type EbayConfig } from "./config";
import { ApiError, EbayApiError } from "./errors";
import { EbayRest, type Amount, type FetchLike } from "./http";
import { getAppToken, OAuthError } from "./oauth";
import { browseParams, type CompQuery } from "./browse";

// Marketplace Insights API — SOLD items, last 90 days. Restricted: eBay
// grants it per application on request, and most sellers do not have it.
//
//   GET /buy/marketplace_insights/v1_beta/item_sales/search
//   app token (client credentials) with scope .../buy.marketplace.insights
//
// No access shows up one of two ways, both handled as "unavailable":
//   - minting the app token fails with OAuth `invalid_scope` (keyset not
//     entitled to the scope at all), or
//   - the call itself returns 403 (or 401) — entitled scope but no API access.

export const INSIGHTS_PATH = "/buy/marketplace_insights/v1_beta/item_sales/search";

export interface SoldComp {
  itemId: string;
  title: string;
  price: string | null;
  currency: string | null;
  soldDate: string | null;
  quantitySold: number | null;
  url: string | null;
}

export class InsightsUnavailable extends Error {
  constructor(public readonly reason: string, public readonly status: number | null, public readonly scopeGranted: boolean) {
    super(reason);
    this.name = "InsightsUnavailable";
  }
}

/** Translate a failure into InsightsUnavailable when it means "no access"; rethrow otherwise. */
export function classifyInsightsError(err: unknown): never {
  if (err instanceof OAuthError && err.oauthError === "invalid_scope") {
    throw new InsightsUnavailable("keyset is not granted the buy.marketplace.insights scope (invalid_scope)", err.upstreamStatus, false);
  }
  if (err instanceof EbayApiError && (err.upstreamStatus === 403 || err.upstreamStatus === 401)) {
    const msg = err.ebayErrors[0]?.longMessage || err.ebayErrors[0]?.message || "access denied";
    throw new InsightsUnavailable(`Marketplace Insights denied: ${msg}`, err.upstreamStatus, true);
  }
  throw err;
}

export function insightsRest(cfg: EbayConfig, fetchImpl: FetchLike): EbayRest {
  return new EbayRest({
    apiBase: cfg.endpoints.api,
    fetch: fetchImpl,
    marketplaceId: cfg.marketplaceId,
    token: () => getAppToken(cfg, fetchImpl, [SCOPE_BASE, INSIGHTS_SCOPE]),
  });
}

export async function searchSold(rest: EbayRest, q: CompQuery): Promise<SoldComp[]> {
  const params = browseParams(q);
  delete (params as Record<string, unknown>).filter; // buyingOptions does not apply to sold items
  try {
    const r = await rest.call<{ itemSales?: {
      itemId: string; title?: string; lastSoldPrice?: Amount; lastSoldDate?: string; totalSoldQuantity?: number; itemWebUrl?: string;
    }[] }>("GET", INSIGHTS_PATH, { query: params, context: "marketplace insights search" });
    return (r?.itemSales ?? []).map((s) => ({
      itemId: s.itemId,
      title: s.title ?? "",
      price: s.lastSoldPrice?.value ?? null,
      currency: s.lastSoldPrice?.currency ?? null,
      soldDate: s.lastSoldDate ?? null,
      quantitySold: s.totalSoldQuantity ?? null,
      url: s.itemWebUrl ?? null,
    }));
  } catch (e) {
    classifyInsightsError(e);
  }
}

export interface ProbeResult {
  available: boolean;
  status: number | null;
  reason: string;
  /** Did eBay mint an app token carrying the insights scope? */
  scopeGranted: boolean;
  /** Does the stored USER token list the insights scope? (Informational: the API is called with the app token.) */
  userTokenHasScope: boolean | null;
}

/** One minimal call (limit=1). Safe to run any time; touches no data. */
export async function probeInsights(cfg: EbayConfig, fetchImpl: FetchLike, userScopes: string[] | null): Promise<ProbeResult> {
  const userTokenHasScope = userScopes ? userScopes.includes(INSIGHTS_SCOPE) : null;
  try {
    await searchSold(insightsRest(cfg, fetchImpl), { q: "baseball card", categoryId: "261328", limit: 1 });
    return { available: true, status: 200, reason: "Marketplace Insights is available to this keyset", scopeGranted: true, userTokenHasScope };
  } catch (e) {
    if (e instanceof InsightsUnavailable) {
      return { available: false, status: e.status, reason: e.reason, scopeGranted: e.scopeGranted, userTokenHasScope };
    }
    if (e instanceof ApiError) {
      return { available: false, status: e.status, reason: `probe failed: ${e.message}`, scopeGranted: false, userTokenHasScope };
    }
    throw e;
  }
}
