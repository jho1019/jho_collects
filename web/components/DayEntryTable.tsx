import { signedUsd, toneClass } from "@/lib/format";
import type { LedgerEntry } from "@/lib/ledgerTypes";

// Type pill colours follow the calendar mock (page_calendar_desktop_full.png):
// sale = amber outline, refund = neg, everything else muted. The text is
// always there, so colour is never the only signal.
function typePill(type: string) {
  if (type === "sale") return "pill pill-amber";
  if (type === "refund") return "pill pill-neg";
  return "pill pill-mute";
}

// One day's ledger entries, in the row shape a day-detail panel uses — no
// running_total, since a single day carries no cumulative meaning of its own.
// Shared by CashChart's click-to-pin panel (Phase 8) and the calendar's
// click-a-day panel (Phase 9), so a fix here fixes both instead of just one.
export default function DayEntryTable({ entries }: { entries: LedgerEntry[] }) {
  if (entries.length === 0) {
    return <p className="sub">No activity.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="tb">
        <thead>
          <tr>
            <th>Type</th>
            <th>Description</th>
            <th className="r">Net cash</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>
                <span className={typePill(e.type)}>{e.type}</span>
              </td>
              <td>{e.description}</td>
              <td className={`r whitespace-nowrap ${toneClass(e.net_cash)}`}>
                {signedUsd(e.net_cash)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
