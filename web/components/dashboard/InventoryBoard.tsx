"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { createPortal } from "react-dom";
import BottomSheet from "@/components/BottomSheet";
import type { InventoryBoardModel } from "@/lib/dashboard/inventoryBoard";
import { money, moneyAria } from "@/lib/dashboard/format";
import type { InventoryGroup } from "@/lib/inventoryGroups";

// Inventory + PC board (spec 18): today's estimated value across Selling,
// Holding and PC, beside the profit hero. Every figure comes from
// lib/dashboard/inventoryBoard.ts; this only lays it out. Selling opens a
// breakdown (popover from md up, the shared bottom sheet below md); Holding
// and PC link to the filtered inventory page.

const COLOR: Record<InventoryGroup, string> = {
  selling: "var(--color-blue)",
  holding: "var(--color-amber)",
  pc: "var(--color-pos)",
};
const unsigned = (c: number) => money(c, { signed: false });
const cardsWord = (n: number) => `${n} card${n === 1 ? "" : "s"}`;

// md is 900px in this app (globals.css --breakpoint-md), the same switch the
// shell uses between its account menu and its bottom sheet.
const MD_QUERY = "(min-width: 900px)";
function subscribeMd(cb: () => void) {
  const mq = window.matchMedia(MD_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export default function InventoryBoard({ model, failed }: { model: InventoryBoardModel | null; failed: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const label = (
    <div className="sb-bl">
      <span>Inventory + PC value · Today</span>
    </div>
  );

  if (failed || !model) {
    return (
      <section className="board sb-board hero sb-invb" aria-label="Inventory and PC value today" aria-busy={pending || undefined}>
        {label}
        <div className="sb-ban sb-err" role="alert" style={{ marginTop: 14 }}>
          <span><b>Couldn&rsquo;t load inventory.</b> Try again.</span>
          <button type="button" className="sb-btn sb-pri" onClick={() => startTransition(() => router.refresh())}>
            Retry
          </button>
        </div>
      </section>
    );
  }
  return <Board model={model} label={label} />;
}

function Board({ model: m, label }: { model: InventoryBoardModel; label: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const wide = useSyncExternalStore(subscribeMd, () => window.matchMedia(MD_QUERY).matches, () => true);
  const wrapRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) openerRef.current?.focus();
  }, []);
  const closeSheet = useCallback(() => setOpen(false), []);

  // Desktop popover: Escape (focus back to the opener) and outside pointerdown.
  useEffect(() => {
    if (!open || !wide) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close(true);
    }
    function onDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) close(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, wide, close]);

  const g = m.groups;
  const total = m.totalCents;
  const seg = (k: InventoryGroup) => m.segments.find((s) => s.key === k)!;
  const ariaFor = (k: InventoryGroup) => {
    const t = g[k];
    const unpriced = t.missingPrice > 0 ? `, ${t.missingPrice} unpriced` : "";
    const action = k === "selling" ? "open breakdown" : `view ${k === "pc" ? "PC" : "holding"} cards`;
    return `${seg(k).label} ${moneyAria(t.valueCents, false)}, ${cardsWord(t.cards)}${unpriced}, ${action}`;
  };
  const href = (k: InventoryGroup) => `/inventory?group=${k}`;
  const toggle = () => setOpen((o) => !o);

  // ------------------------------------------------------------ copy
  const costLine =
    m.singles === 0 ? (
      <>No single cards on hand yet.</>
    ) : (
      <>
        Known cost <b>{unsigned(m.cost.knownCents)}</b> · {m.cost.withCost} of {m.cost.singles} card
        {m.cost.singles === 1 ? "" : "s"} {m.cost.singles === 1 ? "has" : "have"} a cost
      </>
    );
  const gapLine = m.gap ? (
    <>
      <b className={m.gap.cents >= 0 ? "sb-up" : "sb-dn"}>
        {money(m.gap.cents)}
      </b>{" "}
      vs cost on the {m.gap.cards === 1 ? "1 card that has" : `${m.gap.cards} cards that have`} both
    </>
  ) : m.singles > 0 ? (
    <>No card has both a cost and a value yet</>
  ) : null;

  const bulkParts = m.bulk.buckets.map((b) => `${b.label} × ${b.count}`).join(" · ");

  const content = <SellingBreakdown model={m} onNavigate={closeSheet} />;

  return (
    <section className="board sb-board hero sb-invb" aria-label="Inventory and PC value today">
      {label}
      <div className="sb-hv" aria-label={`Total estimated value ${moneyAria(total, false)}`} title={unsigned(total)}>
        {money(total, { signed: false, decimals: 0 })}
      </div>
      <p className="sb-nt">{costLine}</p>
      {gapLine && <p className="sb-nt">{gapLine}</p>}

      <div ref={wrapRef}>
        {/* The bar is a pointer convenience; the labelled cells below are the
            keyboard / screen-reader controls (one tab stop per group). */}
        {total > 0 ? (
          <div className="sb-invbar">
            {m.segments
              .filter((s) => s.valueCents > 0)
              .map((s) =>
                s.key === "selling" ? (
                  <button
                    key={s.key}
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    onClick={toggle}
                    title={s.label}
                    style={{ width: `${s.widthPct}%`, background: COLOR[s.key] }}
                  />
                ) : (
                  <Link
                    key={s.key}
                    href={href(s.key)}
                    tabIndex={-1}
                    aria-hidden="true"
                    title={s.label}
                    style={{ width: `${s.widthPct}%`, background: COLOR[s.key] }}
                  />
                ),
              )}
          </div>
        ) : (
          <div className="sb-invbar sb-nobar">No estimated values yet</div>
        )}

        <div className="sb-invsegs">
          {m.segments.map((s) => {
            const t = g[s.key];
            const inner = (
              <>
                <small><i style={{ background: COLOR[s.key] }} />{s.label}</small>
                <b className={t.valueCents === 0 ? "sb-nil" : undefined}>{unsigned(t.valueCents)}</b>
                <span>{cardsWord(t.cards)}</span>
                {t.missingPrice > 0 && <em>{t.missingPrice} unpriced</em>}
              </>
            );
            return s.key === "selling" ? (
              <button
                key={s.key}
                ref={openerRef}
                type="button"
                className="sb-invseg"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open && wide ? panelId : undefined}
                aria-label={ariaFor(s.key)}
                onClick={toggle}
              >
                {inner}
              </button>
            ) : (
              <Link key={s.key} href={href(s.key)} className="sb-invseg" aria-label={ariaFor(s.key)}>
                {inner}
              </Link>
            );
          })}

          {open && wide && (
            <div
              id={panelId}
              role="dialog"
              aria-label="Selling breakdown"
              className="absolute top-full left-0 z-40 mt-2 hidden w-[300px] max-w-full rounded-[6px] border border-line bg-board px-3 pt-2.5 pb-3 shadow-[0_12px_30px_rgb(0_0_0/0.6)] md:block"
            >
              <p className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-amber">
                Selling breakdown
              </p>
              {content}
            </div>
          )}
        </div>
      </div>

      <div className="sb-invhint">Tap a segment for details</div>
      <div className="sb-invgrow" />

      <div className="sb-invfoot">
        <span>
          {m.bulk.cards > 0 ? (
            <>
              Bulk boxes · {bulkParts} · <b>{unsigned(m.bulk.valueCents)}</b> (included in Selling)
            </>
          ) : (
            <>No bulk boxes counted yet</>
          )}
        </span>
        {m.missingPrice > 0 ? (
          <Link href="/inventory?price=missing" className="sb-chip sb-warn">
            {cardsWord(m.missingPrice)} missing a price →
          </Link>
        ) : (
          <span className="sb-mute">All cards priced</span>
        )}
      </div>
      <p className="sb-sub" style={{ marginTop: 10 }}>
        Today&rsquo;s snapshot · ignores the date range. Values are estimates (est_value, mostly Card Dealer Pro);
        cards without one are flagged, not counted as $0. Bulk boxes have no cost basis yet.
      </p>

      {/* Below md: the shell's bottom sheet, portalled to <body> so it takes
          the page theme like the More sheet instead of the dark board's. */}
      {open && !wide && createPortal(<BottomSheet title="Selling breakdown" onClose={closeSheet}>{content}</BottomSheet>, document.body)}
    </section>
  );
}

/** Same rows in the popover and the sheet. Total = the Selling segment. */
function SellingBreakdown({ model: m, onNavigate }: { model: InventoryBoardModel; onNavigate: () => void }) {
  const { rows, total } = m.selling;
  const firstBox = rows.findIndex((r) => r.kind === "box");
  const missing = rows.findIndex((r) => r.kind === "missing");
  return (
    <div>
      <table className="sb-bdt">
        <thead>
          <tr>
            <th scope="col">Tier</th>
            <th scope="col">Cards</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const cls = [
              r.count === 0 ? "sb-z" : "",
              i === firstBox || i === missing ? "sb-gap" : "",
              r.kind === "missing" && r.count > 0 ? "sb-miss" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <tr key={r.key} className={cls || undefined}>
                <td>{r.kind === "tier" ? `${r.label} singles` : r.label}</td>
                <td>{r.count}</td>
                <td>{r.valueCents == null ? "—" : unsigned(r.valueCents)}</td>
              </tr>
            );
          })}
          <tr className="sb-tot">
            <td>Total</td>
            <td>{total.count}</td>
            <td>{unsigned(total.valueCents)}</td>
          </tr>
        </tbody>
      </table>
      <p className="sb-sub" style={{ marginTop: 8, fontSize: 11 }}>
        {m.selling.caption}. Missing price is counted, never valued at $0.
      </p>
      <p className="sb-sub" style={{ marginTop: 8 }}>
        <Link href="/inventory?group=selling" onClick={onNavigate} className="text-blue underline underline-offset-2">
          View selling cards →
        </Link>{" "}
        Bulk boxes aren&rsquo;t card rows.
      </p>
    </div>
  );
}
