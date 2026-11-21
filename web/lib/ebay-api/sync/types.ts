// Shared shapes for the sold-order sync. See plan.ts for the rules and
// docs/DECISIONS.md ("The eBay API sync never writes ledger cash rows").

/**
 * Stored outcome of one (order, line item):
 *   closed          card closed and linked to the importer's sale row (by this sync)
 *   already_closed  card was already closed against that sale row (usually by the importer's SKU link)
 *   pending_ledger  card identified, but the transaction report has not been
 *                   imported yet — retried every run until the sale row appears
 *   needs_review    the sync could not decide (ambiguous, no tracked card,
 *                   conflict, refunded after close). Terminal; a human resolves it.
 *   ignored         cancelled / fully refunded before it was ever matched
 */
export type SyncStatus = "closed" | "already_closed" | "pending_ledger" | "needs_review" | "ignored";

export const TERMINAL: ReadonlySet<SyncStatus> = new Set(["closed", "already_closed", "needs_review", "ignored"]);

export type MatchType = "sku" | "listing" | "alias" | "fuzzy" | "ledger";

/** One sold line, flattened from a Fulfillment order (or rebuilt from a stored pending row). */
export interface OrderLine {
  orderId: string;
  lineItemId: string;
  legacyItemId: string | null;
  sku: string | null;
  title: string;
  quantity: number;
  /** lineItemCost as reported. Informational; never written to the ledger. */
  price: string | null;
  soldAt: string;
  paymentStatus: string | null;
  cancelState: string | null;
  refunded: boolean;
  /** Lines in the whole order — lets a single-line order match a ledger row with no item number. */
  orderLineCount: number;
  /** false when rebuilt from storage: its live order status is unknown this run. */
  live: boolean;
}

export interface SyncedLine {
  orderId: string;
  lineItemId: string;
  status: SyncStatus;
  cardId: number | null;
  transactionId: number | null;
  matchType: MatchType | null;
  legacyItemId: string | null;
  sku: string | null;
  title: string | null;
  quantity: number;
  price: string | null;
  soldAt: string | null;
  orderLineCount: number;
}

/** A `transactions` sale row written by the report importer. */
export interface LedgerSale {
  id: number;
  orderRef: string;
  itemNumber: string | null;
  occurredOn: string;
  /** cards.id whose sale_transaction_id is this row, if any. */
  linkedCardId: number | null;
}

export interface CardRef {
  id: number;
  sku: string | null;
  title: string;
  status: string; // held | listed | sold | traded
  saleTransactionId: number | null;
}

export interface FuzzyCandidate {
  id: number;
  sku: string | null;
  title: string;
  matchType: "alias" | "fuzzy";
  score: number;
}

export interface Snapshot {
  synced: Map<string, SyncedLine>;
  ledgerByOrder: Map<string, LedgerSale[]>;
  /** Cards by sku, ANY status (sku is unique per user). */
  cardsBySku: Map<string, CardRef>;
  /** ebay_listings links: "L:<listingId>" / "S:<sku>" -> card id. */
  listingLinks: Map<string, number>;
  cardsById: Map<number, CardRef>;
  /** find_cards(title) results, by line key. Absent key = not looked up yet. */
  fuzzy: Map<string, FuzzyCandidate[]>;
}

export type Decision =
  | { kind: "noop"; line: OrderLine; reason: string }
  | { kind: "defer"; line: OrderLine; reason: string }
  | { kind: "need_fuzzy"; line: OrderLine }
  | {
      kind: "record";
      line: OrderLine;
      status: Exclude<SyncStatus, "closed">;
      reason: string;
      cardId?: number | null;
      transactionId?: number | null;
      matchType?: MatchType | null;
      score?: number | null;
      candidates?: { id: number; title: string; score: number }[];
    }
  | { kind: "close"; line: OrderLine; cardId: number; transactionId: number; matchType: MatchType; score?: number | null };

export const lineKey = (orderId: string, lineItemId: string) => `${orderId}#${lineItemId}`;
