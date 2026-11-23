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
        className={`sortable ${right ? "r" : ""} ${active ? "!text-ink" : ""}`}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.currentTarget.click();
          }
        }}
        onClick={() => {
          if (active) setDir(dir === "asc" ? "desc" : "asc");
          else {
            setSort(key);
            setDir(NUMERIC.includes(key) || key === "last_order_on" ? "desc" : "asc");
          }
        }}
      >
        {label}
        {active && (
          <span className="text-amber" aria-hidden>
            {dir === "asc" ? " ▴" : " ▾"}
          </span>
        )}
      </th>
    );
  }

  return (
    <section className="board bd">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="bl">People ({rows.length})</h2>
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              className="chk"
              checked={repeatOnly}
              onChange={(e) => setRepeatOnly(e.target.checked)}
            />
            repeat only
          </label>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter username / name / state"
            aria-label="Filter people"
            className="field w-full sm:w-[270px]"
          />
        </div>
      </div>

      {/* Below 700px: a sort <select> stands in for the table's clickable
          headers, then one card per buyer. */}
      <div className="mt-3 flex items-center gap-2 sm:hidden">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="field field-sm"
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
          className="btn sm"
        >
          {dir === "asc" ? "▲ asc" : "▼ desc"}
        </button>
      </div>

      <div className="mt-3 grid gap-2.5 sm:hidden">
        {rows.map((b) => (
          <div key={b.platform_username} className="cellrow text-[13px]">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="text-ink">{b.platform_username}</span>
                {b.is_repeat_buyer && <span className="pill pill-rep ml-2">repeat</span>}
                {b.display_name && (
                  <div className="text-xs text-ink-muted">{b.display_name}</div>
                )}
              </div>
              <span className="shrink-0 text-xs text-ink-muted">{b.last_state ?? "—"}</span>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] text-ink-muted">
              <span>
                Orders <b className="font-medium tabular-nums text-ink">{b.distinct_orders}</b>
              </span>
              <span>
                Last order{" "}
                <b className="whitespace-nowrap font-medium tabular-nums text-ink">{b.last_order_on ?? "—"}</b>
              </span>
              <span>
                Gross <b className="font-medium tabular-nums text-ink">{usd(b.lifetime_gross)}</b>
              </span>
              <span>
                Net <b className="font-medium tabular-nums text-ink">{usd(b.lifetime_net)}</b>
              </span>
              <span>
                Avg price{" "}
                <b className="font-medium tabular-nums text-ink">{usd(b.avg_item_price)}</b>
              </span>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="sub py-6 text-center">
            {buyers.length === 0 ? "No buyers yet." : "No matches."}
          </p>
        )}
      </div>

      <div className="mt-3 hidden overflow-x-auto sm:block">
        <table className="tb">
          <thead>
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
              <tr key={b.platform_username}>
                <td>
                  {b.platform_username}
                  {b.is_repeat_buyer && <span className="pill pill-rep ml-2">repeat</span>}
                  {b.display_name && (
                    <div className="text-xs text-ink-muted">{b.display_name}</div>
                  )}
                </td>
                <td className="mute">{b.last_state ?? "—"}</td>
                <td className="r mute">{b.distinct_orders}</td>
                <td className="r">{usd(b.lifetime_gross)}</td>
                <td className="r">{usd(b.lifetime_net)}</td>
                <td className="r">{usd(b.avg_item_price)}</td>
                <td className="r mute whitespace-nowrap">{b.last_order_on ?? "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-ink-muted">
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
