"use client";

import { Fragment, useState } from "react";
import { signedUsd, toneClass, usd } from "@/lib/format";

export type Deal = {
  deal_id: number;
  occurred_on: string;
  event_name: string | null;
  counterparty: string | null;
  net_cash: string | number;
  txn_count: number;
  cards_in: number;
  cards_out: number;
  kind: "trade" | "purchase" | "sale" | "cash_only";
  needs_review: boolean;
  notes: string | null;
};

export type DealTxn = {
  id: number;
  deal_id: number;
  occurred_on: string;
  type: string;
  description: string;
  item_amount: string | number;
  net_cash: string | number;
};

export type DealCard = {
  id: number;
  title: string;
  acquisition_cost: string | number | null;
  acquired_deal_id: number | null;
  disposed_deal_id: number | null;
};

// Kind pills reuse the 6.15 status palette: sale = amber (as on the
// calendar's entries table), purchase = muted, trade = neg (as "traded"),
// cash only = muted. The word is always printed.
function kindBadge(kind: Deal["kind"]) {
  switch (kind) {
    case "sale":
      return "pill pill-amber";
    case "trade":
      return "pill pill-traded";
    case "purchase":
    case "cash_only":
    default:
      return "pill pill-mute";
  }
}

// Shared between the desktop table's expanded row and the mobile card's
// expanded section — same three-column breakdown either way.
function DealDetail({
  dealTxns,
  cardsIn,
  cardsOut,
  notes,
}: {
  dealTxns: DealTxn[];
  cardsIn: DealCard[];
  cardsOut: DealCard[];
  notes: string | null;
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <h4 className="bl bl-mute mb-1">Transactions</h4>
          {dealTxns.length === 0 ? (
            <p className="text-xs text-ink-muted">No cash rows.</p>
          ) : (
            <ul className="space-y-1 text-[12px] text-ink">
              {dealTxns.map((t) => (
                <li key={t.id} className="flex justify-between gap-2">
                  <span className="text-ink-muted">
                    {t.type} — {t.description}
                  </span>
                  <span className={`shrink-0 tabular-nums ${toneClass(t.net_cash)}`}>
                    {signedUsd(t.net_cash)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="bl bl-mute mb-1">Cards in</h4>
          {cardsIn.length === 0 ? (
            <p className="text-xs text-ink-muted">None.</p>
          ) : (
            <ul className="space-y-1 text-[12px] text-ink">
              {cardsIn.map((c) => (
                <li key={c.id} className="flex justify-between gap-2">
                  <span>{c.title}</span>
                  <span className="shrink-0 tabular-nums text-ink-muted">
                    {c.acquisition_cost == null ? "—" : usd(c.acquisition_cost)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="bl bl-mute mb-1">Cards out</h4>
          {cardsOut.length === 0 ? (
            <p className="text-xs text-ink-muted">None.</p>
          ) : (
            <ul className="space-y-1 text-[12px] text-ink">
              {cardsOut.map((c) => (
                <li key={c.id} className="flex justify-between gap-2">
                  <span>{c.title}</span>
                  <span className="shrink-0 tabular-nums text-ink-muted">
                    {c.acquisition_cost == null ? "—" : usd(c.acquisition_cost)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {notes && <p className="sub mt-3 italic">{notes}</p>}
    </>
  );
}

// Inside a show visit the date and show name are already in the group header,
// so a grouped list labels each deal by what moved instead.
function dealLabel(d: Deal, dealTxns: DealTxn[]): string {
  return dealTxns[0]?.description ?? d.notes ?? d.counterparty ?? "—";
}

export default function DealList({
  deals,
  txns,
  cards,
  grouped = false,
}: {
  deals: Deal[];
  txns: DealTxn[];
  cards: DealCard[];
  grouped?: boolean;
}) {
  const cols = grouped ? 7 : 8;
  const [open, setOpen] = useState<Set<number>>(new Set());

  function toggle(id: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      {/* Below 700px: one card per deal, same tap-to-expand behaviour as the
          table's row click — an 8-column table has no room on a phone. */}
      <div className="space-y-2 sm:hidden">
        {deals.map((d) => {
          const expanded = open.has(d.deal_id);
          const net = Number(d.net_cash);
          const dealTxns = txns.filter((t) => t.deal_id === d.deal_id);
          const cardsIn = cards.filter((c) => c.acquired_deal_id === d.deal_id);
          const cardsOut = cards.filter((c) => c.disposed_deal_id === d.deal_id);
          return (
            <div key={d.deal_id} className="cellrow !p-0">
              <button
                type="button"
                onClick={() => toggle(d.deal_id)}
                aria-expanded={expanded}
                className="flex w-full flex-col gap-1 px-3 py-2.5 text-left text-[13px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="tabular-nums text-xs text-ink-muted">
                    {grouped ? "" : d.occurred_on}
                  </span>
                  <span className={kindBadge(d.kind)}>{d.kind.replace("_", " ")}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink">
                    {grouped ? dealLabel(d, dealTxns) : (d.event_name ?? "—")}
                    {d.needs_review && <span className="pill pill-rev ml-2">needs review</span>}
                  </span>
                  <span
                    className={`shrink-0 text-ink-muted transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
                    aria-hidden
                  >
                    ▾
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs text-ink-muted">
                  <span>{d.counterparty ?? "—"}</span>
                  <span className="flex items-center gap-3">
                    <span>
                      {d.cards_in} in · {d.cards_out} out
                    </span>
                    <span className={`font-medium tabular-nums ${toneClass(net, "text-ink")}`}>
                      {signedUsd(net)}
                    </span>
                  </span>
                </div>
              </button>
              {expanded && (
                <div className="border-t border-line px-3 py-3">
                  <DealDetail
                    dealTxns={dealTxns}
                    cardsIn={cardsIn}
                    cardsOut={cardsOut}
                    notes={d.notes}
                  />
                </div>
              )}
            </div>
          );
        })}
        {deals.length === 0 && <p className="sub py-6 text-center">No deals yet.</p>}
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table className="tb">
          <thead>
            <tr>
              <th className="w-6" aria-label="Expand" />
              {grouped ? (
                <th>Deal</th>
              ) : (
                <>
                  <th>Date</th>
                  <th>Event</th>
                </>
              )}
              <th>Counterparty</th>
              <th>Kind</th>
              <th className="r">Net cash</th>
              <th className="r">Cards in</th>
              <th className="r">Cards out</th>
            </tr>
          </thead>
          <tbody>
            {deals.map((d) => {
              const expanded = open.has(d.deal_id);
              const net = Number(d.net_cash);
              const dealTxns = txns.filter((t) => t.deal_id === d.deal_id);
              const cardsIn = cards.filter((c) => c.acquired_deal_id === d.deal_id);
              const cardsOut = cards.filter((c) => c.disposed_deal_id === d.deal_id);
              return (
                <Fragment key={d.deal_id}>
                  <tr
                    onClick={() => toggle(d.deal_id)}
                    className="cursor-pointer hover:bg-cell"
                  >
                    <td className="mute">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={expanded ? "Collapse deal" : "Expand deal"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(d.deal_id);
                        }}
                      >
                        {expanded ? "▾" : "▸"}
                      </button>
                    </td>
                    {!grouped && (
                      <td className="mute whitespace-nowrap tabular-nums">{d.occurred_on}</td>
                    )}
                    <td>
                      {grouped ? dealLabel(d, dealTxns) : (d.event_name ?? "—")}
                      {d.needs_review && <span className="pill pill-rev ml-2">needs review</span>}
                    </td>
                    <td className="mute">{d.counterparty ?? "—"}</td>
                    <td>
                      <span className={kindBadge(d.kind)}>{d.kind.replace("_", " ")}</span>
                    </td>
                    <td className={`r whitespace-nowrap ${toneClass(net)}`}>{signedUsd(net)}</td>
                    <td className="r mute">{d.cards_in}</td>
                    <td className="r mute">{d.cards_out}</td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={cols} className="bg-cell !px-6 !py-3">
                        <DealDetail
                          dealTxns={dealTxns}
                          cardsIn={cardsIn}
                          cardsOut={cardsOut}
                          notes={d.notes}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {deals.length === 0 && (
              <tr>
                <td colSpan={cols} className="py-6 text-center text-ink-muted">
                  No deals yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
