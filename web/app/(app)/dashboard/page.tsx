import type { Metadata } from "next";
import Scoreboard from "@/components/dashboard/Scoreboard";
import { todayPT } from "@/lib/dashboard/dates";
import { loadScoreboardData } from "@/lib/dashboard/load";
import { buildScoreboard, type Scoreboard as Model } from "@/lib/dashboard/model";
import { parseRange } from "@/lib/dashboard/range";
import { createClient } from "@/lib/supabase/server";
import "./dashboard.css";

export const metadata: Metadata = { title: "Dashboard · shotime_cards" };
export const dynamic = "force-dynamic";

// The scoreboard (Midnight Scoreboard phase 2). Login lands here; "/" stays
// the calendar. Reads transactions, cards and tracked_inventory (SELECT only,
// RLS-scoped) and computes cost-based profit in lib/dashboard — the same
// definitions as schema/026's sale_profit / profit_daily views, so the page
// does not depend on 026 having been applied. ?range=30d|90d|1y|all scopes
// the charts and range KPIs; anything else is 90D. The hero is always the
// current Pacific calendar month.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const range = parseRange((await searchParams).range);

  let model: Model | null = null;
  try {
    const supabase = await createClient();
    const data = await loadScoreboardData(supabase);
    model = buildScoreboard({ ...data, today: todayPT(), range });
  } catch (err) {
    // Message only — never row data (buyer PII lives in these tables).
    console.error("dashboard: load failed:", err instanceof Error ? err.message : "unknown error");
  }

  return <Scoreboard model={model} range={range} failed={model == null} />;
}
