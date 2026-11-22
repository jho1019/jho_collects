import { describe, expect, it } from "vitest";
import { fetchOrders, normaliseOrder, sumAmounts } from "../fulfillment";
import { EbayRest } from "../http";
import { filterStatus, fromTrading, inventoryListings, mergeListings } from "../listings";
import { getActiveListings, parseActiveList } from "../trading";
import { jsonRes, mockFetch } from "./helpers";

const ACTIVE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <ActiveList>
    <ItemArray>
      <Item>
        <ItemID>3550001</ItemID>
        <ListingDetails><StartTime>2026-11-01T00:00:00.000Z</StartTime><ViewItemURL>https://www.ebay.com/itm/3550001</ViewItemURL></ListingDetails>
        <SellingStatus><CurrentPrice currencyID="USD">1.25</CurrentPrice></SellingStatus>
        <Title>2025 Donruss #347 Graham Mertz &amp; Friends &lt;RC&gt;</Title>
        <SKU>204-19tvfb</SKU>
        <QuantityAvailable>1</QuantityAvailable>
        <ListingType>FixedPriceItem</ListingType>
      </Item>
      <Item>
        <ItemID>3550099</ItemID>
        <SellingStatus><CurrentPrice currencyID="USD">40.00</CurrentPrice></SellingStatus>
        <Title>Made in CDP directly</Title>
        <QuantityAvailable>1</QuantityAvailable>
      </Item>
    </ItemArray>
    <PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages><TotalNumberOfEntries>2</TotalNumberOfEntries></PaginationResult>
  </ActiveList>
</GetMyeBaySellingResponse>`;

describe("Trading GetMyeBaySelling", () => {
  it("parses ActiveList items and decodes entities", () => {
    const { items, totalPages } = parseActiveList(ACTIVE_XML);
    expect(totalPages).toBe(1);
    expect(items[0]).toMatchObject({ itemId: "3550001", sku: "204-19tvfb", price: "1.25", currency: "USD", quantityAvailable: 1, title: "2025 Donruss #347 Graham Mertz & Friends <RC>" });
    expect(items[1]).toMatchObject({ itemId: "3550099", sku: null });
  });

  it("raises an auth error on Ack=Failure with a token error code", () => {
    const xml = `<GetMyeBaySellingResponse><Ack>Failure</Ack><Errors><ShortMessage>Auth token is invalid.</ShortMessage><ErrorCode>931</ErrorCode></Errors></GetMyeBaySellingResponse>`;
    expect(() => parseActiveList(xml)).toThrow(expect.objectContaining({ status: 502, code: "ebay_auth_failed" }));
  });

  it("sends the IAF token and call headers", async () => {
    const m = mockFetch().on("POST", "/ws/api.dll", () => new Response(ACTIVE_XML, { status: 200 }));
    const items = await getActiveListings({ endpoint: "https://api.ebay.com/ws/api.dll", fetch: m.fetch, token: async () => "user-tok" });
    expect(items).toHaveLength(2);
    expect(m.calls[0].headers).toMatchObject({
      "x-ebay-api-iaf-token": "user-tok", "x-ebay-api-call-name": "GetMyeBaySelling", "x-ebay-api-siteid": "0",
      "x-ebay-api-compatibility-level": "1193",
    });
    expect(m.calls[0].body).toContain("<ActiveList>");
  });
});

describe("listings", () => {
  it("enumerates inventory items then offers per SKU, and merges with Trading", async () => {
    const m = mockFetch();
    m.on("GET", "/sell/inventory/v1/inventory_item?limit=100&offset=0", {
      total: 2, inventoryItems: [
        { sku: "204-19tvfb", product: { title: "Mertz" } },
        { sku: "205-19tvfd", product: { title: "Ewers" } },
      ],
    });
    m.on("GET", "/offer?sku=204-19tvfb", { offers: [{ offerId: "11", sku: "204-19tvfb", status: "PUBLISHED", pricingSummary: { price: { value: "1.25", currency: "USD" } }, listing: { listingId: "3550001", listingStatus: "ACTIVE" } }] });
    m.on("GET", "/offer?sku=205-19tvfd", () => jsonRes({ errors: [{ errorId: 25713 }] }, 404));
    const rest = new EbayRest({ apiBase: "https://api.ebay.com", fetch: m.fetch, token: async () => "t", marketplaceId: "EBAY_US" });
    const inv = await inventoryListings(rest, "production");
    expect(inv).toEqual([expect.objectContaining({ offer_id: "11", listing_id: "3550001", title: "Mertz", status: "ACTIVE" })]);

    const merged = mergeListings(inv, fromTrading(parseActiveList(ACTIVE_XML).items, "production"));
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ listing_id: "3550001", sources: ["inventory", "trading"], offer_id: "11" });
    expect(merged[1]).toMatchObject({ listing_id: "3550099", sources: ["trading"], offer_id: null });
    expect(filterStatus([{ ...merged[0], status: "UNPUBLISHED" }, merged[1]], "active")).toHaveLength(1);
  });
});

describe("fulfillment orders", () => {
  const RAW = {
    orderId: "07-15112-65577",
    creationDate: "2026-11-20T18:00:00.000Z",
    lastModifiedDate: "2026-11-20T19:00:00.000Z",
    buyer: { username: "test_buyer" },
    orderPaymentStatus: "PAID",
    orderFulfillmentStatus: "NOT_STARTED",
    cancelStatus: { cancelState: "NONE_REQUESTED" },
    pricingSummary: { priceSubtotal: { value: "10.00", currency: "USD" }, total: { value: "11.73", currency: "USD" } },
    totalMarketplaceFee: { value: "1.73", currency: "USD" },
    lineItems: [{
      lineItemId: "10001", legacyItemId: "3550001", sku: "204-19tvfb", title: "Mertz", quantity: 1,
      lineItemCost: { value: "10.00", currency: "USD" },
      ebayCollectAndRemitTaxes: [{ amount: { value: "0.50", currency: "USD" } }, { amount: { value: "0.23", currency: "USD" } }],
      refunds: [],
    }],
  };

  it("normalises an order and passes the fee through without inventing one", () => {
    const o = normaliseOrder(RAW);
    expect(o).toMatchObject({ orderId: "07-15112-65577", buyerUsername: "test_buyer", paymentStatus: "PAID" });
    expect(o.totals.marketplaceFee).toBe("1.73");
    expect(o.lineItems[0]).toMatchObject({ legacyItemId: "3550001", price: "10.00", ebayCollectedTax: "0.73", refunded: false });
    expect(normaliseOrder({ ...RAW, totalMarketplaceFee: undefined }).totals.marketplaceFee).toBeNull();
  });

  it("adds amounts exactly", () => {
    expect(sumAmounts([{ value: "0.10", currency: "USD" }, { value: "0.20", currency: "USD" }])).toBe("0.30");
    expect(sumAmounts([])).toBeNull();
  });

  it("paginates with a creationdate filter", async () => {
    const m = mockFetch();
    const page = (n: number, offset: number) => Array.from({ length: n }, (_, i) => ({ ...RAW, orderId: `o-${offset + i}` }));
    m.on("GET", "offset=0", { total: 201, orders: page(200, 0) });
    m.on("GET", "offset=200", { total: 201, orders: page(1, 200) });
    const rest = new EbayRest({ apiBase: "https://api.ebay.com", fetch: m.fetch, token: async () => "t", marketplaceId: "EBAY_US" });
    const out = await fetchOrders(rest, { field: "creationdate", since: new Date("2026-10-22T00:00:00Z") });
    expect(out).toHaveLength(201);
    expect(decodeURIComponent(m.calls[0].url)).toContain("filter=creationdate:[2026-10-22T00:00:00.000Z..]");
    expect(m.calls).toHaveLength(2);
  });
});
