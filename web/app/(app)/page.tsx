import Link from "next/link";
import Calendar, { type DailyCashRow, type ReleaseRow } from "@/components/Calendar";
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
  ]);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-surface">Home</h1>
        <p className="text-sm text-surface/70">
          What happened, and what&rsquo;s coming. Position, cash flow, and the
          full history live on{" "}
          <Link href="/ledger" className="underline hover:text-surface">
            Ledger
          </Link>
          .
        </p>
      </header>

      {(dcErr || rErr) && (
        <p className="rounded border-l-4 border-accent bg-surface px-3 py-2 text-sm text-accent-ink">
          {dcErr?.message ?? rErr?.message}
        </p>
      )}

      <Calendar
        year={year}
        month={month}
        todayIso={todayIso}
        dailyCash={(dailyCash ?? []) as DailyCashRow[]}
        releases={(releases ?? []) as ReleaseRow[]}
      />
    </main>
  );
}
