import {
  addDays,
  addMonths,
  daysBetween,
  monthAbbr,
  monthEnd,
  monthStart,
  mondayOf,
  quarterStart,
  slashDate,
} from "./dates";

export const RANGES = ["30d", "90d", "1y", "all"] as const;
export type RangeKey = (typeof RANGES)[number];
export const DEFAULT_RANGE: RangeKey = "90d";

export const RANGE_LABEL: Record<RangeKey, string> = {
  "30d": "30D",
  "90d": "90D",
  "1y": "1Y",
  all: "ALL",
};

/** `?range=` → key. Missing, repeated, or unknown values fall back to 90D. */
export function parseRange(raw: string | string[] | undefined | null): RangeKey {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase();
  return (RANGES as readonly string[]).includes(v ?? "") ? (v as RangeKey) : DEFAULT_RANGE;
}

export type BucketMode = "week" | "month" | "quarter";

export type RangeWindow = {
  start: string;
  end: string; // today, inclusive
  mode: BucketMode;
  /** 1Y only: the account is younger than a year, so 1Y starts at the first activity (spec 6.4). */
  clamped: boolean;
};

/**
 * The day span a range covers.
 *   30D / 90D: the last 30 / 90 days including today, bucketed by week.
 *   1Y: the last 365 days by month, clamped to the first profit activity.
 *   ALL: from the first profit activity by month (by quarter past 18 months).
 * With no activity at all, 1Y and ALL show the last 4 months of empty cells
 * (spec 7, "No sales yet").
 */
export function rangeWindow(range: RangeKey, today: string, firstActivity: string | null): RangeWindow {
  if (range === "30d") return { start: addDays(today, -29), end: today, mode: "week", clamped: false };
  if (range === "90d") return { start: addDays(today, -89), end: today, mode: "week", clamped: false };

  const empty = addMonths(monthStart(today), -3);
  if (range === "1y") {
    const yearStart = addDays(today, -364);
    if (firstActivity == null) return { start: empty, end: today, mode: "month", clamped: false };
    const clamped = firstActivity > yearStart;
    return { start: clamped ? firstActivity : yearStart, end: today, mode: "month", clamped };
  }
  const start = firstActivity ?? empty;
  const months = (Number(today.slice(0, 4)) - Number(start.slice(0, 4))) * 12 +
    Number(today.slice(5, 7)) - Number(start.slice(5, 7)) + 1;
  return { start, end: today, mode: months > 18 ? "quarter" : "month", clamped: false };
}

/** Same-length window immediately before (30D / 90D only; 1Y and ALL have none). */
export function priorWindow(range: RangeKey, w: RangeWindow): { start: string; end: string } | null {
  if (range !== "30d" && range !== "90d") return null;
  const len = daysBetween(w.start, w.end) + 1;
  return { start: addDays(w.start, -len), end: addDays(w.start, -1) };
}

export type BucketSpan = {
  start: string; // clipped to the window
  end: string;
  label: string;
  current: boolean; // contains today: gets the MTD/current outline and bar hatch
};

/** Period buckets for the line score and bars. First and last are clipped to the window. */
export function bucketSpans(w: RangeWindow): BucketSpan[] {
  const out: BucketSpan[] = [];
  let cursor = w.start;
  while (cursor <= w.end) {
    let periodStart: string;
    let periodEnd: string;
    let label: string;
    if (w.mode === "week") {
      periodStart = mondayOf(cursor);
      periodEnd = addDays(periodStart, 6);
      label = slashDate(periodStart);
    } else if (w.mode === "month") {
      periodStart = monthStart(cursor);
      periodEnd = monthEnd(cursor);
      label = monthAbbr(cursor);
    } else {
      periodStart = quarterStart(cursor);
      periodEnd = addDays(addMonths(periodStart, 3), -1);
      label = `Q${Math.floor((Number(periodStart.slice(5, 7)) - 1) / 3) + 1} ${periodStart.slice(2, 4)}`;
    }
    const end = periodEnd < w.end ? periodEnd : w.end;
    out.push({ start: cursor, end, label, current: end === w.end });
    cursor = addDays(end, 1);
  }
  return out;
}

/** Spoken range name for the aria-live announcement. */
export function rangeSpoken(range: RangeKey): string {
  return range === "30d" ? "last 30 days" : range === "90d" ? "last 90 days" : range === "1y" ? "last year" : "all time";
}
