"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { usd } from "@/lib/format";

export type CashPoint = { day: string; net: number };

const WINDOWS: { label: string; days: number }[] = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "All", days: Number.POSITIVE_INFINITY },
];

// Cumulative net *cash*, not net worth. `series` is one point per day from the
// first transaction through today; the window control just clips the tail.
export default function CashChart({ series }: { series: CashPoint[] }) {
  const [days, setDays] = useState(90);

  const data = useMemo(
    () => (Number.isFinite(days) ? series.slice(-days) : series),
    [series, days],
  );
  const current = series.at(-1)?.net ?? 0;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-medium text-zinc-700">
            Cumulative net cash
          </h2>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-600"
          >
            {WINDOWS.map((w) => (
              <option key={w.label} value={w.days}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
        <span className="text-lg font-semibold tabular-nums text-zinc-900">
          {usd(current)}
        </span>
      </div>
      <p className="text-xs text-zinc-500">
        Cash in and out, not net worth. Dips below zero are normal — inventory
        bought and not yet sold.
      </p>

      <div className="rounded-lg border border-zinc-200 bg-white p-3">
        <div className="h-80 w-full">
          <ResponsiveContainer>
            <LineChart
              data={data}
              margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11 }}
                minTickGap={48}
                tickFormatter={(d: string) => d.slice(5)}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                width={64}
                tickFormatter={(v: number) => usd(v)}
              />
              <Tooltip
                formatter={(v: unknown) => [
                  usd(Number(v)),
                  "cumulative net cash",
                ]}
                labelFormatter={(d: unknown) => String(d)}
              />
              <ReferenceLine y={0} stroke="#a1a1aa" />
              <Line
                type="monotone"
                dataKey="net"
                stroke="#2563eb"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        {data.length === 0 && (
          <p className="py-8 text-center text-sm text-zinc-400">
            No transactions yet.
          </p>
        )}
      </div>
    </div>
  );
}
