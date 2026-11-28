"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useOptimistic, useSyncExternalStore, useTransition } from "react";
import type { InventoryBoardModel } from "@/lib/dashboard/inventoryBoard";
import type { Scoreboard as Model } from "@/lib/dashboard/model";
import { RANGE_LABEL, type RangeKey } from "@/lib/dashboard/range";
import { money, moneyAria, pct, tone } from "@/lib/dashboard/format";
import { shortDate } from "@/lib/dashboard/dates";
import { goalValue, informativeDelta } from "@/lib/dashboard/kpi";
import BackOfCard from "./BackOfCard";
import CumulativeChart from "./CumulativeChart";
import GoalRing from "./GoalRing";
import InventoryBoard from "./InventoryBoard";
import LineScore from "./LineScore";
import ProfitBars from "./ProfitBars";
import RangeControl from "./RangeControl";
import Spark from "./Spark";

// The /dashboard scoreboard (spec sections 1, 6.3–6.12, 7). Every figure
// comes from the server-built model; nothing here invents a number. Gaps the
// data cannot fill yet (comps, goals, card images, table-fee category) render
// as marked empty states.

const FIX_HREF = "/inventory?cost=missing";
const STALE_KEY = "sb:last:";
const STALE_ANY = "sb:last:any";
const unsigned = (c: number) => money(c, { signed: false });
const noopSubscribe = () => () => {};
function readStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
const toneCls = (c: number) => (c > 0 ? "" : c < 0 ? "sb-neg" : "sb-zero");

export default function Scoreboard({
  model,
  range,
  failed,
  inventory = null,
  inventoryFailed = false,
}: {
  model: Model | null;
  range: RangeKey;
  failed: boolean;
  /** Inventory + PC board (spec 18); loaded separately, null on failure. */
  inventory?: InventoryBoardModel | null;
  inventoryFailed?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The URL is the state; this only shows the clicked range while the
  // server renders it.
  const [selected, setSelected] = useOptimistic(range);

  // Last good numbers per range, so a failed refresh can keep them on screen
  // with a STALE chip (spec 7, errors). Written on every good render, read
  // only after a failure. A range never loaded before falls back to the last
  // good model of any range (labelled with its own range, not the clicked one).
  useEffect(() => {
    if (!model) return;
    try {
      const json = JSON.stringify(model);
      sessionStorage.setItem(STALE_KEY + model.range, json);
      sessionStorage.setItem(STALE_ANY, json);
    } catch {
      // storage unavailable: no stale fallback, the error banner still shows
    }
  }, [model]);
  const staleRaw = useSyncExternalStore(
    noopSubscribe,
    () => (failed ? (readStorage(STALE_KEY + range) ?? readStorage(STALE_ANY)) : null),
    () => null,
  );
  const stale = useMemo(() => (staleRaw ? (JSON.parse(staleRaw) as Model) : null), [staleRaw]);

  function changeRange(r: RangeKey) {
    if (r === selected) return;
    startTransition(() => {
      setSelected(r);
      router.replace(`/dashboard?range=${r}`, { scroll: false });
    });
  }

  const m = model ?? stale;
  const errorBanner = failed && (
    <div className="sb-ban sb-err" role="alert">
      <span><b>Couldn&rsquo;t load your scoreboard.</b> Try again.</span>
      <button type="button" className="sb-btn sb-pri" onClick={() => startTransition(() => router.refresh())}>
        Retry
      </button>
    </div>
  );

  // Today's inventory snapshot, independent of the scoreboard load.
  const invBoard = <InventoryBoard model={inventory} failed={inventoryFailed || !inventory} />;

  if (!m) {
    return (
      <main className="sb-page">
        {errorBanner}
        {inventory && <div className="sb-herorow">{invBoard}</div>}
      </main>
    );
  }

  const isStale = !model && !!stale;
  const h = m.hero;
  const noSales = !m.hasAnySales;
  const quietMonth = h.mtdSales === 0 && h.mtd === 0;
  const rangeEmpty = m.totals.sales === 0;
  const unit = m.window.mode;
  const rl = RANGE_LABEL[m.range];
  const lastSale = m.lastSaleDay ? shortDate(m.lastSaleDay) : "";
  const missing = h.missingCount;

  // ---------------------------------------------------------------- hero
  const heroValue = noSales || quietMonth ? "$0.00" : money(h.mtd);
  const heroTone = noSales || quietMonth ? "zero" : tone(h.mtd);
  const chips: React.ReactNode[] = [];
  if (isStale) chips.push(<span key="stale" className="sb-chip sb-warn">STALE</span>);
  if (noSales) {
    chips.push(<span key="ns" className="sb-chip sb-mute">NO SALES YET</span>);
  } else {
    if (h.vsPrevPct != null && !quietMonth) {
      const v = h.vsPrevPct;
      chips.push(
        <span key="vs" className={`sb-chip ${v > 0 ? "sb-up" : v < 0 ? "sb-dn" : "sb-mute"}`}>
          {v > 0 ? "▲ " : v < 0 ? "▼ " : ""}
          {pct(v)} VS {h.prevAbbr}
        </span>,
      );
    }
    if (h.mtdSales === 0) {
      chips.push(<span key="nsm" className="sb-chip sb-mute">NO SALES THIS MONTH</span>);
      if (lastSale) chips.push(<span key="ls" className="sb-chip sb-mute">LAST SALE {lastSale.toUpperCase()}</span>);
    }
    if (missing > 0) {
      chips.push(
        <Link key="mc" href={FIX_HREF} className="sb-chip sb-warn">
          {missing} OF {h.mtdSales} SALES MISSING COST
        </Link>,
      );
    }
    // Range-level signal (spec 16.2 must-fix 2): the month chip alone misses a
    // range whose sales all fall before this month.
    if (m.totals.missingCost > 0) {
      chips.push(
        <Link key="mcr" href={FIX_HREF} className="sb-chip sb-warn">
          {m.totals.missingCost} OF {m.totals.sales} SALES IN RANGE MISSING COST
        </Link>,
      );
    }
  }
  chips.push(
    <span key="at" className={`sb-chip ${h.allTime === 0 ? "sb-mute" : "sb-ink"}`}>
      ALL-TIME {money(h.allTime)}
    </span>,
  );

  const nothingLogged = noSales && h.netCash === 0;
  const note = nothingLogged ? (
    <>
      <b>NET CASH $0.00.</b> Nothing logged yet. Profit = what you sold for − what you paid for it, so it starts
      moving with your first sale.
    </>
  ) : (
    <>
      <b>NET CASH {money(h.netCash)}</b> = profit {money(h.allTime)}{" "}
      {h.stock >= 0 ? (
        <>− <b>{unsigned(h.stock)}</b> in unsold stock &amp; bulk lots.</>
      ) : (
        <>+ <b>{unsigned(-h.stock)}</b>.</>
      )}{" "}
      {missing > 0 ? (
        <b className="sb-warn">
          {missing} sale{missing === 1 ? " has" : "s have"} no card cost, so profit is overstated until you add it.
        </b>
      ) : h.mtdSales === 0 ? (
        <>Nothing sold in {h.monthName} yet.</>
      ) : (
        <>Profit only counts what sold.</>
      )}
    </>
  );

  // ----------------------------------------------------------- empty copy
  const chartEmpty = noSales
    ? { title: "NO SALES YET", body: "Log a sale or import your eBay report to start the scoreboard." }
    : rangeEmpty
      ? { title: "NO SALES IN THIS RANGE", body: `Last sale ${lastSale}. Switch to ALL to see your history.` }
      : null;
  const rangeWords = m.range === "30d" ? "the last 30 days" : m.range === "90d" ? "the last 90 days" : "the last year";

  // ------------------------------------------------------------------ KPIs
  const t = m.totals;
  const revDelta = informativeDelta(t.revenue, t.priorRevenue);
  const avg = t.sales ? Math.round(t.profit / t.sales) : 0;
  const margin = t.revenue !== 0 ? t.profit / t.revenue : null;
  const since = `since ${shortDate(m.window.start)}`;

  const pitch = m.pitch;
  const pitchRows = [
    { label: "Card costs", v: pitch.cardCosts, color: "var(--color-series-1)" },
    { label: "eBay fees", v: pitch.ebayFees, color: "var(--color-series-3)" },
    { label: "Shipping", v: pitch.shipping, color: "var(--color-series-2)" },
    { label: "Table fees", v: pitch.tableFees, color: "var(--color-series-4)" },
    ...(pitch.other !== 0 ? [{ label: "Other", v: pitch.other, color: "var(--color-ink-muted)" }] : []),
  ];
  const pitchTotal = pitchRows.reduce((s, r) => s + Math.max(r.v, 0), 0);
  const pitchEmpty = pitchTotal === 0;

  const inv = m.inventory;
  const goal = goalValue(null, h.mtd, unsigned); // no goal storage yet (gap 7)
  const lit = m.sellThrough ? Math.round(m.sellThrough.ratio * 10) : 0;
  const rangeDays = m.range === "30d" ? "30 days" : m.range === "90d" ? "90 days" : m.range === "1y" ? "1 year" : "all time";

  return (
    <main className="sb-page" aria-busy={pending || undefined}>
      <p className="sr-only" aria-live="polite">{m.announcement}</p>
      {errorBanner}

      {missing > 0 && (
        <div className="sb-ban">
          <span>
            <b>
              {missing} of {h.mtdSales} sales this month {missing === 1 ? "has" : "have"} no card cost.
            </b>{" "}
            Profit for {h.monthName} is overstated until you add what you paid.
          </span>
          <Link href={FIX_HREF} className="sb-btn sb-pri">
            Fix <span className="sb-cnt">{missing}</span> sale{missing === 1 ? "" : "s"}
          </Link>
        </div>
      )}

      {/* ------------------------- hero row: profit + inventory (spec 18) */}
      <div className="sb-herorow">
        <section className="board sb-board hero sb-hero" aria-label="Net profit this month">
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div className="sb-bl">
              <span>Net profit · {h.monthName}</span>
              <span className="sb-mute">MTD · {h.dayOfMonth} DAY{h.dayOfMonth === 1 ? "" : "S"}</span>
            </div>
            <div
              className={`sb-hv ${heroTone === "neg" ? "sb-neg" : heroTone === "zero" ? "sb-zero" : ""}`}
              aria-label={`Net profit this month ${noSales || quietMonth ? "$0.00" : moneyAria(h.mtd)}`}
            >
              {heroValue}
            </div>
            <div className="sb-chips">{chips}</div>
            <p className="sb-nt">{note}</p>
            {noSales && (
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <Link href="/data" className="sb-btn sb-pri">Import eBay report</Link>
                <Link href="/deals" className="sb-btn">Log a deal</Link>
              </div>
            )}
            <Spark
              values={h.spark}
              color={h.mtd < 0 ? "var(--color-neg)" : "var(--color-pos)"}
              className="sb-heroSpark"
            />
            <div className="sb-bl" style={{ marginTop: 4, opacity: 0.75 }}>
              <span>Daily profit · last 30 days</span>
            </div>
          </div>
        </section>
        {invBoard}
      </div>

      {/* ------------------------------------------- line score (own board) */}
      <section className="board sb-board hero sb-lsb" aria-label={`Line score, profit by ${unit}`}>
        <div>
          <div className="sb-bl">
            <span>Line score · profit by {unit}</span>
            <RangeControl value={isStale ? m.range : selected} onChange={changeRange} />
          </div>
          <LineScore buckets={m.buckets} unit={unit} hasOther={m.hasOther} missingCurrent={missing > 0} />
          {m.range === "1y" && m.window.clamped && m.firstSaleDay && (
            <p className="sb-sub" style={{ marginTop: 6 }}>
              1Y matches ALL until your first sale ({shortDate(m.firstSaleDay)}) is a year old.
            </p>
          )}
          {!noSales && rangeEmpty && m.range !== "all" && (
            <p className="sb-sub" style={{ marginTop: 6, color: "var(--color-amber)" }}>
              No sales in {rangeWords}. Last sale {lastSale}. Try ALL.
            </p>
          )}
          <div className="sb-bl" style={{ marginTop: 14 }}>
            <span>Profit by {unit} · channel</span>
            <span className="sb-leg">
              <span><i style={{ background: "var(--color-series-1)" }} />eBay</span>
              <span><i style={{ background: "var(--color-series-2)" }} />Shows</span>
              {m.hasOther && <span><i style={{ background: "var(--color-ink-muted)" }} />Other</span>}
            </span>
          </div>
          <div className="sb-ch sb-bars" role="img" aria-label={`Profit by ${unit} and channel; the line score table above has the same numbers`}>
            <ProfitBars buckets={m.buckets} hasOther={m.hasOther} />
            {rangeEmpty && (
              <div className="sb-empty"><div><b>{noSales ? "NO SALES YET" : "NO SALES IN RANGE"}</b></div></div>
            )}
          </div>
        </div>
      </section>

      {/* ------------------------------------------- chart + back of card */}
      <div className="sb-grid2">
        <section className="board sb-board" aria-label="Score progression">
          <div className="sb-bl">
            <span>Score progression · cumulative P&amp;L</span>
            <span className="sb-leg">
              <span><i style={{ background: "var(--color-pos)" }} />Net profit since {shortDate(m.window.start)}</span>
            </span>
          </div>
          <CumulativeChart
            key={m.range}
            points={m.cumulative.points}
            granularity={m.cumulative.granularity}
            entriesByDay={m.entriesByDay}
            start={m.window.start}
            empty={chartEmpty}
          />
        </section>
        <BackOfCard flip={m.flip} bestAllTime={m.bestFlipAllTime} hasAnySales={m.hasAnySales} lastSaleDay={m.lastSaleDay} />
      </div>

      {/* ------------------------------------------------------------- KPIs */}
      <section className="sb-kp" aria-label="Key figures">
        <div className="board sb-board sb-k">
          <div className="sb-bl"><span>Revenue after fees</span><span className="sb-mute">{rl}</span></div>
          {rangeEmpty ? (
            <><div className="sb-v sb-nil">—</div><div className="sb-s">no sales in range</div></>
          ) : (
            <>
              <div className={`sb-v ${t.revenue < 0 ? "sb-neg" : ""}`}>{unsigned(t.revenue)}</div>
              <div className="sb-s">
                {revDelta != null ? (
                  <><b className={toneCls(revDelta)}>{revDelta > 0 ? "▲" : revDelta < 0 ? "▼" : ""} {pct(revDelta)}</b> vs prior {rl.toLowerCase()}</>
                ) : (
                  since
                )}
              </div>
            </>
          )}
          <Spark values={rangeEmpty ? [] : t.revenueSpark} color="var(--color-ink)" className="sb-sp" />
        </div>

        <div className="board sb-board sb-k">
          <div className="sb-bl"><span>Avg profit / sale</span><span className="sb-mute">{rl}</span></div>
          {rangeEmpty ? (
            <><div className="sb-v sb-nil">—</div><div className="sb-s">no sales in range</div></>
          ) : (
            <>
              <div className={`sb-v ${avg < 0 ? "sb-neg" : avg === 0 ? "sb-nil" : ""}`} title="Net profit in range ÷ sales in range">
                {unsigned(avg)}
              </div>
              <div className="sb-s">
                {margin != null && (
                  <><b className={toneCls(Math.round(margin * 1000))} title="Margin = net profit ÷ revenue after fees">{margin < 0 ? "−" : ""}{pct(margin)}</b> margin · </>
                )}
                {t.sales} sale{t.sales === 1 ? "" : "s"}
              </div>
            </>
          )}
          <Spark values={rangeEmpty ? [] : t.profitSpark} color={t.profit < 0 ? "var(--color-neg)" : "var(--color-pos)"} className="sb-sp" />
        </div>

        <div className="board sb-board sb-k">
          <div className="sb-bl">Inventory · cost vs comps</div>
          {!inv || inv.cards_on_hand === 0 ? (
            <><div className="sb-v sb-nil">$0.00</div><div className="sb-s">add cards in Inventory</div></>
          ) : (
            <>
              <div className="sb-v">{unsigned(inv.known_cost_basis)}</div>
              <div className="sb-s">
                known cost · {inv.cards_on_hand} card{inv.cards_on_hand === 1 ? "" : "s"}
                {inv.cards_without_cost > 0 && <>, {inv.cards_without_cost} without a cost</>}
              </div>
              <div className="sb-s">Comps not tracked yet</div>
            </>
          )}
        </div>

        <div className="board sb-board sb-k">
          <div className="sb-bl">Monthly goal</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
            <GoalRing pct={null} />
            <div>
              <div className={`sb-v ${goal.muted ? "sb-nil" : ""}`} style={{ fontSize: 38, margin: "0 0 4px" }}>
                {goal.text}
              </div>
              <div className="sb-s">Monthly goal not set yet</div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ bottom row */}
      <section className="sb-row3" aria-label="Breakdowns">
        <div className="board sb-board">
          <div className="sb-bl"><span>Visitor vs home</span><span className="sb-mute">{rl}</span></div>
          <div className="sb-vs">
            {(["sports", "riftbound"] as const).map((side, i) => {
              const v = m.vs[side];
              const cell = (
                <div key={side}>
                  <small>{side.toUpperCase()}</small>
                  <b className={v.sales === 0 ? "sb-nil" : toneCls(v.profit)} title={v.sales ? moneyAria(v.profit) : undefined}>
                    {v.sales === 0 ? "—" : money(v.profit, { signed: false }).replace("$", "")}
                  </b>
                  <span>{v.sales === 0 ? "no sales" : `${v.sales} sale${v.sales === 1 ? "" : "s"}`}</span>
                </div>
              );
              return i === 0 ? [cell, <div key="dash" className="sb-dash" aria-hidden="true">–</div>] : cell;
            })}
          </div>
          {m.vsOutside !== 0 && (
            <p className="sb-sub" style={{ marginTop: 8 }}>
              {m.vsOutside < 0
                ? <>Doesn&rsquo;t include {unsigned(-m.vsOutside)} in unattributed expenses.</>
                : <>Doesn&rsquo;t include {unsigned(m.vsOutside)} outside the Sports / Riftbound split.</>}
            </p>
          )}
        </div>

        <div className="board sb-board">
          <div className="sb-bl"><span>Pitch count · where costs went</span><span className="sb-mute">{rl}</span></div>
          <div className="sb-pit" style={pitchEmpty ? { opacity: 0.35 } : undefined} aria-hidden="true">
            {pitchEmpty ? (
              <i style={{ width: "100%", background: "var(--color-grid)" }} />
            ) : (
              pitchRows.filter((r) => r.v > 0).map((r) => (
                <i key={r.label} style={{ flexBasis: `${(r.v / pitchTotal) * 100}%`, background: r.color }} />
              ))
            )}
          </div>
          <div className="sb-dl">
            {pitchRows.map((r) => (
              <div key={r.label}>
                <span><i style={{ background: r.color }} />{r.label}</span>
                <span>{pitchEmpty || (r.label === "Table fees" && r.v === 0) ? "—" : unsigned(r.v)}</span>
              </div>
            ))}
          </div>
          {pitch.tableFees === 0 && (
            <p className="sb-sub" style={{ marginTop: 6 }}>No table-fee category in the data yet; show costs land in Other.</p>
          )}
          {t.missingCost > 0 && (
            <p className="sb-sub" style={{ marginTop: 4, color: "var(--color-amber)" }}>
              {t.missingCost} of {t.sales} sale{t.sales === 1 ? "" : "s"} {t.missingCost === 1 ? "has" : "have"} no card cost.
            </p>
          )}
        </div>

        <div className="board sb-board">
          <div className="sb-bl">Days to sell</div>
          {m.daysToSell ? (
            <>
              <div className="sb-bigd">
                {Math.round(m.daysToSell.median)}
                <span style={{ fontSize: 24 }}> DAY{Math.round(m.daysToSell.median) === 1 ? "" : "S"}</span>
              </div>
              <div className="sb-sub">
                median · avg {Math.round(m.daysToSell.avg)} · {Math.round(m.daysToSell.within7 * 100)}% sell within 7 days
              </div>
            </>
          ) : (
            <><div className="sb-bigd sb-nil">—</div><div className="sb-sub">sell a tracked card to start the clock</div></>
          )}
        </div>

        <div className="board sb-board">
          <div className="sb-bl">Sell-through</div>
          <div className={`sb-bigd ${m.sellThrough ? "" : "sb-nil"}`}>
            {m.sellThrough ? `${Math.round(m.sellThrough.ratio * 100)}%` : "—"}
          </div>
          <div className="sb-lights" aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < lit ? "sb-o" : undefined} />)}
          </div>
          <div className="sb-sub">
            {m.sellThrough
              ? `${m.sellThrough.sold} sold of ${m.sellThrough.listed} listed · ${rangeDays}`
              : "needs listings to compare against"}
          </div>
        </div>
      </section>
    </main>
  );
}
