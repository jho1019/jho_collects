import type { NextRequest } from "next/server";
import { challengeResponse, getDeletionConfig } from "@/lib/ebay-api/account-deletion";
import { ApiError } from "@/lib/ebay-api/errors";
import { apiRoute, json } from "@/lib/ebay-api/respond";

// eBay Marketplace Account Deletion endpoint (production keyset requirement).
// auth: "none" — eBay calls this, not Yoshi. GET is a hash challenge proving we
// hold the verification token; POST is acknowledged and NOT acted on.
//
// Why POST does nothing: this service stores no eBay user data keyed by the
// notification's userId. Buyer usernames do live in the ledger (transactions,
// buyers), but those are tax records imported from Seller Hub reports and are
// retained under the record-keeping obligation; see docs/ebay-api.md. The
// payload is personal data, so it is not logged either. eBay's signature
// header is not verified, which is safe only BECAUSE the POST has no effect.

export const GET = apiRoute(async (req: NextRequest) => {
  const code = req.nextUrl.searchParams.get("challenge_code");
  if (!code || code.length > 512) throw new ApiError(400, "invalid_param", "challenge_code is required");
  return json({ challengeResponse: challengeResponse(code, getDeletionConfig()) });
}, "none");

export const POST = apiRoute(async (req: NextRequest) => {
  getDeletionConfig(); // fail with 503 if unconfigured, so eBay retries rather than believing we are live
  await req.arrayBuffer().catch(() => undefined); // drain; contents intentionally unread
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}, "none");
