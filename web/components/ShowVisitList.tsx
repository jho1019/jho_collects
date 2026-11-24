"use client";

import { useState } from "react";
import { signedUsd, toneClass, usd } from "@/lib/format";
import DealList, { type Deal, type DealTxn, type DealCard } from "@/components/DealList";

// A show-level expense: admission, parking, table fee. Carries show_id with a
// null deal_id (DECISIONS.md), so it belongs to the visit, not to any deal.
export type ShowExpense = {
  id: number;
  show_id: number;
  occurred_on: string;
  description: string;
  net_cash: string | number;
};

export type DealShow = { deal_id: number; show_id: number | null };
export type ShowName = { id: number; name: string };

type Visit = {
  key: string;
  showName: string | null;
  date: string;
  deals: Deal[];
  expenses: ShowExpense[];
};

// One visit = one show on one day. Grouping on show_id alone would lump every
// week of a recurring show whose row spans months (e.g. Anaheim through 12/31)
// into a single bucket. Deals with no show group per day under "No show".
function groupVisits(
  deals: Deal[],
  dealShows: DealShow[],
  shows: ShowName[],
  expenses: ShowExpense[],
): Visit[] {
  const showOf = new Map(dealShows.map((d) => [d.deal_id, d.show_id]));
  const nameOf = new Map(shows.map((s) => [s.id, s.name]));
  const visits = new Map<string, Visit>();

  function visitFor(showId: number | null, date: string): Visit {
    const key = `${showId ?? "none"}|${date}`;
    let v = visits.get(key);
    if (!v) {
      v = {
        key,
        showName: showId == null ? null : (nameOf.get(showId) ?? "Unknown show"),
        date,
        deals: [],
        expenses: [],
      };
      visits.set(key, v);
    }
    return v;
  }

  for (const d of deals) visitFor(showOf.get(d.deal_id) ?? null, d.occurred_on).deals.push(d);
  for (const e of expenses) visitFor(e.show_id, e.occurred_on).expenses.push(e);

  return [...visits.values()].sort((a, b) =>
    a.date === b.date ? a.key.localeCompare(b.key) : b.date.localeCompare(a.date),
  );
}

export default function ShowVisitList({
  deals,
  txns,
  cards,
  dealShows,
  shows,
  expenses,
}: {
  deals: Deal[];
  txns: DealTxn[];
  cards: DealCard[];
  dealShows: DealShow[];
  shows: ShowName[];
  expenses: ShowExpense[];
}) {
  const visits = groupVisits(deals, dealShows, shows, expenses);
  // Most recent visit starts open; the rest are one tap away.
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(visits.length > 0 ? [visits[0].key] : []),
  );

  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (visits.length === 0) {
    return (
      <p className="board bd text-center text-sm text-ink-muted">No deals yet.</p>
    );
  }

  return (
    <div className="grid gap-[22px]">
      {visits.map((v) => {
        const expanded = open.has(v.key);
        const dealIds = new Set(v.deals.map((d) => d.deal_id));
        const flows = [
          ...txns.filter((t) => dealIds.has(t.deal_id)).map((t) => Number(t.net_cash)),
          ...v.expenses.map((e) => Number(e.net_cash)),
        ];
        const received = flows.filter((n) => n > 0).reduce((a, n) => a + n, 0);
        // Subtract rather than negate a sum: -(0) is -0, which formats as "-$0.00".
        const spent = flows.filter((n) => n < 0).reduce((a, n) => a - n, 0);
        const net = received - spent;
        const cardsIn = v.deals.reduce((a, d) => a + Number(d.cards_in), 0);
        const cardsOut = v.deals.reduce((a, d) => a + Number(d.cards_out), 0);
        const review = v.deals.filter((d) => d.needs_review).length;

        return (
          <section key={v.key} className="board">
            <button
              type="button"
              onClick={() => toggle(v.key)}
              aria-expanded={expanded}
              className="bd flex w-full flex-col gap-1.5 text-left"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="bl">
                    <span className="tabular-nums">{v.date}</span>
                  </div>
                  <div className="mt-1 text-[15px] font-semibold text-ink">
                    {v.showName ?? "No show"}
                    {review > 0 && (
                      <span className="pill pill-rev ml-2">
                        {review} need{review === 1 ? "s" : ""} review
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <span
                    className={`num text-[28px] font-extrabold leading-none ${toneClass(net, "text-ink-muted")}`}
                  >
                    {signedUsd(net)}
                  </span>
                  <span
                    className={`text-ink-muted transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
                    aria-hidden
                  >
                    ▾
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-muted">
                <span>
                  {v.deals.length} deal{v.deals.length === 1 ? "" : "s"}
                </span>
                <span>
                  {cardsIn} in · {cardsOut} out
                </span>
                <span className="tabular-nums">spent {usd(spent)}</span>
                <span className="tabular-nums">received {usd(received)}</span>
              </div>
            </button>

            {expanded && (
              <div className="space-y-4 border-t border-line px-6 pb-5 pt-4 max-sm:px-3.5">
                {v.deals.length > 0 && (
                  <DealList deals={v.deals} txns={txns} cards={cards} grouped />
                )}
                {v.expenses.length > 0 && (
                  <div>
                    <h3 className="bl bl-mute">Expenses</h3>
                    <table className="tb mt-1">
                      <thead>
                        <tr>
                          <th>Show expense</th>
                          <th className="r">Net cash</th>
                        </tr>
                      </thead>
                      <tbody>
                        {v.expenses.map((e) => (
                          <tr key={e.id}>
                            <td className="mute">{e.description}</td>
                            <td className={`r whitespace-nowrap ${toneClass(e.net_cash)}`}>
                              {signedUsd(e.net_cash)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
