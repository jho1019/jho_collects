"use client";

import { useId, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { axisUsd, signedUsd, toneClass, usd } from "@/lib/format";
import { niceScale } from "@/lib/dashboard/format";
import type { EntriesByDay } from "@/lib/ledgerTypes";
import DayEntryTable from "@/components/DayEntryTable";

export type CashPoint = { day: string; net: number };
export type { LedgerEntry, EntriesByDay } from "@/lib/ledgerTypes";

const WINDOWS: { label: string; days: number }[] = [
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "1Y", days: 365 },
  { label: "All", days: Number.POSITIVE_INFINITY },
];

const MAX_TOOLTIP_ENTRIES = 3;

function ChartTooltip({
  active,
  label,
  payload,
  entriesByDay,
}: {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ value?: number | string }>;
  entriesByDay: EntriesByDay;
}) {
  if (!active || !label || !payload || payload.length === 0) return null;

  const day = String(label);
  const cumulative = Number(payload[0]?.value ?? 0);
  const entries = entriesByDay[day] ?? [];
  const movement = entries.reduce((t, e) => t + Number(e.net_cash), 0);
  const shown = entries.slice(0, MAX_TOOLTIP_ENTRIES);
  const remaining = entries.length - shown.length;

  return (
    <div className="pop w-64 px-3 py-2 text-xs">
      <div className="font-medium text-ink">{day}</div>
      <div className="mt-1 flex justify-between gap-4 text-ink-muted">
        <span>Cumulative</span>
        <span className={`tabular-nums ${toneClass(cumulative, "text-ink")}`}>
          {signedUsd(cumulative)}
        </span>
      </div>

      {entries.length === 0 ? (
        <div className="mt-1 text-ink-muted">No activity</div>
      ) : (
        <>
          <div className="mt-1 flex justify-between gap-4 text-ink-muted">
            <span>
              {entries.length} entr{entries.length === 1 ? "y" : "ies"}
            </span>
            <span className={`tabular-nums ${toneClass(movement, "text-ink")}`}>
              {signedUsd(movement)}
            </span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {shown.map((e) => (
              <li key={e.id} className="flex justify-between gap-2 text-ink">
                <span className="truncate">
                  {e.type} — {e.description}
                </span>
                <span className={`shrink-0 tabular-nums ${toneClass(e.net_cash)}`}>
                  {signedUsd(e.net_cash)}
                </span>
              </li>
            ))}
          </ul>
          {remaining > 0 && (
            <div className="mt-0.5 text-ink-muted">+{remaining} more</div>
          )}
        </>
      )}

      <div className="mt-1.5 text-[10px] uppercase tracking-[0.14em] text-amber">
        Click to pin
      </div>
    </div>
  );
}

// Cumulative net *cash*, not net worth. `series` is one point per day from the
// first transaction through today; the window control just clips the tail.
//
// Two mechanisms cover "day detail", deliberately not one: a recharts
// tooltip unmounts the instant the pointer leaves the plot, so anything
// inside it (an expander, a scrollable list) is unreachable — there is
// nowhere for the pointer, or a keyboard user, to go. Hover gets a richer
// but still non-interactive tooltip; clicking pins the day's full entry list
// in an ordinary panel below the chart, which can be scrolled, selected, and
// reached with a keyboard.
export default function CashChart({
  series,
  entriesByDay,
}: {
  series: CashPoint[];
  entriesByDay: EntriesByDay;
}) {
  const [days, setDays] = useState(90);
  const [pinnedDay, setPinnedDay] = useState<string | null>(null);

  const data = useMemo(
    () => (Number.isFinite(days) ? series.slice(-days) : series),
    [series, days],
  );
  const current = series.at(-1)?.net ?? 0;
  const pinnedEntries = pinnedDay ? (entriesByDay[pinnedDay] ?? []) : [];
  const pinnedInView = pinnedDay != null && data.some((d) => d.day === pinnedDay);

  // Nice axis that always contains $0 (spec L6 fix): a flat 30d window no
  // longer zooms into a meaningless sliver, and the $0 baseline is drawn.
  const scale = useMemo(() => {
    const values = data.map((d) => d.net);
    return niceScale(Math.min(0, ...values), Math.max(0, ...values), 4);
  }, [data]);

  const gradId = `nc-${useId().replace(/:/g, "")}`;
  const segRef = useRef<HTMLDivElement>(null);
  const activeIdx = WINDOWS.findIndex((w) => w.days === days);

  // Radiogroup arrow-key navigation (spec 8, segmented controls).
  function onSegKey(e: React.KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const next = (activeIdx + step + WINDOWS.length) % WINDOWS.length;
    setDays(WINDOWS[next].days);
    segRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }

  const label = `Cumulative net cash, ${WINDOWS[activeIdx]?.label ?? ""}, currently ${usd(current).replace("−", "-")}`;

  return (
    <div className="grid gap-[18px]">
      <section className="board bd">
        <div className="bl">
          <span className="flex flex-wrap items-center gap-3.5">
            <h2>Cumulative net cash</h2>
            <div
              ref={segRef}
              role="radiogroup"
              aria-label="Chart range"
              className="seg sm"
              onKeyDown={onSegKey}
            >
              {WINDOWS.map((w, i) => (
                <button
                  key={w.label}
                  type="button"
                  role="radio"
                  aria-checked={i === activeIdx}
                  tabIndex={i === activeIdx ? 0 : -1}
                  onClick={() => setDays(w.days)}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </span>
          <span
            className={`num whitespace-nowrap rounded-[3px] border px-2.5 text-[20px] font-extrabold tracking-[0.03em] sm:text-[24px] ${
              current < 0
                ? "border-neg bg-neg/10 text-neg"
                : current > 0
                  ? "border-pos bg-pos/10 text-pos"
                  : "border-line text-ink-muted"
            }`}
          >
            {signedUsd(current)}
          </span>
        </div>
        <p className="sub mt-2">
          Cash in and out, not net worth. Dips below zero are normal — inventory
          bought and not yet sold. Excludes standalone expenses (supplies,
          subscriptions, mileage…), so this figure sits above the position card.
        </p>

        <div className="relative mt-2 h-[230px] w-full sm:h-[280px]" role="group" aria-label={label}>
          <ResponsiveContainer>
            <AreaChart
              data={data}
              margin={{ top: 14, right: 16, bottom: 0, left: 0 }}
              onClick={(state) => {
                if (state?.activeLabel != null) {
                  setPinnedDay(String(state.activeLabel));
                }
              }}
            >
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--color-blue)" stopOpacity={0.02} />
                  <stop offset="1" stopColor="var(--color-blue)" stopOpacity={0.3} />
                </linearGradient>
              </defs>
              <CartesianGrid
                vertical={false}
                strokeDasharray="2 4"
                stroke="var(--color-grid)"
              />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11, fill: "var(--color-ink-muted)", fontFamily: "var(--font-mono)" }}
                tickLine={false}
                axisLine={false}
                minTickGap={48}
                tickFormatter={(d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`}
              />
              <YAxis
                domain={[scale.lo, scale.hi]}
                ticks={scale.ticks}
                allowDataOverflow={false}
                tickLine={false}
                axisLine={false}
                width={58}
                tick={(props: { x: number | string; y: number | string; payload: { value: number } }) => (
                  <text
                    x={Number(props.x)}
                    y={Number(props.y)}
                    dy={3.5}
                    textAnchor="end"
                    fontSize={11}
                    fontFamily="var(--font-mono)"
                    fontWeight={props.payload.value === 0 ? 600 : 400}
                    fill={props.payload.value === 0 ? "var(--color-ink)" : "var(--color-ink-muted)"}
                  >
                    {axisUsd(props.payload.value)}
                  </text>
                )}
              />
              <Tooltip
                cursor={{ stroke: "var(--color-line)" }}
                content={(props) => (
                  <ChartTooltip
                    active={props.active}
                    label={props.label}
                    payload={props.payload as ReadonlyArray<{ value?: number | string }>}
                    entriesByDay={entriesByDay}
                  />
                )}
              />
              <ReferenceLine y={0} stroke="var(--color-ink-muted)" strokeWidth={1.4} strokeOpacity={0.7} />
              {pinnedInView && (
                <ReferenceLine
                  x={pinnedDay ?? undefined}
                  stroke="var(--color-amber)"
                  strokeDasharray="4 2"
                />
              )}
              <Area
                type="stepAfter"
                dataKey="net"
                baseValue={0}
                stroke="var(--color-blue)"
                strokeWidth={2.4}
                fill={`url(#${gradId})`}
                dot={false}
                activeDot={{ r: 4.5, fill: "var(--color-blue)", stroke: "none" }}
                isAnimationActive={false}
                className="cursor-pointer"
              />
            </AreaChart>
          </ResponsiveContainer>
          {data.length === 0 && (
            <p className="absolute inset-0 grid place-items-center text-sm text-ink-muted">
              No transactions yet.
            </p>
          )}
        </div>
      </section>

      {pinnedDay && (
        <section className="board bd">
          <div className="bl">
            <h3>{pinnedDay} · day detail</h3>
            <button type="button" onClick={() => setPinnedDay(null)} className="btn sm">
              Dismiss
            </button>
          </div>
          <div className="mt-2">
            <DayEntryTable entries={pinnedEntries} />
          </div>
        </section>
      )}
    </div>
  );
}
