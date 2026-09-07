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
        <h2 className="text-sm font-medium text-zinc-700">
          Buyers{" "}
          <span className="text-zinc-400">({rows.length})</span>
        </h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-zinc-600">
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
            className="w-56 rounded border border-zinc-300 px-2 py-1 text-xs"
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
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
                className="border-b border-zinc-100 last:border-0"
              >
                <td className="px-3 py-2">
                  <span className="text-zinc-800">{b.platform_username}</span>
                  {b.is_repeat_buyer && (
                    <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                      repeat
                    </span>
                  )}
                  {b.display_name && (
                    <div className="text-xs text-zinc-400">{b.display_name}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-zinc-600">
                  {b.last_state ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                  {b.distinct_orders}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-800">
                  {usd(b.lifetime_gross)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-800">
                  {usd(b.lifetime_net)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-800">
                  {usd(b.avg_item_price)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-600">
                  {b.last_order_on ?? "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-zinc-400">
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
