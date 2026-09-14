import { usd } from "@/lib/format";
import type { LedgerEntry } from "@/lib/ledgerTypes";

// One day's ledger entries, in the row shape a day-detail panel uses — no
// running_total, since a single day carries no cumulative meaning of its own.
// Shared by CashChart's click-to-pin panel (Phase 8) and the calendar's
// click-a-day panel (Phase 9), so a fix here fixes both instead of just one.
export default function DayEntryTable({ entries }: { entries: LedgerEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-ink-muted">No activity.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-brand-soft/25 text-left text-xs uppercase text-ink-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Type</th>
            <th className="py-1 pr-3 font-medium">Description</th>
            <th className="py-1 text-right font-medium">Net cash</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-b border-brand-soft/15 last:border-0">
              <td className="py-1 pr-3 text-ink-muted">{e.type}</td>
              <td className="py-1 pr-3 text-ink">{e.description}</td>
              <td className="py-1 text-right tabular-nums text-ink">
                {usd(e.net_cash)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
