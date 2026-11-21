import { ApiError } from "./errors";
import type { Amount, EbayRest } from "./http";

// Sell Fulfillment API: GET /sell/fulfillment/v1/order, normalised.
//
// The order number here (`orderId`, e.g. "07-15112-65577") is the same
// "Order number" the Seller Hub transaction report carries, which the ledger
// importers store as transactions.order_ref. `legacyItemId` is the listing
// id, stored as transactions.item_number. Those two are the shared key the
// sync uses (see sync/plan.ts and docs/DECISIONS.md).
//
// MONEY: these figures are informational. Nothing here is written to the
// ledger — fees and labels arrive only via the transaction report. eBay's
// order-level `totalMarketplaceFee` is passed through when present and
// labelled as such; it is never estimated and never split per line.

export interface SaleLine {
  lineItemId: string;
  legacyItemId: string | null;
  sku: string | null;
  title: string;
  quantity: number;
  /** lineItemCost: item price x quantity, before shipping and tax. */
  price: string | null;
  /** Line total as eBay reports it. */
  total: string | null;
  ebayCollectedTax: string | null;
  refunded: boolean;
  refundTotal: string | null;
  fulfillmentStatus: string | null;
}

export interface SaleOrder {
  orderId: string;
  legacyOrderId: string | null;
  createdAt: string;
  lastModifiedAt: string | null;
  buyerUsername: string | null;
  paymentStatus: string | null;      // PAID | PENDING | FAILED | FULLY_REFUNDED | PARTIALLY_REFUNDED
  fulfillmentStatus: string | null;  // NOT_STARTED | IN_PROGRESS | FULFILLED
  cancelState: string | null;        // NONE_REQUESTED | IN_PROGRESS | CANCELED
  currency: string;
  totals: {
    subtotal: string | null;
    delivery: string | null;
    tax: string | null;
    total: string | null;
    /** eBay's order-level fee figure if the API returned one. Informational only. */
    marketplaceFee: string | null;
    totalDueSeller: string | null;
  };
  lineItems: SaleLine[];
}

interface RawLine {
  lineItemId: string;
  legacyItemId?: string;
  sku?: string;
  title?: string;
  quantity?: number;
  lineItemCost?: Amount;
  total?: Amount;
  ebayCollectAndRemitTaxes?: { amount?: Amount }[];
  refunds?: { amount?: Amount }[];
  lineItemFulfillmentStatus?: string;
}

export interface RawOrder {
  orderId: string;
  legacyOrderId?: string;
  creationDate: string;
  lastModifiedDate?: string;
  buyer?: { username?: string };
  orderPaymentStatus?: string;
  orderFulfillmentStatus?: string;
  cancelStatus?: { cancelState?: string };
  pricingSummary?: { priceSubtotal?: Amount; deliveryCost?: Amount; tax?: Amount; total?: Amount };
  totalMarketplaceFee?: Amount;
  paymentSummary?: { totalDueSeller?: Amount };
  lineItems?: RawLine[];
}

/** Add decimal-string amounts exactly (in cents). */
export function sumAmounts(xs: (Amount | undefined)[]): string | null {
  const vals = xs.filter((x): x is Amount => Boolean(x?.value));
  if (!vals.length) return null;
  const cents = vals.reduce((s, a) => s + Math.round(Number(a.value) * 100), 0);
  return (cents / 100).toFixed(2);
}

export function normaliseOrder(o: RawOrder): SaleOrder {
  return {
    orderId: o.orderId,
    legacyOrderId: o.legacyOrderId ?? null,
    createdAt: o.creationDate,
    lastModifiedAt: o.lastModifiedDate ?? null,
    buyerUsername: o.buyer?.username ?? null,
    paymentStatus: o.orderPaymentStatus ?? null,
    fulfillmentStatus: o.orderFulfillmentStatus ?? null,
    cancelState: o.cancelStatus?.cancelState ?? null,
    currency: o.pricingSummary?.total?.currency ?? "USD",
    totals: {
      subtotal: o.pricingSummary?.priceSubtotal?.value ?? null,
      delivery: o.pricingSummary?.deliveryCost?.value ?? null,
      tax: o.pricingSummary?.tax?.value ?? null,
      total: o.pricingSummary?.total?.value ?? null,
      marketplaceFee: o.totalMarketplaceFee?.value ?? null,
      totalDueSeller: o.paymentSummary?.totalDueSeller?.value ?? null,
    },
    lineItems: (o.lineItems ?? []).map((l) => {
      const refundTotal = sumAmounts((l.refunds ?? []).map((r) => r.amount));
      return {
        lineItemId: l.lineItemId,
        legacyItemId: l.legacyItemId ?? null,
        sku: l.sku?.trim() || null,
        title: l.title ?? "",
        quantity: l.quantity ?? 1,
        price: l.lineItemCost?.value ?? null,
        total: l.total?.value ?? null,
        ebayCollectedTax: sumAmounts((l.ebayCollectAndRemitTaxes ?? []).map((t) => t.amount)),
        refunded: refundTotal !== null && Number(refundTotal) > 0,
        refundTotal,
        fulfillmentStatus: l.lineItemFulfillmentStatus ?? null,
      };
    }),
  };
}

export interface FetchOrdersOptions {
  /** creationdate for "sales in the last N days", lastmodifieddate for the sync cursor. */
  field: "creationdate" | "lastmodifieddate";
  since: Date;
  until?: Date;
  /** Hard cap so a bad cursor cannot page forever. */
  maxOrders?: number;
}

const PAGE = 200; // eBay's maximum for getOrders

export async function fetchOrders(rest: EbayRest, o: FetchOrdersOptions): Promise<SaleOrder[]> {
  const max = o.maxOrders ?? 5000;
  const range = `[${o.since.toISOString()}..${o.until ? o.until.toISOString() : ""}]`;
  const out: SaleOrder[] = [];
  for (let offset = 0; offset < max; offset += PAGE) {
    const r = await rest.call<{ orders?: RawOrder[]; total?: number }>("GET", "/sell/fulfillment/v1/order", {
      query: { filter: `${o.field}:${range}`, limit: PAGE, offset },
      context: "get orders",
    });
    const page = r?.orders ?? [];
    out.push(...page.map(normaliseOrder));
    if (page.length < PAGE || offset + PAGE >= (r?.total ?? 0)) return out;
  }
  throw new ApiError(502, "too_many_orders", `more than ${max} orders in range; narrow the window`);
}
