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
          <h2 className="text-sm font-semibold text-surface">
            Cumulative net cash
          </h2>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded border border-surface/40 bg-surface px-2 py-0.5 text-xs text-ink-muted"
          >
            {WINDOWS.map((w) => (
              <option key={w.label} value={w.days}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
        <span
          className={`text-lg font-semibold tabular-nums ${
            current < 0
              ? "rounded bg-surface px-2 py-0.5 text-accent-ink"
              : "text-surface"
          }`}
        >
          {usd(current)}
        </span>
      </div>
      <p className="text-xs text-surface/70">
        Cash in and out, not net worth. Dips below zero are normal — inventory
        bought and not yet sold.
      </p>

      <div className="rounded-lg border border-brand-soft/25 bg-surface p-3">
        <div className="h-80 w-full">
          <ResponsiveContainer>
            <LineChart
              data={data}
              margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-brand-soft)" opacity={0.25} />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11, fill: "var(--color-ink-muted)" }}
                minTickGap={48}
                tickFormatter={(d: string) => d.slice(5)}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--color-ink-muted)" }}
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
              <ReferenceLine y={0} stroke="var(--color-brand-soft)" />
              <Line
                type="monotone"
                dataKey="net"
                stroke="var(--color-brand)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        {data.length === 0 && (
          <p className="py-8 text-center text-sm text-ink-muted">
            No transactions yet.
          </p>
        )}
      </div>
    </div>
  );
}
