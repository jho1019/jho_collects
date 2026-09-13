import { createClient } from "@/lib/supabase/server";
import CardInventory, {
  type Card,
  type TrackedInventory,
} from "@/components/CardInventory";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const supabase = await createClient();

  const [{ data: cards, error }, { data: trackedRows }] = await Promise.all([
    supabase
      .from("cards")
      .select(
        "id, title, player, year, set_name, parallel, grader, grade, status, sku, acquisition_cost, acquired_on, exited_on, is_opening_stock",
      )
      .order("acquired_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("tracked_inventory")
      .select(
        "cards_on_hand, opening_stock_cards, acquired_since_start, cards_without_cost, known_cost_basis, opening_cost_basis, acquired_cost_basis",
      ),
  ]);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-surface">Inventory</h1>
        <p className="text-sm text-surface/70">
          Individually tracked cards. Bulk-lot commons stay a single cash row
          and never show up here — that&rsquo;s the point.
        </p>
      </header>

      {error && (
        <p className="rounded border-l-4 border-accent bg-surface px-3 py-2 text-sm text-accent-ink">
          {error.message}
        </p>
      )}

      <CardInventory
        cards={(cards ?? []) as Card[]}
        summary={((trackedRows ?? [])[0] ?? null) as TrackedInventory}
      />
    </main>
  );
}
