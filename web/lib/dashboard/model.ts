// Builds the whole scoreboard view model on the server. The browser gets
// bucketed totals and at most ~90 daily points (30D/90D) or one point per
// week (1Y/ALL) — never the raw ledger for a long range.

import type { EntriesByDay } from "@/lib/ledgerTypes";
import { addDays, addMonths, daysBetween, monthAbbr, monthName, monthStart, mondayOf } from "./dates";
import {
  type Card,
  type Channel,
  type SaleProfit,
  type Txn,
  inSpan,
  isTableFee,
  median,
  netCash,
  netProfit,
  profitEvents,
  saleProfits,
  sideOf,
} from "./profit";
import {
  type BucketMode,
  type RangeKey,
  bucketSpans,
  priorWindow,
  rangeSpoken,
  rangeWindow,
} from "./range";

export type InventorySummary = {
  cards_on_hand: number;
  cards_without_cost: number;
  known_cost_basis: number; // cents
};

export type Bucket = {
  label: string;
  start: string;
  end: string;
  current: boolean;
  ebay: number;
  shows: number;
  other: number;
  profit: number;
  sales: number;
};

export type Flip = {
  title: string;
  grader: string | null;
  grade: string | null;
  day: string;
  platform: string;
  cost: number;
  sold: number; // item + shipping charged
  fees: number;
  shipping: number; // shipping cost + other cost
  profit: number;
  pctOfCost: number | null;
  daysToSell: number | null;
};

export type Scoreboard = {
  today: string;
  range: RangeKey;
  hasAnySales: boolean;
  firstSaleDay: string | null;
  lastSaleDay: string | null;

  hero: {
    monthName: string; // "November"
    prevAbbr: string; // "OCT"
    dayOfMonth: number;
    mtd: number;
    mtdSales: number;
    missingCount: number; // sales this month with no card cost
    vsPrevPct: number | null; // ratio; null when last month was $0
    allTime: number;
    netCash: number;
    stock: number; // all-time profit − all-time net cash
    spark: number[]; // daily profit, last 30 days
  };

  window: { start: string; end: string; mode: BucketMode; clamped: boolean };
  buckets: Bucket[];
  hasOther: boolean;

  totals: {
    sales: number;
    missingCost: number; // sales in range with no card cost
    profit: number;
    revenue: number; // Σ net_cash of sales + refunds in range
    priorRevenue: number | null; // null for 1Y / ALL
    revenueSpark: number[]; // cumulative by bucket
    profitSpark: number[];
  };

  cumulative: {
    granularity: "day" | "week";
    points: { day: string; value: number }[];
  };
  /** Ledger rows by day for click-to-pin; 30D/90D only (null for 1Y/ALL). */
  entriesByDay: EntriesByDay | null;

  flip: Flip | null; // best flip this month
  bestFlipAllTime: Flip | null;

  inventory: InventorySummary | null;

  vs: Record<"sports" | "riftbound", { profit: number; sales: number }>;

  pitch: {
    cardCosts: number;
    ebayFees: number;
    shipping: number;
    tableFees: number;
    other: number;
  };

  daysToSell: { median: number; avg: number; within7: number; n: number } | null;
  sellThrough: { sold: number; listed: number; ratio: number } | null;

  announcement: string;
};

function flipOf(s: SaleProfit): Flip {
  const c = s.cards[0];
  const t = s.txn;
  return {
    title: c.title,
    grader: c.grader,
    grade: c.grade,
    day: s.day,
    platform: t.platform,
    cost: c.acquisition_cost ?? 0,
    sold: t.item_amount + t.shipping_charged,
    fees: t.platform_fees,
    shipping: t.shipping_cost + t.other_cost,
    profit: s.profit,
    pctOfCost: c.acquisition_cost ? s.profit / c.acquisition_cost : null,
    daysToSell: c.acquired_on && c.exited_on ? daysBetween(c.acquired_on, c.exited_on) : null,
  };
}

/** Single card, known cost, made money. Largest profit wins; earliest on a tie. */
function bestFlip(sales: SaleProfit[]): Flip | null {
  let best: SaleProfit | null = null;
  for (const s of sales) {
    if (s.cards.length !== 1 || s.missingCost || s.profit <= 0) continue;
    if (!best || s.profit > best.profit) best = s;
  }
  return best ? flipOf(best) : null;
}

function cumulativeBy(values: number[]): number[] {
  let run = 0;
  return values.map((v) => (run += v));
}

export function buildScoreboard(input: {
  txns: Txn[];
  cards: Card[];
  inventory: InventorySummary | null;
  today: string;
  range: RangeKey;
}): Scoreboard {
  const { txns, cards, inventory, today, range } = input;
  const sales = saleProfits(txns, cards);
  const events = profitEvents(txns, sales);
  const saleDays = sales.map((s) => s.day).sort();
  const firstSaleDay = saleDays[0] ?? null;
  const lastSaleDay = saleDays.at(-1) ?? null;

  // ---- hero: current calendar month in PT, never range-scoped
  const mStart = monthStart(today);
  const prevStart = addMonths(mStart, -1);
  const prevEnd = addDays(mStart, -1);
  const monthSales = sales.filter((s) => inSpan(s.day, mStart, today));
  const mtd = netProfit(events, mStart, today);
  const prevTotal = netProfit(events, prevStart, prevEnd);
  const allTime = netProfit(events);
  const cash = netCash(txns);
  const dailyProfit = new Map<string, number>();
  for (const e of events) dailyProfit.set(e.day, (dailyProfit.get(e.day) ?? 0) + e.profit);
  const spark = Array.from({ length: 30 }, (_, i) => dailyProfit.get(addDays(today, i - 29)) ?? 0);

  // ---- range
  const w = rangeWindow(range, today, events[0]?.day ?? null);
  const spans = bucketSpans(w);
  const buckets: Bucket[] = spans.map((sp) => {
    const b: Bucket = { ...sp, ebay: 0, shows: 0, other: 0, profit: 0, sales: 0 };
    for (const e of events) {
      if (!inSpan(e.day, sp.start, sp.end)) continue;
      b[e.channel as Channel] += e.profit;
      b.profit += e.profit;
      if (e.isSale) b.sales += 1;
    }
    return b;
  });
  const rangeSales = sales.filter((s) => inSpan(s.day, w.start, w.end));
  const revenueIn = (start: string, end: string) =>
    txns.reduce(
      (sum, t) => ((t.type === "sale" || t.type === "refund") && inSpan(t.occurred_on, start, end) ? sum + t.net_cash : sum),
      0,
    );
  // A prior period only counts if the ledger covers all of it; otherwise the
  // "vs prior" % compares against days before the first entry (gap, not $0).
  const firstTxnDay = txns.reduce<string | null>((m, t) => (m == null || t.occurred_on < m ? t.occurred_on : m), null);
  const priorSpan = priorWindow(range, w);
  const prior = priorSpan && firstTxnDay != null && priorSpan.start >= firstTxnDay ? priorSpan : null;
  const revenueByBucket = spans.map((sp) => revenueIn(sp.start, sp.end));

  // ---- cumulative P&L, reset to $0 at range start
  const points: { day: string; value: number }[] = [];
  let run = 0;
  if (w.mode === "week") {
    for (let d = w.start; d <= w.end; d = addDays(d, 1)) {
      run += dailyProfit.get(d) ?? 0;
      points.push({ day: d, value: run });
    }
  } else {
    points.push({ day: w.start, value: 0 });
    let d = w.start;
    while (d <= w.end) {
      const weekEnd = addDays(mondayOf(d), 6);
      const end = weekEnd < w.end ? weekEnd : w.end;
      run += netProfit(events, d, end);
      points.push({ day: end, value: run });
      d = addDays(end, 1);
    }
    // The leading $0 point already stands for the start day; a sale on that
    // day lands in the first week-end point.
  }

  let entriesByDay: EntriesByDay | null = null;
  if (w.mode === "week") {
    entriesByDay = {};
    for (const t of txns) {
      if (!inSpan(t.occurred_on, w.start, w.end)) continue;
      (entriesByDay[t.occurred_on] ??= []).push({
        id: t.id,
        type: t.type,
        description: t.description,
        net_cash: t.net_cash / 100,
      });
    }
  }

  // ---- visitor vs home (sale profit only: refunds and expenses carry no card)
  const vs = { sports: { profit: 0, sales: 0 }, riftbound: { profit: 0, sales: 0 } };
  for (const s of rangeSales) {
    const side = sideOf(s.category);
    if (!side) continue;
    vs[side].profit += s.profit;
    vs[side].sales += 1;
  }

  // ---- pitch count
  const pitch = { cardCosts: 0, ebayFees: 0, shipping: 0, tableFees: 0, other: 0 };
  for (const s of rangeSales) {
    pitch.cardCosts += s.cogs;
    pitch.shipping += s.txn.shipping_cost;
    if (s.txn.platform === "ebay") pitch.ebayFees += s.txn.platform_fees;
    else pitch.other += s.txn.platform_fees;
    pitch.other += s.txn.other_cost;
  }
  for (const t of txns) {
    if (t.type !== "expense" || !inSpan(t.occurred_on, w.start, w.end)) continue;
    if (isTableFee(t)) pitch.tableFees += -t.net_cash;
    else pitch.other += -t.net_cash;
  }

  // ---- days to sell / sell-through (tracked business cards only)
  const forSale = cards.filter((c) => c.category !== "pc");
  const soldInRange = forSale.filter(
    (c) => c.status === "sold" && c.exited_on != null && inSpan(c.exited_on, w.start, w.end),
  );
  const durations = soldInRange
    .filter((c) => c.acquired_on != null)
    .map((c) => daysBetween(c.acquired_on!, c.exited_on!));
  const daysToSell = durations.length
    ? {
        median: median(durations),
        avg: durations.reduce((a, b) => a + b, 0) / durations.length,
        within7: durations.filter((d) => d <= 7).length / durations.length,
        n: durations.length,
      }
    : null;
  const listed = forSale.filter((c) => c.status === "listed").length;
  // With nothing listed there is nothing to compare against: 3 sold of 3
  // "listed" would read as 100% sell-through, which is not a real rate.
  const sellThrough = listed > 0
    ? { sold: soldInRange.length, listed: soldInRange.length + listed, ratio: soldInRange.length / (soldInRange.length + listed) }
    : null;

  const unit = w.mode;
  const n = buckets.length;
  const announcement = `Showing ${rangeSpoken(range)}: ${n} ${unit}${n === 1 ? "" : "s"}, ${rangeSales.length} sale${rangeSales.length === 1 ? "" : "s"}.`;

  return {
    today,
    range,
    hasAnySales: sales.length > 0,
    firstSaleDay,
    lastSaleDay,
    hero: {
      monthName: monthName(today),
      prevAbbr: monthAbbr(prevStart),
      dayOfMonth: Number(today.slice(8, 10)),
      mtd,
      mtdSales: monthSales.length,
      missingCount: monthSales.filter((s) => s.missingCost).length,
      vsPrevPct: prevTotal !== 0 ? (mtd - prevTotal) / Math.abs(prevTotal) : null,
      allTime,
      netCash: cash,
      stock: allTime - cash,
      spark,
    },
    window: w,
    buckets,
    hasOther: buckets.some((b) => b.other !== 0),
    totals: {
      sales: rangeSales.length,
      missingCost: rangeSales.filter((s) => s.missingCost).length,
      profit: netProfit(events, w.start, w.end),
      revenue: revenueIn(w.start, w.end),
      priorRevenue: prior ? revenueIn(prior.start, prior.end) : null,
      revenueSpark: cumulativeBy(revenueByBucket),
      profitSpark: cumulativeBy(buckets.map((b) => b.profit)),
    },
    cumulative: { granularity: w.mode === "week" ? "day" : "week", points },
    entriesByDay,
    flip: bestFlip(monthSales),
    bestFlipAllTime: bestFlip(sales),
    inventory,
    vs,
    pitch,
    daysToSell,
    sellThrough,
    announcement,
  };
}
