import { ApiError } from "./errors";
import type { EbayConfig, EbayEnvironment } from "./config";
import type { FetchLike } from "./http";
import { OAuthError, refreshUserToken } from "./oauth";

// The stored eBay user token and the logic that keeps its access token fresh.
//
// Storage is behind `TokenStore` (Supabase in production, an in-memory fake
// in tests). Refresh rules:
//   - an access token with less than REFRESH_SKEW_MS left is refreshed;
//   - concurrent callers in one process share ONE refresh (single-flight);
//   - before refreshing, the store is re-read, so a token another serverless
//     instance just refreshed is reused instead of minting a second one;
//   - `invalid_grant` (refresh token expired or revoked) becomes a 503
//     `ebay_reauth_required` telling the owner to reconnect.
//
// Cross-instance refreshes are not locked. Two instances refreshing at the
// same moment both succeed (eBay permits several live access tokens) and the
// last write wins — harmless, so not worth a database lock.

export const REFRESH_SKEW_MS = 2 * 60 * 1000;
export const REFRESH_TOKEN_WARN_DAYS = 30;

export interface StoredUserToken {
  environment: EbayEnvironment;
  seller: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshToken: string;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
}

export interface TokenStore {
  load(environment: EbayEnvironment): Promise<StoredUserToken | null>;
  save(token: StoredUserToken): Promise<void>;
}

export interface TokenDeps {
  store: TokenStore;
  config: EbayConfig;
  fetch: FetchLike;
  now?: () => Date;
}

const inflight = new Map<string, Promise<string>>();

function fresh(t: StoredUserToken, now: Date): boolean {
  return Boolean(
    t.accessToken &&
      t.accessTokenExpiresAt &&
      t.accessTokenExpiresAt.getTime() - now.getTime() > REFRESH_SKEW_MS,
  );
}

function notConnected(): ApiError {
  return new ApiError(503, "ebay_not_connected",
    "No eBay account is connected. Visit /api/ebay/oauth/start while signed in.");
}

function reauth(why: string): ApiError {
  return new ApiError(503, "ebay_reauth_required",
    `eBay authorization must be renewed (${why}). Visit /api/ebay/oauth/start while signed in.`);
}

export async function getUserAccessToken(deps: TokenDeps): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const env = deps.config.environment;
  const t = await deps.store.load(env);
  if (!t) throw notConnected();
  if (fresh(t, now)) return t.accessToken!;

  const key = `${env}|${t.seller}`;
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = refreshNow(deps, env).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function refreshNow(deps: TokenDeps, env: EbayEnvironment): Promise<string> {
  const now = deps.now?.() ?? new Date();
  // Re-read: another instance may have refreshed while we were deciding to.
  const t = await deps.store.load(env);
  if (!t) throw notConnected();
  if (fresh(t, now)) return t.accessToken!;
  if (t.refreshTokenExpiresAt && t.refreshTokenExpiresAt.getTime() <= now.getTime()) {
    throw reauth("refresh token expired");
  }
  let grant;
  try {
    grant = await refreshUserToken(deps.config, deps.fetch, t.refreshToken, t.scopes, now);
  } catch (err) {
    if (err instanceof OAuthError && err.oauthError === "invalid_grant") throw reauth("refresh token rejected");
    throw err;
  }
  await deps.store.save({ ...t, accessToken: grant.accessToken, accessTokenExpiresAt: grant.accessTokenExpiresAt });
  return grant.accessToken;
}

/** Secret-free summary for /oauth/status. */
export function tokenStatus(t: StoredUserToken | null, now: Date = new Date()) {
  if (!t) return { connected: false as const };
  const daysLeft = t.refreshTokenExpiresAt
    ? Math.floor((t.refreshTokenExpiresAt.getTime() - now.getTime()) / 86_400_000)
    : null;
  let warning: string | null = null;
  if (daysLeft !== null && daysLeft <= 0) warning = "Refresh token has expired. Reconnect via /api/ebay/oauth/start.";
  else if (daysLeft !== null && daysLeft <= REFRESH_TOKEN_WARN_DAYS) {
    warning = `Refresh token expires in ${daysLeft} day(s). Reconnect via /api/ebay/oauth/start before then.`;
  }
  return {
    connected: true as const,
    environment: t.environment,
    scopes: t.scopes,
    access_token_expires_at: t.accessTokenExpiresAt?.toISOString() ?? null,
    access_token_valid: fresh(t, now),
    refresh_token_expires_at: t.refreshTokenExpiresAt?.toISOString() ?? null,
    refresh_token_days_left: daysLeft,
    warning,
  };
}

/** Test hook. */
export function clearTokenInflight(): void {
  inflight.clear();
}
