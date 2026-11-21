import type { NextRequest } from "next/server";
import { ebayContext } from "@/lib/ebay-api/context";
import { fetchOrders } from "@/lib/ebay-api/fulfillment";
import { apiRoute, intParam } from "@/lib/ebay-api/respond";

// GET /api/ebay/sales?days=30   (1-365) — orders created in the window, from the Fulfillment API.
// Informational: the ledger's eBay figures come from the transaction report.
export const maxDuration = 60;

export const GET = apiRoute(async (req: NextRequest) => {
  const days = intParam(req.nextUrl.searchParams, "days", 30, 1, 365);
  const since = new Date(Date.now() - days * 86_400_000);
  const ctx = ebayContext();
  const orders = await fetchOrders(ctx.userRest, { field: "creationdate", since });
  return {
    days,
    since: since.toISOString(),
    count: orders.length,
    orders: orders.map((o) => ({
      order_id: o.orderId,
      created_at: o.createdAt,
      buyer_username: o.buyerUsername,
      payment_status: o.paymentStatus,
      fulfillment_status: o.fulfillmentStatus,
      cancel_state: o.cancelState,
      currency: o.currency,
      totals: {
        subtotal: o.totals.subtotal,
        delivery: o.totals.delivery,
        tax: o.totals.tax,
        total: o.totals.total,
        total_due_seller: o.totals.totalDueSeller,
        marketplace_fee: o.totals.marketplaceFee,
      },
      line_items: o.lineItems.map((l) => ({
        line_item_id: l.lineItemId,
        title: l.title,
        sku: l.sku,
        legacy_item_id: l.legacyItemId,
        quantity: l.quantity,
        price: l.price,
        ebay_collected_tax: l.ebayCollectedTax,
        refunded: l.refunded,
      })),
    })),
    note: "marketplace_fee is eBay's own order-level figure when the API returns it (else null); it is never estimated.",
  };
});
