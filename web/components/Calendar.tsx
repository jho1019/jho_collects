"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import DayEntryTable from "@/components/DayEntryTable";
import Spinner from "@/components/Spinner";
import { getDayEntries } from "@/app/(app)/actions";
import type { LedgerEntry } from "@/lib/ledgerTypes";
import { signedUsd, signedUsdWhole, toneClass, usd } from "@/lib/format";

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

export type ShowRow = {
  id: number;
  name: string;
  venue: string | null;
  city: string | null;
  state: string | null;
  starts_on: string;
  ends_on: string | null;
  doors_at: string | null;
  admission_cost: number | string | null;
  table_cost: number | string | null;
  url: string | null;
  notes: string | null;
  status: string;
  needs_review: boolean;
};

export type ShowSummaryRow = {
  show_id: number;
  deal_count: number;
  net_cash: number | string;
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

// Every calendar day from `start` through `end` inclusive, as ISO strings.
// Used to mark a multi-day show on each day it spans — a weekend show
// marked only on its start date is the failure mode this avoids.
function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cur <= last) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// Sign always shown, colour applied on top of it — colour is emphasis, never
// the sole carrier. Zero is "$0.00": no sign, no colour (spec 7).
const signedAmount = (n: number) => signedUsd(n);

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

// Below sm (700px) the day detail is a bottom sheet (C10, spec 17.1 Q4);
// from sm up it stays the panel under the grid.
const MOBILE_QUERY = "(max-width: 699.98px)";
function subscribeMobile(cb: () => void) {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function useIsMobile() {
  return useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

// Home, as of Phase 9. Opens on the current month; the indicator is the
// day's net movement (not the running position), and a day with nothing in
// it gets no indicator at all, never a zero. Clicking a day fetches just
// that day's entries (see app/(app)/actions.ts) and pins a detail panel
// below the grid (a bottom sheet below 700px, C10), reusing DayEntryTable
// from Phase 8 rather than a second row renderer.
export default function Calendar({
  year,
  month,
  todayIso,
  dailyCash,
  releases,
  shows,
  showSummaries,
}: {
  year: number;
  month: number;
  todayIso: string;
  dailyCash: DailyCashRow[];
  releases: ReleaseRow[];
  shows: ShowRow[];
  showSummaries: ShowSummaryRow[];
}) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayEntries, setDayEntries] = useState<LedgerEntry[]>([]);
  const [isPending, startTransition] = useTransition();
  const isMobile = useIsMobile();
  const closeDay = useCallback(() => setSelectedDay(null), []);

  const netByDay = new Map<string, number>();
  const countByDay = new Map<string, number>();
  for (const r of dailyCash) {
    netByDay.set(r.day, Number(r.net_movement));
    countByDay.set(r.day, r.txn_count);
  }
  // Bar heights scale to the busiest day in the visible month, so a $2
  // sale doesn't draw the same size bar as a $2,000 show. Floors out at 1
  // to avoid a divide-by-zero on a month with only zero-net days.
  const maxAbsNet = Math.max(1, ...dailyCash.map((r) => Math.abs(Number(r.net_movement))));

  const releasesByDay = new Map<string, ReleaseRow[]>();
  for (const r of releases) {
    const list = releasesByDay.get(r.release_on) ?? [];
    list.push(r);
    releasesByDay.set(r.release_on, list);
  }

  // Marks every day a show spans, not just starts_on — see daysBetween.
  const showsByDay = new Map<string, ShowRow[]>();
  for (const s of shows) {
    for (const day of daysBetween(s.starts_on, s.ends_on ?? s.starts_on)) {
      const list = showsByDay.get(day) ?? [];
      list.push(s);
      showsByDay.set(day, list);
    }
  }

  const summaryByShowId = new Map<number, ShowSummaryRow>();
  for (const s of showSummaries) summaryByShowId.set(s.show_id, s);

  // A show still 'planned' after its last day has passed needs a human to
  // reconcile it — that's a prompt, not history, so it reads differently
  // from an ordinary attended show.
  function isUnresolvedPastShow(s: ShowRow) {
    return s.status === "planned" && (s.ends_on ?? s.starts_on) < todayIso;
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

  function selectDay(day: string, cell?: HTMLElement) {
    setSelectedDay(day);
    // Keep the chosen day peekable above the sheet: if it would sit under
    // the sheet (lower ~55% of the viewport), scroll it up near the top.
    if (cell && window.matchMedia(MOBILE_QUERY).matches) {
      const r = cell.getBoundingClientRect();
      if (r.bottom > window.innerHeight * 0.42) {
        window.scrollBy({ top: r.top - 72, behavior: "smooth" });
      }
    }
    startTransition(async () => {
      setDayEntries(await getDayEntries(day));
    });
  }

  const selectedReleases = selectedDay ? (releasesByDay.get(selectedDay) ?? []) : [];
  const selectedShows = selectedDay ? (showsByDay.get(selectedDay) ?? []) : [];

  const detail = selectedDay && (
    <>
      {selectedShows.length > 0 && (
        <div className="mt-3">
          <h3 className="bl bl-mute">Shows</h3>
          <div className="mt-1 space-y-2">
            {selectedShows.map((s) => {
              const summary = summaryByShowId.get(s.id);
              const unresolved = isUnresolvedPastShow(s);
              return (
                <div key={s.id} className="text-[13px] text-ink">
                  <b className="font-semibold">{s.name}</b>{" "}
                  <span className="text-ink-muted">
                    {[s.venue, s.city].filter(Boolean).join(", ") || "venue unknown"}
                    {s.doors_at && <> · doors {formatPacificTime(s.doors_at)}</>}
                    {s.admission_cost != null && (
                      <> · admission ${Number(s.admission_cost).toFixed(2)} (expected)</>
                    )}
                  </span>
                  {unresolved && <span className="pill pill-amber ml-2">▲ unresolved</span>}
                  {s.needs_review && <span className="pill pill-rev ml-2">needs review</span>}
                  {s.status === "attended" && summary && (
                    <div className="sub">
                      {summary.deal_count} {summary.deal_count === 1 ? "deal" : "deals"} · net{" "}
                      <span className={toneClass(summary.net_cash)}>
                        {signedAmount(Number(summary.net_cash))}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-3">
        <h3 className="bl bl-mute">Entries</h3>
        {isPending ? (
          <div className="mt-2 flex items-center gap-2 text-sm text-ink-muted">
            <Spinner />
            Loading…
          </div>
        ) : (
          <div className="mt-1">
            <DayEntryTable entries={dayEntries} />
          </div>
        )}
      </div>

      {selectedReleases.length > 0 && (
        <div className="mt-3">
          <h3 className="bl bl-mute">Releases</h3>
          <div className="mt-1 space-y-1.5">
            {selectedReleases.map((r) => (
              <div key={r.id} className="text-[13px] text-ink">
                <b className="font-semibold">{r.title}</b>{" "}
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
                    <a href={r.url} target="_blank" rel="noreferrer" className="lk">
                      link
                    </a>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="grid min-w-0 gap-[18px]">
      <header className="pg-head">
        <div className="min-w-0">
          <h1 className="pg-h1">
            {MONTH_NAMES[month]} {year}
          </h1>
          {/* C9: one-line legend so the marks explain themselves. */}
          <div className="cal-legend" aria-label="Legend">
            <span>
              <i className="bg-pos" aria-hidden />
              net cash in
            </span>
            <span>
              <i className="bg-neg" aria-hidden />
              net cash out
            </span>
            <span className="text-blue">⚑ show day</span>
            <span>
              <i className="rounded-full bg-amber" aria-hidden />
              release
            </span>
            <span className="text-amber">▲ show still planned: needs review</span>
          </div>
        </div>
        <nav aria-label="Month" className="flex items-center gap-2">
          <Link href={`/?year=${py}&month=${pm + 1}`} className="btn">
            ← Prev
          </Link>
          <Link href="/" className="btn pri">
            Today
          </Link>
          <Link href={`/?year=${ny}&month=${nm + 1}`} className="btn">
            Next →
          </Link>
        </nav>
      </header>

      <section className="board p-2 sm:p-4">
        <div className="cal">
          {WEEKDAYS.map((w) => (
            <div key={w} className="cal-dh">
              {w}
            </div>
          ))}
          {cells.map((day, i) => {
            if (day === null) {
              return <div key={i} className="cal-out" aria-hidden />;
            }
            const iso = isoOf(year, month, day);
            const net = netByDay.get(iso);
            const count = countByDay.get(iso) ?? 0;
            const dayReleases = releasesByDay.get(iso) ?? [];
            const dayShows = showsByDay.get(iso) ?? [];
            const isToday = iso === todayIso;
            const isSelected = iso === selectedDay;
            const hasFlagged = dayReleases.some(
              (r) => r.time_unconfirmed || r.drop_type_uncertain,
            );
            const hasUnresolvedShow = dayShows.some(isUnresolvedPastShow);
            // Bar is at most 16px either side of the dashed centre line,
            // scaled to the busiest day in the visible month. Direction
            // carries the sign as well as colour, so it reads in greyscale.
            const BAR_HALF = 16;
            const netCents = net === undefined ? 0 : Math.round(net * 100);
            const barPx =
              net === undefined || netCents === 0
                ? 0
                : Math.max(3, Math.round((Math.abs(net) / maxAbsNet) * BAR_HALF));
            const stripShow = dayShows.find(isUnresolvedPastShow) ?? dayShows[0];

            const aria = [
              `${MONTH_NAMES[month]} ${day}`,
              isToday ? "today" : null,
              net !== undefined
                ? `net ${usd(net).replace("−", "-")}, ${count} ${count === 1 ? "entry" : "entries"}`
                : null,
              dayShows.length > 0 ? `show: ${dayShows.map((x) => x.name).join(", ")}` : null,
              hasUnresolvedShow ? "needs review" : null,
              dayReleases.length > 0
                ? `${dayReleases.length} ${dayReleases.length === 1 ? "release" : "releases"}`
                : null,
            ]
              .filter(Boolean)
              .join(", ");

            return (
              <button
                key={i}
                type="button"
                onClick={(e) => selectDay(iso, e.currentTarget)}
                aria-label={aria}
                aria-pressed={isSelected}
                aria-current={isToday ? "date" : undefined}
                className={`cal-day${isToday ? " today" : ""}${isSelected ? " sel" : ""}`}
              >
                <span className="cal-n">{day}</span>

                {(dayReleases.length > 0 || dayShows.length > 0) && (
                  <span className="cal-mk" aria-hidden>
                    {dayShows.length > 0 && (
                      <span className={`cal-flag${hasUnresolvedShow ? " rv" : ""}`}>⚑</span>
                    )}
                    {dayReleases.length > 0 && (
                      <span
                        className="cal-dot"
                        title={hasFlagged ? "Release (time or drop type unconfirmed)" : "Release"}
                      />
                    )}
                  </span>
                )}

                {stripShow && (
                  <span
                    className={`cal-strip${isUnresolvedPastShow(stripShow) ? " rv" : ""}`}
                    aria-hidden
                  >
                    {isUnresolvedPastShow(stripShow)
                      ? `▲ ${stripShow.name} · review`
                      : stripShow.name}
                  </span>
                )}

                {net !== undefined && (
                  <>
                    {barPx > 0 && (
                      <span className="cal-bar" aria-hidden>
                        <i
                          className={netCents < 0 ? "dn" : "up"}
                          style={{ height: `${barPx}px` }}
                        />
                      </span>
                    )}
                    <span
                      className={`cal-amt ${toneClass(net, "text-ink-muted")}`}
                      aria-hidden
                    >
                      {signedUsdWhole(net)}
                    </span>
                  </>
                )}

                {(net !== undefined || dayReleases.length > 0 || dayShows.length > 0) && (
                  <span className="cal-tip pop text-xs" aria-hidden>
                    {net !== undefined && (
                      <span className="block">
                        {signedAmount(net)} · {count} {count === 1 ? "entry" : "entries"}
                      </span>
                    )}
                    {dayShows.length > 0 && (
                      <span className="block">{dayShows.map((x) => x.name).join(", ")}</span>
                    )}
                    {dayReleases.length > 0 && (
                      <span className="block">
                        {dayReleases.length}{" "}
                        {dayReleases.length === 1 ? "release" : "releases"}
                      </span>
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {selectedDay && !isMobile && (
        <section className="board bd" aria-live="polite">
          <div className="bl">
            <h2>{selectedDay} · day detail</h2>
            <button type="button" onClick={closeDay} className="btn sm">
              Dismiss
            </button>
          </div>
          {detail}
        </section>
      )}

      {selectedDay && isMobile && (
        <DaySheet day={selectedDay} onClose={closeDay}>
          {detail}
        </DaySheet>
      )}
    </div>
  );
}

// C10: mobile day detail as a bottom sheet, the More-sheet pattern from
// AppShell (scrim, rounded top, 3px amber top border; Escape, Dismiss or a
// scrim tap closes). Docked above the fixed tab bar so CAL stays visible:
// the bar is 3px border + 8px top pad + 44px tab + max(14px, safe area).
// Capped at 55vh so the month grid, and the selected day, still peek out.
const ABOVE_TABS = "calc(55px + max(14px, env(safe-area-inset-bottom)))";

function DaySheet({
  day,
  onClose,
  children,
}: {
  day: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div className="fixed inset-x-0 top-0 z-40 sm:hidden" style={{ bottom: ABOVE_TABS }}>
      <button
        type="button"
        aria-label="Close day detail"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        aria-live="polite"
        className="absolute inset-x-0 bottom-0 max-h-[55vh] overflow-y-auto rounded-t-xl border-t-[3px] border-amber bg-board px-4 pt-3.5 pb-5 shadow-[0_-20px_60px_rgb(0_0_0/0.6)] focus:outline-none"
      >
        <div className="bl">
          <h2 id={titleId}>{day} · day detail</h2>
          <button type="button" onClick={onClose} className="btn sm min-h-11">
            Dismiss
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
