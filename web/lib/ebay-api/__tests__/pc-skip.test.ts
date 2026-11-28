import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Env } from "../config";
import { EbayRest } from "../http";
import { updatePrice, type AuditStore, type ListingStateStore, type PriceChangeRow } from "../price";
import { supabaseListingStore } from "../store";
import { supabaseSyncRepo } from "../sync/supabase-repo";
import { mockFetch } from "./helpers";

// Personal-collection cards (cards.category = 'pc') are excluded from every
// eBay / pricing path (schema/027). The Supabase fake below is an in-memory
// table that actually applies eq / neq / in, so these tests prove the pc row
// is filtered out by the query the code builds — not just that a method was
// called.

const OWNER = "aaaaaaaa-0000-0000-0000-00000000000a";
const env: Env = { OWNER_USER_ID: OWNER };

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>, rpc: Record<string, Row[]> = {}) {
  const queries: { table: string; filters: [string, string, unknown][] }[] = [];
  function from(table: string) {
    const filters: [string, string, unknown][] = [];
    queries.push({ table, filters });
    let single = false;
    let upserted: Row[] | null = null;
    const run = () => {
      if (upserted) return { data: null, error: null };
      const rows = (tables[table] ?? []).filter((r) => filters.every(([op, col, v]) =>
        op === "eq" ? r[col] === v : op === "neq" ? r[col] !== v : op === "in" ? (v as unknown[]).includes(r[col]) : true));
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const b = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), b),
      neq: (c: string, v: unknown) => (filters.push(["neq", c, v]), b),
      in: (c: string, v: unknown[]) => (filters.push(["in", c, v]), b),
      limit: () => b,
      maybeSingle: () => ((single = true), b),
      upsert: (rows: Row[]) => ((upserted = rows), (tables[`${table}:upserted`] = rows), b),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }
  const db = {
    from,
    rpc: async (name: string) => ({ data: rpc[name] ?? [], error: null }),
  } as unknown as SupabaseClient;
  return { db, queries, tables };
}

const CARDS: Row[] = [
  { id: 1, user_id: OWNER, sku: "BIZ-1", title: "wemby rookie", status: "listed", sale_transaction_id: null, category: "business" },
  { id: 2, user_id: OWNER, sku: "PC-1", title: "wemby rookie pc", status: "held", sale_transaction_id: null, category: "pc" },
];

describe("sold-order sync skips pc cards", () => {
  it("getCardsBySku excludes pc", async () => {
    const { db, queries } = fakeDb({ cards: CARDS });
    const out = await supabaseSyncRepo(db, env).getCardsBySku(["BIZ-1", "PC-1"]);
    expect(out.map((c) => c.id)).toEqual([1]);
    expect(queries[0].filters).toContainEqual(["neq", "category", "pc"]);
  });

  it("getCardsById excludes pc", async () => {
    const { db } = fakeDb({ cards: CARDS });
    const out = await supabaseSyncRepo(db, env).getCardsById([1, 2]);
    expect(out.map((c) => c.id)).toEqual([1]);
  });

  it("findCards drops pc candidates returned by ebay_find_cards", async () => {
    const { db } = fakeDb({ cards: CARDS }, {
      ebay_find_cards: [
        { id: 1, sku: "BIZ-1", title: "wemby rookie", match_type: "fuzzy", score: 0.6 },
        { id: 2, sku: "PC-1", title: "wemby rookie pc", match_type: "alias", score: 1 },
      ],
    });
    const out = await supabaseSyncRepo(db, env).findCards("wemby rookie");
    expect(out).toEqual([{ id: 1, sku: "BIZ-1", title: "wemby rookie", matchType: "fuzzy", score: 0.6 }]);
  });
});

describe("CDP import listing links skip pc cards", () => {
  it("links a business card by sku, never a pc card", async () => {
    const { db, tables } = fakeDb({ cards: CARDS });
    const links = await supabaseListingStore(db, env).upsert("production", [
      { sku: "BIZ-1", offerId: "1", listingId: "11", title: "a", price: "5.00", status: "published" },
      { sku: "PC-1", offerId: "2", listingId: "22", title: "b", price: "5.00", status: "published" },
    ]);
    expect(links.get("BIZ-1")).toBe(1);
    expect(links.get("PC-1")).toBeNull();
    expect((tables["ebay_listings:upserted"] as Row[]).map((r) => r.card_id)).toEqual([1, null]);
  });
});

describe("isPersonalCollection (reprice guard lookup)", () => {
  const tables = () => ({
    cards: CARDS,
    ebay_listings: [
      { environment: "production", offer_id: "500", card_id: 2 },
      { environment: "production", offer_id: "501", card_id: 1 },
    ],
  });
  it("true for a pc card's eBay sku", async () => {
    const { db } = fakeDb(tables());
    expect(await supabaseListingStore(db, env).isPersonalCollection!("production", { offerId: "999", sku: "PC-1" })).toBe(true);
  });
  it("true for an offer linked to a pc card in ebay_listings", async () => {
    const { db } = fakeDb(tables());
    expect(await supabaseListingStore(db, env).isPersonalCollection!("production", { offerId: "500", sku: "UNKNOWN" })).toBe(true);
  });
  it("false for a business card", async () => {
    const { db } = fakeDb(tables());
    expect(await supabaseListingStore(db, env).isPersonalCollection!("production", { offerId: "501", sku: "BIZ-1" })).toBe(false);
  });
});

describe("updatePrice refuses pc cards", () => {
  function setup(isPc: boolean) {
    const m = mockFetch();
    const rest = new EbayRest({ apiBase: "https://api.ebay.com", fetch: m.fetch, token: async () => "tok", marketplaceId: "EBAY_US" });
    const prices: PriceChangeRow[] = [];
    const audit: AuditStore = { async logPriceChange(r) { prices.push(r); }, async logListingEvent() {} };
    const listings: ListingStateStore = {
      async setPrice() {}, async markEnded() {},
      async isPersonalCollection() { return isPc; },
    };
    const offer = {
      offerId: "111", sku: "PC-1", marketplaceId: "EBAY_US", status: "PUBLISHED",
      pricingSummary: { price: { value: "10.0", currency: "USD" } },
      listing: { listingId: "3550001", listingStatus: "ACTIVE" },
    };
    m.on("GET", "/sell/inventory/v1/offer/111", offer);
    m.on("POST", "/bulk_update_price_quantity", { responses: [{ statusCode: 200, offerId: "111", sku: "PC-1" }] });
    return { m, deps: { rest, audit, environment: "production" as const, listings }, prices };
  }

  it("409 personal_collection, never calls eBay's update, logs a failed attempt", async () => {
    const { m, deps, prices } = setup(true);
    await expect(updatePrice(deps, { id: "111", by: "offer", price: 12, reason: "comps", actor: "api" }))
      .rejects.toMatchObject({ status: 409, code: "personal_collection" });
    expect(m.calls.some((c) => c.url.includes("bulk_update_price_quantity"))).toBe(false);
    expect(prices).toEqual([expect.objectContaining({ status: "failed", http_status: 409, sku: "PC-1" })]);
  });

  it("a business card still reprices", async () => {
    const { deps } = setup(false);
    await expect(updatePrice(deps, { id: "111", by: "offer", price: 12, reason: "comps", actor: "api" }))
      .resolves.toMatchObject({ status: "succeeded", new_price: "12.00" });
  });
});
