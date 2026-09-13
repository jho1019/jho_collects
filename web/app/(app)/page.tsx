import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/login/actions";
import CashChart, {
  type CashPoint,
  type EntriesByDay,
} from "@/components/CashChart";
import PositionCards from "@/components/PositionCards";
import RecentLedger from "@/components/RecentLedger";
import { isoDay, usd } from "@/lib/format";

// This route owns position cards, the cash chart, and ledger history —
// nothing else. Margin, inventory, and buyers moved to their own routes;
// loading "/" now issues no query against tax_summary's siblings or
// buyer_summary. See docs/PHASE_7_UI.md.
export const dynamic = "force-dynamic";

type TxnRow = {
  id: number;
  occurred_on: string;
  type: string;
  description: string;
  net_cash: string | number;
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

// Same rows buildSeries already groups by day, grouped again into full entry
// lists for the chart's hover tooltip and click-to-pin panel. One query, no
// second round trip.
function buildEntriesByDay(rows: TxnRow[]): EntriesByDay {
  const out: EntriesByDay = {};
  for (const r of rows) {
    const d = isoDay(r.occurred_on);
    (out[d] ??= []).push({
      id: r.id,
      type: r.type,
      description: r.description,
      net_cash: r.net_cash,
    });
  }
  return out;
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ rows?: string; page?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const ledgerParams = await searchParams;

  const [
    { data: txns, error: tErr },
    { data: windows },
    { data: health },
    { data: taxRows },
  ] = await Promise.all([
    supabase
      .from("transactions")
      .select("id, occurred_on, type, description, net_cash")
      .order("occurred_on", { ascending: true })
      .order("id", { ascending: true }),
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
      .from("tax_summary")
      .select("tax_year, ending_inventory_missing"),
  ]);

  const series = buildSeries((txns ?? []) as TxnRow[]);
  const entriesByDay = buildEntriesByDay((txns ?? []) as TxnRow[]);
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
        <h1 className="text-xl font-semibold text-surface">jho_collects</h1>
        <form action={logout}>
          <button
            type="submit"
            className="rounded border border-surface/40 px-3 py-1.5 text-sm text-surface hover:bg-surface/10"
          >
            Sign out
          </button>
        </form>
      </header>

      {countMissing && (
        <p className="rounded-lg border-l-4 border-accent bg-surface px-3 py-2 text-sm text-accent-ink">
          Year-end inventory count for {countYear} is not recorded. Count the
          unsold cards, estimate what you <em>paid</em> for them, and add an{" "}
          <code>inventory_counts</code> row for tax year {countYear}. Until then
          COGS and net profit for {countYear} are incomplete.
        </p>
      )}

      {missingFees > 0 && (
        <p className="rounded-lg border-l-4 border-accent bg-surface px-3 py-2 text-sm text-accent-ink">
          {missingFees} transaction{missingFees === 1 ? "" : "s"} still have
          estimated fees. The tax figures are not final until an eBay report
          import fills them in.
        </p>
      )}

      {tErr && (
        <p className="rounded border-l-4 border-accent bg-surface px-3 py-2 text-sm text-accent-ink">
          {tErr.message}
        </p>
      )}

      <PositionCards netCash={series.at(-1)?.net ?? 0} />

      <CashChart series={series} entriesByDay={entriesByDay} />

      <RecentLedger searchParams={ledgerParams} />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-surface">Rolling windows</h2>
        <div className="overflow-x-auto rounded-lg border border-brand-soft/25 bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-brand-soft/25 text-left text-xs uppercase text-ink-muted">
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
                  className="border-b border-brand-soft/15 last:border-0"
                >
                  <td className="px-3 py-2 text-ink-muted">{w.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                    {w.sale_count}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink">
                    {usd(w.gross_sales)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink">
                    {usd(w.fees_and_shipping)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink">
                    {usd(w.spent_on_cards)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-ink">
                    {usd(w.net_cash)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
