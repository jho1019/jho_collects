"use client";

import { useId, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import DayEntryTable from "@/components/DayEntryTable";
import type { EntriesByDay } from "@/lib/ledgerTypes";
import { mondayOf, monthName, shortDate, slashDate } from "@/lib/dashboard/dates";
import { fmtAxis, money, moneyAria, niceScale } from "@/lib/dashboard/format";
import { useReducedMotion } from "./useReducedMotion";

// Score progression (spec 6.7): cumulative net PROFIT since the range start,
// so it always starts at $0, with a $0 baseline that is always in the domain.
// Green above zero, red below; the stroke changes colour exactly at zero via
// a hard-stop gradient. type="linear" — staircase data reads honestly.
//
// Hover = non-interactive tooltip; click = pin the day's ledger rows in a
// panel below (DayEntryTable), same as the Ledger chart. Pinning needs the
// day's rows, which the server sends for 30D/90D only; 1Y/ALL plot one point
// per week and do not pin (follow-up).
type Point = { day: string; value: number; pos: number; neg: number };

function ScoreTip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: Point }> }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const tone = p.value > 0 ? "var(--color-pos)" : p.value < 0 ? "var(--color-neg)" : "var(--color-ink-muted)";
  return (
    <div className="sb-tip">
      <small>{shortDate(p.day)} · cumulative</small>
      <strong style={{ color: tone }}>{money(Math.round(p.value * 100))}</strong>
    </div>
  );
}

export default function CumulativeChart({
  points,
  granularity,
  entriesByDay,
  start,
  empty,
}: {
  points: { day: string; value: number }[];
  granularity: "day" | "week";
  entriesByDay: EntriesByDay | null;
  start: string;
  empty: { title: string; body: string } | null;
}) {
  const reduced = useReducedMotion();
  const uid = useId().replace(/:/g, "");
  const [pinned, setPinned] = useState<string | null>(null);

  const data: Point[] = useMemo(
    () => points.map((p) => ({ day: p.day, value: p.value / 100, pos: Math.max(p.value, 0) / 100, neg: Math.min(p.value, 0) / 100 })),
    [points],
  );
  const values = data.map((d) => d.value);
  const minV = Math.min(0, ...values);
  const maxV = Math.max(0, ...values);
  const hasLine = values.some((v) => v !== 0);
  const scale = hasLine ? niceScale(minV, Math.max(maxV * 1.05, maxV > 0 ? 25 : 0), 4) : niceScale(0, 0);
  // where zero sits inside the line's own bounding box (objectBoundingBox)
  const zeroOffset = maxV <= 0 ? 0 : minV >= 0 ? 1 : maxV / (maxV - minV);
  const last = data.at(-1);

  const ticks = useMemo(() => {
    const out: string[] = [];
    let prevMonth = "";
    data.forEach((d, i) => {
      if (granularity === "day") {
        if (i === 0 || mondayOf(d.day) === d.day) out.push(d.day);
      } else {
        const m = d.day.slice(0, 7);
        if (i === 0 || m !== prevMonth) out.push(d.day);
        prevMonth = m;
      }
    });
    return out;
  }, [data, granularity]);

  const canPin = granularity === "day" && entriesByDay != null && hasLine;
  const headline = `Cumulative net profit since ${shortDate(start)}, currently ${moneyAria(Math.round((last?.value ?? 0) * 100))}`;
  // screen-reader table: weekly points (spec 8)
  const srRows = granularity === "week" ? data : data.filter((d, i) => i === data.length - 1 || new Date(d.day + "T00:00:00Z").getUTCDay() === 0);

  return (
    <>
      <figure className="sb-ch sb-cum" aria-label={headline} style={{ margin: 0 }}>
        <figcaption className="sr-only">{headline}</figcaption>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ left: 0, right: 16, top: 16, bottom: 0 }}
            accessibilityLayer
            onClick={(state) => {
              if (canPin && state?.activeLabel != null) setPinned(String(state.activeLabel));
            }}
            style={canPin ? { cursor: "pointer" } : undefined}
          >
            <defs>
              <linearGradient id={`gp${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--color-pos)" stopOpacity={0.3} />
                <stop offset="1" stopColor="var(--color-pos)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id={`gn${uid}`} x1="0" y1="1" x2="0" y2="0">
                <stop offset="0" stopColor="var(--color-neg)" stopOpacity={0.34} />
                <stop offset="1" stopColor="var(--color-neg)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id={`gl${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset={zeroOffset} stopColor="var(--color-pos)" />
                <stop offset={zeroOffset} stopColor="var(--color-neg)" />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--color-grid)" strokeDasharray="2 4" />
            <XAxis
              dataKey="day"
              ticks={ticks}
              interval="preserveStart"
              minTickGap={granularity === "day" ? 30 : 18}
              tickLine={{ stroke: "var(--color-grid)" }}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--color-ink-muted)" }}
              tickFormatter={(d: string) => (granularity === "day" ? slashDate(d) : monthName(d).slice(0, 3))}
            />
            <YAxis
              width={50}
              domain={[scale.lo, scale.hi]}
              ticks={scale.ticks}
              allowDataOverflow
              tickLine={false}
              axisLine={false}
              tick={(props: { x?: number | string; y?: number | string; payload?: { value: number } }) => {
                const v = props.payload?.value ?? 0;
                return (
                  <text
                    x={Number(props.x)}
                    y={Number(props.y)}
                    dy={3.5}
                    textAnchor="end"
                    fontSize={11}
                    fill={v === 0 ? "var(--color-ink)" : "var(--color-ink-muted)"}
                    fontWeight={v === 0 ? 600 : 400}
                  >
                    {fmtAxis(v)}
                  </text>
                );
              }}
            />
            {hasLine && (
              <Tooltip
                content={(p) => <ScoreTip active={p.active} payload={p.payload as ReadonlyArray<{ payload?: Point }>} />}
                cursor={{ stroke: "var(--color-ink-muted)", strokeDasharray: "3 3" }}
                isAnimationActive={false}
              />
            )}
            {hasLine && (
              <>
                <Area type="linear" dataKey="pos" baseValue={0} stroke="none" fill={`url(#gp${uid})`} isAnimationActive={!reduced} activeDot={false} />
                <Area type="linear" dataKey="neg" baseValue={0} stroke="none" fill={`url(#gn${uid})`} isAnimationActive={!reduced} activeDot={false} />
              </>
            )}
            <ReferenceLine
              y={0}
              stroke={hasLine ? "var(--color-ink-muted)" : "var(--color-blue)"}
              strokeWidth={hasLine ? 1.4 : 2}
              strokeDasharray={hasLine ? undefined : "6 6"}
              strokeOpacity={hasLine ? 0.7 : 0.6}
              ifOverflow="extendDomain"
            />
            {pinned && canPin && <ReferenceLine x={pinned} stroke="var(--color-amber)" strokeDasharray="4 2" />}
            {hasLine && (
              <Line
                type="linear"
                dataKey="value"
                stroke={`url(#gl${uid})`}
                strokeWidth={2.4}
                strokeLinejoin="round"
                isAnimationActive={!reduced}
                className={minV >= 0 ? "sb-glow" : undefined}
                style={minV >= 0 ? { filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--color-pos) 60%, transparent))" } : undefined}
                dot={(p: { index?: number; cx?: number; cy?: number }) => {
                  if (p.index !== data.length - 1) return <g key={p.index} />;
                  const c = (last?.value ?? 0) < 0 ? "var(--color-neg)" : "var(--color-pos)";
                  return (
                    <g key="last">
                      <circle cx={p.cx} cy={p.cy} r={9} fill={c} opacity={0.22} />
                      <circle cx={p.cx} cy={p.cy} r={4.5} fill={c} />
                    </g>
                  );
                }}
                activeDot={{ r: 5, fill: "var(--color-tip)", stroke: "var(--color-pos)", strokeWidth: 2.4 }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
        {empty && (
          <div className="sb-empty">
            <div>
              <b>{empty.title}</b>
              <span>{empty.body}</span>
            </div>
          </div>
        )}
        <table className="sr-only">
          <caption>Cumulative net profit by week</caption>
          <thead>
            <tr><th scope="col">Date</th><th scope="col">Cumulative</th></tr>
          </thead>
          <tbody>
            {srRows.map((d) => (
              <tr key={d.day}><td>{shortDate(d.day)}</td><td>{moneyAria(Math.round(d.value * 100))}</td></tr>
            ))}
          </tbody>
        </table>
      </figure>

      {pinned && canPin && (
        <div className="mt-3 rounded-[4px] border border-line bg-board p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-ink">{pinned}</h3>
            <button
              type="button"
              onClick={() => setPinned(null)}
              className="rounded-[3px] border border-line px-2 py-0.5 text-xs text-ink-muted hover:text-ink"
            >
              Dismiss
            </button>
          </div>
          <div className="mt-2">
            <DayEntryTable entries={entriesByDay?.[pinned] ?? []} />
          </div>
        </div>
      )}
    </>
  );
}
