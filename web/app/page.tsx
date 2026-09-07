import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/login/actions";
import CashChart, { type CashPoint } from "@/components/CashChart";
import PositionCards from "@/components/PositionCards";
import MarginByBand, { type Band } from "@/components/MarginByBand";
import BuyerList, { type Buyer } from "@/components/BuyerList";
import CardInventory, {
  type Card,
  type TrackedInventory,
} from "@/components/CardInventory";
import { isoDay, usd } from "@/lib/format";

export const dynamic = "force-dynamic";

type TxnRow = { occurred_on: string; net_cash: string | number };
type LedgerRow = {
  occurred_on: string;
  description: string;
  type: string;
  net_cash: string | number;
  running_total: string | number;
};
type WindowRow = {
  label: string;
  days: number;
  gross_sales: string | number;
  fees_and_shipping: string | number;
  spent_on_cards: string | number;
  net_cash: string | number;
  sale_count: number;
};
type SaleRow = {
  item_amount: string | number;
  shipping_charged: string | number;
  platform_fees: string | number;
  shipping_cost: string | number;
  other_cost: string | number;
};

const DAY = 86_400_000;

// One cumulative point per day from the first transaction through today.
// Replaces the fixed-180-day daily_position view so the chart's window
// control can reach all the way back.
function buildSeries(rows: TxnRow[]): CashPoint[] {
  if (rows.length === 0) return [];
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const d = isoDay(r.occurred_on);
    byDay.set(d, (byDay.get(d) ?? 0) + Number(r.net_cash));
  }
  const start = Date.parse(`${isoDay(rows[0].occurred_on)}T00:00:00Z`);
  const end = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const out: CashPoint[] = [];
  let cum = 0;
  for (let t = start; t <= end; t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    cum += byDay.get(day) ?? 0;
    out.push({ day, net: Math.round(cum * 100) / 100 });
  }
  return out;
}

const BANDS: { label: string; lo: number; hi: number }[] = [
  { label: "< $5", lo: 0, hi: 5 },
  { label: "$5–10", lo: 5, hi: 10 },
  { label: "$10–25", lo: 10, hi: 25 },
  { label: "$25–50", lo: 25, hi: 50 },
  { label: "$50+", lo: 50, hi: Infinity },
];

function toBands(sales: SaleRow[]): Band[] {
  return BANDS.map(({ label, lo, hi }) => {
    const rows = sales.filter((s) => {
      const a = Number(s.item_amount);
      return a >= lo && a < hi;
    });
    const proceeds = rows.reduce(
      (t, s) => t + Number(s.item_amount) + Number(s.shipping_charged),
      0,
    );
    const cost = rows.reduce(
      (t, s) =>
        t +
        Number(s.platform_fees) +
        Number(s.shipping_cost) +
        Number(s.other_cost),
      0,
    );
    const net = proceeds - cost;
    return {
      band: label,
      count: rows.length,
      proceeds: Math.round(proceeds * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      net: Math.round(net * 100) / 100,
      marginPct: proceeds > 0 ? Math.round((net / proceeds) * 1000) / 10 : null,
    };
  });
}

export default async function Dashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [
    { data: txns, error: tErr },
    { data: ledger, error: lErr },
    { data: windows },
    { data: health },
    { data: sales },
    { data: buyers },
    { data: cards },
    { data: trackedRows },
    { data: taxRows },
  ] = await Promise.all([
    supabase
      .from("transactions")
      .select("occurred_on, net_cash")
      .order("occurred_on", { ascending: true }),
    supabase
      .from("ledger_running")
      .select("occurred_on, description, type, net_cash, running_total")
      .order("occurred_on", { ascending: false })
      .order("id", { ascending: false })
      .limit(15),
    supabase
      .from("dashboard_windows")
      .select(
        "label, days, gross_sales, fees_and_shipping, spent_on_cards, net_cash, sale_count",
      )
      .order("days", { ascending: true }),
    supabase
      .from("import_health")
      .select("tax_year, rows_missing_fees, revenue_at_risk"),
    supabase
      .from("transactions")
      .select(
        "item_amount, shipping_charged, platform_fees, shipping_cost, other_cost",
      )
      .eq("type", "sale"),
    supabase
      .from("buyer_summary")
      .select(
        "platform_username, display_name, last_city, last_state, order_count, distinct_orders, lifetime_gross, lifetime_net, avg_item_price, last_order_on, is_repeat_buyer",
      ),
    supabase
      .from("cards")
      .select(
        "id, title, player, year, set_name, parallel, grader, grade, status, sku, acquisition_cost, acquired_on, sold_on, is_opening_stock",
      )
      .order("acquired_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("tracked_inventory")
      .select(
        "cards_on_hand, opening_stock_cards, acquired_since_start, cards_without_cost, known_cost_basis, opening_cost_basis, acquired_cost_basis",
      ),
    supabase
      .from("tax_summary")
      .select("tax_year, ending_inventory_missing"),
  ]);

  const series = buildSeries((txns ?? []) as TxnRow[]);
  const bands = toBands((sales ?? []) as SaleRow[]);
  const missingFees = (health ?? []).reduce(
    (t: number, r: { rows_missing_fees: number }) =>
      t + Number(r.rows_missing_fees),
    0,
  );

  // December reminder: from Nov 15 through Feb, nag if the current tax year's
  // ending inventory count is still missing. Without it COGS is guesswork.
  const now = new Date();
  const month = now.getMonth(); // 0 = Jan
  const inCountSeason = month >= 10 || month <= 1; // Nov, Dec, Jan, Feb
  const countYear = month <= 1 ? now.getFullYear() - 1 : now.getFullYear();
  const countMissing =
    inCountSeason &&
    ((taxRows ?? []) as { tax_year: number; ending_inventory_missing: boolean }[]).some(
      (r) => r.tax_year === countYear && r.ending_inventory_missing,
    );

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Card ledger</h1>
          <p className="text-sm text-zinc-500">{user.email}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/data"
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            Import / export
          </Link>
          <form action={logout}>
            <button
              type="submit"
              className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      {countMissing && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Year-end inventory count for {countYear} is not recorded. Count the
          unsold cards, estimate what you <em>paid</em> for them, and add an{" "}
          <code>inventory_counts</code> row for tax year {countYear}. Until then
          COGS and net profit for {countYear} are incomplete.
        </p>
      )}

      {missingFees > 0 && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {missingFees} transaction{missingFees === 1 ? "" : "s"} still have
          estimated fees. The tax figures are not final until an eBay report
          import fills them in.
        </p>
      )}

      {(tErr || lErr) && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {tErr?.message ?? lErr?.message}
        </p>
      )}

      <PositionCards netCash={series.at(-1)?.net ?? 0} />

      <CashChart series={series} />

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-700">Recent ledger</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 text-right font-medium">Net cash</th>
                <th className="px-3 py-2 text-right font-medium">Running</th>
              </tr>
            </thead>
            <tbody>
              {((ledger ?? []) as LedgerRow[]).map((r, i) => (
                <tr key={i} className="border-b border-zinc-100 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-zinc-600">
                    {isoDay(r.occurred_on)}
                  </td>
                  <td className="px-3 py-2 text-zinc-600">{r.type}</td>
                  <td className="max-w-xs truncate px-3 py-2 text-zinc-800">
                    {r.description}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-800">
                    {usd(r.net_cash)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-800">
                    {usd(r.running_total)}
                  </td>
                </tr>
              ))}
              {((ledger ?? []) as LedgerRow[]).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-zinc-400">
                    No transactions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-700">Rolling windows</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Window</th>
                <th className="px-3 py-2 text-right font-medium">Sales</th>
                <th className="px-3 py-2 text-right font-medium">Gross sales</th>
                <th className="px-3 py-2 text-right font-medium">
                  Fees + shipping
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  Spent on cards
                </th>
                <th className="px-3 py-2 text-right font-medium">Net cash</th>
              </tr>
            </thead>
            <tbody>
              {((windows ?? []) as WindowRow[]).map((w) => (
                <tr
                  key={w.days}
                  className="border-b border-zinc-100 last:border-0"
                >
                  <td className="px-3 py-2 text-zinc-700">{w.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-600">
                    {w.sale_count}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-800">
                    {usd(w.gross_sales)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-800">
                    {usd(w.fees_and_shipping)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-800">
                    {usd(w.spent_on_cards)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-zinc-900">
                    {usd(w.net_cash)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-700">
          Margin by price band
        </h2>
        <p className="text-xs text-zinc-500">
          Net as a share of proceeds. Bars under 25% are flagged — the fixed
          per-order fee and label eat low-price cards.
        </p>
        <div className="rounded-lg border border-zinc-200 bg-white p-3">
          <MarginByBand bands={bands} />
        </div>
      </section>

      <CardInventory
        cards={(cards ?? []) as Card[]}
        summary={((trackedRows ?? [])[0] ?? null) as TrackedInventory}
      />

      <BuyerList buyers={(buyers ?? []) as Buyer[]} />
    </main>
  );
}
