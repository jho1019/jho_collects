"use server";

import { createClient } from "@/lib/supabase/server";
import type { LedgerEntry } from "@/lib/ledgerTypes";

// One day's transactions, for the calendar's click-a-day panel. Deliberately
// separate from the calendar's own month query (daily_cash + releases only)
// — this is a single day, not the full transactions table, and it only runs
// when a day is actually clicked.
export async function getDayEntries(day: string): Promise<LedgerEntry[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("transactions")
    .select("id, type, description, net_cash")
    .eq("occurred_on", day)
    .order("id", { ascending: true });
  return (data ?? []) as LedgerEntry[];
}
