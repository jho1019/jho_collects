import { createClient } from "@/lib/supabase/server";
import BuyerList, { type Buyer } from "@/components/BuyerList";

// "/people", not "/buyers" — buyers now also holds show vendors bought FROM.
// See the column comment on deals.counterparty_id and docs/PHASE_7_UI.md.
export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const supabase = await createClient();

  const { data: buyers, error } = await supabase
    .from("buyer_summary")
    .select(
      "platform_username, display_name, last_city, last_state, order_count, distinct_orders, lifetime_gross, lifetime_net, avg_item_price, last_order_on, is_repeat_buyer",
    );

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-ink">People</h1>
        <p className="text-sm text-ink-muted">
          Buyers, and card-show counterparties you&rsquo;ve bought from.
        </p>
      </header>

      {error && (
        <p className="rounded bg-accent/10 px-3 py-2 text-sm text-accent-ink">
          {error.message}
        </p>
      )}

      <BuyerList buyers={(buyers ?? []) as Buyer[]} />
    </main>
  );
}
