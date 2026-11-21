import { ebayContext, syncDeps } from "@/lib/ebay-api/context";
import { apiRoute } from "@/lib/ebay-api/respond";
import { runSync } from "@/lib/ebay-api/sync/run";

// GET /api/ebay/cron/sync — Vercel Cron (web/vercel.json). Auth: Vercel sends
// `Authorization: Bearer $CRON_SECRET`. Real run from the stored cursor.
// Returns counts only; the per-line plan is available from POST /api/ebay/sync.
export const maxDuration = 60;

export const GET = apiRoute(async () => {
  const r = await runSync(syncDeps(ebayContext()), { dryRun: false });
  return {
    since: r.since,
    run_at: r.run_at,
    orders_fetched: r.orders_fetched,
    lines: r.lines,
    counts: r.counts,
    cursor_advanced: r.cursor_advanced,
    fuzzy_matches: r.fuzzy_matches.length,
    errors: r.errors.length,
  };
}, "cron");
