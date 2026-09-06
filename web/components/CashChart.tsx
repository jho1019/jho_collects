"use client";

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

// Cumulative net *cash*, not net worth. Dips below zero are normal: they mean
// inventory was bought and not yet sold.
export default function CashChart({ data }: { data: CashPoint[] }) {
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
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
            formatter={(v: unknown) => [usd(Number(v)), "cumulative net cash"]}
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
  );
}
