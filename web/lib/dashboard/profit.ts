// Cost-based profit, spec section 10.1. Pure functions over ledger rows that
// have already been converted to integer cents. schema/026_profit_views.sql
// defines the same numbers as SQL views (sale_profit, profit_daily); the page
// computes them here so it works whether or not 026 has been applied.
//
//   sale profit   = sale.net_cash − Σ acquisition_cost of cards linked by
//                   cards.sale_transaction_id (a null cost counts as 0 and
//                   marks the sale "missing cost")
//   refund        = its own (negative) net_cash; no cost is credited back
//   expense       = its own (negative) net_cash; expenses reduce profit
//   purchases     = never profit; cost reaches profit only through COGS
//   net profit    = Σ sale profit + Σ refund net_cash + Σ expense net_cash
//
// Trades are not profit events (open question 13.1): a traded-away card has no
// sale row, so nothing is recognized until something is sold for cash.

export type TxnType = "purchase" | "sale" | "refund" | "expense";

export type Txn = {
  id: number;
  occurred_on: string;
  type: TxnType;
  platform: string;
  description: string;
  net_cash: number; // cents, generated column
  item_amount: number;
  shipping_charged: number;
  platform_fees: number;
  shipping_cost: number;
  other_cost: number;
  show_id: number | null;
  deal_id: number | null;
};

export type CardStatus = "held" | "listed" | "sold" | "traded";
export type CardCategory = "pc" | "business" | "riftbound" | "sealed";

export type Card = {
  id: number;
  title: string;
  player: string | null;
  year: string | null;
  set_name: string | null;
  parallel: string | null;
  grader: string | null;
  grade: string | null;
  status: CardStatus;
  category: CardCategory;
  acquisition_cost: number | null; // cents
  acquired_on: string | null;
  exited_on: string | null;
  is_opening_stock: boolean;
  sale_transaction_id: number | null;
};

export type Channel = "ebay" | "shows" | "other";

/** 10.1: eBay; card_show / local / lcs = Shows; everything else = other. */
export function channelOf(platform: string): Channel {
  if (platform === "ebay") return "ebay";
  if (platform === "card_show" || platform === "local" || platform === "lcs") return "shows";
  return "other";
}

export type Side = "sports" | "riftbound";

/**
 * Visitor vs home split. riftbound = Riftbound; business and sealed = Sports
 * (sealed placement is open question 13.6); pc is excluded (null); a sale with
 * no linked card is Sports.
 */
export function sideOf(category: string | null): Side | null {
  if (category == null) return "sports";
  if (category === "riftbound") return "riftbound";
  if (category === "pc") return null;
  return "sports";
}

export type SaleProfit = {
  txn: Txn;
  day: string;
  channel: Channel;
  revenue: number; // net_cash
  cogs: number;
  profit: number;
  missingCost: boolean;
  /** min(category) over linked cards, mirroring the 026 view; null when unlinked. */
  category: CardCategory | null;
  cards: Card[];
};

export function saleProfits(txns: Txn[], cards: Card[]): SaleProfit[] {
  const bySale = new Map<number, Card[]>();
  for (const c of cards) {
    if (c.sale_transaction_id == null) continue;
    const list = bySale.get(c.sale_transaction_id) ?? [];
    list.push(c);
    bySale.set(c.sale_transaction_id, list);
  }
  return txns
    .filter((t) => t.type === "sale")
    .map((t) => {
      const linked = bySale.get(t.id) ?? [];
      const cogs = linked.reduce((s, c) => s + (c.acquisition_cost ?? 0), 0);
      const missingCost = linked.length === 0 || linked.some((c) => c.acquisition_cost == null);
      const category = linked.length
        ? ([...linked.map((c) => c.category)].sort()[0] as CardCategory)
        : null;
      return {
        txn: t,
        day: t.occurred_on,
        channel: channelOf(t.platform),
        revenue: t.net_cash,
        cogs,
        profit: t.net_cash - cogs,
        missingCost,
        category,
        cards: linked,
      };
    });
}

/** One profit-affecting event: a sale (at its profit), a refund or an expense (at net_cash). */
export type ProfitEvent = {
  day: string;
  channel: Channel;
  profit: number;
  isSale: boolean;
  missingCost: boolean;
};

export function profitEvents(txns: Txn[], sales: SaleProfit[]): ProfitEvent[] {
  const out: ProfitEvent[] = sales.map((s) => ({
    day: s.day,
    channel: s.channel,
    profit: s.profit,
    isSale: true,
    missingCost: s.missingCost,
  }));
  for (const t of txns) {
    if (t.type === "refund" || t.type === "expense") {
      out.push({
        day: t.occurred_on,
        channel: channelOf(t.platform),
        profit: t.net_cash,
        isSale: false,
        missingCost: false,
      });
    }
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export const inSpan = (day: string, start: string, end: string) => day >= start && day <= end;

export function netProfit(events: ProfitEvent[], start = "0000-01-01", end = "9999-12-31"): number {
  return events.reduce((s, e) => (inSpan(e.day, start, end) ? s + e.profit : s), 0);
}

export function netCash(txns: Txn[]): number {
  return txns.reduce((s, t) => s + t.net_cash, 0);
}

/**
 * Table fee heuristic (10.2, gap 4): there is no table-fee expense category,
 * so a show-level expense (show_id set, no deal) whose description says
 * table or booth is the best available signal. Everything else is Other.
 */
export function isTableFee(t: Txn): boolean {
  return (
    t.type === "expense" &&
    t.show_id != null &&
    t.deal_id == null &&
    /\b(table|booth)\b/i.test(t.description)
  );
}

export function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
