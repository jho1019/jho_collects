import type { NextRequest } from "next/server";
import { ebayContext, syncDeps } from "@/lib/ebay-api/context";
import { ApiError } from "@/lib/ebay-api/errors";
import { apiRoute, boolParam } from "@/lib/ebay-api/respond";
import { runSync } from "@/lib/ebay-api/sync/run";
import { syncOverview } from "@/lib/ebay-api/sync/supabase-repo";

// GET  /api/ebay/sync                          cursor, last run, pending count, needs_review lines
// POST /api/ebay/sync?dry_run=true&since=ISO   run the sold-order sync by hand.
//      dry_run defaults to TRUE (returns the plan, writes nothing).
//      since overrides the cursor (e.g. a first back-fill).
export const maxDuration = 60;

export const GET = apiRoute(async () => {
  const ctx = ebayContext();
  return syncOverview(ctx.db, ctx.config.environment);
});

export const POST = apiRoute(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const dryRun = boolParam(sp, "dry_run", true);
  const sinceRaw = sp.get("since");
  let since: Date | undefined;
  if (sinceRaw) {
    since = new Date(sinceRaw);
    if (Number.isNaN(since.getTime()) || since.getTime() > Date.now()) {
      throw new ApiError(400, "invalid_param", "since must be an ISO date in the past");
    }
  }
  return runSync(syncDeps(ebayContext()), { dryRun, since });
});
