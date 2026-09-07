"use client";

import { useMemo, useState } from "react";
import { usd } from "@/lib/format";

export type Card = {
  id: number;
  title: string;
  player: string | null;
  year: string | null;
  set_name: string | null;
  parallel: string | null;
  grader: string | null;
  grade: string | null;
  status: "held" | "listed" | "sold";
  sku: string | null;
  acquisition_cost: string | number | null;
  acquired_on: string | null;
  sold_on: string | null;
  is_opening_stock: boolean;
};

export type TrackedInventory = {
  cards_on_hand: number;
  opening_stock_cards: number;
  acquired_since_start: number;
  cards_without_cost: number;
  known_cost_basis: string | number;
  opening_cost_basis: string | number;
  acquired_cost_basis: string | number;
} | null;

const STATUSES = ["all", "held", "listed", "sold"] as const;
type Filter = (typeof STATUSES)[number];

function grade(c: Card) {
  return [c.grader, c.grade].filter(Boolean).join(" ") || "raw";
}
function setLine(c: Card) {
  return [c.year, c.set_name, c.parallel].filter(Boolean).join(" ") || "—";
}

export default function CardInventory({
  cards,
  summary,
}: {
  cards: Card[];
  summary: TrackedInventory;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cards.filter((c) => {
      if (filter !== "all" && c.status !== filter) return false;
      if (!needle) return true;
      return [c.title, c.player, c.set_name, c.parallel, c.sku]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [cards, filter, q]);

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-zinc-700">
          Card inventory <span className="text-zinc-400">({rows.length})</span>
        </h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-zinc-300 text-xs">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`px-2 py-1 capitalize ${
                  filter === s
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-600 hover:bg-zinc-50"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter title / player / set / sku"
            className="w-56 rounded border border-zinc-300 px-2 py-1 text-xs"
          />
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600 sm:grid-cols-3">
          <Stat label="On hand" value={String(summary.cards_on_hand)} />
          <Stat
            label="Opening stock"
            value={`${summary.opening_stock_cards} · ${usd(summary.opening_cost_basis)}`}
          />
          <Stat
            label="Acquired since start"
            value={`${summary.acquired_since_start} · ${usd(summary.acquired_cost_basis)}`}
          />
          <Stat
            label="Without a cost"
            value={String(summary.cards_without_cost)}
          />
          <Stat
            label="Known cost basis"
            value={usd(summary.known_cost_basis)}
          />
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Card</th>
              <th className="px-3 py-2 font-medium">Set</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
              <th className="px-3 py-2 text-right font-medium">Acquired</th>
              <th className="px-3 py-2 text-right font-medium">Sold</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-zinc-100 last:border-0">
                <td className="px-3 py-2">
                  <span className="text-zinc-800">{c.title}</span>
                  <span className="ml-2 text-xs text-zinc-400">{grade(c)}</span>
                  {c.is_opening_stock && (
                    <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">
                      opening
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-zinc-600">{setLine(c)}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      c.status === "sold"
                        ? "bg-zinc-100 text-zinc-500"
                        : c.status === "listed"
                          ? "bg-amber-50 text-amber-700"
                          : "bg-green-50 text-green-700"
                    }`}
                  >
                    {c.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                  {c.acquisition_cost == null ? "—" : usd(c.acquisition_cost)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-600">
                  {c.acquired_on ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-600">
                  {c.sold_on ?? "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-400">
                  {cards.length === 0
                    ? "No tracked cards yet — bulk lots stay as cash rows."
                    : "No matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-zinc-400">{label}: </span>
      <span className="tabular-nums text-zinc-700">{value}</span>
    </div>
  );
}
