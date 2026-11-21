import type { NextRequest } from "next/server";
import { hasValidApiKey } from "@/lib/ebay-api/auth";
import { EXTRA_USER_SCOPES, USER_SCOPES } from "@/lib/ebay-api/config";
import { ebayContext } from "@/lib/ebay-api/context";
import { ApiError } from "@/lib/ebay-api/errors";
import { buildConsentUrl, generateState, hashState, STATE_TTL_MS } from "@/lib/ebay-api/oauth";
import { apiRoute, boolParam, json } from "@/lib/ebay-api/respond";
import { saveOAuthState } from "@/lib/ebay-api/store";
import { createClient } from "@/lib/supabase/server";

// GET /api/ebay/oauth/start[?extra_scopes=1]
//
// auth: "none" at the wrapper because this route accepts EITHER of two
// credentials, checked below: a signed-in Supabase session (browser -> 302 to
// eBay) or a valid x-api-key (machine -> JSON with the URL to open). proxy.ts
// no longer gates /api/ebay/*, so this check is the only gate.

async function signedIn(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return Boolean(data.user);
  } catch {
    return false; // Supabase public env missing or auth unreachable: not signed in
  }
}

export const GET = apiRoute(async (req: NextRequest) => {
  const viaKey = hasValidApiKey(req.headers);
  if (!viaKey && !(await signedIn())) {
    throw new ApiError(401, "unauthorized", "sign in to the dashboard first, or send a valid x-api-key");
  }
  const ctx = ebayContext();
  const extra = boolParam(req.nextUrl.searchParams, "extra_scopes", ctx.config.extraScopesByDefault);
  const scopes = [...USER_SCOPES, ...(extra ? EXTRA_USER_SCOPES : [])];

  const state = generateState();
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  await saveOAuthState(ctx.db, { stateHash: hashState(state), environment: ctx.config.environment, scopes, expiresAt });
  const url = buildConsentUrl(ctx.config, state, scopes);

  if (viaKey) return json({ authorization_url: url, expires_at: expiresAt.toISOString(), scopes });
  return Response.redirect(url, 302);
}, "none");
