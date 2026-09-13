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

export type LedgerEntry = {
  id: number;
  type: string;
  description: string;
  net_cash: number | string;
};

// Keyed by ISO day (matches CashPoint.day) so a Server Component can
// serialise it as a plain object — a Map wouldn't survive the RSC boundary.
export type EntriesByDay = Record<string, LedgerEntry[]>;

const WINDOWS: { label: string; days: number }[] = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
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
    <div className="w-64 rounded-lg border border-brand-soft/25 bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-ink">{day}</div>
      <div className="mt-1 flex justify-between gap-4 text-ink-muted">
        <span>Cumulative</span>
        <span className="tabular-nums text-ink">{usd(cumulative)}</span>
      </div>

      {entries.length === 0 ? (
        <div className="mt-1 text-ink-muted">No activity</div>
      ) : (
        <>
          <div className="mt-1 flex justify-between gap-4 text-ink-muted">
            <span>
              {entries.length} entr{entries.length === 1 ? "y" : "ies"}
            </span>
            <span
              className={`tabular-nums ${movement < 0 ? "text-accent-ink" : "text-brand"}`}
            >
              {usd(movement)}
            </span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {shown.map((e) => (
              <li key={e.id} className="flex justify-between gap-2 text-ink">
                <span className="truncate">
                  {e.type} — {e.description}
                </span>
                <span className="shrink-0 tabular-nums">{usd(e.net_cash)}</span>
              </li>
            ))}
          </ul>
          {remaining > 0 && (
            <div className="mt-0.5 text-ink-muted">+{remaining} more</div>
          )}
        </>
      )}

      <div className="mt-1.5 text-[10px] uppercase tracking-wide text-ink-muted">
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
              onClick={(state) => {
                if (state?.activeLabel != null) {
                  setPinnedDay(String(state.activeLabel));
                }
              }}
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
                content={(props) => (
                  <ChartTooltip
                    active={props.active}
                    label={props.label}
                    payload={props.payload as ReadonlyArray<{ value?: number | string }>}
                    entriesByDay={entriesByDay}
                  />
                )}
              />
              <ReferenceLine y={0} stroke="var(--color-brand-soft)" />
              {pinnedInView && (
                <ReferenceLine
                  x={pinnedDay ?? undefined}
                  stroke="var(--color-accent-ink)"
                  strokeDasharray="4 2"
                />
              )}
              <Line
                type="monotone"
                dataKey="net"
                stroke="var(--color-brand)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                className="cursor-pointer"
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

      {pinnedDay && (
        <div className="rounded-lg border border-brand-soft/25 bg-surface p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-ink">{pinnedDay}</h3>
            <button
              type="button"
              onClick={() => setPinnedDay(null)}
              className="rounded border border-brand-soft/40 px-2 py-0.5 text-xs text-ink-muted hover:bg-brand-soft/10"
            >
              Dismiss
            </button>
          </div>
          {pinnedEntries.length === 0 ? (
            <p className="mt-2 text-sm text-ink-muted">No activity.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-brand-soft/25 text-left text-xs uppercase text-ink-muted">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Type</th>
                    <th className="py-1 pr-3 font-medium">Description</th>
                    <th className="py-1 text-right font-medium">Net cash</th>
                  </tr>
                </thead>
                <tbody>
                  {pinnedEntries.map((e) => (
                    <tr key={e.id} className="border-b border-brand-soft/15 last:border-0">
                      <td className="py-1 pr-3 text-ink-muted">{e.type}</td>
                      <td className="py-1 pr-3 text-ink">{e.description}</td>
                      <td className="py-1 text-right tabular-nums text-ink">
                        {usd(e.net_cash)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
