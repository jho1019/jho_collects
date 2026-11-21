import { ApiError } from "./errors";
import type { BrowseResult, CompQuery } from "./browse";
import type { SaleOrder } from "./fulfillment";
import { InsightsUnavailable, type SoldComp } from "./insights";
import { round2 } from "./money";

// Comps = active asking prices (Browse) + sold prices.
//
// Sold prices come from Marketplace Insights when the keyset has it. When it
// does not (the expected case), the response says so explicitly —
// `sold_comps.available: false` with the reason — and falls back to the
// seller's OWN eBay sales over the last 90 days whose titles contain every
// query word. Own sales are a thin sample; they are labelled as such, never
// presented as market data.
//
// Statistics are over item price only (shipping excluded), floats rounded to
// cents. Outliers are dropped with Tukey fences (1.5 x IQR) when
// exclude_outliers is on (default) and there are at least 4 prices.

export interface Stats {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  outliers_excluded: number;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function priceStats(prices: number[], excludeOutliers: boolean): Stats {
  let xs = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  let excluded = 0;
  if (excludeOutliers && xs.length >= 4) {
    const q1 = quantile(xs, 0.25);
    const q3 = quantile(xs, 0.75);
    const fence = 1.5 * (q3 - q1);
    const kept = xs.filter((x) => x >= q1 - fence && x <= q3 + fence);
    excluded = xs.length - kept.length;
    xs = kept;
  }
  if (!xs.length) return { count: 0, min: null, max: null, mean: null, median: null, p25: null, p75: null, outliers_excluded: excluded };
  return {
    count: xs.length,
    min: round2(xs[0]),
    max: round2(xs[xs.length - 1]),
    mean: round2(xs.reduce((s, x) => s + x, 0) / xs.length),
    median: round2(quantile(xs, 0.5)),
    p25: round2(quantile(xs, 0.25)),
    p75: round2(quantile(xs, 0.75)),
    outliers_excluded: excluded,
  };
}

const toNum = (s: string | null) => (s === null ? NaN : Number(s));

/** Lower-case words of 2+ chars (or any digit run), for title matching. */
export function queryWords(q: CompQuery): string[] {
  const parts = [q.q, q.grader ?? "", q.grade ?? ""].join(" ").toLowerCase().split(/[^a-z0-9.]+/);
  return [...new Set(parts.map((w) => w.replace(/^\.+|\.+$/g, "")).filter((w) => w.length >= 2 || /\d/.test(w)))];
}

export function titleMatches(title: string, words: string[]): boolean {
  const t = ` ${title.toLowerCase().replace(/[^a-z0-9.]+/g, " ")} `;
  return words.every((w) => t.includes(` ${w} `));
}

export interface OwnSale {
  order_id: string;
  sold_at: string;
  title: string;
  sku: string | null;
  quantity: number;
  unit_price: string | null;
}

export function matchOwnSales(orders: SaleOrder[], q: CompQuery): OwnSale[] {
  const words = queryWords(q);
  const out: OwnSale[] = [];
  for (const o of orders) {
    if (o.cancelState === "CANCELED" || o.paymentStatus === "FULLY_REFUNDED") continue;
    for (const l of o.lineItems) {
      if (l.refunded || !titleMatches(l.title, words)) continue;
      const unit = l.price !== null && l.quantity > 0 ? (Math.round((Number(l.price) * 100) / l.quantity) / 100).toFixed(2) : null;
      out.push({ order_id: o.orderId, sold_at: o.createdAt, title: l.title, sku: l.sku, quantity: l.quantity, unit_price: unit });
    }
  }
  return out;
}

export interface CompsDeps {
  browse: (q: CompQuery) => Promise<BrowseResult>;
  /** Throws InsightsUnavailable when there is no access. */
  sold: (q: CompQuery) => Promise<SoldComp[]>;
  /** Seller's own orders created in the last `days` days. */
  ownOrders: (days: number) => Promise<SaleOrder[]>;
}

export const OWN_SALES_DAYS = 90;

export async function getComps(deps: CompsDeps, q: CompQuery, excludeOutliers = true) {
  const active = await deps.browse(q);
  const activeStats = priceStats(active.items.map((i) => toNum(i.price)), excludeOutliers);

  let sold_comps;
  try {
    const items = await deps.sold(q);
    sold_comps = {
      available: true as const,
      source: "marketplace_insights" as const,
      stats: priceStats(items.map((i) => toNum(i.price)), excludeOutliers),
      items,
    };
  } catch (e) {
    if (!(e instanceof InsightsUnavailable) && !(e instanceof ApiError)) throw e;
    const reason = e instanceof InsightsUnavailable ? e.reason : `Marketplace Insights failed: ${e.message}`;
    let fallback;
    try {
      const own = matchOwnSales(await deps.ownOrders(OWN_SALES_DAYS), q);
      fallback = {
        source: "own_sales" as const,
        days: OWN_SALES_DAYS,
        note: "Your own eBay sales whose titles contain every query word. A small sample, not market data.",
        stats: priceStats(own.map((s) => toNum(s.unit_price)), excludeOutliers),
        items: own,
      };
    } catch (fe) {
      if (!(fe instanceof ApiError)) throw fe;
      fallback = { source: "own_sales" as const, days: OWN_SALES_DAYS, error: fe.message, stats: priceStats([], false), items: [] };
    }
    sold_comps = { available: false as const, reason, fallback };
  }

  return {
    query: { q: q.q, category_id: q.categoryId, grader: q.grader ?? null, grade: q.grade ?? null, graded: q.graded ?? null, limit: q.limit, exclude_outliers: excludeOutliers },
    active: { source: "browse" as const, total: active.total, stats: activeStats, items: active.items },
    sold_comps,
  };
}
