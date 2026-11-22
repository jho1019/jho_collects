"use client";

import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { useReducedMotion } from "./useReducedMotion";

// 44px KPI / hero sparkline (spec 6.9): no axes, gradient fill, last-point
// dot. All-zero data draws the mock's flat dashed line instead of a fake
// trend. Decorative: the figure next to it carries the number.
export default function Spark({
  values,
  color,
  className = "",
  style,
}: {
  values: number[];
  color: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const reduced = useReducedMotion();
  const id = useId().replace(/:/g, "");
  const flat = values.length < 2 || values.every((v) => v === 0);
  const data = values.map((v, i) => ({ i, v: v / 100 }));
  const last = data.length - 1;

  return (
    <div className={className} style={style} aria-hidden="true">
      {flat ? (
        <svg width="100%" height="100%" preserveAspectRatio="none">
          <line x1="2" x2="100%" y1="88%" y2="88%" stroke="var(--color-ink-muted)" strokeDasharray="4 5" opacity="0.6" />
        </svg>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 2, left: 4 }}>
            <defs>
              <linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={color} stopOpacity={0.28} />
                <stop offset="1" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Area
              type="linear"
              dataKey="v"
              stroke={color}
              strokeWidth={2}
              fill={`url(#sp${id})`}
              isAnimationActive={!reduced}
              dot={(p: { index?: number; cx?: number; cy?: number }) =>
                p.index === last ? <circle key="last" cx={p.cx} cy={p.cy} r={3} fill={color} /> : <g key={p.index} />
              }
              activeDot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
