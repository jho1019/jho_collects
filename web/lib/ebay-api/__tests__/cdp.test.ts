import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildCondition } from "../cdp/conditions";
import { importCdp, type ImportDeps, type ListingLinkStore } from "../cdp/import";
import { parseCdpCsv, parseHeader } from "../cdp/mapping";
import { splitPhotos } from "../cdp/payloads";
import { ApiError } from "../errors";
import { EbayRest } from "../http";
import { clearPolicyCache, accountLookup } from "../policies";
import { jsonRes, mockFetch } from "./helpers";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "cdp_sample.csv"), "utf8");
const HEADER_LINE = FIXTURE.replace(/^﻿/, "").split("\n")[1];
// Header cells in the CDP export contain no quotes or commas.
const HEADERS = HEADER_LINE.split(",");

/** Synthetic graded rows in the fixture's exact column layout. */
function syntheticCsv(rows: Record<string, string>[]): string {
  const lines = ["Info,Version=1.0.0,Template=fx_category_template_EBAY_US", HEADERS.join(",")];
  for (const r of rows) {
    lines.push(HEADERS.map((h) => {
      const v = r[h] ?? "";
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(","));
  }
  return lines.join("\n");
}

function gradedRow(over: Record<string, string> = {}): Record<string, string> {
  return {
    [HEADERS[0]]: "Add",
    CustomLabel: "G-1",
    "*Category": "261328",
    "*Title": "2018 Topps Update Shohei Ohtani #US1 PSA 10",
    "*ConditionID": "2750",
    "*C:Graded": "Yes",
    "*C:Sport": "Baseball",
    "*C:Player/Athlete": "Shohei Ohtani",
    "CD:Professional Grader - (ID: 27501)": "PSA",
    "CD:Grade - (ID: 27502)": "10",
    "CDA:Certification Number - (ID: 27503)": "12345678",
    PicURL: "https://example.com/g1-front.jpg | https://example.com/g1-back.jpg",
    "*Description": "<p>Graded slab</p>",
    "*Format": "FixedPrice",
    "*Duration": "GTC",
    "*StartPrice": "180.00",
    "*Quantity": "1",
    BestOfferEnabled: "1",
    BestOfferAutoAcceptPrice: "170.00",
    MinimumBestOfferPrice: "150.00",
    ...over,
  };
}

const dryDeps: ImportDeps = { environment: "production", marketplaceId: "EBAY_US", env: {}, config: {} };
const DRY = { dryRun: true, publish: false, overrides: {} };

beforeEach(() => clearPolicyCache());

describe("header parsing", () => {
  it("strips markers and reads descriptor ids generically", () => {
    expect(parseHeader("*Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)", 0)).toMatchObject({ kind: "action", canonical: "action" });
    expect(parseHeader("*C:Player/Athlete", 1)).toMatchObject({ kind: "aspect", name: "Player/Athlete", required: true, canonical: "player" });
    expect(parseHeader("CD:Grade - (ID: 27502)", 2)).toMatchObject({ kind: "descriptor", name: "Grade", descriptorId: "27502", freeText: false, canonical: "grade" });
    expect(parseHeader("CDA:Certification Number - (ID: 27503)", 3)).toMatchObject({ descriptorId: "27503", freeText: true, canonical: "cert_number" });
    expect(parseHeader("ShippingService-1:Cost", 4)).toMatchObject({ kind: "field", ignored: true });
  });

  it("matches aliases case- and punctuation-insensitively", () => {
    expect(parseHeader("custom label", 0).canonical).toBe("sku");
    expect(parseHeader("SKU", 0).canonical).toBe("sku");
    expect(parseHeader("start_price", 0).canonical).toBe("price");
    expect(parseHeader("Picture URLs", 0).canonical).toBe("photos");
  });

  it("lists missing required columns and the unmapped headers", () => {
    const err = (() => {
      try {
        parseCdpCsv("Name,Cost,Whatever\nx,1,2\n");
      } catch (e) {
        return e as ApiError;
      }
    })()!;
    expect(err.code).toBe("cdp_missing_columns");
    expect(err.message).toMatch(/sku, title, price/);
    const d = err.details as { missing: { field: string; accepted_headers: string[] }[]; unmapped_columns: string[] };
    expect(d.missing.map((m) => m.field)).toEqual(["sku", "title", "price"]);
    expect(d.missing[0].accepted_headers).toContain("CustomLabel");
    expect(d.unmapped_columns).toEqual(["Name", "Cost", "Whatever"]);
  });
});

describe("real CDP export fixture (dry run)", () => {
  it("parses all 8 rows; 7 ready, 1 skipped for quantity 0", async () => {
    const r = await importCdp(FIXTURE, DRY, dryDeps);
    expect(r.dry_run).toBe(true);
    expect(r.summary).toMatchObject({ rows: 8, ready: 7, skipped_zero_quantity: 1, invalid: 0 });
    const zero = r.rows.find((x) => x.status === "skipped_zero_quantity")!;
    expect(zero.sku).toBe("203-19tvfa");
    expect(zero.warnings.join(" ")).toMatch(/Quantity is 0/);
  });

  it("reports shipping/payment/return/location columns as ignored", async () => {
    const r = await importCdp(FIXTURE, DRY, dryDeps);
    for (const c of ["*Location", "PostalCode", "ShippingService-1:Option", "ShippingService-1:Cost", "*DispatchTimeMax",
      "*ReturnsAcceptedOption", "PayPalAccepted", "PayPalEmailAddress", "ShippingProfileName", "PaymentProfileName"]) {
      expect(r.columns.ignoredColumns).toContain(c);
    }
    expect(r.columns.mapped.sku).toBe("CustomLabel");
    expect(r.columns.mapped.price).toBe("*StartPrice");
    expect(r.columns.unmappedColumns).toEqual(expect.arrayContaining(["StoreCategory", "BuyItNowPrice"]));
    // Nothing from the ignored columns leaks into a payload.
    const json = JSON.stringify(r.rows.map((x) => x.payloads));
    expect(json).not.toMatch(/Anytown|00000|StandardEnvelope|0\.78/);
  });

  it("builds the exact ungraded inventory item and offer payloads", async () => {
    const r = await importCdp(FIXTURE, DRY, dryDeps);
    const row = r.rows.find((x) => x.sku === "204-19tvfb")!;
    const { inventoryItem, offer } = row.payloads!;
    expect(inventoryItem).toEqual({
      sku: "204-19tvfb",
      locale: "en_US",
      product: {
        title: "2025 Donruss #347 Graham Mertz Optic Rated Rookies Preview Pink",
        description: expect.stringMatching(/^<p>This is a nice example of a 2025 Donruss #347 Graham Mertz/),
        aspects: expect.objectContaining({
          Graded: ["No"],
          Sport: ["Football"],
          "Player/Athlete": ["Graham Mertz"],
          Features: ["RC"],
          "Card Number": ["347"],
          Rookie: ["Yes"],
          "Year Manufactured": ["2025"],
        }),
        imageUrls: ["https://example.com/photos/2-front.jpg", "https://example.com/photos/2-back.jpg"],
      },
      condition: "USED_VERY_GOOD",
      conditionDescriptors: [{ name: "40001", values: ["400010"] }],
      availability: { shipToLocationAvailability: { quantity: 1 } },
    });
    // empty aspects are dropped, descriptors are not aspects
    expect(inventoryItem.product.aspects).not.toHaveProperty("Card Name");
    expect(inventoryItem.product.aspects).not.toHaveProperty("Card Condition");
    expect(offer).toEqual({
      sku: "204-19tvfb",
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: 1,
      categoryId: "261328",
      listingDescription: inventoryItem.product.description,
      listingDuration: "GTC",
      pricingSummary: { price: { value: "1.25", currency: "USD" } },
      listingPolicies: {
        fulfillmentPolicyId: null,
        paymentPolicyId: null,
        returnPolicyId: null,
        bestOfferTerms: { bestOfferEnabled: true },
      },
      merchantLocationKey: null,
    });
  });

  it("drops the RC feature where the export left it blank", async () => {
    const r = await importCdp(FIXTURE, DRY, dryDeps);
    const mcconkey = r.rows.find((x) => x.sku === "208-19tvfj")!; // Ladd McConkey, no RC
    expect(mcconkey.payloads!.inventoryItem.product.aspects).not.toHaveProperty("Features");
  });

  it("dry run shows fulfillmentPolicyId: null and explains it, without calling eBay", async () => {
    const r = await importCdp(FIXTURE, DRY, dryDeps);
    expect(r.policies.fulfillmentPolicyId).toBeNull();
    expect(r.policies.problems.join(" ")).toMatch(/new shipping policy/);
  });

  it("applies policy overrides: request > env > config", async () => {
    const r = await importCdp(FIXTURE, {
      ...DRY,
      overrides: { fulfillmentPolicyId: "F-REQ" },
    }, {
      ...dryDeps,
      env: { EBAY_FULFILLMENT_POLICY_ID: "F-ENV", EBAY_PAYMENT_POLICY_ID: "P-ENV" },
      config: { payment_policy_id: "P-CFG", return_policy_id: "R-CFG", merchant_location_key: "home" },
    });
    expect(r.policies).toMatchObject({
      fulfillmentPolicyId: "F-REQ", paymentPolicyId: "P-ENV", returnPolicyId: "R-CFG", merchantLocationKey: "home",
      sources: { fulfillmentPolicyId: "request", paymentPolicyId: "env", returnPolicyId: "config", merchantLocationKey: "config" },
    });
    expect(r.rows[1].payloads!.offer.listingPolicies).toMatchObject({
      fulfillmentPolicyId: "F-REQ", paymentPolicyId: "P-ENV", returnPolicyId: "R-CFG",
    });
    expect(r.rows[1].payloads!.offer.merchantLocationKey).toBe("home");
  });

  it("rejects a policy id that is not a plain eBay id", async () => {
    await expect(importCdp(FIXTURE, { ...DRY, overrides: { fulfillmentPolicyId: "../x?y" } }, dryDeps))
      .rejects.toMatchObject({ code: "invalid_policy_id" });
  });
});

describe("graded rows (synthetic)", () => {
  it("builds 2750 / LIKE_NEW with grader, grade and cert descriptors", async () => {
    const r = await importCdp(syntheticCsv([gradedRow()]), DRY, dryDeps);
    const p = r.rows[0].payloads!;
    expect(r.rows[0].status).toBe("ready");
    expect(p.inventoryItem.condition).toBe("LIKE_NEW");
    expect(p.inventoryItem.conditionDescriptors).toEqual([
      { name: "27501", values: ["275010"] },
      { name: "27502", values: ["275020"] },
      { name: "27503", additionalInfo: "12345678" },
    ]);
    expect(p.inventoryItem.product.aspects.Graded).toEqual(["Yes"]);
    expect(p.offer.listingPolicies.bestOfferTerms).toEqual({
      bestOfferEnabled: true,
      autoAcceptPrice: { value: "170.00", currency: "USD" },
      autoDeclinePrice: { value: "150.00", currency: "USD" },
    });
  });

  it("passes eBay value ids through and accepts BGS 9.5", async () => {
    const r = await importCdp(syntheticCsv([
      gradedRow({ CustomLabel: "G-2", "CD:Professional Grader - (ID: 27501)": "275016", "CD:Grade - (ID: 27502)": "275022" }),
      gradedRow({ CustomLabel: "G-3", "CD:Professional Grader - (ID: 27501)": "BGS", "CD:Grade - (ID: 27502)": "9.5" }),
    ]), DRY, dryDeps);
    expect(r.rows[0].payloads!.inventoryItem.conditionDescriptors.slice(0, 2)).toEqual([
      { name: "27501", values: ["275016"] }, { name: "27502", values: ["275022"] },
    ]);
    expect(r.rows[1].payloads!.inventoryItem.conditionDescriptors.slice(0, 2)).toEqual([
      { name: "27501", values: ["275013"] }, { name: "27502", values: ["275021"] },
    ]);
  });

  it("fails the row (never guesses) on an unknown grader or missing grade", async () => {
    const r = await importCdp(syntheticCsv([
      gradedRow({ CustomLabel: "G-4", "CD:Professional Grader - (ID: 27501)": "Bob's Grading" }),
      gradedRow({ CustomLabel: "G-5", "CD:Grade - (ID: 27502)": "" }),
      gradedRow({ CustomLabel: "G-6", "*C:Graded": "No" }), // contradicts 2750
    ]), DRY, dryDeps);
    expect(r.rows.map((x) => x.status)).toEqual(["invalid", "invalid", "invalid"]);
    expect(r.rows[0].errors.join()).toMatch(/unknown grader "Bob's Grading"/);
    expect(r.rows[1].errors.join()).toMatch(/needs a Grade/);
    expect(r.rows[2].errors.join()).toMatch(/contradicts ConditionID 2750/);
    expect(r.rows[0].payloads).toBeUndefined();
  });

  it("validates price, best offer bounds and duplicate SKUs", async () => {
    const r = await importCdp(syntheticCsv([
      gradedRow({ CustomLabel: "D", "*StartPrice": "abc" }),
      gradedRow({ CustomLabel: "E", BestOfferAutoAcceptPrice: "200.00" }),
      gradedRow({ CustomLabel: "F" }),
      gradedRow({ CustomLabel: "F" }),
    ]), DRY, dryDeps);
    expect(r.rows[0].errors.join()).toMatch(/StartPrice "abc"/);
    expect(r.rows[1].errors.join()).toMatch(/auto-accept must be below the price/);
    expect(r.rows[2].errors.join()).toMatch(/appears more than once/);
    expect(r.rows[3].status).toBe("invalid");
  });
});

describe("helpers", () => {
  it("splits photos on | and ;", () => {
    expect(splitPhotos("https://a/1.jpg | https://a/2.jpg;https://a/3.jpg ")).toEqual(["https://a/1.jpg", "https://a/2.jpg", "https://a/3.jpg"]);
    expect(splitPhotos("")).toEqual([]);
  });
  it("needs a card condition for ungraded", () => {
    expect(buildCondition({ conditionId: "4000" })).toMatchObject({ ok: false });
    expect(buildCondition({ graded: "No", cardCondition: "Excellent" })).toMatchObject({ ok: true, value: { conditionDescriptors: [{ name: "40001", values: ["400011"] }] } });
  });
});

describe("real import (mocked eBay)", () => {
  function realDeps(m: ReturnType<typeof mockFetch>, links?: ListingLinkStore): ImportDeps {
    const rest = new EbayRest({ apiBase: "https://api.ebay.com", fetch: m.fetch, token: async () => "user-token", marketplaceId: "EBAY_US" });
    return {
      environment: "production", marketplaceId: "EBAY_US",
      env: { EBAY_FULFILLMENT_POLICY_ID: "F1" }, config: {},
      rest, lookup: accountLookup(rest, "production"), links,
    };
  }

  function okEbay() {
    const m = mockFetch();
    m.on("GET", "/sell/account/v1/payment_policy", { paymentPolicies: [{ paymentPolicyId: "P1", name: "Pay" }] });
    m.on("GET", "/sell/account/v1/return_policy", { returnPolicies: [{ returnPolicyId: "R1", name: "No returns" }] });
    m.on("GET", "/sell/inventory/v1/location", { locations: [{ merchantLocationKey: "home", merchantLocationStatus: "ENABLED" }] });
    m.on("POST", "/bulk_create_or_replace_inventory_item", (req: { body?: string }) => {
      const reqs = JSON.parse(req.body!).requests as { sku: string }[];
      return jsonRes({ responses: reqs.map((x) => ({ statusCode: 200, sku: x.sku })) });
    });
    m.on("POST", "/bulk_create_offer", (req: { body?: string }) => {
      const reqs = JSON.parse(req.body!).requests as { sku: string }[];
      return jsonRes({ responses: reqs.map((x, i) => ({ statusCode: 200, sku: x.sku, offerId: `90${i}` })) });
    });
    m.on("POST", "/bulk_publish_offer", (req: { body?: string }) => {
      const reqs = JSON.parse(req.body!).requests as { offerId: string }[];
      return jsonRes({ responses: reqs.map((x) => ({ statusCode: 200, offerId: x.offerId, listingId: `L${x.offerId}` })) });
    });
    return m;
  }

  it("refuses with 422 and sends nothing when no fulfillment policy is configured", async () => {
    const m = okEbay();
    const deps = { ...realDeps(m), env: {} };
    const err = await importCdp(FIXTURE, { dryRun: false, publish: true, overrides: {} }, deps).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.code).toBe("policies_unresolved");
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("creates, offers and publishes the 7 publishable rows, linking cards", async () => {
    const m = okEbay();
    const upserts: unknown[] = [];
    const links: ListingLinkStore = {
      async upsert(_env, l) {
        upserts.push(...l);
        return new Map(l.map((x) => [x.sku, x.sku === "204-19tvfb" ? 42 : null]));
      },
    };
    const r = await importCdp(FIXTURE, { dryRun: false, publish: true, overrides: {} }, realDeps(m, links));
    expect(r.summary).toMatchObject({ published: 7, skipped_zero_quantity: 1 });
    expect(r.policies.sources).toMatchObject({ fulfillmentPolicyId: "env", paymentPolicyId: "account_api" });
    const sent = JSON.parse(m.calls.find((c) => c.url.includes("bulk_create_offer"))!.body!).requests;
    expect(sent).toHaveLength(7);
    expect(sent[0].listingPolicies).toMatchObject({ fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" });
    expect(sent[0].merchantLocationKey).toBe("home");
    expect(m.calls.find((c) => c.url.includes("bulk_create_or_replace"))!.headers["content-language"]).toBe("en-US");
    expect(upserts).toHaveLength(7);
    expect(r.rows.find((x) => x.sku === "204-19tvfb")!.card_id).toBe(42);
    expect(r.rows.find((x) => x.sku === "204-19tvfb")!.listingId).toMatch(/^L90/);
  });

  it("reports per-row eBay errors and an existing offer", async () => {
    const m = okEbay();
    m.on("POST", "/bulk_create_offer", (req: { body?: string }) => {
      const reqs = JSON.parse(req.body!).requests as { sku: string }[];
      return jsonRes({
        responses: reqs.map((x, i) => i === 0
          ? { statusCode: 400, sku: x.sku, errors: [{ errorId: 25002, message: "Offer entity already exists", parameters: [{ name: "offerId", value: "555" }] }] }
          : { statusCode: 200, sku: x.sku, offerId: `7${i}` }),
      }, 207);
    });
    const r = await importCdp(FIXTURE, { dryRun: false, publish: false, overrides: {} }, realDeps(m));
    const first = r.rows.find((x) => x.status === "offer_failed")!;
    expect(first.offerId).toBe("555");
    expect(first.errors.join(" ")).toMatch(/25002: Offer entity already exists.*offerId 555/);
    expect(r.summary).toMatchObject({ offer_failed: 1, offer_created: 6, published: 0 });
    expect(m.calls.some((c) => c.url.includes("bulk_publish_offer"))).toBe(false);
  });

  it("chunks bulk calls at 25 and fails only the chunk that errored", async () => {
    const m = okEbay();
    let call = 0;
    m.on("POST", "/bulk_create_or_replace_inventory_item", (req: { body?: string }) => {
      const reqs = JSON.parse(req.body!).requests as { sku: string }[];
      expect(reqs.length).toBeLessThanOrEqual(25);
      return ++call === 2
        ? jsonRes({ errors: [{ errorId: 2004, message: "Invalid request" }] }, 400)
        : jsonRes({ responses: reqs.map((x) => ({ statusCode: 200, sku: x.sku })) });
    });
    const rows = Array.from({ length: 30 }, (_, i) => gradedRow({ CustomLabel: `S-${i}` }));
    const r = await importCdp(syntheticCsv(rows), { dryRun: false, publish: false, overrides: {} }, realDeps(m));
    expect(call).toBe(2);
    expect(r.summary).toMatchObject({ offer_created: 25, inventory_failed: 5 });
    expect(r.rows.find((x) => x.status === "inventory_failed")!.errors.join()).toMatch(/Invalid request/);
  });
});
