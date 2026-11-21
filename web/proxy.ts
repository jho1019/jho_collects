import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/session";

// Next 16 renamed the `middleware` convention to `proxy`. Same semantics.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Everything except Next internals, static assets, and /api/ebay/*.
    //
    // /api/ebay/* is machine-facing (Yoshi, Vercel Cron, eBay's own callbacks)
    // and must not be redirected to /login. Every route there authenticates
    // itself: x-api-key, the cron bearer, or — for oauth/start — a Supabase
    // session checked inside the handler. See web/lib/ebay-api/respond.ts.
    "/((?!_next/static|_next/image|favicon.ico|api/ebay(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
