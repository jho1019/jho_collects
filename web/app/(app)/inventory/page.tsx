import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { inventoryGroup, parseGroup, type InventoryGroup } from "@/lib/inventoryGroups";
import CardInventory, {
  type Card,
  type TrackedInventory,
} from "@/components/CardInventory";

export const dynamic = "force-dynamic";

// ?cost=missing (the dashboard's "Fix N sales" link, spec 7.5) narrows the
// list to sold cards with no acquisition cost. Without the param the page is
// unchanged. Sales never linked to a card (bulk lots) have no row here.
//
// ?group=selling|holding|pc and ?price=missing are the dashboard Inventory
// board's links (spec 18). Both narrow to on-hand cards (held / listed) with
// the same predicate as the board (lib/inventoryGroups.ts); price=missing is
// "no est_value" and combines with group. Anything else in group is ignored.
// ?cost=missing (sold-only) wins over them, so its view stays identical.
const GROUP_WORDS: Record<InventoryGroup, string> = {
  selling: "selling cards",
  holding: "holding cards",
  pc: "PC cards",
};

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    cost?: string | string[];
    group?: string | string[];
    price?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const missingCost = first(params.cost) === "missing";
  const group = missingCost ? null : parseGroup(params.group);
  const missingPrice = !missingCost && first(params.price) === "missing";
  const groupView = group != null || missingPrice;
  const supabase = await createClient();

  let cardQuery = supabase
    .from("cards")
    .select(
      "id, title, player, year, set_name, parallel, grader, grade, status, category, intent, sku, acquisition_cost, est_value, acquired_on, exited_on, is_opening_stock",
    );
  if (groupView) cardQuery = cardQuery.in("status", ["held", "listed"]);

  const [{ data: cards, error }, { data: trackedRows }] = await Promise.all([
    cardQuery
      .order("acquired_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("tracked_inventory")
      .select(
        "cards_on_hand, opening_stock_cards, acquired_since_start, cards_without_cost, known_cost_basis, opening_cost_basis, acquired_cost_basis",
      ),
  ]);

  const shown = ((cards ?? []) as Card[]).filter((c) => {
    if (missingCost) return c.status === "sold" && c.acquisition_cost == null;
    if (!groupView) return true;
    const g = inventoryGroup(c);
    if (!g) return false;
    if (group && g !== group) return false;
    if (missingPrice && c.est_value != null) return false;
    return true;
  });
  const viewWords = group
    ? `${GROUP_WORDS[group]}${missingPrice ? " with no price" : ""}`
    : "cards with no price";

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

      {groupView && (
        <p className="ban" role="note">
          <span>
            <b>Showing {viewWords}.</b>{" "}
            <Link href="/inventory" className="lk">
              Show all cards
            </Link>
          </span>
        </p>
      )}

      <CardInventory
        cards={shown}
        summary={((trackedRows ?? [])[0] ?? null) as TrackedInventory}
        missingCost={missingCost}
        groupView={groupView}
      />
    </main>
  );
}
