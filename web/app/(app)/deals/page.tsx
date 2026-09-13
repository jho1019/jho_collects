import { createClient } from "@/lib/supabase/server";
import DealList, {
  type Deal,
  type DealTxn,
  type DealCard,
} from "@/components/DealList";

// deal_summary is net new — no component existed for it before this phase.
// Per-deal net is computed in the view, never stored, never collapsed into a
// single ledger row (see schema/007_deal_functions.sql).
export const dynamic = "force-dynamic";

export default async function DealsPage() {
  const supabase = await createClient();

  const [{ data: deals, error }, { data: txns }, { data: cards }] =
    await Promise.all([
      supabase
        .from("deal_summary")
        .select(
          "deal_id, occurred_on, event_name, counterparty, net_cash, txn_count, cards_in, cards_out, kind, needs_review, notes",
        )
        .order("occurred_on", { ascending: false })
        .order("deal_id", { ascending: false }),
      supabase
        .from("transactions")
        .select("id, deal_id, occurred_on, type, description, item_amount, net_cash")
        .not("deal_id", "is", null),
      supabase
        .from("cards")
        .select("id, title, acquisition_cost, acquired_deal_id, disposed_deal_id")
        .or("acquired_deal_id.not.is.null,disposed_deal_id.not.is.null"),
    ]);

  const needsReview = (deals ?? []).filter((d) => d.needs_review).length;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-surface">Deals</h1>
        <p className="text-sm text-surface/70">
          Card show events — purchases, sales, and trades grouped by
          counterparty.
          {needsReview > 0 && (
            <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-xs font-medium text-accent-ink">
              {needsReview} need{needsReview === 1 ? "s" : ""} review
            </span>
          )}
        </p>
      </header>

      {error && (
        <p className="rounded border-l-4 border-accent bg-surface px-3 py-2 text-sm text-accent-ink">
          {error.message}
        </p>
      )}

      <DealList
        deals={(deals ?? []) as Deal[]}
        txns={(txns ?? []) as DealTxn[]}
        cards={(cards ?? []) as DealCard[]}
      />
    </main>
  );
}
