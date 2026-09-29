"use client";

import { useMemo, useState } from "react";
import { usd } from "@/lib/format";

export type Buyer = {
  platform_username: string;
  display_name: string | null;
  last_city: string | null;
  last_state: string | null;
  order_count: number;
  distinct_orders: number;
  lifetime_gross: string | number;
  lifetime_net: string | number;
  avg_item_price: string | number;
  last_order_on: string | null;
  is_repeat_buyer: boolean;
};

type SortKey =
  | "platform_username"
  | "last_state"
  | "distinct_orders"
  | "lifetime_gross"
  | "lifetime_net"
  | "avg_item_price"
  | "last_order_on";

const NUMERIC: SortKey[] = [
  "distinct_orders",
  "lifetime_gross",
  "lifetime_net",
  "avg_item_price",
];

// Mirrors the table's column headers — used to build the mobile sort
// <select>, since a card list has no header row of its own to click.
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "platform_username", label: "Buyer" },
  { key: "last_state", label: "State" },
  { key: "distinct_orders", label: "Orders" },
  { key: "lifetime_gross", label: "Lifetime gross" },
  { key: "lifetime_net", label: "Lifetime net" },
  { key: "avg_item_price", label: "Avg price" },
  { key: "last_order_on", label: "Last order" },
];

export default function BuyerList({ buyers }: { buyers: Buyer[] }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("last_order_on");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [repeatOnly, setRepeatOnly] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = buyers.filter((b) => {
      if (repeatOnly && !b.is_repeat_buyer) return false;
      if (!needle) return true;
      return [b.platform_username, b.display_name, b.last_state, b.last_city]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
    out = [...out].sort((a, b) => {
      const av = a[sort] ?? "";
      const bv = b[sort] ?? "";
      const cmp = NUMERIC.includes(sort)
        ? Number(av) - Number(bv)
        : String(av).localeCompare(String(bv));
      return dir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [buyers, q, sort, dir, repeatOnly]);

  function header(key: SortKey, label: string, right = false) {
    const active = sort === key;
    return (
      <th
        className={`cursor-pointer select-none px-3 py-2 font-medium ${right ? "text-right" : "text-left"}`}
        onClick={() => {
          if (active) setDir(dir === "asc" ? "desc" : "asc");
          else {
            setSort(key);
            setDir(NUMERIC.includes(key) || key === "last_order_on" ? "desc" : "asc");
          }
        }}
      >
        {label}
        {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
      </th>
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-surface">
          People{" "}
          <span className="font-normal text-surface/70">({rows.length})</span>
        </h2>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <label className="flex items-center gap-1 text-xs text-surface/80">
            <input
              type="checkbox"
              checked={repeatOnly}
              onChange={(e) => setRepeatOnly(e.target.checked)}
            />
            repeat only
          </label>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter username / name / state"
            className="w-full rounded border border-surface/40 bg-surface px-2 py-1 text-xs text-ink sm:w-56"
          />
        </div>
      </div>

      {/* Below md: a sort <select> stands in for the table's clickable
          headers, then one card per buyer. md+: the table, unchanged. */}
      <div className="flex items-center gap-2 md:hidden">
        <label className="flex items-center gap-1.5 text-xs text-ink-muted">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded border border-brand-soft/40 bg-surface px-1.5 py-1 text-xs text-ink"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setDir(dir === "asc" ? "desc" : "asc")}
          className="rounded border border-brand-soft/40 px-2 py-1 text-xs text-ink-muted"
        >
          {dir === "asc" ? "▲ asc" : "▼ desc"}
        </button>
      </div>

      <div className="space-y-2 md:hidden">
        {rows.map((b) => (
          <div
            key={b.platform_username}
            className="rounded-lg border border-brand-soft/25 bg-surface px-3 py-2 text-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="text-ink">{b.platform_username}</span>
                {b.is_repeat_buyer && (
                  <span className="ml-2 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">
                    repeat
                  </span>
                )}
                {b.display_name && (
                  <div className="text-xs text-ink-muted">{b.display_name}</div>
                )}
              </div>
              <span className="shrink-0 text-xs text-ink-muted">{b.last_state ?? "—"}</span>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-ink-muted">
              <span>
                Orders <span className="tabular-nums text-ink">{b.distinct_orders}</span>
              </span>
              <span>
                Last order <span className="tabular-nums text-ink">{b.last_order_on ?? "—"}</span>
              </span>
              <span>
                Gross <span className="tabular-nums text-ink">{usd(b.lifetime_gross)}</span>
              </span>
              <span>
                Net <span className="tabular-nums text-ink">{usd(b.lifetime_net)}</span>
              </span>
              <span>
                Avg price <span className="tabular-nums text-ink">{usd(b.avg_item_price)}</span>
              </span>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="rounded-lg border border-brand-soft/25 bg-surface px-3 py-6 text-center text-sm text-ink-muted">
            {buyers.length === 0 ? "No buyers yet." : "No matches."}
          </p>
        )}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border border-brand-soft/25 bg-surface md:block">
        <table className="w-full text-sm">
          <thead className="border-b border-brand-soft/25 text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              {header("platform_username", "Buyer")}
              {header("last_state", "State")}
              {header("distinct_orders", "Orders", true)}
              {header("lifetime_gross", "Lifetime gross", true)}
              {header("lifetime_net", "Lifetime net", true)}
              {header("avg_item_price", "Avg price", true)}
              {header("last_order_on", "Last order", true)}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr
                key={b.platform_username}
                className="border-b border-brand-soft/15 last:border-0"
              >
                <td className="px-3 py-2">
                  <span className="text-ink">{b.platform_username}</span>
                  {b.is_repeat_buyer && (
                    <span className="ml-2 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">
                      repeat
                    </span>
                  )}
                  {b.display_name && (
                    <div className="text-xs text-ink-muted">{b.display_name}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-ink-muted">
                  {b.last_state ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                  {b.distinct_orders}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink">
                  {usd(b.lifetime_gross)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink">
                  {usd(b.lifetime_net)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink">
                  {usd(b.avg_item_price)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                  {b.last_order_on ?? "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-ink-muted">
                  {buyers.length === 0 ? "No buyers yet." : "No matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
