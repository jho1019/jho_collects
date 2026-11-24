import Link from "next/link";
import type { Flip } from "@/lib/dashboard/model";
import { money } from "@/lib/dashboard/format";
import { shortDate } from "@/lib/dashboard/dates";

// "Back of the card" (spec 6.8). Cards have no image field yet (gap 8), so
// the image slot is always the neutral placeholder graphic from the mock —
// never a stock photo. Three states: a real best flip this month; no flip this
// month (ghost card + all-time best as fallback); no sales at all (onboarding).

function PlaceholderCard({ ghost = false, width = 92 }: { ghost?: boolean; width?: number }) {
  return (
    <svg
      viewBox="0 0 100 140"
      width={width}
      height={width * 1.4}
      className="sb-cardsvg"
      aria-hidden="true"
      style={ghost ? { opacity: 0.35, filter: "grayscale(1)" } : undefined}
    >
      <defs>
        <linearGradient id="sb-card-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9aa6c8" />
          <stop offset="1" stopColor="#5b6890" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="96" height="136" rx="7" fill="#f4ecd8" stroke="rgba(0,0,0,.25)" />
      <rect x="8" y="8" width="84" height="102" rx="3" fill="url(#sb-card-grad)" />
      <circle cx="50" cy="48" r="15" fill="rgba(255,255,255,.28)" />
      <path d="M20 110c4-24 18-34 30-34s26 10 30 34z" fill="rgba(255,255,255,.28)" />
      <rect x="8" y="114" width="84" height="16" rx="2" fill="rgba(20,20,20,.82)" />
      <rect x="14" y="119" width="46" height="3.4" rx="1.5" fill="#f4ecd8" />
      <rect x="14" y="125" width="28" height="2.4" rx="1.2" fill="#f4ecd8" opacity=".6" />
    </svg>
  );
}

const unsigned = (c: number) => money(c, { signed: false });

export default function BackOfCard({
  flip,
  bestAllTime,
  hasAnySales,
  lastSaleDay,
}: {
  flip: Flip | null;
  bestAllTime: Flip | null;
  hasAnySales: boolean;
  lastSaleDay: string | null;
}) {
  if (!hasAnySales) {
    return (
      <section className="sb-back" aria-label="Play ball">
        <div className="sb-bl"><span>Play ball</span><span>NO. —</span></div>
        <div className="sb-nm" style={{ fontSize: 30, marginTop: 8 }}>LOG YOUR FIRST SALE</div>
        <div className="sb-pm" style={{ fontSize: 12, marginBottom: 6 }}>Three ways to get on the board</div>
        <table>
          <tbody>
            <tr><td>1 · Import your eBay Transaction report</td><td><Link href="/data">Data →</Link></td></tr>
            <tr><td>2 · Log a show or card-shop deal</td><td><Link href="/deals">Deals →</Link></td></tr>
            <tr><td>3 · Add a card you&rsquo;re hunting</td><td><Link href="/buying">Buying →</Link></td></tr>
            <tr><td>Costs help: add what you paid</td><td><Link href="/inventory">Inventory →</Link></td></tr>
          </tbody>
        </table>
      </section>
    );
  }

  if (!flip) {
    return (
      <section className="sb-back" aria-label="Back of the card, flip of the month">
        <div className="sb-bl"><span>Back of the card · flip of the month</span><span>NO. —</span></div>
        <div className="sb-bf">
          <PlaceholderCard ghost />
          <div>
            <div className="sb-nm" style={{ fontSize: 28, color: "var(--color-paper-muted)" }}>NO FLIP THIS MONTH</div>
            <div className="sb-pm" style={{ fontSize: 12, marginTop: 6, maxWidth: 210 }}>
              Sell a card for more than you paid and the best one lands here.
            </div>
          </div>
        </div>
        <table>
          <tbody>
            <tr>
              <td>Best flip all-time</td>
              <td style={bestAllTime ? { color: "var(--color-paper-pos)" } : undefined}>
                {bestAllTime ? money(bestAllTime.profit) : "—"}
              </td>
            </tr>
            <tr><td>Last sale</td><td>{lastSaleDay ? shortDate(lastSaleDay) : "—"}</td></tr>
          </tbody>
        </table>
      </section>
    );
  }

  const graded = [flip.grader, flip.grade ? `GRADED ${flip.grade}` : null].filter(Boolean).join(" · ");
  const meta = [
    flip.pctOfCost != null ? `+${(flip.pctOfCost * 100).toFixed(0)}%` : null,
    flip.daysToSell != null ? `SOLD IN ${flip.daysToSell} DAY${flip.daysToSell === 1 ? "" : "S"}` : `SOLD ${shortDate(flip.day).toUpperCase()}`,
  ].filter(Boolean).join(" · ");

  return (
    <section className="sb-back" aria-label="Back of the card, flip of the month">
      <div className="sb-bl"><span>Back of the card · flip of the month</span><span>NO. 01</span></div>
      <div className="sb-bf">
        <PlaceholderCard />
        <div style={{ minWidth: 0 }}>
          <div className="sb-nm">{flip.title}</div>
          {graded && <div className="sb-pm">{graded.toUpperCase()}</div>}
          <div className="sb-big">{money(flip.profit)}</div>
          <div className="sb-pm">{meta}</div>
        </div>
      </div>
      <table>
        <tbody>
          <tr><td>Bought</td><td>{unsigned(flip.cost)}</td></tr>
          <tr><td>Sold</td><td>{unsigned(flip.sold)}</td></tr>
          <tr><td>{flip.platform === "ebay" ? "eBay fees" : "Fees"}</td><td>{unsigned(flip.fees)}</td></tr>
          {flip.shipping !== 0 && <tr><td>Shipping</td><td>{unsigned(flip.shipping)}</td></tr>}
          <tr><td>Net profit</td><td style={{ color: "var(--color-paper-pos)" }}>{money(flip.profit)}</td></tr>
        </tbody>
      </table>
    </section>
  );
}
