import { TtlCache } from "./cache";
import type { EbayEnvironment, Env } from "./config";
import { ApiError } from "./errors";
import type { EbayRest } from "./http";
import type { PolicyIds } from "./cdp/payloads";

// Business policies (fulfillment / payment / return) and the merchant
// location every offer needs.
//
// Resolution order, per value:  request override > env var > ebay_config row
//                                > Account/Inventory API lookup (see below)
//
// FULFILLMENT IS NEVER AUTO-PICKED. The seller's existing shipping policy is
// eBay Standard Envelope, which is wrong for the mid-tier cards this import
// is for, and a lookup that found exactly one policy would select it silently.
// A real import with no configured fulfillment policy refuses instead.
//
// Payment, return and location may be auto-resolved, but only when the
// account has exactly ONE candidate; zero or several is a clear error.

export type PolicyField = keyof PolicyIds;
export type PolicySource = "request" | "env" | "config" | "account_api" | "unset";

export const POLICY_KEYS: Record<PolicyField, { env: string; config: string; param: string }> = {
  fulfillmentPolicyId: { env: "EBAY_FULFILLMENT_POLICY_ID", config: "fulfillment_policy_id", param: "fulfillment_policy_id" },
  paymentPolicyId: { env: "EBAY_PAYMENT_POLICY_ID", config: "payment_policy_id", param: "payment_policy_id" },
  returnPolicyId: { env: "EBAY_RETURN_POLICY_ID", config: "return_policy_id", param: "return_policy_id" },
  merchantLocationKey: { env: "EBAY_MERCHANT_LOCATION_KEY", config: "merchant_location_key", param: "merchant_location_key" },
};

const FIELDS = Object.keys(POLICY_KEYS) as PolicyField[];

/** Key/value config persisted in ebay_config. */
export interface ConfigStore {
  getAll(environment: EbayEnvironment): Promise<Record<string, string>>;
  set(environment: EbayEnvironment, values: Record<string, string>): Promise<void>;
}

export interface PolicySummary {
  id: string;
  name: string;
  description?: string;
  marketplaceId?: string;
  isDefault: boolean;
  /** fulfillment only: shipping service codes, so an eSE policy is recognisable. */
  shippingServices?: string[];
  looksLikeStandardEnvelope?: boolean;
}

export interface LocationSummary {
  key: string;
  name?: string;
  status?: string;
  city?: string;
  stateOrProvince?: string;
}

export interface AccountLookup {
  fulfillment(): Promise<PolicySummary[]>;
  payment(): Promise<PolicySummary[]>;
  returns(): Promise<PolicySummary[]>;
  locations(): Promise<LocationSummary[]>;
}

export interface ResolvedPolicies extends PolicyIds {
  sources: Record<PolicyField, PolicySource>;
  problems: string[];
}

/** Rejects ids that could smuggle a path or query into an eBay URL. */
export function validId(v: string): boolean {
  return /^[A-Za-z0-9_\-.]{1,64}$/.test(v);
}

export async function resolvePolicies(o: {
  overrides: Partial<Record<PolicyField, string | null | undefined>>;
  env: Env;
  config: Record<string, string>;
  /** null in a dry run: no eBay calls. */
  lookup: AccountLookup | null;
}): Promise<ResolvedPolicies> {
  const out: ResolvedPolicies = {
    fulfillmentPolicyId: null, paymentPolicyId: null, returnPolicyId: null, merchantLocationKey: null,
    sources: { fulfillmentPolicyId: "unset", paymentPolicyId: "unset", returnPolicyId: "unset", merchantLocationKey: "unset" },
    problems: [],
  };
  for (const f of FIELDS) {
    const k = POLICY_KEYS[f];
    const candidates: [PolicySource, string | null | undefined][] = [
      ["request", o.overrides[f]],
      ["env", o.env[k.env]],
      ["config", o.config[k.config]],
    ];
    for (const [src, raw] of candidates) {
      const v = raw?.trim();
      if (!v) continue;
      if (!validId(v)) {
        throw new ApiError(400, "invalid_policy_id", `${k.param} from ${src} is not a valid eBay id`);
      }
      out[f] = v;
      out.sources[f] = src;
      break;
    }
  }

  if (!out.fulfillmentPolicyId) {
    out.problems.push(
      "No fulfillment (shipping) policy configured. Create a new shipping policy for these cards in Seller Hub " +
        "(Account > Business policies), then set EBAY_FULFILLMENT_POLICY_ID, POST /api/ebay/policies, or pass " +
        "fulfillment_policy_id. It is never auto-selected, so the Standard Envelope policy cannot be picked by accident.",
    );
  }

  if (o.lookup) {
    const pick = async <T,>(f: PolicyField, label: string, load: () => Promise<T[]>, id: (t: T) => string, name: (t: T) => string) => {
      if (out[f]) return;
      const all = await load();
      if (all.length === 1) {
        out[f] = id(all[0]);
        out.sources[f] = "account_api";
      } else if (!all.length) {
        out.problems.push(`No ${label} found on the eBay account; create one in Seller Hub.`);
      } else {
        out.problems.push(
          `Several ${label}s found (${all.map((t) => `${name(t)} = ${id(t)}`).join("; ")}); ` +
            `choose one with POST /api/ebay/policies or ${POLICY_KEYS[f].env}.`,
        );
      }
    };
    await pick("paymentPolicyId", "payment policy", o.lookup.payment, (p) => p.id, (p) => p.name);
    await pick("returnPolicyId", "return policy", o.lookup.returns, (p) => p.id, (p) => p.name);
    await pick(
      "merchantLocationKey", "enabled inventory location",
      async () => (await o.lookup!.locations()).filter((l) => !l.status || l.status === "ENABLED"),
      (l) => l.key, (l) => l.name ?? l.key,
    );
  } else {
    for (const f of ["paymentPolicyId", "returnPolicyId", "merchantLocationKey"] as PolicyField[]) {
      if (!out[f]) out.problems.push(`${POLICY_KEYS[f].param} not configured; a real import would look it up via the eBay Account API (dry runs make no eBay calls).`);
    }
  }
  return out;
}

// ------------------------------------------------------------ Account API
// GET /sell/account/v1/{fulfillment,payment,return}_policy?marketplace_id=
// GET /sell/inventory/v1/location
// Cached 5 minutes per (environment, marketplace, kind). Per-instance.

interface RawPolicy {
  name?: string;
  description?: string;
  marketplaceId?: string;
  categoryTypes?: { name?: string; default?: boolean }[];
  shippingOptions?: { shippingServices?: { shippingServiceCode?: string }[] }[];
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
}

const lookupCache = new TtlCache<unknown>(5 * 60 * 1000);

function summarise(p: RawPolicy, id: string | undefined): PolicySummary {
  const services = (p.shippingOptions ?? []).flatMap((o) => o.shippingServices ?? [])
    .map((s) => s.shippingServiceCode).filter((s): s is string => Boolean(s));
  return {
    id: id ?? "",
    name: p.name ?? "",
    description: p.description,
    marketplaceId: p.marketplaceId,
    isDefault: Boolean(p.categoryTypes?.some((c) => c.default)),
    ...(p.shippingOptions ? {
      shippingServices: services,
      looksLikeStandardEnvelope: services.some((s) => /standardenvelope/i.test(s)),
    } : {}),
  };
}

export function accountLookup(rest: EbayRest, environment: EbayEnvironment): AccountLookup {
  const mp = rest.marketplaceId;
  const cached = <T,>(kind: string, load: () => Promise<T>) =>
    lookupCache.getOrLoad(`${environment}|${mp}|${kind}`, load) as Promise<T>;
  return {
    fulfillment: () => cached("fulfillment", async () => {
      const r = await rest.call<{ fulfillmentPolicies?: RawPolicy[] }>("GET", "/sell/account/v1/fulfillment_policy",
        { query: { marketplace_id: mp }, context: "list fulfillment policies" });
      return (r?.fulfillmentPolicies ?? []).map((p) => summarise(p, p.fulfillmentPolicyId));
    }),
    payment: () => cached("payment", async () => {
      const r = await rest.call<{ paymentPolicies?: RawPolicy[] }>("GET", "/sell/account/v1/payment_policy",
        { query: { marketplace_id: mp }, context: "list payment policies" });
      return (r?.paymentPolicies ?? []).map((p) => summarise(p, p.paymentPolicyId));
    }),
    returns: () => cached("return", async () => {
      const r = await rest.call<{ returnPolicies?: RawPolicy[] }>("GET", "/sell/account/v1/return_policy",
        { query: { marketplace_id: mp }, context: "list return policies" });
      return (r?.returnPolicies ?? []).map((p) => summarise(p, p.returnPolicyId));
    }),
    locations: () => cached("locations", async () => {
      const r = await rest.call<{ locations?: {
        merchantLocationKey?: string; name?: string; merchantLocationStatus?: string;
        location?: { address?: { city?: string; stateOrProvince?: string } };
      }[] }>("GET", "/sell/inventory/v1/location", { query: { limit: 100 }, context: "list inventory locations" });
      return (r?.locations ?? []).map((l) => ({
        key: l.merchantLocationKey ?? "",
        name: l.name,
        status: l.merchantLocationStatus,
        city: l.location?.address?.city,
        stateOrProvince: l.location?.address?.stateOrProvince,
      }));
    }),
  };
}

export function clearPolicyCache(): void {
  lookupCache.clear();
}
