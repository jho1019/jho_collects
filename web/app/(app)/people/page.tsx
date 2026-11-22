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
    <main className="pg">
      <header>
        <h1 className="pg-h1">People</h1>
        <p className="pg-lead">
          Buyers, and card-show counterparties you&rsquo;ve bought from.
        </p>
      </header>

      {error && (
        <p className="ban err" role="alert">
          <span>
            <b>Couldn&rsquo;t load people.</b> {error.message}
          </span>
        </p>
      )}

      <BuyerList buyers={(buyers ?? []) as Buyer[]} />
    </main>
  );
}
