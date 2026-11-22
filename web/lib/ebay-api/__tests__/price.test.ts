import { describe, expect, it } from "vitest";
import { EbayRest } from "../http";
import { actorFrom, endListing, parseIdKind, updatePrice, type AuditStore, type ListingEventRow, type PriceChangeRow } from "../price";
import { jsonRes, mockFetch } from "./helpers";

function setup() {
  const m = mockFetch();
  const rest = new EbayRest({ apiBase: "https://api.ebay.com", fetch: m.fetch, token: async () => "tok", marketplaceId: "EBAY_US" });
  const prices: PriceChangeRow[] = [];
  const events: ListingEventRow[] = [];
  const audit: AuditStore = {
    async logPriceChange(r) { prices.push(r); },
    async logListingEvent(r) { events.push(r); },
  };
  const offer = {
    offerId: "111", sku: "203-19tvfa", marketplaceId: "EBAY_US", status: "PUBLISHED",
    pricingSummary: { price: { value: "1.0", currency: "USD" } },
    listing: { listingId: "3550001", listingStatus: "ACTIVE" },
  };
  m.on("GET", "/sell/inventory/v1/offer/111", offer);
  m.on("GET", "/sell/inventory/v1/offer?sku=203-19tvfa", { offers: [offer] });
  m.on("POST", "/bulk_update_price_quantity", { responses: [{ statusCode: 200, offerId: "111", sku: "203-19tvfa" }] });
  return { m, deps: { rest, audit, environment: "production" as const }, prices, events };
}

describe("updatePrice", () => {
  it("reprices by offerId via bulk_update_price_quantity and logs old/new/reason", async () => {
    const { m, deps, prices } = setup();
    const out = await updatePrice(deps, { id: "111", by: "offer", price: 12.5, reason: "comps dropped", actor: "api:yoshi" });
    expect(out).toMatchObject({ status: "succeeded", old_price: "1.00", new_price: "12.50", listing_id: "3550001", audit_logged: true });
    const body = JSON.parse(m.calls.find((c) => c.url.includes("bulk_update_price_quantity"))!.body!);
    expect(body).toEqual({ requests: [{ sku: "203-19tvfa", offers: [{ offerId: "111", price: { value: "12.50", currency: "USD" } }] }] });
    expect(prices).toEqual([expect.objectContaining({
      offer_id: "111", sku: "203-19tvfa", old_price: "1.00", new_price: "12.50", reason: "comps dropped",
      status: "succeeded", actor: "api:yoshi", error: null,
    })]);
  });

  it("resolves ?by=sku to the single offer", async () => {
    const { m, deps } = setup();
    await updatePrice(deps, { id: "203-19tvfa", by: "sku", price: "2", reason: "r", actor: "api" });
    expect(m.calls[0].url).toContain("/sell/inventory/v1/offer?sku=203-19tvfa&marketplace_id=EBAY_US");
  });

  it.each([
    [{ price: 0, reason: "x" }, "invalid_price"],
    [{ price: "1.234", reason: "x" }, "invalid_price"],
    [{ price: -5, reason: "x" }, "invalid_price"],
    [{ price: 5, reason: "   " }, "invalid_reason"],
    [{ price: 5, reason: undefined }, "invalid_reason"],
  ])("rejects %j before calling eBay and logs nothing", async (input, code) => {
    const { m, deps, prices } = setup();
    await expect(updatePrice(deps, { id: "111", by: "offer", actor: "api", ...input })).rejects.toMatchObject({ status: 400, code });
    expect(m.calls).toHaveLength(0);
    expect(prices).toHaveLength(0);
  });

  it("rejects a non-numeric offerId (no path injection)", async () => {
    const { m, deps } = setup();
    await expect(updatePrice(deps, { id: "../location", by: "offer", price: 5, reason: "x", actor: "api" }))
      .rejects.toMatchObject({ code: "invalid_offer_id" });
    expect(m.calls).toHaveLength(0);
  });

  it("logs a failed eBay update with its status and rethrows", async () => {
    const { m, deps, prices } = setup();
    m.on("POST", "/bulk_update_price_quantity", () =>
      jsonRes({ errors: [{ errorId: 25001, message: "System error" }] }, 500));
    await expect(updatePrice(deps, { id: "111", by: "offer", price: 9, reason: "test", actor: "api" }))
      .rejects.toMatchObject({ status: 502, code: "ebay_upstream_error" });
    expect(prices).toEqual([expect.objectContaining({
      status: "failed", http_status: 500, new_price: "9.00", old_price: "1.00", offer_id: "111",
      error: expect.stringContaining("System error"),
    })]);
  });

  it("logs a per-offer rejection inside a 200 bulk response as failed", async () => {
    const { m, deps, prices } = setup();
    m.on("POST", "/bulk_update_price_quantity", {
      responses: [{ statusCode: 400, offerId: "111", errors: [{ errorId: 25709, message: "Invalid value for price" }] }],
    });
    await expect(updatePrice(deps, { id: "111", by: "offer", price: 9, reason: "t", actor: "api" }))
      .rejects.toMatchObject({ code: "ebay_update_failed" });
    expect(prices[0]).toMatchObject({ status: "failed", http_status: 400, error: expect.stringContaining("25709") });
  });

  it("logs a not-found offer as failed with the id that was asked for", async () => {
    const { m, deps, prices } = setup();
    m.on("GET", "/sell/inventory/v1/offer/999", () => jsonRes({ errors: [{ errorId: 25713, message: "This Offer is not available" }] }, 404));
    await expect(updatePrice(deps, { id: "999", by: "offer", price: 3, reason: "t", actor: "api" })).rejects.toMatchObject({ status: 404 });
    expect(prices[0]).toMatchObject({ offer_id: "999", status: "failed", http_status: 404, old_price: null });
  });

  it("reports success with audit_logged:false if the audit insert fails after eBay accepted", async () => {
    const { deps } = setup();
    deps.audit.logPriceChange = async () => { throw new Error("db down"); };
    const out = await updatePrice(deps, { id: "111", by: "offer", price: 4, reason: "t", actor: "api" });
    expect(out).toMatchObject({ status: "succeeded", audit_logged: false });
  });
});

describe("endListing", () => {
  it("withdraws the offer and logs a listing event", async () => {
    const { m, deps, events } = setup();
    m.on("POST", "/offer/111/withdraw", { listingId: "3550001" });
    const out = await endListing(deps, { id: "111", by: "offer", reason: "sold at a show", actor: "api" });
    expect(out).toMatchObject({ status: "succeeded", listing_id: "3550001" });
    expect(events).toEqual([expect.objectContaining({ action: "end", status: "succeeded", reason: "sold at a show", offer_id: "111" })]);
  });

  it("logs a failed withdraw", async () => {
    const { m, deps, events } = setup();
    m.on("POST", "/offer/111/withdraw", () => jsonRes({ errors: [{ errorId: 25713, message: "not published" }] }, 400));
    await expect(endListing(deps, { id: "111", by: "offer", reason: "x", actor: "api" })).rejects.toMatchObject({ status: 400 });
    expect(events[0]).toMatchObject({ status: "failed", http_status: 400 });
  });

  it("requires a reason", async () => {
    const { deps } = setup();
    await expect(endListing(deps, { id: "111", by: "offer", reason: "", actor: "api" })).rejects.toMatchObject({ code: "invalid_reason" });
  });
});

describe("helpers", () => {
  it("parses by and sanitises the actor", () => {
    expect(parseIdKind(null)).toBe("offer");
    expect(parseIdKind("sku")).toBe("sku");
    expect(() => parseIdKind("listing")).toThrow();
    expect(actorFrom(new Headers({ "x-actor": "yoshi <script>" }))).toBe("api:yoshiscript");
    expect(actorFrom(new Headers())).toBe("api");
  });
});
