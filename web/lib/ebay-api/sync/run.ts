import type { EbayEnvironment } from "../config";
import { ApiError } from "../errors";
import type { SaleOrder } from "../fulfillment";
import { linesFromOrders, planSync } from "./plan";
import {
  lineKey,
  type CardRef, type Decision, type FuzzyCandidate, type LedgerSale, type MatchType, type OrderLine, type Snapshot,
  type SyncStatus, type SyncedLine,
} from "./types";

// Sold-order sync orchestration: gather a snapshot -> plan (pure, plan.ts) ->
// apply. All database access goes through SyncRepo, so tests run against an
// in-memory fake and production against Supabase (supabase-repo.ts).
//
// Idempotency: ebay_synced_orders is unique on (environment, order, line).
// Terminal rows plan to `noop`; a re-run with nothing new writes nothing.
// Cursor: ebay_sync_state.cursor_at, compared to order lastModifiedDate (so
// payments, cancellations and refunds after the sale are seen). It advances
// to this run's start time only when the run had no errors, and every fetch
// overlaps the previous one by OVERLAP_MS.

export const OVERLAP_MS = 60 * 60 * 1000;
export const FIRST_RUN_LOOKBACK_DAYS = 30;
export const STATE_NAME = "orders";

export type CloseResult =
  | { result: "closed" }
  | { result: "already_closed" }
  | { result: "conflict"; message: string };

export interface SyncedLineWrite {
  orderId: string;
  lineItemId: string;
  status: SyncStatus;
  legacyItemId: string | null;
  sku: string | null;
  title: string;
  quantity: number;
  price: string | null;
  soldAt: string | null;
  orderLineCount: number;
  cardId: number | null;
  transactionId: number | null;
  matchType: MatchType | null;
  matchScore: number | null;
  reason: string;
}

export interface SyncRepo {
  getState(env: EbayEnvironment): Promise<{ cursorAt: Date | null }>;
  saveState(env: EbayEnvironment, s: { cursorAt?: Date; lastRunAt: Date; lastStatus: "ok" | "error"; lastError: string | null }): Promise<void>;
  getSyncedLines(env: EbayEnvironment, keys: { orderId: string; lineItemId: string }[]): Promise<SyncedLine[]>;
  getPendingLines(env: EbayEnvironment): Promise<SyncedLine[]>;
  /** eBay `sale` rows in transactions whose order_ref is one of these. */
  getLedgerSales(orderIds: string[]): Promise<LedgerSale[]>;
  getCardsBySku(skus: string[]): Promise<CardRef[]>;
  getCardsById(ids: number[]): Promise<CardRef[]>;
  getListingLinks(env: EbayEnvironment, q: { listingIds: string[]; skus: string[] }): Promise<{ listingId: string | null; sku: string; cardId: number }[]>;
  /** find_cards(title) for the owner. */
  findCards(title: string): Promise<FuzzyCandidate[]>;
  /** ebay_close_card_for_sale: atomic close + alias retire, re-validated in SQL. */
  closeCard(cardId: number, transactionId: number): Promise<CloseResult>;
  upsertLine(env: EbayEnvironment, row: SyncedLineWrite): Promise<void>;
}

export interface SyncDeps {
  environment: EbayEnvironment;
  repo: SyncRepo;
  fetchOrders: (since: Date) => Promise<SaleOrder[]>;
  now?: () => Date;
}

export interface SyncOptions {
  dryRun: boolean;
  /** Override the cursor (manual runs). */
  since?: Date;
}

export interface DecisionReport {
  order_id: string;
  line_item_id: string;
  title: string;
  sku: string | null;
  action: "noop" | "defer" | "record" | "close";
  status: SyncStatus | null;
  reason: string;
  card_id: number | null;
  transaction_id: number | null;
  match_type: MatchType | null;
  score: number | null;
  candidates?: { id: number; title: string; score: number }[];
  error?: string;
}

const uniq = <T,>(xs: (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x !== null && x !== undefined && x !== ""))];

async function gather(deps: SyncDeps, fresh: OrderLine[], pending: SyncedLine[]): Promise<Snapshot> {
  const { repo, environment: env } = deps;
  const all = [...fresh, ...pending];
  const synced = await repo.getSyncedLines(env, fresh.map((l) => ({ orderId: l.orderId, lineItemId: l.lineItemId })));
  const syncedMap = new Map<string, SyncedLine>();
  for (const s of [...pending, ...synced]) syncedMap.set(lineKey(s.orderId, s.lineItemId), s);

  const ledger = await repo.getLedgerSales(uniq(all.map((l) => l.orderId)));
  const ledgerByOrder = new Map<string, LedgerSale[]>();
  for (const r of ledger) ledgerByOrder.set(r.orderRef, [...(ledgerByOrder.get(r.orderRef) ?? []), r]);

  const skus = uniq(all.map((l) => l.sku));
  const cardsBySku = new Map((await repo.getCardsBySku(skus)).filter((c) => c.sku).map((c) => [c.sku!, c]));
  const links = await repo.getListingLinks(env, { listingIds: uniq(all.map((l) => l.legacyItemId)), skus });
  const listingLinks = new Map<string, number>();
  for (const k of links) {
    if (k.listingId) listingLinks.set(`L:${k.listingId}`, k.cardId);
    listingLinks.set(`S:${k.sku}`, k.cardId);
  }
  const ids = uniq<number>([
    ...links.map((k) => k.cardId),
    ...[...syncedMap.values()].map((s) => s.cardId),
  ]);
  const cardsById = new Map((await repo.getCardsById(ids)).map((c) => [c.id, c]));
  return { synced: syncedMap, ledgerByOrder, cardsBySku, listingLinks, cardsById, fuzzy: new Map() };
}

function toReport(d: Decision): DecisionReport {
  const base = {
    order_id: d.line.orderId, line_item_id: d.line.lineItemId, title: d.line.title, sku: d.line.sku,
    card_id: null, transaction_id: null, match_type: null, score: null,
  };
  switch (d.kind) {
    case "noop":
    case "defer":
      return { ...base, action: d.kind, status: null, reason: d.reason };
    case "close":
      return { ...base, action: "close", status: "closed", reason: `close card ${d.cardId} against transaction ${d.transactionId}`,
        card_id: d.cardId, transaction_id: d.transactionId, match_type: d.matchType, score: d.score ?? null };
    case "record":
      return { ...base, action: "record", status: d.status, reason: d.reason, card_id: d.cardId ?? null,
        transaction_id: d.transactionId ?? null, match_type: d.matchType ?? null, score: d.score ?? null,
        ...(d.candidates ? { candidates: d.candidates } : {}) };
    case "need_fuzzy":
      throw new Error("unresolved need_fuzzy decision");
  }
}

function write(l: OrderLine, r: DecisionReport): SyncedLineWrite {
  return {
    orderId: l.orderId, lineItemId: l.lineItemId, status: r.status!, legacyItemId: l.legacyItemId, sku: l.sku,
    title: l.title, quantity: l.quantity, price: l.price, soldAt: l.soldAt || null, orderLineCount: l.orderLineCount,
    cardId: r.card_id, transactionId: r.transaction_id, matchType: r.match_type, matchScore: r.score, reason: r.reason,
  };
}

export async function runSync(deps: SyncDeps, opts: SyncOptions) {
  const now = deps.now?.() ?? new Date();
  const { repo, environment: env } = deps;
  const state = await repo.getState(env);
  const since = opts.since
    ?? (state.cursorAt ? new Date(state.cursorAt.getTime() - OVERLAP_MS) : new Date(now.getTime() - FIRST_RUN_LOOKBACK_DAYS * 86_400_000));

  let orders: SaleOrder[];
  try {
    orders = await deps.fetchOrders(since);
  } catch (e) {
    if (!opts.dryRun) {
      await repo.saveState(env, { lastRunAt: now, lastStatus: "error", lastError: e instanceof ApiError ? e.message : "fetch failed" }).catch(() => {});
    }
    throw e;
  }

  const fresh = linesFromOrders(orders);
  const pending = await repo.getPendingLines(env);
  const snap = await gather(deps, fresh, pending);

  // Pass 1 finds the lines that need a title lookup; pass 2 plans with them.
  let decisions = planSync(fresh, pending, snap);
  for (const d of decisions) {
    if (d.kind !== "need_fuzzy") continue;
    const cands = await repo.findCards(d.line.title);
    snap.fuzzy.set(lineKey(d.line.orderId, d.line.lineItemId), cands);
    for (const c of cands) if (!snap.cardsById.has(c.id)) snap.cardsById.set(c.id, { id: c.id, sku: c.sku, title: c.title, status: "held", saleTransactionId: null });
  }
  decisions = planSync(fresh, pending, snap);

  const reports: DecisionReport[] = [];
  const errors: { order_id: string; line_item_id: string; error: string }[] = [];
  for (const d of decisions) {
    const r = toReport(d);
    reports.push(r);
    if (opts.dryRun || r.action === "noop" || r.action === "defer") continue;
    try {
      if (d.kind === "close") {
        const res = await repo.closeCard(d.cardId, d.transactionId);
        if (res.result === "already_closed") {
          r.status = "already_closed";
          r.reason = "card was already closed against this sale row";
        } else if (res.result === "conflict") {
          r.status = "needs_review";
          r.reason = `close_conflict: ${res.message}`;
        }
      }
      await repo.upsertLine(env, write(d.line, r));
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "write failed";
      r.error = msg;
      errors.push({ order_id: r.order_id, line_item_id: r.line_item_id, error: msg });
    }
  }

  let cursorAdvanced = false;
  if (!opts.dryRun) {
    if (errors.length) {
      await repo.saveState(env, { lastRunAt: now, lastStatus: "error", lastError: `${errors.length} line(s) failed` });
    } else {
      await repo.saveState(env, { cursorAt: now, lastRunAt: now, lastStatus: "ok", lastError: null });
      cursorAdvanced = true;
    }
  }

  const counts: Record<string, number> = {};
  for (const r of reports) {
    const k = r.action === "noop" || r.action === "defer" ? r.action : r.status!;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return {
    dry_run: opts.dryRun,
    since: since.toISOString(),
    run_at: now.toISOString(),
    orders_fetched: orders.length,
    lines: reports.length,
    counts,
    cursor_advanced: cursorAdvanced,
    /** Fuzzy closes are worth a glance: no human confirmed them. */
    fuzzy_matches: reports.filter((r) => r.match_type === "fuzzy" && (r.status === "closed" || r.status === "pending_ledger")),
    decisions: reports,
    errors,
  };
}
