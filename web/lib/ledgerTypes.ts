// Shared between CashChart's click-to-pin panel and the Phase 9 calendar's
// day-detail panel — both render the same row shape via DayEntryTable, per
// "reuse the Phase 8 component rather than writing a second one."
export type LedgerEntry = {
  id: number;
  type: string;
  description: string;
  net_cash: number | string;
};

// Keyed by ISO day so a Server Component can serialise it as a plain object
// — a Map wouldn't survive the RSC boundary.
export type EntriesByDay = Record<string, LedgerEntry[]>;
