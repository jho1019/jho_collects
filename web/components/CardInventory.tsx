"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usd } from "@/lib/format";
import { inventoryStats, isFiltered } from "@/lib/inventoryStats";

export type Card = {
  id: number;
  title: string;
  player: string | null;
  year: string | null;
  set_name: string | null;
  parallel: string | null;
  grader: string | null;
  grade: string | null;
  status: "held" | "listed" | "sold" | "traded";
  /** pc | business | riftbound | sealed (025); pc is not business inventory. */
  category?: string | null;
  sku: string | null;
  acquisition_cost: string | number | null;
  acquired_on: string | null;
  exited_on: string | null;
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

const STATUSES = ["all", "held", "listed", "sold", "traded"] as const;
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
  missingCost = false,
}: {
  cards: Card[];
  summary: TrackedInventory;
  /** ?cost=missing is active (spec I6); the chip links in and out of it. */
  missingCost?: boolean;
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

  // Spec 17.3 #3: the strip follows the filters so it matches the table.
  // Unfiltered it is the tracked_inventory view, unchanged.
  const filtered = isFiltered(filter, q, missingCost);
  const stats = filtered
    ? inventoryStats(rows, filter, missingCost)
    : summary && { label: "On hand", ...summary };

  const emptyText =
    cards.length === 0
      ? missingCost
        ? "No sold cards are missing a cost."
        : "No tracked cards yet — bulk lots stay as cash rows."
      : "No matches.";

  return (
    <section className="board bd">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="bl">Card inventory ({rows.length})</h2>
        <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto">
          <div className="seg" role="group" aria-label="Status">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={filter === s}
                onClick={() => setFilter(s)}
              >
                {s}
              </button>
            ))}
          </div>
          {/* I6: the dashboard's "Fix N sales" target as a filter chip. A
              link, because the filter lives in the URL (server-side). */}
          <div className="seg" role="group" aria-label="Cost filter">
            <Link
              href={missingCost ? "/inventory" : "/inventory?cost=missing"}
              aria-pressed={missingCost}
              className={missingCost ? "on" : undefined}
              title={missingCost ? "Show all cards" : "Sold cards with no cost"}
            >
              No cost
            </Link>
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter title / player / set / sku"
            aria-label="Filter cards"
            // 17.3 #1: 33 chars of 13px Plex Mono (7.8px advance) is ~258px of
            // text (264px measured); 270px border-box minus padding clipped "sku". 296px
            // fits it with room for the caret; shrink-0 stops the flex row eating it.
            className="field w-full sm:w-[296px] sm:shrink-0"
          />
        </div>
      </div>

      {stats && (
        <div className="strip my-3.5">
          <div>
            <small>{stats.label}</small>
            <b>{stats.cards_on_hand}</b>
          </div>
          <div>
            <small>Without a cost</small>
            <b className={stats.cards_without_cost > 0 ? "text-amber" : undefined}>
              {stats.cards_without_cost}
            </b>
          </div>
          <div>
            <small>Opening stock</small>
            <b>
              {stats.opening_stock_cards} · {usd(stats.opening_cost_basis)}
            </b>
          </div>
          <div>
            <small>Known cost basis</small>
            <b>{usd(stats.known_cost_basis)}</b>
          </div>
          <div>
            <small>Acquired since start</small>
            <b>
              {stats.acquired_since_start} · {usd(stats.acquired_cost_basis)}
            </b>
          </div>
        </div>
      )}

      {/* Same table at every width; Set / Acquired / Exited fold away below
          700px and the set line moves under the card name. */}
      <div className="overflow-x-auto">
        <table className="tb">
          <thead>
            <tr>
              <th>Card</th>
              <th className="hm">Set</th>
              <th>Status</th>
              <th className="r">Cost</th>
              <th className="r hm">Acquired</th>
              <th className="r hm">Exited</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.title}
                  <span className="tg">{grade(c)}</span>
                  {c.is_opening_stock && <span className="tg">opening</span>}
                  {c.acquisition_cost == null && (
                    <span className="tg tg-amber">no cost</span>
                  )}
                  <span className="sm-only mt-0.5 block text-[11px] text-ink-muted">
                    {setLine(c)} · {c.acquired_on ?? "—"}
                    {c.exited_on && <> → {c.exited_on}</>}
                  </span>
                </td>
                <td className="hm mute">{setLine(c)}</td>
                <td>
                  <span className={statusPill(c.status)}>{c.status}</span>
                </td>
                <td className="r whitespace-nowrap">
                  {c.acquisition_cost == null ? "—" : usd(c.acquisition_cost)}
                </td>
                <td className="r hm mute whitespace-nowrap">{c.acquired_on ?? "—"}</td>
                <td className="r hm mute whitespace-nowrap">{c.exited_on ?? "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-ink-muted">
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Spec 6.15: held = blue, listed = amber, sold = muted, traded = neg.
function statusPill(status: Card["status"]) {
  switch (status) {
    case "held":
      return "pill pill-held";
    case "listed":
      return "pill pill-listed";
    case "traded":
      return "pill pill-traded";
    case "sold":
    default:
      return "pill pill-sold";
  }
}
