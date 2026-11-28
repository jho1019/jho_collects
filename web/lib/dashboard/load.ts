import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bucket } from "@/lib/inventory-import/overrides";
import type { BoardBulkLot, BoardCard } from "./inventoryBoard";
import type { InventorySummary } from "./model";
import type { Card, Txn } from "./profit";

// Reads for the scoreboard. SELECT only, anon key + the signed-in user's
// session, so RLS scopes every row. Money arrives as numeric (number or
// string) and is converted to integer cents here, once, so the math never
// adds floats.

const PAGE = 1000; // PostgREST's default max-rows; page past it explicitly

export function toCents(v: unknown): number {
  if (v == null || v === "") return 0;
  return Math.round(Number(v) * 100);
}

/** Cents, or null when the column is null — for values where "none" must
 * never become $0 (est_value, acquisition_cost on the inventory board). */
export function toCentsOrNull(v: unknown): number | null {
  return v == null || v === "" ? null : toCents(v);
}

async function selectAll<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  where?: { column: string; in: readonly string[] },
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const base = supabase.from(table).select(columns);
    const { data, error } = await (where ? base.in(where.column, [...where.in]) : base)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

type RawTxn = Record<keyof Txn, unknown>;
type RawCard = Record<keyof Card, unknown>;

export function normalizeTxn(r: RawTxn): Txn {
  return {
    id: Number(r.id),
    occurred_on: String(r.occurred_on),
    type: r.type as Txn["type"],
    platform: String(r.platform),
    description: String(r.description ?? ""),
    net_cash: toCents(r.net_cash),
    item_amount: toCents(r.item_amount),
    shipping_charged: toCents(r.shipping_charged),
    platform_fees: toCents(r.platform_fees),
    shipping_cost: toCents(r.shipping_cost),
    other_cost: toCents(r.other_cost),
    show_id: r.show_id == null ? null : Number(r.show_id),
    deal_id: r.deal_id == null ? null : Number(r.deal_id),
  };
}

export function normalizeCard(r: RawCard): Card {
  const s = (v: unknown) => (v == null ? null : String(v));
  return {
    id: Number(r.id),
    title: String(r.title ?? ""),
    player: s(r.player),
    year: s(r.year),
    set_name: s(r.set_name),
    parallel: s(r.parallel),
    grader: s(r.grader),
    grade: s(r.grade),
    status: r.status as Card["status"],
    category: (r.category ?? "business") as Card["category"],
    acquisition_cost: r.acquisition_cost == null ? null : toCents(r.acquisition_cost),
    acquired_on: s(r.acquired_on),
    exited_on: s(r.exited_on),
    is_opening_stock: Boolean(r.is_opening_stock),
    sale_transaction_id: r.sale_transaction_id == null ? null : Number(r.sale_transaction_id),
  };
}

export async function loadScoreboardData(supabase: SupabaseClient): Promise<{
  txns: Txn[];
  cards: Card[];
  inventory: InventorySummary | null;
}> {
  const [txnRows, cardRows, inv] = await Promise.all([
    selectAll<RawTxn>(
      supabase,
      "transactions",
      "id, occurred_on, type, platform, description, net_cash, item_amount, shipping_charged, platform_fees, shipping_cost, other_cost, show_id, deal_id",
    ),
    selectAll<RawCard>(
      supabase,
      "cards",
      "id, title, player, year, set_name, parallel, grader, grade, status, category, acquisition_cost, acquired_on, exited_on, is_opening_stock, sale_transaction_id",
    ),
    supabase.from("tracked_inventory").select("cards_on_hand, cards_without_cost, known_cost_basis"),
  ]);
  if (inv.error) throw new Error(`tracked_inventory: ${inv.error.message}`);
  const row = (inv.data ?? [])[0] as Record<string, unknown> | undefined;
  return {
    txns: txnRows.map(normalizeTxn),
    cards: cardRows.map(normalizeCard),
    inventory: row
      ? {
          cards_on_hand: Number(row.cards_on_hand ?? 0),
          cards_without_cost: Number(row.cards_without_cost ?? 0),
          known_cost_basis: toCents(row.known_cost_basis),
        }
      : null,
  };
}

// ------------------------------------------------------- inventory board
// Today's on-hand cards and the bulk boxes, for the Inventory + PC board
// (lib/dashboard/inventoryBoard.ts). Paged like everything else so a
// collection past 1000 cards is not silently cut off.

type RawBoardCard = Record<keyof BoardCard, unknown>;
type RawBulkLot = Record<"bucket" | "card_count" | "total_value", unknown>;

export function normalizeBoardCard(r: RawBoardCard): BoardCard {
  return {
    id: Number(r.id),
    status: String(r.status),
    category: r.category == null ? null : String(r.category),
    intent: r.intent == null ? null : String(r.intent),
    acquisition_cost: toCentsOrNull(r.acquisition_cost),
    est_value: toCentsOrNull(r.est_value),
  };
}

export function normalizeBulkLot(r: RawBulkLot): BoardBulkLot {
  return {
    bucket: String(r.bucket) as Bucket,
    card_count: Number(r.card_count ?? 0),
    total_value: toCents(r.total_value),
  };
}

export async function loadInventoryBoard(supabase: SupabaseClient): Promise<{
  cards: BoardCard[];
  bulkLots: BoardBulkLot[];
}> {
  const [cardRows, bulkRows] = await Promise.all([
    selectAll<RawBoardCard>(supabase, "cards", "id, status, category, intent, acquisition_cost, est_value", {
      column: "status",
      in: ["held", "listed"],
    }),
    selectAll<RawBulkLot>(supabase, "bulk_lots", "bucket, card_count, total_value"),
  ]);
  return { cards: cardRows.map(normalizeBoardCard), bulkLots: bulkRows.map(normalizeBulkLot) };
}
