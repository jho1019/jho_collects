"use client";

import { useState } from "react";
import { usd } from "@/lib/format";
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
      <p className="rounded-lg border border-brand-soft/25 bg-surface px-3 py-6 text-center text-sm text-ink-muted">
        No deals yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {visits.map((v) => {
        const expanded = open.has(v.key);
        const dealIds = new Set(v.deals.map((d) => d.deal_id));
        const flows = [
          ...txns.filter((t) => dealIds.has(t.deal_id)).map((t) => Number(t.net_cash)),
          ...v.expenses.map((e) => Number(e.net_cash)),
        ];
        const received = flows.filter((n) => n > 0).reduce((a, n) => a + n, 0);
        const spent = -flows.filter((n) => n < 0).reduce((a, n) => a + n, 0);
        const net = received - spent;
        const cardsIn = v.deals.reduce((a, d) => a + Number(d.cards_in), 0);
        const cardsOut = v.deals.reduce((a, d) => a + Number(d.cards_out), 0);
        const review = v.deals.filter((d) => d.needs_review).length;

        return (
          <section key={v.key} className="rounded-lg border border-brand-soft/25 bg-surface">
            <button
              type="button"
              onClick={() => toggle(v.key)}
              aria-expanded={expanded}
              className="flex w-full flex-col gap-1 px-4 py-3 text-left"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="tabular-nums text-xs text-ink-muted">{v.date}</div>
                  <div className="truncate text-base font-semibold text-ink">
                    {v.showName ?? "No show"}
                    {review > 0 && (
                      <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 align-middle text-[10px] font-medium text-accent-ink">
                        {review} need{review === 1 ? "s" : ""} review
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`tabular-nums text-base font-semibold ${net < 0 ? "text-accent-ink" : "text-brand"}`}
                  >
                    {usd(net)}
                  </span>
                  <span
                    className={`text-ink-muted transition-transform ${expanded ? "rotate-180" : ""}`}
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
              <div className="space-y-3 border-t border-brand-soft/15 bg-page/40 p-3">
                {v.deals.length > 0 && (
                  <DealList deals={v.deals} txns={txns} cards={cards} grouped />
                )}
                {v.expenses.length > 0 && (
                  <div className="rounded-lg border border-brand-soft/25 bg-surface px-3 py-2">
                    <div className="mb-1 text-xs uppercase text-ink-muted">Show expenses</div>
                    <ul className="space-y-1 text-xs text-ink">
                      {v.expenses.map((e) => (
                        <li key={e.id} className="flex justify-between gap-2">
                          <span className="text-ink-muted">{e.description}</span>
                          <span className="tabular-nums">{usd(e.net_cash)}</span>
                        </li>
                      ))}
                    </ul>
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
