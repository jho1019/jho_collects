import Calendar, {
  type DailyCashRow,
  type ReleaseRow,
  type ShowRow,
  type ShowSummaryRow,
} from "@/components/Calendar";
import { createClient } from "@/lib/supabase/server";

// Home is the calendar, as of Phase 9. Position cards, the cash chart, and
// the paginated ledger — everything Home used to show — moved to /ledger
// intact. This route reads daily_cash and releases only, scoped to the
// visible month; it never fetches the full transactions table the way the
// old Home page did to build a cumulative series.
export const dynamic = "force-dynamic";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>;
}) {
  const params = await searchParams;

  // "Today" and the default month are in America/Los_Angeles, matching
  // release_on's timezone — a server running in UTC must not treat 11pm
  // Pacific as tomorrow.
  const todayIso = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
  const [todayYear, todayMonthOneIndexed] = todayIso.split("-").map(Number);

  const year = Number(params.year) || todayYear;
  const month = (Number(params.month) || todayMonthOneIndexed) - 1; // 0-indexed

  const monthStart = `${year}-${pad(month + 1)}-01`;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthEnd = `${year}-${pad(month + 1)}-${pad(daysInMonth)}`;

  const supabase = await createClient();
  const [
    { data: dailyCash, error: dcErr },
    { data: releases, error: rErr },
    { data: shows, error: shErr },
  ] = await Promise.all([
    supabase
      .from("daily_cash")
      .select("day, net_movement, txn_count")
      .gte("day", monthStart)
      .lte("day", monthEnd),
    supabase
      .from("releases")
      .select(
        "id, release_on, release_at, time_unconfirmed, title, category, manufacturer, drop_type, drop_type_uncertain, url, notes, status",
      )
      .gte("release_on", monthStart)
      .lte("release_on", monthEnd)
      .order("release_on", { ascending: true })
      .order("release_at", { ascending: true, nullsFirst: true }),
    // A show overlaps the visible month if it starts before month-end and
    // (has no end date and starts on/after month-start) or (ends on/after
    // month-start) — this is what makes a multi-day show that started last
    // month still mark this month's days.
    supabase
      .from("shows")
      .select(
        "id, name, venue, city, state, starts_on, ends_on, doors_at, admission_cost, table_cost, url, notes, status, needs_review",
      )
      .lte("starts_on", monthEnd)
      .or(
        `and(ends_on.is.null,starts_on.gte.${monthStart}),and(ends_on.not.is.null,ends_on.gte.${monthStart})`,
      )
      .order("starts_on", { ascending: true }),
  ]);

  const showIds = (shows ?? []).map((s) => s.id);
  const { data: showSummaries, error: ssErr } =
    showIds.length > 0
      ? await supabase.from("show_summary").select("show_id, deal_count, net_cash").in("show_id", showIds)
      : { data: [] as ShowSummaryRow[], error: null };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center space-y-6 p-6">
      {(dcErr || rErr || shErr || ssErr) && (
        <p className="rounded border-l-4 border-accent bg-surface px-3 py-2 text-sm text-accent-ink">
          {dcErr?.message ?? rErr?.message ?? shErr?.message ?? ssErr?.message}
        </p>
      )}

      <Calendar
        year={year}
        month={month}
        todayIso={todayIso}
        dailyCash={(dailyCash ?? []) as DailyCashRow[]}
        releases={(releases ?? []) as ReleaseRow[]}
        shows={(shows ?? []) as ShowRow[]}
        showSummaries={(showSummaries ?? []) as ShowSummaryRow[]}
      />
    </main>
  );
}
