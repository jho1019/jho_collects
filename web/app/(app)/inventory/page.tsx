import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import CardInventory, {
  type Card,
  type TrackedInventory,
} from "@/components/CardInventory";

export const dynamic = "force-dynamic";

// ?cost=missing (the dashboard's "Fix N sales" link, spec 7.5) narrows the
// list to sold cards with no acquisition cost. Without the param the page is
// unchanged. Sales never linked to a card (bulk lots) have no row here.
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ cost?: string | string[] }>;
}) {
  const costParam = (await searchParams).cost;
  const missingCost = (Array.isArray(costParam) ? costParam[0] : costParam) === "missing";
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
    <main className="pg">
      <header>
        <h1 className="pg-h1">Inventory</h1>
        <p className="pg-lead">
          Individually tracked cards. Bulk-lot commons stay a single cash row
          and never show up here — that&rsquo;s the point.
        </p>
      </header>

      {error && (
        <p className="ban err" role="alert">
          <span>
            <b>Couldn&rsquo;t load cards.</b> {error.message}
          </span>
        </p>
      )}

      {missingCost && (
        <p className="ban" role="note">
          <span>
            <b>Showing sold cards with no cost.</b>{" "}
            <Link href="/inventory" className="lk">
              Show all cards
            </Link>
          </span>
        </p>
      )}

      <CardInventory
        cards={((cards ?? []) as Card[]).filter(
          (c) => !missingCost || (c.status === "sold" && c.acquisition_cost == null),
        )}
        summary={((trackedRows ?? [])[0] ?? null) as TrackedInventory}
        missingCost={missingCost}
      />
    </main>
  );
}
