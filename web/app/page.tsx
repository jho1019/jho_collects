import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/login/actions";
import CashChart, { type CashPoint } from "@/components/CashChart";
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

export default async function Dashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: daily, error: dErr }, { data: ledger, error: lErr }] =
    await Promise.all([
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
    ]);

  const points: CashPoint[] = (daily ?? []).map((r: DailyRow) => ({
    day: isoDay(r.day),
    net: Number(r.cumulative_net),
  }));
  const current = points.at(-1)?.net ?? 0;

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

      {(dErr || lErr) && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {dErr?.message ?? lErr?.message}
        </p>
      )}

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
          This is cash in and out, not net worth. Dips below zero are normal —
          inventory bought and not yet sold.
        </p>
        <div className="rounded-lg border border-zinc-200 bg-white p-3">
          <CashChart data={points} />
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
              {(ledger ?? []).map((r: LedgerRow, i: number) => (
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
              {(ledger ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-6 text-center text-zinc-400"
                  >
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
