import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isoDay, usd } from "@/lib/format";
import LedgerPageSizeSelect from "@/components/LedgerPageSizeSelect";

const ALLOWED_ROWS = [5, 10, 50] as const;
const DEFAULT_ROWS = 10;

type LedgerRow = {
  id: number;
  occurred_on: string;
  description: string;
  type: string;
  net_cash: string | number;
  running_total: string | number;
};

function parseRows(raw: string | undefined): number {
  const n = Number(raw);
  return (ALLOWED_ROWS as readonly number[]).includes(n) ? n : DEFAULT_ROWS;
}

function parsePage(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

// Server-side pagination through the URL, not client-side slicing. The eBay
// importer adds a quarter of rows at a time; a ledger that eventually holds
// thousands of rows should not ship every one to the browser to show ten.
// Paging through the URL also makes a page linkable and survives a refresh.
export default async function RecentLedger({
  searchParams,
}: {
  searchParams: { rows?: string; page?: string };
}) {
  const rows = parseRows(searchParams.rows);
  const supabase = await createClient();

  // Count first so an out-of-range page (e.g. a stale bookmark after rows
  // shrank) clamps to the last real page instead of silently rendering
  // nothing with a nonsensical range line.
  const { count } = await supabase
    .from("ledger_running")
    .select("id", { count: "exact", head: true });

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / rows));
  const page = Math.min(parsePage(searchParams.page), totalPages);

  const from = (page - 1) * rows;
  const to = from + rows - 1;

  // occurred_on desc, id desc everywhere. Without the id tiebreaker,
  // same-day rows can reorder between requests and a row lands on two pages
  // or none.
  const { data, error } = await supabase
    .from("ledger_running")
    .select("id, occurred_on, description, type, net_cash, running_total")
    .order("occurred_on", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  const ledger = (data ?? []) as LedgerRow[];
  const rangeStart = total === 0 ? 0 : from + 1;
  const rangeEnd = total === 0 ? 0 : from + ledger.length;

  const hrefFor = (p: number) => `/?rows=${rows}&page=${p}`;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-surface">Ledger</h2>
        <LedgerPageSizeSelect rows={rows} />
      </div>

      {error && (
        <p className="rounded border-l-4 border-accent bg-surface px-3 py-2 text-sm text-accent-ink">
          {error.message}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-brand-soft/25 bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-brand-soft/25 text-left text-xs uppercase text-ink-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 text-right font-medium">Net cash</th>
              <th className="px-3 py-2 text-right font-medium">Running</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((r) => (
              <tr key={r.id} className="border-b border-brand-soft/15 last:border-0">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-ink-muted">
                  {isoDay(r.occurred_on)}
                </td>
                <td className="px-3 py-2 text-ink-muted">{r.type}</td>
                <td className="max-w-xs truncate px-3 py-2 text-ink">
                  {r.description}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink">
                  {usd(r.net_cash)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink">
                  {usd(r.running_total)}
                </td>
              </tr>
            ))}
            {ledger.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-ink-muted">
                  No transactions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-surface/70">
        <span>
          {total === 0 ? "0 of 0" : `${rangeStart}–${rangeEnd} of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link
              href={hrefFor(page - 1)}
              className="rounded border border-surface/40 px-2 py-1 text-surface hover:bg-surface/10"
            >
              Previous
            </Link>
          ) : (
            <span className="rounded border border-surface/15 px-2 py-1 text-surface/40">
              Previous
            </span>
          )}
          {page < totalPages ? (
            <Link
              href={hrefFor(page + 1)}
              className="rounded border border-surface/40 px-2 py-1 text-surface hover:bg-surface/10"
            >
              Next
            </Link>
          ) : (
            <span className="rounded border border-surface/15 px-2 py-1 text-surface/40">
              Next
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
