// Port of importers/parse_ebay.py — the CLI stays the tested reference.
// Turns a raw eBay Seller Hub transaction report into ledger rows plus the
// orphan shipping labels the loader must attach to a prior month's order.

import { parseCsvRows } from "@/lib/csv";

const IGNORED_TYPES = new Set([
  "payout",
  "secondary payout",
  "transfer",
  "charge",
  "hold",
  "reserve",
]);

const FEE_COLUMNS = [
  "Final Value Fee - fixed",
  "Final Value Fee - variable",
  "Regulatory operating fee",
  "International fee",
  "Deposit processing fee",
  'Very high "item not as described" fee',
  "Below standard performance fee",
];

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function clean(s: string | undefined): string {
  const t = (s ?? "").trim();
  return t === "--" ? "" : t;
}

function money(s: string | undefined): number {
  let t = (s ?? "").replace(/--/g, "").replace(/\$/g, "").replace(/,/g, "").trim();
  if (!t) return 0;
  const neg = t.startsWith("(") && t.endsWith(")");
  if (neg) t = t.slice(1, -1);
  const n = Number(t);
  if (Number.isNaN(n)) return 0;
  return neg ? -n : n;
}

// "Aug 31, 2026" | "Aug-31-2026" | "2026-08-31" -> "2026-08-31"
export function parseDate(s: string): string {
  const t = clean(s);
  let m = /^([A-Za-z]{3})[ -](\d{1,2}),? ?[ -]?(\d{4})$/.exec(t);
  if (m) {
    const mm = MONTHS[m[1].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${m[2].padStart(2, "0")}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return t;
  throw new Error(`unparseable date: ${t || "(empty)"}`);
}

const TRACKING_RE = /Tracking no\.\s*(\S+)/;
const SERVICE_RE = /Tracking no\.\s*\S+\s+(.*?)\s*$/;

export type EbayRow = {
  occurred_on: string;
  type: "sale" | "refund";
  platform: "ebay";
  description: string;
  qty: number;
  item_amount: number;
  shipping_charged: number;
  sales_tax_collected: number;
  platform_fees: number;
  shipping_cost: number;
  other_cost: number;
  source_ref: string | null;
  order_ref: string;
  item_number: string | null;
  custom_label: string | null;
  buyer_username: string | null;
  buyer_name: string | null;
  ship_to_city: string | null;
  ship_to_state: string | null;
  ship_to_zip: string | null;
  ship_to_country: string | null;
  shipping_service: string | null;
  tracking_number: string | null;
  fees_estimated: false;
};

export type OrphanLabel = {
  order_ref: string;
  amount: number;
  tracking_number: string | null;
  shipping_service: string | null;
};

export type ParsedReport = {
  rows: EbayRow[];
  ignored: Record<string, number>;
  orphanLabels: OrphanLabel[];
  totals: {
    grossBuyerPayments: number; // item + shipping + tax on sales — the 1099-K number
    orderProceedsExTax: number; // item + shipping
    fees: number; // negative
    labels: number; // negative
    netCash: number;
  };
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function parseEbayReport(text: string): ParsedReport {
  const all = parseCsvRows(text);
  const hi = all.findIndex(
    (r) => r.length > 0 && r[0].trim() === "Transaction creation date",
  );
  if (hi === -1) {
    throw new Error(
      "no header row found — is this a Seller Hub transaction report?",
    );
  }
  const header = all[hi];
  const records: Record<string, string>[] = [];
  for (const r of all.slice(hi + 1)) {
    if (r.length < header.length || !clean(r[0])) continue;
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = r[i] ?? ""));
    records.push(o);
  }

  const orders: Record<string, string>[] = [];
  const labels = new Map<string, number>();
  const labelMeta = new Map<
    string,
    { tracking_number: string | null; shipping_service: string | null }
  >();
  const ignored: Record<string, number> = {};

  for (const rec of records) {
    const typ = clean(rec["Type"]).toLowerCase();
    if (IGNORED_TYPES.has(typ)) {
      ignored[typ] = (ignored[typ] ?? 0) + 1;
      continue;
    }
    if (typ === "shipping label") {
      const on = clean(rec["Order number"]);
      labels.set(on, (labels.get(on) ?? 0) + Math.abs(money(rec["Net amount"])));
      const desc = clean(rec["Description"]);
      const tm = TRACKING_RE.exec(desc);
      const sm = SERVICE_RE.exec(desc);
      labelMeta.set(on, {
        tracking_number: tm ? tm[1] : null,
        shipping_service: (sm ? sm[1] : desc) || null,
      });
    } else if (typ === "order" || typ === "refund") {
      orders.push(rec);
    } else {
      ignored[typ] = (ignored[typ] ?? 0) + 1;
    }
  }

  const byOrder = new Map<string, Record<string, string>[]>();
  for (const rec of orders) {
    const on = clean(rec["Order number"]);
    (byOrder.get(on) ?? byOrder.set(on, []).get(on)!).push(rec);
  }

  const rows: EbayRow[] = [];
  for (const [orderNo, items] of byOrder) {
    const subtotals = items.map((i) => money(i["Item subtotal"]));
    const totalSub = subtotals.reduce((a, b) => a + b, 0) || 1;
    const labelCost = labels.get(orderNo) ?? 0;
    const meta = labelMeta.get(orderNo) ?? {
      tracking_number: null,
      shipping_service: null,
    };

    items.forEach((rec, i) => {
      const share = subtotals[i] / totalSub;
      const isRefund = clean(rec["Type"]).toLowerCase() === "refund";
      const fees = FEE_COLUMNS.reduce(
        (t, c) => t + Math.abs(money(rec[c])),
        0,
      );
      rows.push({
        occurred_on: parseDate(rec["Transaction creation date"]),
        type: isRefund ? "refund" : "sale",
        platform: "ebay",
        description: clean(rec["Item title"]),
        qty: parseInt(clean(rec["Quantity"]) || "1", 10),
        item_amount: r2(money(rec["Item subtotal"])),
        shipping_charged: r2(money(rec["Shipping and handling"])),
        sales_tax_collected: r2(
          money(rec["eBay collected tax"]) + money(rec["Seller collected tax"]),
        ),
        platform_fees: r2(fees),
        shipping_cost: r2(labelCost * share),
        other_cost: 0,
        source_ref: clean(rec["Transaction ID"]) || null,
        order_ref: orderNo,
        item_number: clean(rec["Item ID"]) || null,
        custom_label: clean(rec["Custom label"]) || null,
        buyer_username: clean(rec["Buyer username"]) || null,
        buyer_name: clean(rec["Buyer name"]) || null,
        ship_to_city: clean(rec["Ship to city"]) || null,
        ship_to_state: clean(rec["Ship to province/region/state"]) || null,
        ship_to_zip: clean(rec["Ship to zip"]) || null,
        ship_to_country: clean(rec["Ship to country"]) || null,
        shipping_service: meta.shipping_service,
        tracking_number: meta.tracking_number,
        fees_estimated: false,
      });
    });
  }

  rows.sort((a, b) =>
    a.occurred_on === b.occurred_on
      ? (a.source_ref ?? "").localeCompare(b.source_ref ?? "")
      : a.occurred_on.localeCompare(b.occurred_on),
  );

  const orphanLabels: OrphanLabel[] = [];
  for (const [on, amt] of labels) {
    if (byOrder.has(on)) continue;
    const m = labelMeta.get(on);
    orphanLabels.push({
      order_ref: on,
      amount: r2(amt),
      tracking_number: m?.tracking_number ?? null,
      shipping_service: m?.shipping_service ?? null,
    });
  }

  const sales = rows.filter((r) => r.type === "sale");
  const totals = {
    grossBuyerPayments: r2(
      sales.reduce(
        (t, r) => t + r.item_amount + r.shipping_charged + r.sales_tax_collected,
        0,
      ),
    ),
    orderProceedsExTax: r2(
      rows.reduce((t, r) => t + r.item_amount + r.shipping_charged, 0),
    ),
    fees: r2(-rows.reduce((t, r) => t + r.platform_fees, 0)),
    labels: r2(-rows.reduce((t, r) => t + r.shipping_cost, 0)),
    netCash: r2(
      rows.reduce((t, r) => {
        const v =
          r.item_amount +
          r.shipping_charged -
          r.platform_fees -
          r.shipping_cost -
          r.other_cost;
        return t + (r.type === "refund" ? -v : v);
      }, 0),
    ),
  };

  return { rows, ignored, orphanLabels, totals };
}
