import { describe, expect, it } from "vitest";
import { addDays, mondayOf, todayPT } from "../dates";
import { bare, fmtAxis, money, moneyAria, niceScale, tone } from "../format";
import { buildScoreboard } from "../model";
import {
  type Card,
  type Txn,
  channelOf,
  isTableFee,
  netCash,
  netProfit,
  profitEvents,
  saleProfits,
  sideOf,
} from "../profit";
import { bucketSpans, parseRange, priorWindow, rangeWindow } from "../range";
import { normalizeCard, normalizeTxn, toCents } from "../load";

// ------------------------------------------------------------- fixtures
let nextId = 1;
function txn(p: Partial<Txn> & Pick<Txn, "type" | "occurred_on">): Txn {
  const t: Txn = {
    id: nextId++,
    platform: "ebay",
    description: "",
    net_cash: 0,
    item_amount: 0,
    shipping_charged: 0,
    platform_fees: 0,
    shipping_cost: 0,
    other_cost: 0,
    show_id: null,
    deal_id: null,
    ...p,
  };
  return t;
}
function card(p: Partial<Card>): Card {
  return {
    id: nextId++,
    title: "Test card",
    player: null,
    year: null,
    set_name: null,
    parallel: null,
    grader: null,
    grade: null,
    status: "held",
    category: "business",
    acquisition_cost: null,
    acquired_on: null,
    exited_on: null,
    is_opening_stock: false,
    sale_transaction_id: null,
    ...p,
  };
}

// ------------------------------------------------------------- range
describe("parseRange", () => {
  it("defaults to 90d when missing or unknown", () => {
    expect(parseRange(undefined)).toBe("90d");
    expect(parseRange(null)).toBe("90d");
    expect(parseRange("")).toBe("90d");
    expect(parseRange("7d")).toBe("90d");
    expect(parseRange("<script>")).toBe("90d");
  });
  it("accepts the four ranges case-insensitively and takes the first of repeats", () => {
    expect(parseRange("30d")).toBe("30d");
    expect(parseRange("1Y")).toBe("1y");
    expect(parseRange("ALL")).toBe("all");
    expect(parseRange(["all", "30d"])).toBe("all");
  });
});

describe("todayPT", () => {
  it("is the Pacific calendar day, not UTC", () => {
    // 2026-11-23 05:30 UTC is still Nov 22 at 9:30pm Pacific.
    expect(todayPT(new Date("2026-11-23T05:30:00Z"))).toBe("2026-11-22");
  });
});

describe("rangeWindow / bucketSpans", () => {
  const today = "2026-11-22"; // a Sunday

  it("30D is the last 30 days in Monday-start weeks, first bucket clipped", () => {
    const w = rangeWindow("30d", today, "2026-08-08");
    expect(w).toMatchObject({ start: "2026-10-24", end: today, mode: "week" });
    const b = bucketSpans(w);
    expect(b.map((x) => x.label)).toEqual(["10/19", "10/26", "11/2", "11/9", "11/16"]);
    expect(b[0]).toMatchObject({ start: "2026-10-24", end: "2026-10-25" });
    expect(b.at(-1)).toMatchObject({ start: "2026-11-16", end: today, current: true });
    expect(b.filter((x) => x.current)).toHaveLength(1);
  });

  it("90D buckets every day exactly once", () => {
    const w = rangeWindow("90d", today, null);
    const b = bucketSpans(w);
    expect(w.start).toBe("2026-08-25");
    expect(b.length).toBe(13); // Tue Aug 25 .. Sun Nov 22 = weeks of 8/24 .. 11/16
    let covered = 0;
    for (const s of b) {
      expect(mondayOf(s.end) <= s.end).toBe(true);
      covered += (Date.parse(s.end) - Date.parse(s.start)) / 86_400_000 + 1;
    }
    expect(covered).toBe(90);
    expect(addDays(b[0].end, 1)).toBe(b[1].start);
  });

  it("1Y clamps to the first activity while the account is younger than a year", () => {
    const w = rangeWindow("1y", today, "2026-08-08");
    expect(w).toMatchObject({ start: "2026-08-08", mode: "month", clamped: true });
    expect(bucketSpans(w).map((x) => x.label)).toEqual(["AUG", "SEP", "OCT", "NOV"]);
    expect(rangeWindow("1y", "2027-09-01", "2026-08-08").clamped).toBe(false);
  });

  it("ALL starts at the first activity; past 18 months it groups by quarter", () => {
    expect(rangeWindow("all", today, "2026-08-08")).toMatchObject({ start: "2026-08-08", mode: "month" });
    const w = rangeWindow("all", "2028-03-10", "2026-08-08");
    expect(w.mode).toBe("quarter");
    expect(bucketSpans(w).map((x) => x.label)[0]).toBe("Q3 26");
  });

  it("with no activity, 1Y and ALL show the last 4 months", () => {
    expect(bucketSpans(rangeWindow("all", today, null)).map((x) => x.label)).toEqual(["AUG", "SEP", "OCT", "NOV"]);
  });

  it("only 30D and 90D have a prior period", () => {
    expect(priorWindow("30d", rangeWindow("30d", today, null))).toEqual({ start: "2026-09-24", end: "2026-10-23" });
    expect(priorWindow("all", rangeWindow("all", today, null))).toBeNull();
  });
});

// ------------------------------------------------------------- format
describe("money formatting", () => {
  it("signs positives and negatives, never zero", () => {
    expect(money(16570)).toBe("+$165.70");
    expect(money(-3840)).toBe("−$38.40");
    expect(money(0)).toBe("$0.00");
    expect(money(-0)).toBe("$0.00");
    expect(tone(0)).toBe("zero");
    expect(tone(1)).toBe("pos");
    expect(tone(-1)).toBe("neg");
  });
  it("whole dollars round, and a value that rounds to 0 is unsigned", () => {
    expect(money(11270, { decimals: 0 })).toBe("+$113");
    expect(money(40, { decimals: 0 })).toBe("$0");
    expect(bare(-11270, 0)).toBe("−113");
    expect(money(123456)).toBe("+$1,234.56");
  });
  it("aria text uses an ASCII minus", () => {
    expect(moneyAria(-97522)).toBe("-$975.22");
  });
  it("axis ticks match the mock", () => {
    expect(fmtAxis(-900)).toBe("−$900");
    expect(fmtAxis(0)).toBe("$0");
    expect(fmtAxis(300)).toBe("$300");
  });
  it("niceScale always includes zero", () => {
    expect(niceScale(0, 0).ticks).toContain(0);
    const s = niceScale(-140, 540);
    expect(s.lo).toBeLessThanOrEqual(-140);
    expect(s.hi).toBeGreaterThanOrEqual(540);
    expect(s.ticks).toContain(0);
  });
});

// ------------------------------------------------------------- profit
describe("sale profit and net profit", () => {
  it("subtracts linked card cost from net_cash", () => {
    const sale = txn({ type: "sale", occurred_on: "2026-11-02", net_cash: 5291 });
    const c = card({ status: "sold", sale_transaction_id: sale.id, acquisition_cost: 1400 });
    const [p] = saleProfits([sale], [c]);
    expect(p).toMatchObject({ revenue: 5291, cogs: 1400, profit: 3891, missingCost: false });
  });

  it("flags missing cost for unlinked sales and null-cost cards, using cogs 0", () => {
    const bulk = txn({ type: "sale", occurred_on: "2026-11-02", net_cash: 1000 });
    const opening = txn({ type: "sale", occurred_on: "2026-11-03", net_cash: 2000 });
    const mixed = txn({ type: "sale", occurred_on: "2026-11-04", net_cash: 3000 });
    const cards = [
      card({ status: "sold", sale_transaction_id: opening.id, is_opening_stock: true, acquisition_cost: null }),
      card({ status: "sold", sale_transaction_id: mixed.id, acquisition_cost: 500 }),
      card({ status: "sold", sale_transaction_id: mixed.id, acquisition_cost: null }),
    ];
    const ps = saleProfits([bulk, opening, mixed], cards);
    expect(ps.map((p) => p.missingCost)).toEqual([true, true, true]);
    expect(ps.map((p) => p.profit)).toEqual([1000, 2000, 2500]);
  });

  it("an opening-stock card with a cost entered is no longer missing", () => {
    const sale = txn({ type: "sale", occurred_on: "2026-11-03", net_cash: 2000 });
    const c = card({ status: "sold", sale_transaction_id: sale.id, is_opening_stock: true, acquisition_cost: 800 });
    expect(saleProfits([sale], [c])[0]).toMatchObject({ missingCost: false, profit: 1200 });
  });

  it("net profit = sale profit + refunds + expenses, and ignores purchases", () => {
    const sale = txn({ type: "sale", occurred_on: "2026-10-01", net_cash: 10000 });
    const txns = [
      sale,
      txn({ type: "refund", occurred_on: "2026-10-02", net_cash: -2500 }),
      txn({ type: "expense", occurred_on: "2026-10-03", net_cash: -1800 }),
      txn({ type: "purchase", occurred_on: "2026-10-04", net_cash: -9999 }),
    ];
    const cards = [card({ status: "sold", sale_transaction_id: sale.id, acquisition_cost: 4000 })];
    const events = profitEvents(txns, saleProfits(txns, cards));
    expect(netProfit(events)).toBe(10000 - 4000 - 2500 - 1800);
    expect(netProfit(events, "2026-10-02", "2026-10-02")).toBe(-2500);
    expect(netCash(txns)).toBe(10000 - 2500 - 1800 - 9999);
  });

  it("maps channels per 10.1 (local and lcs are Shows)", () => {
    expect(channelOf("ebay")).toBe("ebay");
    expect(["card_show", "local", "lcs"].map(channelOf)).toEqual(["shows", "shows", "shows"]);
    expect(["collx", "online", "other", "na"].map(channelOf)).toEqual(["other", "other", "other", "other"]);
  });

  it("splits sports vs riftbound by category", () => {
    expect(sideOf(null)).toBe("sports");
    expect(sideOf("business")).toBe("sports");
    expect(sideOf("sealed")).toBe("sports");
    expect(sideOf("riftbound")).toBe("riftbound");
    expect(sideOf("pc")).toBeNull();
  });

  it("recognizes a table fee only from a show-level expense that says so", () => {
    const base = { type: "expense" as const, occurred_on: "2026-11-01" };
    expect(isTableFee(txn({ ...base, show_id: 4, description: "Table fee" }))).toBe(true);
    expect(isTableFee(txn({ ...base, show_id: 4, description: "booth rental" }))).toBe(true);
    expect(isTableFee(txn({ ...base, show_id: null, description: "Table fee" }))).toBe(false);
    expect(isTableFee(txn({ ...base, show_id: 4, deal_id: 9, description: "Table fee" }))).toBe(false);
    expect(isTableFee(txn({ ...base, show_id: 4, description: "parking" }))).toBe(false);
    expect(isTableFee(txn({ ...base, show_id: 4, description: "timetable" }))).toBe(false);
  });
});

describe("load normalization", () => {
  it("converts numeric strings and numbers to integer cents", () => {
    expect(toCents("13.25")).toBe(1325);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(null)).toBe(0);
    const t = normalizeTxn({
      id: "7", occurred_on: "2026-09-05", type: "expense", platform: "na", description: null,
      net_cash: "-180.00", item_amount: 180, shipping_charged: 0, platform_fees: 0,
      shipping_cost: 0, other_cost: 0, show_id: null, deal_id: null,
    });
    expect(t).toMatchObject({ id: 7, net_cash: -18000, item_amount: 18000, description: "" });
    const c = normalizeCard({
      id: 1, title: "x", player: null, year: null, set_name: null, parallel: null, grader: null,
      grade: null, status: "sold", category: null, acquisition_cost: null, acquired_on: null,
      exited_on: "2026-09-09", is_opening_stock: true, sale_transaction_id: 65,
    });
    expect(c).toMatchObject({ acquisition_cost: null, category: "business", sale_transaction_id: 65 });
  });
});

// ------------------------------------------------------------- model
describe("buildScoreboard", () => {
  const today = "2026-11-22";

  // Shaped like the live account on Nov 22: sales Aug–early Oct, none since,
  // an unattached $180 fee, every sale missing cost.
  function liveLike() {
    const s1 = txn({ type: "sale", platform: "ebay", occurred_on: "2026-08-08", net_cash: 3985 });
    const s2 = txn({ type: "sale", platform: "card_show", occurred_on: "2026-09-12", net_cash: 6000 });
    const s3 = txn({ type: "sale", platform: "ebay", occurred_on: "2026-10-04", net_cash: 20000 });
    const txns = [
      s1, s2, s3,
      txn({ type: "purchase", platform: "card_show", occurred_on: "2026-09-01", net_cash: -50000 }),
      txn({ type: "expense", platform: "na", occurred_on: "2026-09-05", net_cash: -18000, description: "fees" }),
    ];
    const cards = [card({ status: "sold", sale_transaction_id: s2.id, is_opening_stock: true, exited_on: "2026-09-12" })];
    return { txns, cards };
  }

  it("30D is an empty range, 90D is not; hero is MTD and unscoped", () => {
    const { txns, cards } = liveLike();
    const d30 = buildScoreboard({ txns, cards, inventory: null, today, range: "30d" });
    const d90 = buildScoreboard({ txns, cards, inventory: null, today, range: "90d" });
    expect(d30.totals.sales).toBe(0);
    expect(d30.buckets.every((b) => b.sales === 0 && b.profit === 0)).toBe(true);
    expect(d90.totals.sales).toBe(2); // Sep 12 and Oct 4; Aug 8 is outside 90D
    expect(d90.totals.profit).toBe(6000 + 20000 - 18000);
    expect(d30.hero).toEqual(d90.hero);
    expect(d30.hero).toMatchObject({ mtd: 0, mtdSales: 0, missingCount: 0, prevAbbr: "OCT", monthName: "November" });
    expect(d30.lastSaleDay).toBe("2026-10-04");
  });

  it("stock & bulk lots = all-time profit − all-time net cash", () => {
    const { txns, cards } = liveLike();
    const m = buildScoreboard({ txns, cards, inventory: null, today, range: "all" });
    expect(m.hero.allTime).toBe(3985 + 6000 + 20000 - 18000);
    expect(m.hero.netCash).toBe(3985 + 6000 + 20000 - 50000 - 18000);
    expect(m.hero.stock).toBe(50000);
    expect(m.hero.allTime - m.hero.stock).toBe(m.hero.netCash);
  });

  it("buckets sum to the range total and expenses land in 'other'", () => {
    const { txns, cards } = liveLike();
    const m = buildScoreboard({ txns, cards, inventory: null, today, range: "all" });
    expect(m.buckets.map((b) => b.label)).toEqual(["AUG", "SEP", "OCT", "NOV"]);
    const sep = m.buckets[1];
    expect(sep).toMatchObject({ ebay: 0, shows: 6000, other: -18000, profit: -12000, sales: 1 });
    expect(m.hasOther).toBe(true);
    expect(m.buckets.reduce((s, b) => s + b.profit, 0)).toBe(m.totals.profit);
    expect(m.cumulative.points.at(-1)!.value).toBe(m.totals.profit);
    expect(m.cumulative.points[0].value).toBe(0);
  });

  it("ships daily points and pinnable entries for 90D, weekly points and no entries for ALL", () => {
    const { txns, cards } = liveLike();
    const d90 = buildScoreboard({ txns, cards, inventory: null, today, range: "90d" });
    expect(d90.cumulative.granularity).toBe("day");
    expect(d90.cumulative.points).toHaveLength(90);
    expect(d90.entriesByDay!["2026-10-04"]).toEqual([expect.objectContaining({ type: "sale", net_cash: 200 })]);
    expect(Object.keys(d90.entriesByDay!).every((d) => d >= "2026-08-25")).toBe(true);
    const all = buildScoreboard({ txns, cards, inventory: null, today, range: "all" });
    expect(all.cumulative.granularity).toBe("week");
    expect(all.cumulative.points.length).toBeLessThan(20);
    expect(all.entriesByDay).toBeNull();
  });

  it("cumulative resets to $0 at the range start", () => {
    const { txns, cards } = liveLike();
    const d30 = buildScoreboard({ txns, cards, inventory: null, today, range: "30d" });
    expect(d30.cumulative.points.every((p) => p.value === 0)).toBe(true);
  });

  it("counts missing-cost sales in the current month and computes vs last month", () => {
    const oct = txn({ type: "sale", occurred_on: "2026-10-10", net_cash: 10000 });
    const nov1 = txn({ type: "sale", occurred_on: "2026-11-02", net_cash: 5000 });
    const nov2 = txn({ type: "sale", occurred_on: "2026-11-03", net_cash: 7000 });
    const cards = [card({ status: "sold", sale_transaction_id: nov2.id, acquisition_cost: 1000 })];
    const m = buildScoreboard({ txns: [oct, nov1, nov2], cards, inventory: null, today, range: "90d" });
    expect(m.hero).toMatchObject({ mtd: 11000, mtdSales: 2, missingCount: 1 });
    expect(m.hero.vsPrevPct).toBeCloseTo(0.1);
  });

  it("vs last month is null when last month was $0", () => {
    const nov = txn({ type: "sale", occurred_on: "2026-11-02", net_cash: 5000 });
    expect(buildScoreboard({ txns: [nov], cards: [], inventory: null, today, range: "90d" }).hero.vsPrevPct).toBeNull();
  });

  it("best flip needs one card with a known cost and a profit; falls back to all-time", () => {
    const oct = txn({ type: "sale", occurred_on: "2026-10-10", net_cash: 5291, item_amount: 6100, platform_fees: 809 });
    const nov = txn({ type: "sale", occurred_on: "2026-11-02", net_cash: 3000 });
    const cards = [
      card({ title: "Rookie", grader: "PSA", grade: "10", status: "sold", sale_transaction_id: oct.id, acquisition_cost: 1400, acquired_on: "2026-10-06", exited_on: "2026-10-10" }),
      card({ status: "sold", sale_transaction_id: nov.id, acquisition_cost: null }),
    ];
    const m = buildScoreboard({ txns: [oct, nov], cards, inventory: null, today, range: "90d" });
    expect(m.flip).toBeNull();
    expect(m.bestFlipAllTime).toMatchObject({
      title: "Rookie", cost: 1400, sold: 6100, fees: 809, profit: 3891, daysToSell: 4,
    });
    expect(m.bestFlipAllTime!.pctOfCost).toBeCloseTo(2.779, 2);
  });

  it("days to sell needs acquired_on and exited_on; sell-through needs listings", () => {
    const sale = txn({ type: "sale", occurred_on: "2026-11-02", net_cash: 3000 });
    const noDates = buildScoreboard({
      txns: [sale],
      cards: [card({ status: "sold", sale_transaction_id: sale.id, is_opening_stock: true, exited_on: "2026-11-02" })],
      inventory: null, today, range: "90d",
    });
    expect(noDates.daysToSell).toBeNull();
    expect(noDates.sellThrough).toBeNull(); // 1 sold, nothing listed: no rate

    const s2 = txn({ type: "sale", occurred_on: "2026-11-05", net_cash: 3000 });
    const withData = buildScoreboard({
      txns: [sale, s2],
      cards: [
        card({ status: "sold", sale_transaction_id: sale.id, acquired_on: "2026-10-30", exited_on: "2026-11-02" }),
        card({ status: "sold", sale_transaction_id: s2.id, acquired_on: "2026-10-01", exited_on: "2026-11-05" }),
        card({ status: "listed" }),
        card({ status: "listed" }),
        card({ status: "listed", category: "pc" }),
      ],
      inventory: null, today, range: "90d",
    });
    expect(withData.daysToSell).toMatchObject({ median: 19, avg: 19, within7: 0.5, n: 2 });
    expect(withData.sellThrough).toEqual({ sold: 2, listed: 4, ratio: 0.5 });
  });

  it("pitch count splits costs; unmatched fees go to Other", () => {
    const sale = txn({ type: "sale", platform: "ebay", occurred_on: "2026-11-02", net_cash: 4000, platform_fees: 800, shipping_cost: 500 });
    const collx = txn({ type: "sale", platform: "collx", occurred_on: "2026-11-02", net_cash: 900, platform_fees: 100 });
    const table = txn({ type: "expense", occurred_on: "2026-11-01", net_cash: -3625, show_id: 1, description: "Table fee" });
    const supplies = txn({ type: "expense", occurred_on: "2026-11-01", net_cash: -1200, description: "toploaders" });
    const cards = [card({ status: "sold", sale_transaction_id: sale.id, acquisition_cost: 1500 })];
    const m = buildScoreboard({ txns: [sale, collx, table, supplies], cards, inventory: null, today, range: "30d" });
    expect(m.pitch).toEqual({ cardCosts: 1500, ebayFees: 800, shipping: 500, tableFees: 3625, other: 1300 });
  });

  it("visitor vs home uses category and excludes pc", () => {
    const a = txn({ type: "sale", occurred_on: "2026-11-02", net_cash: 1000 });
    const b = txn({ type: "sale", occurred_on: "2026-11-02", net_cash: 2000 });
    const c = txn({ type: "sale", occurred_on: "2026-11-02", net_cash: 4000 });
    const cards = [
      card({ status: "sold", sale_transaction_id: b.id, category: "riftbound", acquisition_cost: 500 }),
      card({ status: "sold", sale_transaction_id: c.id, category: "pc", acquisition_cost: 0 }),
    ];
    const m = buildScoreboard({ txns: [a, b, c], cards, inventory: null, today, range: "30d" });
    expect(m.vs).toEqual({ sports: { profit: 1000, sales: 1 }, riftbound: { profit: 1500, sales: 1 } });
  });

  it("an account with no sales has no sales anywhere", () => {
    const m = buildScoreboard({ txns: [], cards: [], inventory: null, today, range: "90d" });
    expect(m.hasAnySales).toBe(false);
    expect(m.hero).toMatchObject({ mtd: 0, allTime: 0, netCash: 0, stock: 0 });
    expect(m.announcement).toBe("Showing last 90 days: 13 weeks, 0 sales.");
  });
});

// Same fixture used to verify schema/026_profit_views.sql on a throwaway
// PGlite: sale_profit gave (60, missing=false), (10, true), (25, true) and
// profit_daily summed to 52.00. The TS path must agree with the views.
describe("parity with schema/026 views", () => {
  it("matches sale_profit and profit_daily on the 026 fixture", () => {
    const a = txn({ type: "sale", platform: "ebay", occurred_on: "2026-10-01", net_cash: 10000 });
    const bulk = txn({ type: "sale", platform: "local", occurred_on: "2026-10-05", net_cash: 1000 });
    const b = txn({ type: "sale", platform: "collx", occurred_on: "2026-10-06", net_cash: 3000 });
    const txns = [
      a,
      txn({ type: "refund", occurred_on: "2026-10-02", net_cash: -2500 }),
      txn({ type: "expense", platform: "na", occurred_on: "2026-10-03", net_cash: -1800 }),
      txn({ type: "purchase", platform: "card_show", occurred_on: "2026-10-04", net_cash: -9999 }),
      bulk,
      b,
    ];
    const cards = [
      card({ status: "sold", sale_transaction_id: a.id, acquisition_cost: 4000, category: "business" }),
      card({ status: "sold", sale_transaction_id: b.id, acquisition_cost: 500, category: "riftbound" }),
      card({ status: "sold", sale_transaction_id: b.id, acquisition_cost: null, category: "riftbound" }),
    ];
    const sp = saleProfits(txns, cards);
    expect(sp.map((s) => [s.channel, s.cogs, s.profit, s.missingCost, s.category])).toEqual([
      ["ebay", 4000, 6000, false, "business"],
      ["shows", 0, 1000, true, null],
      ["other", 500, 2500, true, "riftbound"],
    ]);
    expect(netProfit(profitEvents(txns, sp))).toBe(5200);
  });
});

describe("prior-period revenue", () => {
  it("is null when the ledger does not cover the whole prior period", () => {
    const early = txn({ type: "sale", occurred_on: "2026-08-08", net_cash: 1000 });
    const later = txn({ type: "sale", occurred_on: "2026-10-04", net_cash: 2000 });
    const m = buildScoreboard({ txns: [early, later], cards: [], inventory: null, today: "2026-11-22", range: "90d" });
    expect(m.totals.priorRevenue).toBeNull(); // prior 90D starts May 27, ledger Aug 8
    const m30 = buildScoreboard({ txns: [early, later], cards: [], inventory: null, today: "2026-11-22", range: "30d" });
    expect(m30.totals.priorRevenue).toBe(2000); // Sep 24–Oct 23 is covered and holds Oct 4
  });
});
