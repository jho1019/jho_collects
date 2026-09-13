"use client";

import { Fragment, useState } from "react";
import { usd } from "@/lib/format";

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

function kindBadge(kind: Deal["kind"]) {
  switch (kind) {
    case "sale":
      return "bg-brand/10 text-brand";
    case "purchase":
      return "bg-accent/15 text-accent-ink";
    case "trade":
      return "bg-brand-soft/20 text-ink";
    case "cash_only":
    default:
      return "bg-brand-soft/10 text-ink-muted";
  }
}

export default function DealList({
  deals,
  txns,
  cards,
}: {
  deals: Deal[];
  txns: DealTxn[];
  cards: DealCard[];
}) {
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
    <div className="overflow-x-auto rounded-lg border border-brand-soft/25 bg-surface">
      <table className="w-full text-sm">
        <thead className="border-b border-brand-soft/25 text-left text-xs uppercase text-ink-muted">
          <tr>
            <th className="w-6 px-3 py-2" />
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Event</th>
            <th className="px-3 py-2 font-medium">Counterparty</th>
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 text-right font-medium">Net cash</th>
            <th className="px-3 py-2 text-right font-medium">Cards in</th>
            <th className="px-3 py-2 text-right font-medium">Cards out</th>
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
                  className="cursor-pointer border-b border-brand-soft/15 last:border-0 hover:bg-brand-soft/5"
                >
                  <td className="px-3 py-2 text-ink-muted">{expanded ? "▾" : "▸"}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-ink-muted">
                    {d.occurred_on}
                  </td>
                  <td className="px-3 py-2 text-ink">
                    {d.event_name ?? "—"}
                    {d.needs_review && (
                      <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent-ink">
                        needs review
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{d.counterparty ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${kindBadge(d.kind)}`}
                    >
                      {d.kind.replace("_", " ")}
                    </span>
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums font-medium ${
                      net < 0 ? "text-accent-ink" : "text-brand"
                    }`}
                  >
                    {usd(net)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                    {d.cards_in}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                    {d.cards_out}
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b border-brand-soft/15 last:border-0">
                    <td colSpan={8} className="bg-page/60 px-6 py-3">
                      <div className="grid gap-4 sm:grid-cols-3">
                        <div>
                          <div className="mb-1 text-xs uppercase text-ink-muted">
                            Transactions
                          </div>
                          {dealTxns.length === 0 ? (
                            <p className="text-xs text-ink-muted">No cash rows.</p>
                          ) : (
                            <ul className="space-y-1 text-xs text-ink">
                              {dealTxns.map((t) => (
                                <li key={t.id} className="flex justify-between gap-2">
                                  <span className="text-ink-muted">
                                    {t.type} — {t.description}
                                  </span>
                                  <span className="tabular-nums">{usd(t.net_cash)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div>
                          <div className="mb-1 text-xs uppercase text-ink-muted">
                            Cards in
                          </div>
                          {cardsIn.length === 0 ? (
                            <p className="text-xs text-ink-muted">None.</p>
                          ) : (
                            <ul className="space-y-1 text-xs text-ink">
                              {cardsIn.map((c) => (
                                <li key={c.id} className="flex justify-between gap-2">
                                  <span>{c.title}</span>
                                  <span className="tabular-nums text-ink-muted">
                                    {c.acquisition_cost == null ? "—" : usd(c.acquisition_cost)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div>
                          <div className="mb-1 text-xs uppercase text-ink-muted">
                            Cards out
                          </div>
                          {cardsOut.length === 0 ? (
                            <p className="text-xs text-ink-muted">None.</p>
                          ) : (
                            <ul className="space-y-1 text-xs text-ink">
                              {cardsOut.map((c) => (
                                <li key={c.id} className="flex justify-between gap-2">
                                  <span>{c.title}</span>
                                  <span className="tabular-nums text-ink-muted">
                                    {c.acquisition_cost == null ? "—" : usd(c.acquisition_cost)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                      {d.notes && (
                        <p className="mt-3 text-xs italic text-ink-muted">{d.notes}</p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {deals.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-6 text-center text-ink-muted">
                No deals yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
