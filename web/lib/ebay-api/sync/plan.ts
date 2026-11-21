import type { SaleOrder } from "../fulfillment";
import {
  lineKey, TERMINAL,
  type CardRef, type Decision, type LedgerSale, type MatchType, type OrderLine, type Snapshot, type SyncedLine,
} from "./types";

// ============================================================================
// Sold-order sync: PURE planning. No I/O. Every rule lives here.
// ============================================================================
//
// THE SYNC NEVER WRITES A LEDGER CASH ROW. The Seller Hub transaction report
// importers (importers/load_ebay.py, web/app/(app)/data/ebay) remain the only
// source of eBay sale rows, because only the report carries real fees and
// label costs (CLAUDE.md: never invent fees). This sync's job is to link a
// sold eBay line to the physical card and close it against the sale row the
// importer wrote. It therefore cannot double-count: there is nothing it
// inserts into `transactions` at all.
//
// SHARED KEY with the importers:
//   transactions.order_ref   = Fulfillment orderId      (eBay "Order number")
//   transactions.item_number = Fulfillment legacyItemId (eBay "Item ID")
// Not lineItemId vs. the report's "Transaction ID" — that equivalence is not
// verified, so nothing depends on it.
//
// Per line, in order:
//   1. Already synced?  terminal -> noop (or flag a refund-after-close);
//                       pending_ledger -> keep its card, go to step 6.
//   2. Cancelled / fully refunded / line refunded -> ignored.
//      Not yet paid -> defer (no row; seen again when the order changes).
//   3. Find the importer's sale row for this line (order_ref + item_number).
//      Several -> needs_review. Already linked to a card -> already_closed.
//   4. quantity != 1 -> needs_review (a card row is one physical card).
//   5. Identify the card, first hit wins:
//        cards.sku = line SKU (eBay Custom label; same rule as the importer)
//        ebay_listings link by listing id / sku (written by the CDP import)
//        find_cards(title) ONLY if exactly one candidate survives; candidates
//        whose own sku contradicts the line's sku are dropped first.
//      None -> needs_review (no_card_match; normal for bulk commons).
//      Several -> needs_review (ambiguous), candidates listed. Never guessed.
//   6. Card already out of inventory: against this sale row -> already_closed;
//      otherwise needs_review.
//   7. No sale row yet -> pending_ledger (card id kept; retried every run).
//   8. Otherwise -> close (ebay_close_card_for_sale, atomic, re-checks all of it).
// ============================================================================

const OUT_OF_INVENTORY = new Set(["sold", "traded"]);

export function linesFromOrders(orders: SaleOrder[]): OrderLine[] {
  return orders.flatMap((o) =>
    o.lineItems.map((l) => ({
      orderId: o.orderId,
      lineItemId: l.lineItemId,
      legacyItemId: l.legacyItemId,
      sku: l.sku,
      title: l.title,
      quantity: l.quantity,
      price: l.price,
      soldAt: o.createdAt,
      paymentStatus: o.paymentStatus,
      cancelState: o.cancelState,
      refunded: l.refunded,
      orderLineCount: o.lineItems.length,
      live: true,
    })),
  );
}

/** A stored pending row whose order fell outside this run's fetch window. */
export function lineFromStored(s: SyncedLine): OrderLine {
  return {
    orderId: s.orderId,
    lineItemId: s.lineItemId,
    legacyItemId: s.legacyItemId,
    sku: s.sku,
    title: s.title ?? "",
    quantity: s.quantity,
    price: s.price,
    soldAt: s.soldAt ?? "",
    paymentStatus: null,
    cancelState: null,
    refunded: false,
    orderLineCount: s.orderLineCount,
    live: false,
  };
}

function goneReason(l: OrderLine): string | null {
  if (!l.live) return null;
  if (l.cancelState === "CANCELED") return "order_cancelled";
  if (l.paymentStatus === "FULLY_REFUNDED") return "order_fully_refunded";
  if (l.refunded) return "line_refunded";
  return null;
}

type LedgerHit = { row: LedgerSale } | { none: true } | { ambiguous: LedgerSale[] };

export function findLedgerRow(l: OrderLine, snap: Snapshot): LedgerHit {
  const rows = snap.ledgerByOrder.get(l.orderId) ?? [];
  const byItem = l.legacyItemId ? rows.filter((r) => r.itemNumber === l.legacyItemId) : [];
  if (byItem.length === 1) return { row: byItem[0] };
  if (byItem.length > 1) return { ambiguous: byItem };
  // Single-line order and a single sale row, but one side lacks an item number.
  if (rows.length === 1 && l.orderLineCount === 1 && (!rows[0].itemNumber || !l.legacyItemId)) return { row: rows[0] };
  return { none: true };
}

function resolveCard(l: OrderLine, snap: Snapshot):
  | { card: CardRef; matchType: MatchType; score?: number }
  | { need_fuzzy: true }
  | { none: true }
  | { ambiguous: { id: number; title: string; score: number }[] } {
  if (l.sku) {
    const c = snap.cardsBySku.get(l.sku);
    if (c) return { card: c, matchType: "sku" };
  }
  const linked = (l.legacyItemId && snap.listingLinks.get(`L:${l.legacyItemId}`)) || (l.sku && snap.listingLinks.get(`S:${l.sku}`));
  if (linked) {
    const c = snap.cardsById.get(linked);
    if (c) return { card: c, matchType: "listing" };
  }
  const key = lineKey(l.orderId, l.lineItemId);
  if (!snap.fuzzy.has(key)) return { need_fuzzy: true };
  const candidates = snap.fuzzy.get(key)!.filter((c) => !(l.sku && c.sku && c.sku !== l.sku));
  if (candidates.length === 1) {
    const c = candidates[0];
    return {
      card: snap.cardsById.get(c.id) ?? { id: c.id, sku: c.sku, title: c.title, status: "held", saleTransactionId: null },
      matchType: c.matchType,
      score: c.score,
    };
  }
  if (!candidates.length) return { none: true };
  return { ambiguous: candidates.map((c) => ({ id: c.id, title: c.title, score: c.score })) };
}

export function planLine(l: OrderLine, snap: Snapshot): Decision {
  const existing = snap.synced.get(lineKey(l.orderId, l.lineItemId));
  const gone = goneReason(l);

  // 1. already synced
  if (existing && TERMINAL.has(existing.status)) {
    if (gone && (existing.status === "closed" || existing.status === "already_closed")) {
      return {
        kind: "record", line: l, status: "needs_review",
        reason: `refunded_after_close (${gone}): card ${existing.cardId} may be back in hand`,
        cardId: existing.cardId, transactionId: existing.transactionId, matchType: existing.matchType,
      };
    }
    return { kind: "noop", line: l, reason: `already ${existing.status}` };
  }

  // 2. cancelled / refunded / unpaid
  if (gone) return { kind: "record", line: l, status: "ignored", reason: gone, cardId: existing?.cardId ?? null };
  if (l.live && l.paymentStatus !== "PAID" && l.paymentStatus !== "PARTIALLY_REFUNDED") {
    return { kind: "defer", line: l, reason: `awaiting payment (${l.paymentStatus ?? "unknown"})` };
  }

  // 3. the importer's sale row
  const ledger = findLedgerRow(l, snap);
  if ("ambiguous" in ledger) {
    return {
      kind: "record", line: l, status: "needs_review",
      reason: `ambiguous_ledger_rows: transactions ${ledger.ambiguous.map((r) => r.id).join(", ")} share order ${l.orderId} item ${l.legacyItemId}`,
      cardId: existing?.cardId ?? null,
    };
  }
  const txn = "row" in ledger ? ledger.row : null;
  if (txn?.linkedCardId) {
    if (existing?.cardId && existing.cardId !== txn.linkedCardId) {
      return {
        kind: "record", line: l, status: "needs_review",
        reason: `ledger_row_linked_to_other_card: transaction ${txn.id} is linked to card ${txn.linkedCardId}, sync matched card ${existing.cardId}`,
        cardId: existing.cardId, transactionId: txn.id, matchType: existing.matchType,
      };
    }
    return {
      kind: "record", line: l, status: "already_closed", reason: "sale row already linked to a card (report import)",
      cardId: txn.linkedCardId, transactionId: txn.id, matchType: existing?.matchType ?? "ledger",
    };
  }

  // 4 + 5. which card
  let card: CardRef;
  let matchType: MatchType;
  let score: number | null = null;
  if (existing?.status === "pending_ledger" && existing.cardId) {
    const c = snap.cardsById.get(existing.cardId);
    if (!c) {
      return { kind: "record", line: l, status: "needs_review", reason: `card ${existing.cardId} no longer exists`, transactionId: txn?.id ?? null };
    }
    card = c;
    matchType = existing.matchType ?? "sku";
  } else {
    if (l.quantity !== 1) {
      return { kind: "record", line: l, status: "needs_review", reason: `multi_quantity_line: quantity ${l.quantity}`, transactionId: txn?.id ?? null };
    }
    const r = resolveCard(l, snap);
    if ("need_fuzzy" in r) return { kind: "need_fuzzy", line: l };
    if ("none" in r) {
      return { kind: "record", line: l, status: "needs_review", reason: "no_card_match: no tracked card for this SKU/listing/title", transactionId: txn?.id ?? null };
    }
    if ("ambiguous" in r) {
      return {
        kind: "record", line: l, status: "needs_review",
        reason: `ambiguous: ${r.ambiguous.length} cards match the title`, candidates: r.ambiguous, transactionId: txn?.id ?? null,
      };
    }
    card = r.card;
    matchType = r.matchType;
    score = r.score ?? null;
  }

  // 6. card already out of inventory
  if (OUT_OF_INVENTORY.has(card.status)) {
    if (txn && card.saleTransactionId === txn.id) {
      return { kind: "record", line: l, status: "already_closed", reason: "card already closed against this sale row", cardId: card.id, transactionId: txn.id, matchType };
    }
    return {
      kind: "record", line: l, status: "needs_review",
      reason: `card_already_left_inventory: card ${card.id} is ${card.status}${card.saleTransactionId ? ` (transaction ${card.saleTransactionId})` : ""}`,
      cardId: card.id, transactionId: txn?.id ?? null, matchType,
    };
  }

  // 7. waiting for the transaction report
  if (!txn) {
    return {
      kind: "record", line: l, status: "pending_ledger",
      reason: "card matched; waiting for the transaction report import to create the sale row",
      cardId: card.id, matchType, score,
    };
  }

  // 8. close
  return { kind: "close", line: l, cardId: card.id, transactionId: txn.id, matchType, score };
}

/** Plans every line. Fresh lines win over a stored copy of the same line. */
export function planSync(fresh: OrderLine[], pending: SyncedLine[], snap: Snapshot): Decision[] {
  const seen = new Set(fresh.map((l) => lineKey(l.orderId, l.lineItemId)));
  const lines = [...fresh, ...pending.filter((p) => !seen.has(lineKey(p.orderId, p.lineItemId))).map(lineFromStored)];
  return lines.map((l) => planLine(l, snap));
}
