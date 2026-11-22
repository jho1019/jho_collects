import type { NextRequest } from "next/server";
import { ebayContext } from "@/lib/ebay-api/context";
import { ApiError } from "@/lib/ebay-api/errors";
import { accountLookup, POLICY_KEYS, resolvePolicies, validId, type PolicyField } from "@/lib/ebay-api/policies";
import { apiRoute, readJson } from "@/lib/ebay-api/respond";
import { supabaseConfigStore } from "@/lib/ebay-api/store";

// GET  /api/ebay/policies   the account's fulfillment/payment/return policies and
//                           inventory locations, plus what an import would use now.
// POST /api/ebay/policies   {"fulfillment_policy_id": "...", ...} — save defaults to
//                           ebay_config. Each id is checked against the account first.

export const GET = apiRoute(async () => {
  const ctx = ebayContext();
  const lookup = accountLookup(ctx.userRest, ctx.config.environment);
  const [fulfillment, payment, returns, locations, config] = await Promise.all([
    lookup.fulfillment(), lookup.payment(), lookup.returns(), lookup.locations(),
    supabaseConfigStore(ctx.db).getAll(ctx.config.environment),
  ]);
  const resolved = await resolvePolicies({ overrides: {}, env: ctx.env, config, lookup });
  return {
    marketplace_id: ctx.config.marketplaceId,
    fulfillment_policies: fulfillment,
    payment_policies: payment,
    return_policies: returns,
    locations,
    defaults: resolved,
    note: "Fulfillment policies are never auto-selected. looksLikeStandardEnvelope flags the eSE policy so it is not chosen by mistake.",
  };
});

export const POST = apiRoute(async (req: NextRequest) => {
  const body = await readJson(req);
  const ctx = ebayContext();
  const lookup = accountLookup(ctx.userRest, ctx.config.environment);
  const known: Record<PolicyField, () => Promise<string[]>> = {
    fulfillmentPolicyId: async () => (await lookup.fulfillment()).map((p) => p.id),
    paymentPolicyId: async () => (await lookup.payment()).map((p) => p.id),
    returnPolicyId: async () => (await lookup.returns()).map((p) => p.id),
    merchantLocationKey: async () => (await lookup.locations()).map((l) => l.key),
  };
  const values: Record<string, string> = {};
  for (const [field, k] of Object.entries(POLICY_KEYS) as [PolicyField, (typeof POLICY_KEYS)[PolicyField]][]) {
    const v = body[k.param];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || !validId(v)) throw new ApiError(400, "invalid_policy_id", `${k.param} is not a valid eBay id`);
    if (!(await known[field]()).includes(v)) {
      throw new ApiError(404, "policy_not_found", `${k.param} ${v} does not exist on this eBay account (see GET /api/ebay/policies)`);
    }
    values[k.config] = v;
  }
  if (!Object.keys(values).length) {
    throw new ApiError(400, "invalid_body", `send at least one of: ${Object.values(POLICY_KEYS).map((k) => k.param).join(", ")}`);
  }
  await supabaseConfigStore(ctx.db).set(ctx.config.environment, values);
  return { saved: values };
});
