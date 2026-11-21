import { beforeEach, describe, expect, it } from "vitest";
import { browseParams, clearBrowseCache, parseCompQuery, searchActive, type CompQuery } from "../browse";
import { getComps, matchOwnSales, priceStats, titleMatches, queryWords } from "../comps";
import { ApiError } from "../errors";
import { EbayRest } from "../http";
import { insightsRest, probeInsights, searchSold } from "../insights";
import { normaliseOrder, type SaleOrder } from "../fulfillment";
import { clearAppTokenCache } from "../oauth";
import { jsonRes, mockFetch, testConfig } from "./helpers";

beforeEach(() => {
  clearBrowseCache();
  clearAppTokenCache();
});

const Q: CompQuery = { q: "Ashton Jeanty Press Proofs", categoryId: "261328", limit: 50 };

function browseFixture(prices: string[]) {
  return {
    total: prices.length,
    itemSummaries: prices.map((p, i) => ({
      itemId: `v1|${i}|0`, title: `Ashton Jeanty #${i}`, price: { value: p, currency: "USD" },
      itemWebUrl: `https://www.ebay.com/itm/${i}`, shippingOptions: [{ shippingCost: { value: "1.00", currency: "USD" } }],
    })),
  };
}

function order(id: string, title: string, price: string, extra: Partial<Parameters<typeof normaliseOrder>[0]> = {}): SaleOrder {
  return normaliseOrder({
    orderId: id, creationDate: "2026-11-01T00:00:00.000Z", orderPaymentStatus: "PAID",
    lineItems: [{ lineItemId: `${id}-1`, legacyItemId: "1", title, quantity: 1, lineItemCost: { value: price, currency: "USD" } }],
    ...extra,
  });
}

function wire() {
  const m = mockFetch();
  m.on("POST", "/identity/v1/oauth2/token", { access_token: "app-token", expires_in: 7200 });
  const browseRest = new EbayRest({ apiBase: "https://api.ebay.com", fetch: m.fetch, token: async () => "app-token", marketplaceId: "EBAY_US" });
  const ownOrders: SaleOrder[] = [
    order("o1", "2025 Donruss #305 Ashton Jeanty Press Proofs Green RC", "1.50"),
    order("o2", "2025 Donruss Ashton Jeanty Press Proofs Red", "3.00"),
    order("o3", "2025 Donruss Ashton Jeanty Base", "0.99"), // missing "press proofs"
    order("o4", "Ashton Jeanty Press Proofs Blue", "9.00", { cancelStatus: { cancelState: "CANCELED" } }),
  ];
  const deps = {
    browse: (q: CompQuery) => searchActive(browseRest, q),
    sold: (q: CompQuery) => searchSold(insightsRest(testConfig, m.fetch), q),
    ownOrders: async (days: number) => {
      expect(days).toBe(90);
      return ownOrders;
    },
  };
  return { m, deps };
}

describe("comps fallback", () => {
  it("Marketplace Insights 403 -> sold_comps.available=false + own sales + Browse stats", async () => {
    const { m, deps } = wire();
    m.on("GET", "/buy/browse/v1/item_summary/search", browseFixture(["1.00", "1.50", "2.00", "2.50", "3.00", "250.00"]));
    m.on("GET", "/buy/marketplace_insights/", () =>
      jsonRes({ errors: [{ errorId: 1100, domain: "ACCESS", message: "Access denied", longMessage: "Insufficient permissions to fulfill the request." }] }, 403));

    const out = await getComps(deps, Q);
    expect(out.active.stats).toEqual({ count: 5, min: 1, max: 3, mean: 2, median: 2, p25: 1.5, p75: 2.5, outliers_excluded: 1 });
    expect(out.sold_comps.available).toBe(false);
    if (out.sold_comps.available) throw new Error("unreachable");
    expect(out.sold_comps.reason).toMatch(/Insufficient permissions/);
    expect(out.sold_comps.fallback.source).toBe("own_sales");
    expect(out.sold_comps.fallback.items.map((s) => s.order_id)).toEqual(["o1", "o2"]);
    expect(out.sold_comps.fallback.stats).toMatchObject({ count: 2, median: 2.25 });

    // the insights call used an app token minted with the insights scope
    const mint = m.calls.find((c) => c.url.includes("oauth2/token"))!;
    expect(new URLSearchParams(mint.body).get("scope")).toContain("buy.marketplace.insights");
    // and never leaked into the response
    expect(JSON.stringify(out)).not.toContain("app-token");
  });

  it("invalid_scope when minting the token is also a clean fallback", async () => {
    const { m, deps } = wire();
    m.on("GET", "/buy/browse/v1/item_summary/search", browseFixture(["5.00"]));
    m.on("POST", "/identity/v1/oauth2/token", () => jsonRes({ error: "invalid_scope", error_description: "The requested scope is invalid" }, 400));
    const out = await getComps(deps, Q);
    expect(out.sold_comps).toMatchObject({ available: false, reason: expect.stringMatching(/invalid_scope/) });
  });

  it("uses sold comps when Marketplace Insights answers", async () => {
    const { m, deps } = wire();
    m.on("GET", "/buy/browse/v1/item_summary/search", browseFixture(["5.00"]));
    m.on("GET", "/buy/marketplace_insights/", {
      itemSales: [
        { itemId: "a", title: "x", lastSoldPrice: { value: "4.00", currency: "USD" }, lastSoldDate: "2026-11-10T00:00:00Z" },
        { itemId: "b", title: "y", lastSoldPrice: { value: "6.00", currency: "USD" }, lastSoldDate: "2026-11-11T00:00:00Z" },
      ],
    });
    const out = await getComps(deps, Q);
    expect(out.sold_comps).toMatchObject({ available: true, source: "marketplace_insights", stats: { count: 2, median: 5 } });
  });

  it("own-sales failure does not sink the response", async () => {
    const { m, deps } = wire();
    m.on("GET", "/buy/browse/v1/item_summary/search", browseFixture(["5.00"]));
    m.on("GET", "/buy/marketplace_insights/", () => jsonRes({ errors: [{ errorId: 1100 }] }, 403));
    deps.ownOrders = async () => { throw new ApiError(503, "ebay_not_connected", "No eBay account is connected."); };
    const out = await getComps(deps, Q);
    expect(out.sold_comps).toMatchObject({ available: false, fallback: { error: expect.stringMatching(/No eBay account is connected/), items: [] } });
  });

  it("caches Browse results for repeated identical queries", async () => {
    const { m, deps } = wire();
    m.on("GET", "/buy/browse/v1/item_summary/search", browseFixture(["5.00"]));
    m.on("GET", "/buy/marketplace_insights/", () => jsonRes({ errors: [] }, 403));
    await getComps(deps, Q);
    await getComps(deps, Q);
    expect(m.calls.filter((c) => c.url.includes("/buy/browse/"))).toHaveLength(1);
  });
});

describe("browse query", () => {
  it("builds graded filters and aspect filters", () => {
    const q = parseCompQuery(new URLSearchParams("q=shohei ohtani&grader=PSA&grade=10&limit=20"));
    expect(q).toMatchObject({ graded: true, limit: 20, categoryId: "261328" });
    expect(browseParams(q)).toEqual({
      q: "shohei ohtani", category_ids: "261328", limit: 20,
      filter: "buyingOptions:{FIXED_PRICE},conditionIds:{2750}",
      aspect_filter: "categoryId:261328,Professional Grader:{Professional Sports Authenticator (PSA)},Grade:{10}",
    });
    expect(browseParams(parseCompQuery(new URLSearchParams("q=wemby&graded=false"))).filter).toContain("conditionIds:{4000}");
  });

  it("validates params", () => {
    expect(() => parseCompQuery(new URLSearchParams(""))).toThrow(/q is required/);
    expect(() => parseCompQuery(new URLSearchParams("q=ab&limit=500"))).toThrow(/limit/);
    expect(() => parseCompQuery(new URLSearchParams("q=ab&grader={x}"))).toThrow(/unsupported/);
  });
});

describe("stats + matching", () => {
  it("computes quantiles and leaves small samples alone", () => {
    expect(priceStats([], true)).toMatchObject({ count: 0, median: null });
    expect(priceStats([1, 100], true)).toMatchObject({ count: 2, outliers_excluded: 0, median: 50.5 });
    expect(priceStats([170, 180, 400], false).median).toBe(180);
  });

  it("matches whole words, including grader and grade", () => {
    const words = queryWords({ ...Q, q: "Jordan", grader: "PSA", grade: "10" });
    expect(words).toEqual(["jordan", "psa", "10"]);
    expect(titleMatches("1997 Michael Jordan PSA 10 Gem Mint", words)).toBe(true);
    expect(titleMatches("1997 Michael Jordan PSA 9", words)).toBe(false);
    expect(titleMatches("Jordan PSA 100", words)).toBe(false);
  });

  it("skips refunded lines", () => {
    const o = normaliseOrder({
      orderId: "r", creationDate: "2026-11-01T00:00:00Z", orderPaymentStatus: "PARTIALLY_REFUNDED",
      lineItems: [{ lineItemId: "1", title: "Jordan", quantity: 1, lineItemCost: { value: "5.00", currency: "USD" }, refunds: [{ amount: { value: "5.00", currency: "USD" } }] }],
    });
    expect(matchOwnSales([o], { ...Q, q: "jordan" })).toEqual([]);
  });
});

describe("probeInsights", () => {
  it("reports unavailable with scopeGranted=true on 403", async () => {
    const m = mockFetch()
      .on("POST", "/oauth2/token", { access_token: "a", expires_in: 7200 })
      .on("GET", "/buy/marketplace_insights/", () => jsonRes({ errors: [{ errorId: 1100, message: "Access denied" }] }, 403));
    const r = await probeInsights(testConfig, m.fetch, ["https://api.ebay.com/oauth/api_scope"]);
    expect(r).toEqual({ available: false, status: 403, reason: expect.stringMatching(/Access denied/), scopeGranted: true, userTokenHasScope: false });
    expect(m.calls.find((c) => c.url.includes("marketplace_insights"))!.url).toContain("limit=1");
  });

  it("reports scopeGranted=false on invalid_scope", async () => {
    const m = mockFetch().on("POST", "/oauth2/token", () => jsonRes({ error: "invalid_scope" }, 400));
    const r = await probeInsights(testConfig, m.fetch, null);
    expect(r).toMatchObject({ available: false, scopeGranted: false, userTokenHasScope: null });
  });

  it("reports available on 200", async () => {
    const m = mockFetch()
      .on("POST", "/oauth2/token", { access_token: "a", expires_in: 7200 })
      .on("GET", "/buy/marketplace_insights/", { itemSales: [] });
    expect(await probeInsights(testConfig, m.fetch, ["https://api.ebay.com/oauth/api_scope/buy.marketplace.insights"]))
      .toMatchObject({ available: true, status: 200, userTokenHasScope: true });
  });
});
