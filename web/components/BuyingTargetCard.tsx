"use client";

import { useState } from "react";
import { usd } from "@/lib/format";
import CompInput from "@/components/CompInput";
import CopyTitle from "@/components/CopyTitle";
import RowNotes from "@/components/RowNotes";
import CardImageLightbox from "@/components/CardImageLightbox";

// Mobile row for the buying list (Phase 12). The table this stands in for
// packs five columns per card — fine on a laptop, unreadable at phone width.
// At a show the only thing worth seeing at a glance is "is this the card I'm
// hunting" — image and title — so everything else (comp, target price,
// notes, listing links) sits behind one "See more" toggle per row.
export default function BuyingTargetCard({
  id,
  title,
  img,
  latestComp,
  compAgeDays,
  isStale,
  maxAllIn,
  isManual,
  notes,
  soldUrl,
  searchUrl,
  pointUrl,
}: {
  id: number;
  title: string;
  img?: string;
  latestComp: number | null;
  compAgeDays: number | null;
  isStale: boolean;
  maxAllIn: string | number | null;
  isManual: boolean;
  notes: string | null;
  soldUrl: string;
  searchUrl: string;
  pointUrl: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="cellrow min-w-0 !p-0">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt=""
            className="h-14 w-auto shrink-0 rounded-[3px] border border-line"
          />
        ) : (
          <span
            className="h-14 w-10 shrink-0 rounded-[3px] border border-dashed border-line"
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{title}</span>
        <span
          className={`shrink-0 text-ink-muted transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          ▾
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3">
          {img && (
            <div className="flex justify-center">
              <CardImageLightbox src={img} alt={title} />
            </div>
          )}

          <div className="min-w-0 wrap-anywhere">
            <CopyTitle title={title}>
              <span className="text-[13px] text-ink">{title}</span>
            </CopyTitle>
          </div>

          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-amber">
              Comp
            </span>
            <CompInput
              itemId={id}
              current={latestComp}
              stale={isStale}
              ageLabel={
                <>
                  {compAgeDays === 0 ? "today" : `${compAgeDays}d old`}
                  {isStale ? " · stale" : ""}
                </>
              }
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-amber">
              Target price
            </span>
            <span className="tabular-nums text-ink">
              {maxAllIn == null ? "—" : usd(maxAllIn)}
              {isManual && <span className="ml-1 text-[11.5px] text-ink-muted">manual</span>}
            </span>
          </div>

          <div>
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.14em] text-amber">
              Notes
            </span>
            <RowNotes itemId={id} initialNotes={notes} />
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-2 text-[13px]">
            <a href={soldUrl} target="_blank" rel="noopener noreferrer" className="lk">
              Recent sales
            </a>
            <a href={pointUrl} target="_blank" rel="noopener noreferrer" className="lk">
              130point
            </a>
            <a href={searchUrl} target="_blank" rel="noopener noreferrer" className="lk">
              eBay listings
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
