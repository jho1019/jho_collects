import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/login/actions";
import CashChart, { type CashPoint } from "@/components/CashChart";
import PositionCards from "@/components/PositionCards";
import MarginByBand, { type Band } from "@/components/MarginByBand";
import { isoDay, usd } from "@/lib/format";

export const dynamic = "force-dynamic";

type DailyRow = { day: string; cumulative_net: string | number };
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
    { data: daily, error: dErr },
    { data: ledger, error: lErr },
    { data: windows },
    { data: health },
    { data: sales },
  ] = await Promise.all([
    supabase
      .from("daily_position")
      .select("day, cumulative_net")
      .order("day", { ascending: true }),
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
    supabase.from("import_health").select("tax_year, rows_missing_fees, revenue_at_risk"),
    supabase
      .from("transactions")
      .select(
        "item_amount, shipping_charged, platform_fees, shipping_cost, other_cost",
      )
      .eq("type", "sale"),
  ]);

  const points: CashPoint[] = (daily ?? []).map((r: DailyRow) => ({
    day: isoDay(r.day),
    net: Number(r.cumulative_net),
  }));
  const current = points.at(-1)?.net ?? 0;
  const bands = toBands((sales ?? []) as SaleRow[]);
  const missingFees = (health ?? []).reduce(
    (t: number, r: { rows_missing_fees: number }) => t + Number(r.rows_missing_fees),
    0,
  );

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Card ledger</h1>
          <p className="text-sm text-zinc-500">{user.email}</p>
        </div>
        <form action={logout}>
          <button
            type="submit"
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            Sign out
          </button>
        </form>
      </header>

      {missingFees > 0 && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {missingFees} transaction{missingFees === 1 ? "" : "s"} still have
          estimated fees. The tax figures are not final until an eBay report
          import fills them in.
        </p>
      )}

      {(dErr || lErr) && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {dErr?.message ?? lErr?.message}
        </p>
      )}

      <PositionCards netCash={current} />

      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-zinc-700">
            Cumulative net cash
          </h2>
          <span className="text-lg font-semibold tabular-nums text-zinc-900">
            {usd(current)}
          </span>
        </div>
        <p className="text-xs text-zinc-500">
          Cash in and out, not net worth. Dips below zero are normal — inventory
          bought and not yet sold.
        </p>
        <div className="rounded-lg border border-zinc-200 bg-white p-3">
          <CashChart data={points} />
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
    </main>
  );
}
