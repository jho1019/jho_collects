import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { importCdp, skuVariants, type ImportDeps, type PersonalCollectionLookup } from "../cdp/import";
import { EbayRest } from "../http";
import { supabaseListingStore } from "../store";
import { jsonRes, mockFetch } from "./helpers";

// The CDP -> eBay listing import skips personal-collection rows BEFORE
// anything is built or sent: rows matching the shared PC rules
// (lib/inventory-import/pc-rules.ts) and rows whose SKU is a pc card.

const HEADERS = [
  "*Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)", "CustomLabel", "*Category", "*Title",
  "*ConditionID", "*C:Graded", "*C:Sport", "*C:Player/Athlete", "C:Season", "*C:Set", "*C:Parallel/Variety", "C:Card Number",
  "CD:Professional Grader - (ID: 27501)", "CD:Grade - (ID: 27502)", "CDA:Certification Number - (ID: 27503)",
  "CD:Card Condition - (ID: 40001)", "PicURL", "*Description", "*Format", "*Duration", "*StartPrice", "*Quantity",
];

function csv(rows: Record<string, string>[]): string {
  const lines = ["Info,Version=1.0.0,Template=fx_category_template_EBAY_US", HEADERS.join(",")];
  for (const r of rows) lines.push(HEADERS.map((h) => {
    const v = r[h] ?? "";
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","));
  return lines.join("\n");
}

function raw(over: Record<string, string>): Record<string, string> {
  return {
    [HEADERS[0]]: "Add", "*Category": "261328", "*ConditionID": "4000", "*C:Graded": "No", "*C:Sport": "Basketball",
    "CD:Card Condition - (ID: 40001)": "400010", PicURL: "https://example.com/f.jpg", "*Description": "<p>x</p>",
    "*Format": "FixedPrice", "*Duration": "GTC", "*StartPrice": "9.99", "*Quantity": "1", ...over,
  };
}

const ROWS = [
  raw({ CustomLabel: "301-aaa", "*Title": "2023-24 Donruss #1 Victor Wembanyama", "*C:Player/Athlete": "Victor Wembanyama", "C:Season": "2023-24", "*C:Set": "Donruss" }),
  raw({ CustomLabel: "302-bbb", "*Title": "2018 Leaf #02 Shohei Ohtani", "*C:Player/Athlete": "Shohei Ohtani", "C:Season": "2018", "*C:Set": "Leaf" }),
  raw({ CustomLabel: "303-ccc", "*Title": "2025 Topps Heritage #719 Hyeseong Kim", "*C:Player/Athlete": "Hyeseong Kim", "C:Season": "2025", "*C:Set": "Topps Heritage" }),
  raw({
    CustomLabel: "304-ddd", "*Title": "2008-09 Topps #24 Kobe Bryant Orange PSA 2.5", "*ConditionID": "2750", "*C:Graded": "Yes",
    "*C:Player/Athlete": "Kobe Bryant", "C:Season": "2008-09", "*C:Set": "Topps", "*C:Parallel/Variety": "Orange",
    "CD:Professional Grader - (ID: 27501)": "275010", "CD:Grade - (ID: 27502)": "2750215", "CDA:Certification Number - (ID: 27503)": "555",
    "CD:Card Condition - (ID: 40001)": "",
  }),
  raw({ CustomLabel: "305-eee", "*Title": "2026 Topps Heritage #144 Jacob Misiorowski", "*C:Player/Athlete": "Jacob Misiorowski", "C:Season": "2026", "*C:Set": "Topps Heritage" }),
  raw({ CustomLabel: "306-fff", "*Title": "1997-98 Fleer #50 Kobe Bryant", "*C:Player/Athlete": "Kobe Bryant", "C:Season": "1997-98", "*C:Set": "Fleer" }),
];

const DRY = { dryRun: true, publish: false, overrides: {} };
const dryDeps: ImportDeps = { environment: "production", marketplaceId: "EBAY_US", env: {}, config: {} };

describe("CDP listing import skips personal collection", () => {
  it("rule matches are skipped with reason personal_collection and get no payloads (dry run)", async () => {
    const r = await importCdp(csv(ROWS), DRY, dryDeps);
    const by = Object.fromEntries(r.rows.map((x) => [x.sku, x]));
    for (const sku of ["302-bbb", "303-ccc", "304-ddd"]) {
      expect(by[sku]).toMatchObject({ status: "skipped_personal_collection", reason: "personal_collection" });
      expect(by[sku].payloads).toBeUndefined();
    }
    expect(by["302-bbb"].pc_match).toBe("rule:player_ohtani");
    expect(by["303-ccc"].pc_match).toBe("rule:set_2025_topps_heritage");
    expect(by["304-ddd"].pc_match).toBe("rule:kobe_2008_topps_orange_psa25"); // grader/grade given as eBay value IDs
    // 2026 Heritage and a raw Kobe are business
    expect(by["305-eee"].status).toBe("ready");
    expect(by["306-fff"].status).toBe("ready");
    expect(by["301-aaa"].status).toBe("ready");
    expect(r.summary).toMatchObject({ rows: 6, ready: 3, skipped_personal_collection: 3 });
  });

  it("rows whose sku is a pc card in the database are skipped (CDP sku prefix or full label)", async () => {
    const asked: string[][] = [];
    const pcCards: PersonalCollectionLookup = {
      async personalCollectionSkus(skus) { asked.push(skus); return new Set(["301"]); },
    };
    const r = await importCdp(csv([ROWS[0], ROWS[4]]), DRY, { ...dryDeps, pcCards });
    expect(asked[0]).toEqual(expect.arrayContaining(["301-aaa", "301", "305-eee", "305"]));
    expect(r.rows[0]).toMatchObject({ status: "skipped_personal_collection", reason: "personal_collection", pc_match: "pc_card_sku:301" });
    expect(r.rows[1].status).toBe("ready");
  });

  it("real run: PC rows never reach eBay", async () => {
    const m = mockFetch();
    m.on("POST", "/bulk_create_or_replace_inventory_item", (req: { body?: string }) => {
      const reqs = JSON.parse(req.body!).requests as { sku: string }[];
      return jsonRes({ responses: reqs.map((x) => ({ statusCode: 200, sku: x.sku })) });
    });
    m.on("POST", "/bulk_create_offer", (req: { body?: string }) => {
      const reqs = JSON.parse(req.body!).requests as { sku: string }[];
      return jsonRes({ responses: reqs.map((x, i) => ({ statusCode: 200, sku: x.sku, offerId: `90${i}` })) });
    });
    const rest = new EbayRest({ apiBase: "https://api.ebay.com", fetch: m.fetch, token: async () => "user-token", marketplaceId: "EBAY_US" });
    const r = await importCdp(csv(ROWS), {
      dryRun: false, publish: false,
      overrides: { fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1", merchantLocationKey: "home" },
    }, { ...dryDeps, rest });
    const sent = m.calls.filter((c) => c.body).flatMap((c) => (JSON.parse(c.body!).requests as { sku: string }[]).map((x) => x.sku));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((s) => ["302-bbb", "303-ccc", "304-ddd"].includes(s))).toEqual([]);
    expect(r.rows.filter((x) => x.status === "skipped_personal_collection").map((x) => x.sku)).toEqual(["302-bbb", "303-ccc", "304-ddd"]);
    expect(r.summary.offer_created).toBe(3);
  });

  it("skuVariants", () => {
    expect(skuVariants("203-19tvfa")).toEqual(["203-19tvfa", "203"]);
    expect(skuVariants("G-1")).toEqual(["G-1"]);
  });
});

describe("supabaseListingStore.personalCollectionSkus", () => {
  it("returns pc skus by cdp_sku and eBay sku, owner scoped", async () => {
    const OWNER = "aaaaaaaa-0000-0000-0000-00000000000a";
    const cards = [
      { user_id: OWNER, sku: null, cdp_sku: "301", category: "pc" },
      { user_id: OWNER, sku: "305-eee", cdp_sku: null, category: "pc" },
      { user_id: OWNER, sku: null, cdp_sku: "306", category: "business" },
      { user_id: "other", sku: null, cdp_sku: "302", category: "pc" },
    ];
    const db = {
      from: () => {
        const f: [string, unknown][] = [];
        const b = {
          select: () => b,
          eq: (c: string, v: unknown) => (f.push([c, v]), b),
          in: (c: string, v: unknown[]) => (f.push([c, v]), b),
          then: (res: (v: unknown) => unknown) => Promise.resolve({
            data: cards.filter((r) => f.every(([c, v]) => (Array.isArray(v) ? v.includes((r as Record<string, unknown>)[c]) : (r as Record<string, unknown>)[c] === v))),
            error: null,
          }).then(res),
        };
        return b;
      },
    } as unknown as SupabaseClient;
    const got = await supabaseListingStore(db, { OWNER_USER_ID: OWNER }).personalCollectionSkus(["301", "302", "305-eee", "306"]);
    expect([...got].sort()).toEqual(["301", "305-eee"]);
  });
});
