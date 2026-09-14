"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import DayEntryTable from "@/components/DayEntryTable";
import { getDayEntries } from "@/app/(app)/actions";
import type { LedgerEntry } from "@/lib/ledgerTypes";

export type DailyCashRow = {
  day: string;
  net_movement: number | string;
  txn_count: number;
};

export type ReleaseRow = {
  id: number;
  release_on: string;
  release_at: string | null;
  time_unconfirmed: boolean;
  title: string;
  category: string | null;
  manufacturer: string | null;
  drop_type: string | null;
  drop_type_uncertain: boolean;
  url: string | null;
  notes: string | null;
  status: string;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function isoOf(year: number, month: number, day: number) {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

// Sign always shown, colour applied on top of it — Phase 7's rule that
// colour is emphasis, never the sole carrier, holds on the calendar too.
function signedAmount(n: number) {
  const abs = Math.abs(n).toFixed(2);
  return n < 0 ? `−${abs}` : `+${abs}`;
}

function formatPacificTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  });
}

function prevMonth(year: number, month: number) {
  return month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
}
function nextMonth(year: number, month: number) {
  return month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
}

// Home, as of Phase 9. Opens on the current month; the indicator is the
// day's net movement (not the running position), and a day with nothing in
// it gets no indicator at all, never a zero. Clicking a day fetches just
// that day's entries (see app/(app)/actions.ts) and pins a detail panel
// below the grid, reusing DayEntryTable from Phase 8 rather than a second
// row renderer.
export default function Calendar({
  year,
  month,
  todayIso,
  dailyCash,
  releases,
}: {
  year: number;
  month: number;
  todayIso: string;
  dailyCash: DailyCashRow[];
  releases: ReleaseRow[];
}) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayEntries, setDayEntries] = useState<LedgerEntry[]>([]);
  const [isPending, startTransition] = useTransition();

  const netByDay = new Map<string, number>();
  for (const r of dailyCash) netByDay.set(r.day, Number(r.net_movement));

  const releasesByDay = new Map<string, ReleaseRow[]>();
  for (const r of releases) {
    const list = releasesByDay.get(r.release_on) ?? [];
    list.push(r);
    releasesByDay.set(r.release_on, list);
  }

  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const startWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const cells: (number | null)[] = [
    ...Array(startWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const { year: py, month: pm } = prevMonth(year, month);
  const { year: ny, month: nm } = nextMonth(year, month);

  function selectDay(day: string) {
    setSelectedDay(day);
    startTransition(async () => {
      setDayEntries(await getDayEntries(day));
    });
  }

  const selectedReleases = selectedDay ? (releasesByDay.get(selectedDay) ?? []) : [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-surface">
          {MONTH_NAMES[month]} {year}
        </h2>
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`/?year=${py}&month=${pm + 1}`}
            className="rounded border border-surface/40 px-2 py-1 text-surface hover:bg-surface/10"
          >
            ← Prev
          </Link>
          <Link
            href="/"
            className="rounded border border-surface/40 px-2 py-1 text-surface hover:bg-surface/10"
          >
            Today
          </Link>
          <Link
            href={`/?year=${ny}&month=${nm + 1}`}
            className="rounded border border-surface/40 px-2 py-1 text-surface hover:bg-surface/10"
          >
            Next →
          </Link>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-brand-soft/25 bg-surface">
        <div className="grid grid-cols-7 border-b border-brand-soft/25 text-center text-xs font-medium uppercase text-ink-muted">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-2">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((day, i) => {
            if (day === null) {
              return <div key={i} className="min-h-24 border-b border-r border-brand-soft/10" />;
            }
            const iso = isoOf(year, month, day);
            const net = netByDay.get(iso);
            const dayReleases = releasesByDay.get(iso) ?? [];
            const isToday = iso === todayIso;
            const isSelected = iso === selectedDay;
            const shownReleases = dayReleases.slice(0, 2);
            const remaining = dayReleases.length - shownReleases.length;

            return (
              <button
                key={i}
                type="button"
                onClick={() => selectDay(iso)}
                className={`min-h-24 border-b border-r border-brand-soft/10 p-1.5 text-left align-top transition-colors hover:bg-brand-soft/10 ${
                  isSelected ? "bg-brand/10" : ""
                }`}
              >
                <div
                  className={`text-xs ${
                    isToday
                      ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand font-semibold text-surface"
                      : "text-ink-muted"
                  }`}
                >
                  {day}
                </div>
                {net !== undefined && (
                  <div
                    className={`mt-1 text-xs font-medium tabular-nums ${
                      net < 0 ? "text-accent-ink" : "text-brand"
                    }`}
                  >
                    {signedAmount(net)}
                  </div>
                )}
                {shownReleases.map((r) => (
                  <div
                    key={r.id}
                    className="mt-0.5 truncate text-[11px] text-ink"
                    title={r.title}
                  >
                    {(r.time_unconfirmed || r.drop_type_uncertain) && (
                      <span className="text-accent-ink">! </span>
                    )}
                    {r.title}
                  </div>
                ))}
                {remaining > 0 && (
                  <div className="mt-0.5 text-[11px] text-ink-muted">
                    +{remaining} more
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {selectedDay && (
        <div className="rounded-lg border border-brand-soft/25 bg-surface p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-ink">{selectedDay}</h3>
            <button
              type="button"
              onClick={() => setSelectedDay(null)}
              className="rounded border border-brand-soft/40 px-2 py-0.5 text-xs text-ink-muted hover:bg-brand-soft/10"
            >
              Dismiss
            </button>
          </div>

          {isPending ? (
            <p className="mt-2 text-sm text-ink-muted">Loading…</p>
          ) : (
            <div className="mt-2">
              <DayEntryTable entries={dayEntries} />
            </div>
          )}

          {selectedReleases.length > 0 && (
            <div className="mt-3 space-y-1.5 border-t border-brand-soft/15 pt-2">
              <div className="text-xs font-medium uppercase text-ink-muted">
                Releases
              </div>
              {selectedReleases.map((r) => (
                <div key={r.id} className="text-sm text-ink">
                  <span className="font-medium">{r.title}</span>{" "}
                  <span className="text-ink-muted">
                    {r.time_unconfirmed || !r.release_at
                      ? "time unconfirmed"
                      : formatPacificTime(r.release_at)}
                    {r.drop_type && (
                      <>
                        {" · "}
                        {r.drop_type}
                        {r.drop_type_uncertain ? "?" : ""}
                      </>
                    )}
                  </span>
                  {r.url && (
                    <>
                      {" · "}
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand hover:underline"
                      >
                        link
                      </a>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
