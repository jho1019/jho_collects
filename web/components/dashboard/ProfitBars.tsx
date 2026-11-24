"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { Bucket } from "@/lib/dashboard/model";
import { MINUS, barScale, fmtAxis } from "@/lib/dashboard/format";
import { useReducedMotion } from "./useReducedMotion";

// Profit by period split by channel (spec 6.6). Same buckets as the line
// score, so the two always agree. stackOffset="sign" puts negative periods
// below $0. The total sits 9px above the positive stack (or on the baseline
// when there is none) with a board-coloured halo. Current period is hatched.
type Key = "ebay" | "shows" | "other";
const SERIES: { key: Key; color: string }[] = [
  { key: "ebay", color: "var(--color-series-1)" },
  { key: "shows", color: "var(--color-series-2)" },
  { key: "other", color: "var(--color-ink-muted)" },
];

type Row = {
  label: string; current: boolean; ebay: number; shows: number; other: number; total: number; sales: number;
  anchor: Key | null;
  // row index on the anchor series only; LabelList skips empty entries, so
  // its own `index` does not line up with the data row
  lab_ebay?: number; lab_shows?: number; lab_other?: number;
};

export default function ProfitBars({ buckets, hasOther }: { buckets: Bucket[]; hasOther: boolean }) {
  const reduced = useReducedMotion();
  const dense = buckets.length > 8;
  const series = SERIES.filter((s) => s.key !== "other" || hasOther);

  const rows: Row[] = buckets.map((b, i) => {
    const v = { ebay: b.ebay / 100, shows: b.shows / 100, other: b.other / 100 };
    // label anchor: the top positive segment, else the first negative one
    // (whose top edge is the $0 line in a sign-offset stack)
    const pos = series.filter((s) => v[s.key] > 0);
    const neg = series.filter((s) => v[s.key] < 0);
    const anchor = pos.length ? pos[pos.length - 1].key : neg.length ? neg[0].key : null;
    const row: Row = { label: b.label, current: b.current, ...v, total: b.profit / 100, sales: b.sales, anchor };
    if (anchor) row[`lab_${anchor}`] = i;
    return row;
  });

  const maxPos = Math.max(0, ...rows.map((r) => series.reduce((s, x) => s + Math.max(r[x.key], 0), 0)));
  const minNeg = Math.min(0, ...rows.map((r) => series.reduce((s, x) => s + Math.min(r[x.key], 0), 0)));
  const scale = barScale(minNeg, maxPos);

  function totalLabel(key: Key) {
    function TotalLabel(props: { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown }) {
      if (typeof props.value !== "number") return null;
      const r = rows[props.value];
      if (!r || r.anchor !== key || (r.sales === 0 && r.total === 0)) return null;
      const x = Number(props.x) + Number(props.width) / 2;
      const top = Math.min(Number(props.y), Number(props.y) + Number(props.height));
      const amount = Math.abs(r.total);
      const text = dense ? `$${Math.round(amount)}` : `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
      const neg = Math.round(r.total) < 0;
      return (
        <text
          x={x}
          y={top - 9}
          textAnchor="middle"
          fontSize={dense ? 10.5 : 12.5}
          fontWeight={700}
          fill={neg ? "var(--color-neg)" : "var(--color-ink)"}
          stroke="var(--color-board)"
          strokeWidth={3.5}
          paintOrder="stroke"
        >
          {neg ? MINUS : ""}
          {text}
        </text>
      );
    }
    return TotalLabel;
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={rows}
        stackOffset="sign"
        barCategoryGap="30%"
        margin={{ top: 22, right: 4, bottom: 0, left: 0 }}
        accessibilityLayer
      >
        <defs>
          {series.map((s) => (
            <pattern key={s.key} id={`sb-hatch-${s.key}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill={s.color} />
              <rect width="3" height="6" fill="#fff" opacity="0.22" />
            </pattern>
          ))}
        </defs>
        <CartesianGrid vertical={false} stroke="var(--color-grid)" strokeDasharray="2 4" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={4}
          tick={{ fontSize: dense ? 9.5 : 11, fill: "var(--color-ink-muted)" }}
          tickFormatter={(l: string, i: number) => (rows[i]?.current && !dense && buckets.length <= 6 && /^[A-Z]{3}$/.test(l) ? `${l} (MTD)` : l)}
        />
        <YAxis
          width={50}
          domain={[scale.lo, scale.hi]}
          ticks={scale.ticks}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 10.5, fill: "var(--color-ink-muted)" }}
          tickFormatter={fmtAxis}
          allowDataOverflow
        />
        <ReferenceLine y={0} stroke="var(--color-ink-muted)" strokeOpacity={0.55} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} stackId="p" fill={s.color} maxBarSize={54} isAnimationActive={!reduced} radius={2}>
            {rows.map((r) => (
              <Cell key={r.label} fill={r.current ? `url(#sb-hatch-${s.key})` : s.color} />
            ))}
            <LabelList dataKey={`lab_${s.key}`} content={totalLabel(s.key)} />
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
