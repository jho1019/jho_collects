import { describe, expect, it } from "vitest";
import { parseOverrides } from "../overrides";
import { parseInventoryCsv } from "../parse";
import { planImport, type Existing } from "../plan";
import { lit, planToSql, SqlEmitError } from "../sql";
import { card, cdpCsv, OWNER, row } from "./helpers";

function sqlFor(rows: ReturnType<typeof row>[], existing: Existing = { cards: [], bulk_lots: [] }, overrides?: unknown) {
  const plan = planImport({
    file: "t.csv", parsed: parseInventoryCsv(cdpCsv(rows)), mode: "bulk", existing,
    overrides: overrides ? parseOverrides(overrides) : undefined, valuedOn: "2026-11-27", batchId: "cdp-42",
  });
  return { plan, sql: planToSql(plan, { userId: OWNER }) };
}

describe("commit SQL", () => {
  const { sql } = sqlFor([
    row({ sku: "10", market_price: "30.00", title: "O'Neal Gold", player: "Shaquille O'Neal" }),
    row({ sku: "11", market_price: "8.00" }),
    row({ sku: "12", market_price: "" }), // missing value -> left out
  ]);

  it("one transaction, owner guard first", () => {
    expect(sql).toMatch(/^-- Card Dealer Pro/);
    expect(sql.indexOf("begin;")).toBeLessThan(sql.indexOf("do $guard$"));
    expect(sql.trim().endsWith("commit;")).toBe(true);
  });

  it("explicit user_id everywhere; never relies on auth.uid()", () => {
    expect(sql).not.toMatch(/auth\.uid\(\)/);
    expect(sql).toContain(`'${OWNER}'::uuid`);
    expect(sql).toMatch(/insert into bulk_lots \(user_id, bucket, card_count, unit_price, location\)\s+values \('aaaaaaaa/);
  });

  it("insert is guarded by apply-time match on cdp_sku and ON CONFLICT DO NOTHING; enum casts", () => {
    expect(sql).toContain(`where not exists (select 1 from cards where user_id = '${OWNER}' and (cdp_sku = '10'))\non conflict do nothing;`);
    expect(sql).toContain("'business'::card_category");
    expect(sql).toContain("'held'::card_status");
    expect(sql).toContain("'O''Neal Gold'"); // quotes escaped
  });

  it("update fills nulls only and keeps a non-CDP estimate", () => {
    expect(sql).toMatch(/player = coalesce\(player, 'Shaquille O''Neal'\)/);
    expect(sql).toMatch(/est_value = case when est_value is null or est_value_source = 'cdp' then 30\.00 else est_value end/);
    expect(sql).not.toMatch(/acquisition_cost = (?!coalesce)/);
  });

  it("bulk increment is guarded by a batch marker in bulk_lot_events.notes", () => {
    expect(sql).toContain("notes = 'cdp-import:cdp-42:6_20:'");
    expect(sql).toContain("on conflict (user_id, bucket, coalesce(location, '')) do nothing");
    expect(sql).toContain("round((v_count * v_unit + 8) / (v_count + 1), 2)");
    expect(sql).toMatch(/insert into bulk_lot_events \(user_id, lot_id, delta, reason, occurred_on, notes\)\s+values \('aaaa[^,]+, v_lot, 1, 'scan_add'/);
  });

  it("never touches transactions, never deletes, never writes generated columns, eBay sku or status other than held", () => {
    const code = sql.split("\n").filter((l) => !l.startsWith("--")).join("\n");
    expect(code).not.toMatch(/\btransactions\b/);
    expect(code).not.toMatch(/\bdelete\b/i);
    expect(code).not.toMatch(/search_text|total_value|net_cash/);
    expect(code).not.toMatch(/'(listed|sold)'/);
    expect(code).not.toMatch(/(^|[^_])\bsku\b/); // only cdp_sku, never the eBay sku column
    expect(code).not.toMatch(/\bstatus\s*=/);
  });

  it("every UPDATE has a WHERE", () => {
    const updates = sql.split(/;\s*\n/).filter((s) => /^\s*(--.*\n)*\s*update /m.test(s) || /\n\s*update /.test(s));
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u).toMatch(/\bwhere\b/);
  });

  it("flagged rows are left out", () => {
    expect(sql).not.toContain("cdp_sku = '12'");
  });

  it("merge override updates by id only", () => {
    const { sql: s } = sqlFor([row({ sku: "20", market_price: "40" })],
      { cards: [card({ id: 77, title: "hand entered" })], bulk_lots: [] },
      { rows: [{ cdp_sku: "20", action: "merge", card_id: 77, list_price: "45" }] });
    expect(s).toContain(`where user_id = '${OWNER}' and id = 77;`);
    expect(s).toContain("list_price = 45");
    expect(s).not.toMatch(/insert into cards/);
  });

  it("a manual add with no sku/cert inserts once, keyed on title + set + number among non-CDP cards", () => {
    const m = { manual_adds: [{ title: "Kobe Orange PSA 2.5", set_name: "2008-09 Topps", card_number: "24",
      grader: "PSA", grade: "2.5", category: "pc", est_value: "600.00", est_value_source: "cdp" }] };
    const { sql: s } = sqlFor([], undefined, m);
    expect(s).toContain(`where not exists (select 1 from cards where user_id = '${OWNER}' and cdp_sku is null and title = 'Kobe Orange PSA 2.5' and coalesce(set_name, '') = '2008-09 Topps' and coalesce(card_number, '') = '24')\non conflict do nothing;`);
    expect(s).toMatch(/'pc'::card_category, NULL, NULL, 600\.00, 'cdp'/i);
  });

  it("rejects a non-UUID owner and NUL bytes", () => {
    const { plan } = sqlFor([row()]);
    expect(() => planToSql(plan, { userId: "me" })).toThrow(SqlEmitError);
    expect(() => lit("a\u0000b")).toThrow(SqlEmitError);
  });
});
