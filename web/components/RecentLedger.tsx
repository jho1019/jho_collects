import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isoDay, signedUsd, toneClass } from "@/lib/format";
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

  const hrefFor = (p: number) => `/ledger?rows=${rows}&page=${p}`;

  return (
    <section className="board bd">
      <div className="bl">
        <h2>Ledger</h2>
        <LedgerPageSizeSelect rows={rows} />
      </div>

      {error && (
        <p className="ban err mt-2" role="alert">
          <span>
            <b>Couldn&rsquo;t load the ledger.</b> {error.message}
          </span>
        </p>
      )}

      {/* One table at every width (spec L8). Below 700px Type and Running
          fold away and Running sits under Net cash in muted 10.5px. */}
      <div className="mt-2 overflow-x-auto">
        <table className="tb">
          <thead>
            <tr>
              <th>Date</th>
              <th className="hm">Type</th>
              <th>Description</th>
              <th className="r">Net cash</th>
              <th className="r hm">Running</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap tabular-nums">{isoDay(r.occurred_on)}</td>
                <td className="hm">{r.type}</td>
                <td className="max-w-[28rem] sm:truncate">
                  {r.description}
                  <span className="sm-only block text-[10.5px] text-ink-muted">{r.type}</span>
                </td>
                <td className={`r whitespace-nowrap ${toneClass(r.net_cash)}`}>
                  {signedUsd(r.net_cash)}
                  <span className="sm-only block text-[10.5px] font-normal text-ink-muted">
                    {signedUsd(r.running_total)}
                  </span>
                </td>
                <td className="r hm whitespace-nowrap">{signedUsd(r.running_total)}</td>
              </tr>
            ))}
            {ledger.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-ink-muted">
                  No transactions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-ink-muted">
        <span className="tabular-nums">
          {total === 0 ? "0 of 0" : `${rangeStart}–${rangeEnd} of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} className="btn">
              Previous
            </Link>
          ) : (
            <span className="btn off" aria-disabled="true">
              Previous
            </span>
          )}
          {page < totalPages ? (
            <Link href={hrefFor(page + 1)} className="btn">
              Next
            </Link>
          ) : (
            <span className="btn off" aria-disabled="true">
              Next
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
