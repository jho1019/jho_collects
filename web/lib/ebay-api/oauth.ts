import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "./errors";
import type { EbayConfig } from "./config";
import type { FetchLike } from "./http";

// eBay OAuth 2.0: authorization-code grant (user token, for Sell APIs and the
// Trading API via IAF), refresh grant, and client-credentials grant (app
// token, for Browse / Marketplace Insights).
//
// Token endpoint: POST {api}/identity/v1/oauth2/token, form-encoded, HTTP
// Basic auth with client_id:client_secret. Lifetimes per eBay docs: access
// token ~2h (expires_in 7200), refresh token ~18 months
// (refresh_token_expires_in 47304000). We trust the numbers in the response,
// never these constants.

export const STATE_TTL_MS = 10 * 60 * 1000;

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/** Only the hash is stored server-side, so a DB read cannot replay a state. */
export function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/**
 * Browser consent URL. Built by hand rather than URLSearchParams because the
 * latter encodes the space between scopes as `+`; eBay's docs show `%20`.
 */
export function buildConsentUrl(cfg: EbayConfig, state: string, scopes: readonly string[]): string {
  const params: [string, string][] = [
    ["client_id", cfg.clientId],
    ["redirect_uri", cfg.ruName],
    ["response_type", "code"],
    ["scope", scopes.join(" ")],
    ["state", state],
  ];
  return `${cfg.endpoints.auth}/oauth2/authorize?${params
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&")}`;
}

/** eBay's OAuth error body is {error, error_description}. */
export class OAuthError extends ApiError {
  constructor(
    public readonly oauthError: string,
    description: string | undefined,
    public readonly upstreamStatus: number,
    context: string,
  ) {
    super(502, "ebay_oauth_failed", `${context}: ${oauthError}${description ? ` (${description})` : ""}`, {
      upstream_status: upstreamStatus,
      oauth_error: oauthError,
    });
    this.name = "OAuthError";
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type?: string;
}

async function tokenRequest(
  cfg: EbayConfig,
  fetchImpl: FetchLike,
  form: Record<string, string>,
  context: string,
): Promise<TokenResponse> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString("base64");
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.endpoints.api}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(502, "ebay_unreachable", `${context}: eBay identity service unreachable`);
  }
  const text = await res.text();
  let j: Partial<TokenResponse> & { error?: string; error_description?: string } = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* fall through to the status-only error */
  }
  if (!res.ok || !j.access_token) {
    throw new OAuthError(j.error ?? `http_${res.status}`, j.error_description, res.status, context);
  }
  return j as TokenResponse;
}

export interface UserTokenGrant {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date | null;
}

export async function exchangeCode(
  cfg: EbayConfig,
  fetchImpl: FetchLike,
  code: string,
  now: Date = new Date(),
): Promise<UserTokenGrant> {
  const t = await tokenRequest(
    cfg,
    fetchImpl,
    { grant_type: "authorization_code", code, redirect_uri: cfg.ruName },
    "exchange authorization code",
  );
  if (!t.refresh_token) {
    throw new ApiError(502, "ebay_oauth_failed", "exchange authorization code: no refresh token returned");
  }
  return {
    accessToken: t.access_token,
    accessTokenExpiresAt: new Date(now.getTime() + t.expires_in * 1000),
    refreshToken: t.refresh_token,
    refreshTokenExpiresAt: t.refresh_token_expires_in
      ? new Date(now.getTime() + t.refresh_token_expires_in * 1000)
      : null,
  };
}

/**
 * Refresh grant. eBay requires the scope list to be a subset of what the user
 * consented to, and does not rotate the refresh token.
 */
export async function refreshUserToken(
  cfg: EbayConfig,
  fetchImpl: FetchLike,
  refreshToken: string,
  scopes: readonly string[],
  now: Date = new Date(),
): Promise<{ accessToken: string; accessTokenExpiresAt: Date }> {
  const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken };
  if (scopes.length) form.scope = scopes.join(" ");
  const t = await tokenRequest(cfg, fetchImpl, form, "refresh eBay access token");
  return {
    accessToken: t.access_token,
    accessTokenExpiresAt: new Date(now.getTime() + t.expires_in * 1000),
  };
}

// ------------------------------------------------------------- app token
// Client-credentials token, cached in memory per (environment, client, scope
// set). Per-instance on serverless — a cold start just mints a new one, which
// eBay allows (app tokens are not single-use and several may be live).

const APP_SKEW_MS = 120_000;
const appTokens = new Map<string, { token: string; expiresAt: number }>();
const appInflight = new Map<string, Promise<string>>();

export async function getAppToken(
  cfg: EbayConfig,
  fetchImpl: FetchLike,
  scopes: readonly string[],
  now: () => number = Date.now,
): Promise<string> {
  const key = `${cfg.environment}|${cfg.clientId}|${[...scopes].sort().join(" ")}`;
  const hit = appTokens.get(key);
  if (hit && hit.expiresAt - now() > APP_SKEW_MS) return hit.token;
  const pending = appInflight.get(key);
  if (pending) return pending;
  const p = tokenRequest(
    cfg,
    fetchImpl,
    { grant_type: "client_credentials", scope: scopes.join(" ") },
    "mint eBay application token",
  )
    .then((t) => {
      appTokens.set(key, { token: t.access_token, expiresAt: now() + t.expires_in * 1000 });
      return t.access_token;
    })
    .finally(() => appInflight.delete(key));
  appInflight.set(key, p);
  return p;
}

/** Test hook. */
export function clearAppTokenCache(): void {
  appTokens.clear();
  appInflight.clear();
}
