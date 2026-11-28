import { CDP_COLUMNS } from "../parse";
import type { ExistingCard } from "../plan";

export const OWNER = "aaaaaaaa-0000-0000-0000-00000000000a";

export type Cells = Partial<Record<(typeof CDP_COLUMNS)[number] | string, string>>;

const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** A CDP inventory CSV. `titleRow` puts a "batch-...-export" line above the header. */
export function cdpCsv(rows: Cells[], opts: { titleRow?: string; extra?: string[] } = {}): string {
  const cols = [...CDP_COLUMNS, ...(opts.extra ?? [])];
  const lines: string[] = [];
  if (opts.titleRow) lines.push(opts.titleRow);
  lines.push(cols.join(","));
  for (const r of rows) lines.push(cols.map((c) => q(r[c] ?? "")).join(","));
  return lines.join("\n") + "\n";
}

let sku = 1000;
/** A plausible raw card row. */
export function row(over: Cells = {}): Cells {
  sku++;
  return {
    title: `2024-25 Panini Prizm #${sku} Test Player`,
    sale_price: "1.00",
    market_price: "1.00",
    category: "BASKETBALL",
    matched: "Yes",
    year: "2024",
    brand: "Panini",
    set: "2024-25 Panini Prizm",
    player: "Test Player",
    card_number: String(sku),
    condition: "Near Mint or Better",
    graded: "No",
    purchase_price: "0.00",
    sku: String(sku),
    ...over,
  };
}

export function card(over: Partial<ExistingCard> & { id: number }): ExistingCard {
  return { title: "x", status: "held", category: "business", ...over };
}
