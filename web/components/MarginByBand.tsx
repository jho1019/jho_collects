"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type Band = {
  band: string;
  count: number;
  proceeds: number;
  cost: number;
  net: number;
  marginPct: number | null;
};

// All-in cost ran ~31% of proceeds on the real August data, and the fixed
// per-order fee + label means a $1 card nets close to nothing. This chart is
// meant to change what gets listed individually vs bundled into lots.
export default function MarginByBand({ bands }: { bands: Band[] }) {
  const data = bands.map((b) => ({
    ...b,
    margin: b.marginPct ?? 0,
  }));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 16, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-brand-soft)" opacity={0.25} />
          <XAxis dataKey="band" tick={{ fontSize: 11, fill: "var(--color-ink-muted)" }} />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--color-ink-muted)" }}
            width={44}
            tickFormatter={(v: number) => `${v}%`}
            domain={[0, 100]}
          />
          <Tooltip
            formatter={(v: unknown, _n: unknown, p: { payload?: { count?: number } }) => {
              const n = p?.payload?.count ?? 0;
              return [
                `${Number(v).toFixed(0)}% margin`,
                `${n} sale${n === 1 ? "" : "s"}`,
              ];
            }}
          />
          <Bar dataKey="margin" radius={[3, 3, 0, 0]}>
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={d.margin < 25 ? "var(--color-accent)" : "var(--color-brand)"}
              />
            ))}
            <LabelList
              dataKey="count"
              position="top"
              formatter={(v: unknown) => `n=${String(v)}`}
              fill="var(--color-ink-muted)"
              className="text-[10px]"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
