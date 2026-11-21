import { beforeAll, describe, expect, it } from "vitest";
import { browseParams, clearBrowseCache, parseCompQuery, searchActive, type CompQuery } from "../../browse";
import { GRADE_ASPECT_VALUES, GRADER_ASPECT_NAMES } from "../../cdp/conditions";
import { getComps, type Stats } from "../../comps";
import { getEbayConfig, SCOPE_BASE, type EbayConfig } from "../../config";
import { ApiError } from "../../errors";
import { EbayRest, type FetchLike } from "../../http";
import { probeInsights } from "../../insights";
import { clearAppTokenCache, getAppToken } from "../../oauth";

// LIVE, READ-ONLY checks against PRODUCTION eBay. Skipped unless EBAY_LIVE=1
// and the keyset env vars are set:   cd web && npm run test:live
//
// Uses only a client-credentials APP token: Browse searches, refinements and
// the Marketplace Insights probe. No user token, no Sell / Inventory /
// Fulfillment / Trading call, nothing is ever created, edited or ended.
// Prints counts and medians only — never a token, key or raw response.

const KEYS = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME"] as const;
const LIVE = process.env.EBAY_LIVE === "1" && KEYS.every((k) => process.env[k]?.trim());
const T = 30_000;

const realFetch: FetchLike = (input, init) => fetch(input, init);

interface Refinements {
  total?: number;
  itemSummaries?: { condition?: string; conditionId?: string }[];
  refinement?: {
    aspectDistributions?: { localizedAspectName: string; aspectValueDistributions: { localizedAspectValue: string; matchCount: number }[] }[];
    categoryDistributions?: { categoryId: string; categoryName: string }[];
  };
}

const UNGRADED: CompQuery = parseCompQuery(new URLSearchParams({ q: "2023 Panini Prizm Victor Wembanyama rookie", graded: "false" }));
const GRADED: CompQuery = parseCompQuery(new URLSearchParams({ q: "Michael Jordan 1986 Fleer", grader: "PSA", grade: "10" }));

function summary(label: string, total: number, s: Stats) {
  console.log(`[live] ${label}: total=${total} priced=${s.count} median=${s.median} p25=${s.p25} p75=${s.p75} outliers=${s.outliers_excluded}`);
}

describe.skipIf(!LIVE)("LIVE production Browse (app token, read-only)", () => {
  let cfg: EbayConfig;
  let rest: EbayRest;

  beforeAll(() => {
    cfg = getEbayConfig(process.env);
    clearAppTokenCache();
    clearBrowseCache();
    rest = new EbayRest({
      apiBase: cfg.endpoints.api, fetch: realFetch, marketplaceId: cfg.marketplaceId,
      token: () => getAppToken(cfg, realFetch, [SCOPE_BASE]),
    });
  });

  const raw = (params: Record<string, string | number>) =>
    rest.call<Refinements>("GET", "/buy/browse/v1/item_summary/search", { query: params, context: "live browse" });

  it("mints a base-scope app token through the real OAuth path", async () => {
    const t = await getAppToken(cfg, realFetch, [SCOPE_BASE]);
    expect(typeof t).toBe("string");
    expect(t.length).toBeGreaterThan(20);
    console.log(`[live] app token: ok (${cfg.environment}, ${cfg.marketplaceId})`);
  }, T);

  it("category 261328 is accepted and is Trading Card Singles", async () => {
    const r = await raw({ q: GRADED.q, category_ids: "261328", limit: 1, fieldgroups: "CATEGORY_REFINEMENTS" });
    const cats = r.refinement?.categoryDistributions ?? [];
    expect(cats.map((c) => c.categoryId)).toContain("261328");
    console.log(`[live] category: ${cats.find((c) => c.categoryId === "261328")?.categoryName}`);
  }, T);

  it("(a) ungraded comps: real getComps over real fetch, conditionIds:{4000}", async () => {
    expect(browseParams(UNGRADED).filter).toContain("conditionIds:{4000}");
    const out = await getComps({
      browse: (q) => searchActive(rest, q),
      sold: null, // EBAY_INSIGHTS_ENABLED is off for this keyset
      ownOrders: async () => { throw new ApiError(503, "ebay_not_connected", "No eBay account is connected (live test: app token only)."); },
    }, UNGRADED);
    expect(out.active.total).toBeGreaterThan(0);
    expect(out.active.items.length).toBeGreaterThan(0);
    for (const i of out.active.items) {
      expect(Number.isFinite(Number(i.price)), `price ${i.price}`).toBe(true);
      expect(i.condition).toBe("Ungraded");
    }
    expect(out.active.stats.count).toBeGreaterThan(0);
    expect(out.active.stats.median).toEqual(expect.any(Number));
    expect(out.sold_comps).toMatchObject({ available: false, reason: "marketplace_insights_not_enabled", primary_source: "own_sales" });
    summary("ungraded Wembanyama", out.active.total, out.active.stats);
  }, T);

  it("(b) graded comps: PSA 10 aspect_filter is applied (narrows results), conditionIds:{2750}", async () => {
    const p = browseParams(GRADED);
    expect(p.aspect_filter).toBe("categoryId:261328,Professional Grader:{Professional Sports Authenticator (PSA)},Grade:{10}");
    const res = await searchActive(rest, GRADED);
    expect(res.total).toBeGreaterThan(0);
    for (const i of res.items) {
      expect(Number.isFinite(Number(i.price))).toBe(true);
      expect(i.condition).toBe("Graded");
    }
    // eBay ignores an unknown aspect value silently, so prove this one bites:
    // the same search without aspect_filter must return more.
    const { aspect_filter: _omit, ...noAspect } = p;
    void _omit;
    const unfiltered = await raw({ ...noAspect, limit: 1 });
    expect(res.total).toBeLessThan(unfiltered.total ?? 0);
    const out = await getComps({ browse: (q) => searchActive(rest, q), sold: null, ownOrders: async () => [] }, GRADED);
    expect(out.active.stats.count).toBeGreaterThan(0);
    summary(`graded Jordan PSA 10 (graded-only total ${unfiltered.total})`, out.active.total, out.active.stats);
  }, T);

  it("aspect names and values in our tables match eBay's live refinements", async () => {
    const r = await raw({ q: "graded card", category_ids: "261328", limit: 1, filter: "conditionIds:{2750}", fieldgroups: "ASPECT_REFINEMENTS" });
    const dist = (name: string) =>
      new Set((r.refinement?.aspectDistributions ?? []).find((d) => d.localizedAspectName === name)?.aspectValueDistributions.map((v) => v.localizedAspectValue) ?? []);
    const graders = dist("Professional Grader");
    const grades = dist("Grade");
    expect(graders.size, "Professional Grader aspect present").toBeGreaterThan(0);
    expect(grades.size, "Grade aspect present").toBeGreaterThan(0);
    for (const v of ["Professional Sports Authenticator (PSA)", "Beckett Grading Services (BGS)", "Sportscard Guaranty Corporation (SGC)", "Certified Guaranty Company (CGC)"]) {
      expect(graders, v).toContain(v);
    }
    for (const v of ["10", "9.5", "9", "8", "Authentic"]) expect(grades, v).toContain(v);
    const missingG = Object.values(GRADER_ASPECT_NAMES).filter((v) => !graders.has(v));
    const missingGr = [...new Set(Object.values(GRADE_ASPECT_VALUES))].filter((v) => !grades.has(v));
    console.log(`[live] grader values: ${Object.keys(GRADER_ASPECT_NAMES).length - missingG.length}/${Object.keys(GRADER_ASPECT_NAMES).length} of ours seen` +
      (missingG.length ? ` (not in this sample: ${missingG.join("; ")})` : ""));
    console.log(`[live] grade values: ${Object.keys(GRADE_ASPECT_VALUES).length - missingGr.length}/${Object.keys(GRADE_ASPECT_VALUES).length} seen` +
      (missingGr.length ? ` (not in this sample: ${missingGr.join("; ")})` : ""));
  }, T);

  it("Marketplace Insights probe reports available:false (invalid_scope) for this keyset", async () => {
    const r = await probeInsights(cfg, realFetch, null);
    expect(r).toMatchObject({ available: false, scopeGranted: false });
    expect(r.reason).toMatch(/invalid_scope/);
    console.log(`[live] insights probe: available=${r.available} status=${r.status} scopeGranted=${r.scopeGranted} reason="${r.reason}"`);
  }, T);
});
