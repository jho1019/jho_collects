import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EbayEnvironment, Env } from "../config";
import { ApiError } from "../errors";
import { money2, resolveOwnerUserId } from "../store";
import type { CloseResult, SyncRepo, SyncedLineWrite } from "./run";
import { STATE_NAME } from "./run";
import type { CardRef, FuzzyCandidate, LedgerSale, MatchType, SyncedLine, SyncStatus } from "./types";

// SyncRepo over Supabase (service role). Reads the ledger and cards scoped to
// the owner explicitly (the service role has no auth.uid()); writes ONLY to
// ebay_synced_orders / ebay_sync_state and, through ebay_close_card_for_sale,
// to cards + card_aliases. There is deliberately no method here that writes
// to `transactions`.
//
// Personal-collection cards (category 'pc') are invisible to the sync: every
// card read below excludes them, so a pc card is never matched or closed
// (schema/027's trigger would refuse the close anyway). A sold line that only
// a pc card would match lands in needs_review as no_card_match.

function dbError(op: string, err: { message?: string } | null): ApiError {
  console.error(`[ebay-api] sync ${op} failed:`, err?.message);
  return new ApiError(500, "database_error", `database error during sync ${op}`);
}

const IN_CHUNK = 100; // keep PostgREST URLs short

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
}

interface SyncedRow {
  order_id: string; line_item_id: string; status: SyncStatus; card_id: number | null; transaction_id: number | null;
  match_type: MatchType | null; legacy_item_id: string | null; sku: string | null; title: string | null;
  quantity: number; line_price: number | null; sold_at: string | null; order_line_count: number;
}

const SYNCED_COLS = "order_id, line_item_id, status, card_id, transaction_id, match_type, legacy_item_id, sku, title, quantity, line_price, sold_at, order_line_count";

function toSynced(r: SyncedRow): SyncedLine {
  return {
    orderId: r.order_id, lineItemId: r.line_item_id, status: r.status, cardId: r.card_id, transactionId: r.transaction_id,
    matchType: r.match_type, legacyItemId: r.legacy_item_id, sku: r.sku, title: r.title, quantity: r.quantity,
    price: money2(r.line_price), soldAt: r.sold_at, orderLineCount: r.order_line_count,
  };
}

interface CardRow { id: number; sku: string | null; title: string; status: string; sale_transaction_id: number | null }
const toCard = (c: CardRow): CardRef => ({ id: c.id, sku: c.sku, title: c.title, status: c.status, saleTransactionId: c.sale_transaction_id });

export function supabaseSyncRepo(db: SupabaseClient, env: Env = process.env): SyncRepo {
  const owner = () => resolveOwnerUserId(db, env);

  return {
    async getState(environment) {
      const { data, error } = await db.from("ebay_sync_state").select("cursor_at")
        .eq("environment", environment).eq("name", STATE_NAME).maybeSingle();
      if (error) throw dbError("read state", error);
      return { cursorAt: data?.cursor_at ? new Date(data.cursor_at) : null };
    },

    async saveState(environment, s) {
      const row: Record<string, unknown> = {
        environment, name: STATE_NAME, last_run_at: s.lastRunAt.toISOString(),
        last_status: s.lastStatus, last_error: s.lastError, updated_at: new Date().toISOString(),
      };
      if (s.cursorAt) row.cursor_at = s.cursorAt.toISOString();
      const { error } = await db.from("ebay_sync_state").upsert(row, { onConflict: "environment,name" });
      if (error) throw dbError("save state", error);
    },

    async getSyncedLines(environment, keys) {
      const orderIds = [...new Set(keys.map((k) => k.orderId))];
      const want = new Set(keys.map((k) => `${k.orderId}#${k.lineItemId}`));
      const out: SyncedLine[] = [];
      for (const part of chunks(orderIds)) {
        const { data, error } = await db.from("ebay_synced_orders").select(SYNCED_COLS)
          .eq("environment", environment).in("order_id", part);
        if (error) throw dbError("read synced lines", error);
        for (const r of (data ?? []) as SyncedRow[]) if (want.has(`${r.order_id}#${r.line_item_id}`)) out.push(toSynced(r));
      }
      return out;
    },

    async getPendingLines(environment) {
      const { data, error } = await db.from("ebay_synced_orders").select(SYNCED_COLS)
        .eq("environment", environment).eq("status", "pending_ledger").limit(1000);
      if (error) throw dbError("read pending lines", error);
      return ((data ?? []) as SyncedRow[]).map(toSynced);
    },

    async getLedgerSales(orderIds): Promise<LedgerSale[]> {
      if (!orderIds.length) return [];
      const user = await owner();
      const out: LedgerSale[] = [];
      for (const part of chunks(orderIds)) {
        const { data, error } = await db.from("transactions").select("id, order_ref, item_number, occurred_on")
          .eq("user_id", user).eq("platform", "ebay").eq("type", "sale").in("order_ref", part);
        if (error) throw dbError("read ledger sales", error);
        const rows = data ?? [];
        const linked = new Map<number, number>();
        if (rows.length) {
          const { data: cards, error: e2 } = await db.from("cards").select("id, sale_transaction_id")
            .eq("user_id", user).in("sale_transaction_id", rows.map((r) => r.id));
          if (e2) throw dbError("read linked cards", e2);
          for (const c of cards ?? []) linked.set(c.sale_transaction_id, c.id);
        }
        for (const r of rows) {
          out.push({ id: r.id, orderRef: r.order_ref, itemNumber: r.item_number, occurredOn: r.occurred_on, linkedCardId: linked.get(r.id) ?? null });
        }
      }
      return out;
    },

    async getCardsBySku(skus) {
      if (!skus.length) return [];
      const user = await owner();
      const out: CardRef[] = [];
      for (const part of chunks(skus)) {
        const { data, error } = await db.from("cards").select("id, sku, title, status, sale_transaction_id")
          .eq("user_id", user).neq("category", "pc").in("sku", part);
        if (error) throw dbError("read cards by sku", error);
        out.push(...((data ?? []) as CardRow[]).map(toCard));
      }
      return out;
    },

    async getCardsById(ids) {
      if (!ids.length) return [];
      const user = await owner();
      const out: CardRef[] = [];
      for (const part of chunks(ids)) {
        const { data, error } = await db.from("cards").select("id, sku, title, status, sale_transaction_id")
          .eq("user_id", user).neq("category", "pc").in("id", part);
        if (error) throw dbError("read cards by id", error);
        out.push(...((data ?? []) as CardRow[]).map(toCard));
      }
      return out;
    },

    async getListingLinks(environment: EbayEnvironment, q) {
      const out: { listingId: string | null; sku: string; cardId: number }[] = [];
      const add = (rows: { listing_id: string | null; sku: string; card_id: number | null }[] | null) => {
        for (const r of rows ?? []) if (r.card_id) out.push({ listingId: r.listing_id, sku: r.sku, cardId: r.card_id });
      };
      for (const part of chunks(q.listingIds)) {
        const { data, error } = await db.from("ebay_listings").select("listing_id, sku, card_id")
          .eq("environment", environment).in("listing_id", part);
        if (error) throw dbError("read listing links", error);
        add(data);
      }
      for (const part of chunks(q.skus)) {
        const { data, error } = await db.from("ebay_listings").select("listing_id, sku, card_id")
          .eq("environment", environment).in("sku", part);
        if (error) throw dbError("read listing links", error);
        add(data);
      }
      return out;
    },

    async findCards(title): Promise<FuzzyCandidate[]> {
      const { data, error } = await db.rpc("ebay_find_cards", { p_user_id: await owner(), q: title });
      if (error) throw dbError("find_cards", error);
      const rows = (data ?? []) as { id: number; sku: string | null; title: string; match_type: string; score: number }[];
      // find_cards does not return category; drop pc candidates here so the
      // sync never matches (and so never tries to close) a pc card.
      const pc = new Set<number>();
      if (rows.length) {
        const { data: pcRows, error: e2 } = await db.from("cards").select("id")
          .in("id", rows.map((r) => r.id)).eq("category", "pc");
        if (e2) throw dbError("filter pc candidates", e2);
        for (const r of pcRows ?? []) pc.add(r.id);
      }
      return rows.filter((r) => !pc.has(r.id))
        .map((r) => ({ id: r.id, sku: r.sku, title: r.title, matchType: r.match_type === "alias" ? "alias" : "fuzzy", score: r.score }));
    },

    async closeCard(cardId, transactionId): Promise<CloseResult> {
      const { data, error } = await db.rpc("ebay_close_card_for_sale", { p_card_id: cardId, p_transaction_id: transactionId });
      if (error) throw dbError("close card", error);
      const res = String(data ?? "");
      if (res === "closed" || res === "already_closed") return { result: res };
      return { result: "conflict", message: res.replace(/^conflict:\s*/, "") || "unknown" };
    },

    async upsertLine(environment, w: SyncedLineWrite) {
      const { error } = await db.from("ebay_synced_orders").upsert({
        environment, order_id: w.orderId, line_item_id: w.lineItemId, status: w.status,
        legacy_item_id: w.legacyItemId, sku: w.sku, title: w.title, quantity: w.quantity, line_price: w.price,
        sold_at: w.soldAt, order_line_count: w.orderLineCount, card_id: w.cardId, transaction_id: w.transactionId,
        match_type: w.matchType, match_score: w.matchScore, reason: w.reason, updated_at: new Date().toISOString(),
      }, { onConflict: "environment,order_id,line_item_id" });
      if (error) throw dbError("write synced line", error);
    },
  };
}

export async function syncOverview(db: SupabaseClient, environment: EbayEnvironment) {
  const [{ data: state, error: e1 }, { data: review, error: e2 }, { count: pending, error: e3 }] = await Promise.all([
    db.from("ebay_sync_state").select("cursor_at, last_run_at, last_status, last_error").eq("environment", environment).eq("name", STATE_NAME).maybeSingle(),
    db.from("ebay_synced_orders").select("order_id, line_item_id, title, sku, reason, card_id, transaction_id, updated_at")
      .eq("environment", environment).eq("status", "needs_review").order("updated_at", { ascending: false }).limit(100),
    db.from("ebay_synced_orders").select("id", { count: "exact", head: true }).eq("environment", environment).eq("status", "pending_ledger"),
  ]);
  if (e1 || e2 || e3) throw dbError("read overview", e1 ?? e2 ?? e3);
  return { state: state ?? null, pending_ledger: pending ?? 0, needs_review: review ?? [] };
}
