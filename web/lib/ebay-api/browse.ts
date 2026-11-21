import { TtlCache } from "./cache";
import { ApiError } from "./errors";
import type { Amount, EbayRest } from "./http";
import { CONDITION_GRADED, CONDITION_UNGRADED, GRADE_ASPECT_VALUES, GRADER_ASPECT_NAMES, GRADER_IDS } from "./cdp/conditions";
import { DEFAULT_CATEGORY_ID } from "./cdp/payloads";

// Browse API item_summary/search — ACTIVE listings (asking prices, not sales).
// Uses an application token (client credentials, base scope). Results are
// cached 5 minutes in memory per instance to spare the rate limit.

export interface CompQuery {
  q: string;
  categoryId: string;
  grader?: string;
  grade?: string;
  /** true -> conditionIds 2750, false -> 4000, undefined -> both. Implied true by grader/grade. */
  graded?: boolean;
  limit: number;
}

export interface ActiveComp {
  itemId: string;
  title: string;
  price: string | null;
  currency: string | null;
  shipping: string | null;
  condition: string | null;
  url: string | null;
}

export interface BrowseResult {
  total: number;
  items: ActiveComp[];
}

const SAFE_ASPECT = /^[\w .()&'/-]{1,60}$/;

export function parseCompQuery(sp: URLSearchParams): CompQuery {
  const q = (sp.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 100) throw new ApiError(400, "invalid_param", "q is required (2-100 characters)");
  const categoryId = (sp.get("category_id") ?? DEFAULT_CATEGORY_ID).trim();
  if (!/^\d{1,10}$/.test(categoryId)) throw new ApiError(400, "invalid_param", "category_id must be numeric");
  const grader = sp.get("grader")?.trim() || undefined;
  const grade = sp.get("grade")?.trim() || undefined;
  for (const [k, v] of [["grader", grader], ["grade", grade]] as const) {
    if (v && !SAFE_ASPECT.test(v)) throw new ApiError(400, "invalid_param", `${k} contains unsupported characters`);
  }
  // eBay ignores an aspect value it does not know and returns UNFILTERED
  // results, so an unmapped grader/grade is a 400, never passed through raw.
  if (grader && !graderAspectValue(grader)) {
    throw new ApiError(400, "invalid_param", "grader is not one eBay recognises as a Professional Grader (try PSA, BGS, SGC, CGC, TAG)");
  }
  if (grade && !gradeAspectValue(grade)) {
    throw new ApiError(400, "invalid_param", "grade must be 1-10 in half steps, or Authentic / Authentic Altered / Authentic - Trimmed");
  }
  const gradedRaw = sp.get("graded");
  const graded = gradedRaw === null || gradedRaw === "" ? (grader || grade ? true : undefined) : /^(1|true|yes)$/i.test(gradedRaw);
  const limitRaw = sp.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, "invalid_param", "limit must be 1-200");
  return { q, categoryId, grader, grade, graded, limit };
}

/** Exact eBay aspect value for a grader ("PSA" -> "Professional Sports Authenticator (PSA)"), or null. Verified live. */
export function graderAspectValue(grader: string): string | null {
  const id = GRADER_IDS[grader.trim().toLowerCase()];
  return (id && GRADER_ASPECT_NAMES[id]) || null;
}

/** Exact eBay "Grade" aspect value ("10", "9.5", "Authentic"), or null. Verified live. */
export function gradeAspectValue(grade: string): string | null {
  const g = grade.trim().toLowerCase().replace(/^(\d+(?:\.5)?)\.0$/, "$1");
  return GRADE_ASPECT_VALUES[g] ?? null;
}

function aspect(name: string, value: string | null, raw: string): string {
  if (!value) throw new ApiError(400, "invalid_param", `${name} "${raw}" has no eBay aspect value`);
  return `${name}:{${value}}`;
}

export function browseParams(q: CompQuery): Record<string, string | number> {
  const filters = ["buyingOptions:{FIXED_PRICE}"];
  if (q.graded === true) filters.push(`conditionIds:{${CONDITION_GRADED}}`);
  if (q.graded === false) filters.push(`conditionIds:{${CONDITION_UNGRADED}}`);
  const aspects: string[] = [];
  if (q.grader) aspects.push(aspect("Professional Grader", graderAspectValue(q.grader), q.grader));
  if (q.grade) aspects.push(aspect("Grade", gradeAspectValue(q.grade), q.grade));
  return {
    q: q.q,
    category_ids: q.categoryId,
    limit: q.limit,
    filter: filters.join(","),
    ...(aspects.length ? { aspect_filter: `categoryId:${q.categoryId},${aspects.join(",")}` } : {}),
  };
}

const cache = new TtlCache<BrowseResult>(5 * 60 * 1000);

export async function searchActive(rest: EbayRest, q: CompQuery): Promise<BrowseResult> {
  const params = browseParams(q);
  return cache.getOrLoad(`${rest.marketplaceId}|${JSON.stringify(params)}`, async () => {
    const r = await rest.call<{ total?: number; itemSummaries?: {
      itemId: string; title?: string; price?: Amount; condition?: string; itemWebUrl?: string;
      shippingOptions?: { shippingCost?: Amount }[];
    }[] }>("GET", "/buy/browse/v1/item_summary/search", { query: params, context: "browse search" });
    return {
      total: r?.total ?? 0,
      items: (r?.itemSummaries ?? []).map((i) => ({
        itemId: i.itemId,
        title: i.title ?? "",
        price: i.price?.value ?? null,
        currency: i.price?.currency ?? null,
        shipping: i.shippingOptions?.[0]?.shippingCost?.value ?? null,
        condition: i.condition ?? null,
        url: i.itemWebUrl ?? null,
      })),
    };
  });
}

export function clearBrowseCache(): void {
  cache.clear();
}
