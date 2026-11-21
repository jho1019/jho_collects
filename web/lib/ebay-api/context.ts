import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEbayConfig, SCOPE_BASE, type Env } from "./config";
import { fetchOrders } from "./fulfillment";
import { EbayRest, type FetchLike } from "./http";
import { getAppToken } from "./oauth";
import { supabaseTokenStore } from "./store";
import { supabaseSyncRepo } from "./sync/supabase-repo";
import type { SyncDeps } from "./sync/run";
import { getUserAccessToken } from "./tokens";

// Per-request wiring for route handlers. Reads env at call time (never at
// import), so `next build` needs no eBay or service-role secrets.

const nodeFetch: FetchLike = (input, init) => fetch(input, { ...init, cache: "no-store" });

export function ebayContext(env: Env = process.env) {
  const config = getEbayConfig(env);
  const db = createAdminClient();
  const tokenStore = supabaseTokenStore(db);
  const userToken = () => getUserAccessToken({ store: tokenStore, config, fetch: nodeFetch });
  const rest = (token: () => Promise<string>) =>
    new EbayRest({ apiBase: config.endpoints.api, fetch: nodeFetch, token, marketplaceId: config.marketplaceId });
  return {
    env,
    config,
    db,
    fetch: nodeFetch,
    tokenStore,
    userToken,
    /** Sell APIs + Trading: the seller's OAuth user token. */
    userRest: rest(userToken),
    /** Browse: client-credentials app token, base scope. */
    appRest: rest(() => getAppToken(config, nodeFetch, [SCOPE_BASE])),
  };
}

export type EbayContext = ReturnType<typeof ebayContext>;

export function syncDeps(ctx: EbayContext): SyncDeps {
  return {
    environment: ctx.config.environment,
    repo: supabaseSyncRepo(ctx.db, ctx.env),
    fetchOrders: (since) => fetchOrders(ctx.userRest, { field: "lastmodifieddate", since }),
  };
}
