import "server-only";
import { ConfigError } from "./errors";

// Every env var is read lazily, at request time, through these functions —
// never at module load — so `next build` succeeds with no eBay secrets set.
// Functions take an `env` argument (default process.env) so tests can pass a
// plain object instead of mutating the process environment.

export type Env = Record<string, string | undefined>;
export type EbayEnvironment = "production" | "sandbox";

export const SCOPE_BASE = "https://api.ebay.com/oauth/api_scope";

/** Granted to every keyset. Requested on every user consent. */
export const USER_SCOPES = [
  SCOPE_BASE,
  `${SCOPE_BASE}/sell.inventory`,
  `${SCOPE_BASE}/sell.account`,
  `${SCOPE_BASE}/sell.fulfillment`,
] as const;

/**
 * Optional extras, requested only with /oauth/start?extra_scopes=1 (or
 * EBAY_EXTRA_SCOPES=1). Not every keyset is granted these, and asking for a
 * scope the keyset lacks makes eBay reject the whole consent with
 * `invalid_scope` — so they are off by default.
 *
 * UNVERIFIED against a live keyset: buy.marketplace.insights is, per eBay's
 * docs, an *application* (client-credentials) scope for the Marketplace
 * Insights API, which is why insights.ts requests it on the app token rather
 * than relying on the user token. It is listed here only so a keyset that
 * does carry it as a user scope can opt in.
 */
export const EXTRA_USER_SCOPES = [
  `${SCOPE_BASE}/commerce.catalog.readonly`,
  `${SCOPE_BASE}/buy.marketplace.insights`,
] as const;

export const INSIGHTS_SCOPE = `${SCOPE_BASE}/buy.marketplace.insights`;

export interface EbayEndpoints {
  /** REST APIs: sell/*, buy/*, identity token endpoint. */
  api: string;
  /** Browser consent page host. */
  auth: string;
  /** Legacy Trading API (XML). */
  trading: string;
}

export const ENDPOINTS: Record<EbayEnvironment, EbayEndpoints> = {
  production: {
    api: "https://api.ebay.com",
    auth: "https://auth.ebay.com",
    trading: "https://api.ebay.com/ws/api.dll",
  },
  sandbox: {
    api: "https://api.sandbox.ebay.com",
    auth: "https://auth.sandbox.ebay.com",
    trading: "https://api.sandbox.ebay.com/ws/api.dll",
  },
};

export interface EbayConfig {
  environment: EbayEnvironment;
  clientId: string;
  clientSecret: string;
  devId?: string;
  /** eBay "RuName" — sent as redirect_uri. Not a URL. */
  ruName: string;
  marketplaceId: string;
  endpoints: EbayEndpoints;
  extraScopesByDefault: boolean;
}

/**
 * Marketplace Insights (sold comps) is an opt-in upgrade: the production
 * keyset was refused the scope (invalid_scope, 2026-11-21). Off unless
 * EBAY_INSIGHTS_ENABLED=true; while off, comps never mint an insights token or
 * call the API. The probe route ignores this so access can be re-tested.
 */
export function insightsEnabled(env: Env = process.env): boolean {
  return env.EBAY_INSIGHTS_ENABLED?.trim().toLowerCase() === "true";
}

export function getEbayEnvironment(env: Env = process.env): EbayEnvironment {
  const v = (env.EBAY_ENV ?? "production").trim().toLowerCase();
  if (v === "production" || v === "sandbox") return v;
  throw new ConfigError(`EBAY_ENV must be "production" or "sandbox", got "${v}"`);
}

export function getEbayConfig(env: Env = process.env): EbayConfig {
  const missing = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME"].filter(
    (k) => !env[k]?.trim(),
  );
  if (missing.length) {
    throw new ConfigError("eBay API is not configured", { missing_env: missing });
  }
  const environment = getEbayEnvironment(env);
  return {
    environment,
    clientId: env.EBAY_CLIENT_ID!.trim(),
    clientSecret: env.EBAY_CLIENT_SECRET!.trim(),
    devId: env.EBAY_DEV_ID?.trim() || undefined,
    ruName: env.EBAY_RUNAME!.trim(),
    marketplaceId: env.EBAY_MARKETPLACE_ID?.trim() || "EBAY_US",
    endpoints: ENDPOINTS[environment],
    extraScopesByDefault: env.EBAY_EXTRA_SCOPES === "1",
  };
}
