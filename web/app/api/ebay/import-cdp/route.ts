import type { NextRequest } from "next/server";
import { importCdp } from "@/lib/ebay-api/cdp/import";
import { ebayContext } from "@/lib/ebay-api/context";
import { ApiError } from "@/lib/ebay-api/errors";
import { accountLookup, POLICY_KEYS, type PolicyField } from "@/lib/ebay-api/policies";
import { apiRoute, boolParam } from "@/lib/ebay-api/respond";
import { supabaseConfigStore, supabaseListingStore } from "@/lib/ebay-api/store";

// POST /api/ebay/import-cdp
//   body: multipart/form-data with a `file` field, OR a raw text/csv body
//   dry_run   default TRUE — only dry_run=false sends anything to eBay
//   publish   default false — create inventory items + offers; true also publishes
//   fulfillment_policy_id / payment_policy_id / return_policy_id / merchant_location_key
//             optional per-request overrides (query string or form fields)
export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024; // under Vercel's 4.5 MB request body limit

async function readBody(req: NextRequest): Promise<{ csv: string; fields: URLSearchParams }> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) throw new ApiError(413, "payload_too_large", "CSV must be under 4 MB");
  const type = req.headers.get("content-type") ?? "";
  const fields = new URLSearchParams();
  let csv: string;
  if (type.startsWith("multipart/form-data")) {
    const form = await req.formData().catch(() => {
      throw new ApiError(400, "invalid_body", "could not read multipart body");
    });
    const file = form.get("file");
    if (!file || typeof file === "string") throw new ApiError(400, "invalid_body", "multipart body needs a `file` field");
    csv = await file.text();
    for (const [k, v] of form.entries()) if (typeof v === "string") fields.set(k, v);
  } else if (type.startsWith("text/csv") || type.startsWith("text/plain") || type.startsWith("application/csv")) {
    csv = await req.text();
  } else {
    throw new ApiError(415, "unsupported_media_type", "send multipart/form-data (file) or text/csv");
  }
  if (csv.length > MAX_BYTES) throw new ApiError(413, "payload_too_large", "CSV must be under 4 MB");
  if (!csv.trim()) throw new ApiError(400, "cdp_empty", "CSV is empty");
  return { csv, fields };
}

export const POST = apiRoute(async (req: NextRequest) => {
  const { csv, fields } = await readBody(req);
  // Query string first, then form fields.
  const sp = new URLSearchParams(fields);
  req.nextUrl.searchParams.forEach((v, k) => sp.set(k, v));

  const dryRun = sp.get("dry_run") === null ? true : boolParam(sp, "dry_run", true);
  const publish = boolParam(sp, "publish", false);
  const overrides: Partial<Record<PolicyField, string | null>> = {};
  for (const [field, k] of Object.entries(POLICY_KEYS) as [PolicyField, (typeof POLICY_KEYS)[PolicyField]][]) {
    overrides[field] = sp.get(k.param);
  }

  const ctx = ebayContext();
  const config = await supabaseConfigStore(ctx.db).getAll(ctx.config.environment);
  return importCdp(csv, { dryRun, publish, overrides }, {
    environment: ctx.config.environment,
    marketplaceId: ctx.config.marketplaceId,
    env: ctx.env,
    config,
    rest: ctx.userRest,
    lookup: accountLookup(ctx.userRest, ctx.config.environment),
    links: supabaseListingStore(ctx.db, ctx.env),
  });
});
