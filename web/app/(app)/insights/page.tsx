import { createClient } from "@/lib/supabase/server";
import MarginByBand, { type Band } from "@/components/MarginByBand";

// Margin by price band, and only that. See docs/PHASE_7_UI.md — sell-through
// and aging are explicitly out of this phase.
export const dynamic = "force-dynamic";

type SaleRow = {
  item_amount: string | number;
  shipping_charged: string | number;
  platform_fees: string | number;
  shipping_cost: string | number;
  other_cost: string | number;
};

const BANDS: { label: string; lo: number; hi: number }[] = [
  { label: "< $5", lo: 0, hi: 5 },
  { label: "$5–10", lo: 5, hi: 10 },
  { label: "$10–25", lo: 10, hi: 25 },
  { label: "$25–50", lo: 25, hi: 50 },
  { label: "$50+", lo: 50, hi: Infinity },
];

function toBands(sales: SaleRow[]): Band[] {
  return BANDS.map(({ label, lo, hi }) => {
    const rows = sales.filter((s) => {
      const a = Number(s.item_amount);
      return a >= lo && a < hi;
    });
    const proceeds = rows.reduce(
      (t, s) => t + Number(s.item_amount) + Number(s.shipping_charged),
      0,
    );
    const cost = rows.reduce(
      (t, s) =>
        t +
        Number(s.platform_fees) +
        Number(s.shipping_cost) +
        Number(s.other_cost),
      0,
    );
    const net = proceeds - cost;
    return {
      band: label,
      count: rows.length,
      proceeds: Math.round(proceeds * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      net: Math.round(net * 100) / 100,
      marginPct: proceeds > 0 ? Math.round((net / proceeds) * 1000) / 10 : null,
    };
  });
}

export default async function InsightsPage() {
  const supabase = await createClient();

  const { data: sales, error } = await supabase
    .from("transactions")
    .select(
      "item_amount, shipping_charged, platform_fees, shipping_cost, other_cost",
    )
    .eq("type", "sale");

  const bands = toBands((sales ?? []) as SaleRow[]);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-ink">Insights</h1>
        <p className="text-sm text-ink-muted">
          Margin as a share of proceeds, by sale price.
        </p>
      </header>

      {error && (
        <p className="rounded bg-accent/10 px-3 py-2 text-sm text-accent-ink">
          {error.message}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-ink-muted">
          Margin by price band
        </h2>
        <p className="text-xs text-ink-muted">
          Net as a share of proceeds. Bars under 25% are flagged — the fixed
          per-order fee and label eat low-price cards.
        </p>
        <div className="rounded-lg border border-brand-soft/25 bg-surface p-3">
          <MarginByBand bands={bands} />
        </div>
      </section>
    </main>
  );
}
