import type { Metadata } from "next";
import Scoreboard from "@/components/dashboard/Scoreboard";
import { todayPT } from "@/lib/dashboard/dates";
import { buildInventoryBoard, type InventoryBoardModel } from "@/lib/dashboard/inventoryBoard";
import { loadInventoryBoard, loadScoreboardData } from "@/lib/dashboard/load";
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
// current Pacific calendar month. The Inventory + PC board is today's
// snapshot (cards + bulk_lots) and loads in its own try/catch, so a failure
// there shows a retry inside that board and never breaks the rest.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const range = parseRange((await searchParams).range);

  // A client failure falls through to both catches below, as before.
  const client = createClient();
  const [model, inventory] = await Promise.all([
    (async (): Promise<Model | null> => {
      try {
        const data = await loadScoreboardData(await client);
        return buildScoreboard({ ...data, today: todayPT(), range });
      } catch (err) {
        // Message only — never row data (buyer PII lives in these tables).
        console.error("dashboard: load failed:", err instanceof Error ? err.message : "unknown error");
        return null;
      }
    })(),
    // Separate try/catch: a board failure never breaks the scoreboard.
    (async (): Promise<InventoryBoardModel | null> => {
      try {
        const { cards, bulkLots } = await loadInventoryBoard(await client);
        return buildInventoryBoard(cards, bulkLots);
      } catch (err) {
        console.error("dashboard: inventory board failed:", err instanceof Error ? err.message : "unknown error");
        return null;
      }
    })(),
  ]);

  return (
    <Scoreboard
      model={model}
      range={range}
      failed={model == null}
      inventory={inventory}
      inventoryFailed={inventory == null}
    />
  );
}
