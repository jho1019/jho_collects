import type { NextRequest } from "next/server";
import { ebayContext } from "@/lib/ebay-api/context";
import { ApiError } from "@/lib/ebay-api/errors";
import { htmlPage } from "@/lib/ebay-api/html";
import { exchangeCode, hashState } from "@/lib/ebay-api/oauth";
import { consumeOAuthState } from "@/lib/ebay-api/store";

// GET /api/ebay/oauth/callback?code=...&state=...      (eBay "auth accepted URL")
// GET /api/ebay/oauth/callback[?state=...]              (eBay "auth declined URL")
//
// The RuName's accepted AND declined URLs are both exactly
// https://jho-collects.vercel.app/api/ebay/oauth/callback. eBay's decline
// redirect carries no `code` (it may carry `state`, or `error=access_denied`),
// so "no code" is treated as a decline: a friendly page, nothing stored, the
// state left to expire. `?declined=1` is still honoured for old RuNames.
//
// No x-api-key: eBay redirects the owner's browser here. The CSRF guard is
// the `state`: its hash must exist in ebay_oauth_states, unexpired and unused,
// and it is consumed atomically so it works exactly once. The page shows a
// plain success/failure message — never a token.

export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const code = sp.get("code");
  const state = sp.get("state");
  if (sp.get("declined") || sp.get("error") || !code) {
    return htmlPage("eBay authorization declined",
      "eBay was not connected, and nothing was saved. If that was a mistake, start again from /api/ebay/oauth/start.", false, 200);
  }
  if (!state || state.length > 200 || code.length > 2000) {
    return htmlPage("eBay authorization failed", "The callback was missing its code or state.", false);
  }

  try {
    const ctx = ebayContext();
    const scopes = await consumeOAuthState(ctx.db, hashState(state), ctx.config.environment);
    if (!scopes) {
      return htmlPage("eBay authorization failed",
        "This sign-in link is invalid, expired or already used. Start again from /api/ebay/oauth/start.", false);
    }
    const grant = await exchangeCode(ctx.config, ctx.fetch, code);
    await ctx.tokenStore.save({
      environment: ctx.config.environment,
      seller: "default",
      accessToken: grant.accessToken,
      accessTokenExpiresAt: grant.accessTokenExpiresAt,
      refreshToken: grant.refreshToken,
      refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
      scopes,
    });
    const until = grant.refreshTokenExpiresAt ? ` Authorization lasts until ${grant.refreshTokenExpiresAt.toDateString()}.` : "";
    return htmlPage("eBay connected", `The ${ctx.config.environment} eBay account is connected.${until}`, true);
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "internal_error";
    if (!(err instanceof ApiError)) console.error("[ebay-api] oauth callback:", err instanceof Error ? err.message : err);
    return htmlPage("eBay authorization failed", `Could not complete the connection (${code}). Start again from /api/ebay/oauth/start.`, false,
      err instanceof ApiError && err.status >= 500 ? 502 : 400);
  }
}
