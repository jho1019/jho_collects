"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { addComp, getCompHistory, type CompHistoryRow } from "@/app/(app)/buying/actions";
import { usd } from "@/lib/format";

// Type a price, press Enter or leave the field. A blank or unchanged value
// saves nothing. Each save is a NEW dated comp row, never an edit — the old
// price stays in history. The age line below opens it as a small popup.
//
// The popup is portaled to document.body and positioned with `fixed` from
// the toggle button's own screen coordinates, rather than rendered inline.
// The table wrapper this sits in is `overflow-x-auto`, and per the CSS
// overflow spec setting one axis to a non-visible value forces the other
// to `auto` too — so an inline `absolute` popup was clipped by that
// scroll container instead of floating over the page.
export default function CompInput({
  itemId,
  current,
  ageLabel,
  stale = false,
}: {
  itemId: number;
  current: number | null;
  ageLabel: React.ReactNode;
  /** Comp older than 30 days: the age line turns amber (spec B8). */
  stale?: boolean;
}) {
  const [value, setValue] = useState(current == null ? "" : current.toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [history, setHistory] = useState<CompHistoryRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function place() {
      const rect = toggleRef.current?.getBoundingClientRect();
      if (rect) setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    place();
    function onOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        toggleRef.current &&
        !toggleRef.current.contains(target) &&
        popupRef.current &&
        !popupRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }
    function close() {
      setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    // Scroll/resize can move the anchor; closing is simpler than tracking it live.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function save() {
    const price = Number(value.replace(/[$,]/g, ""));
    if (value.trim() === "" || (current != null && price === current)) return;
    startTransition(async () => {
      const res = await addComp(itemId, price);
      setError(res.error ?? null);
      setHistory(null); // stale after a new entry; refetch on next open
    });
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && history === null) {
      setLoadingHistory(true);
      getCompHistory(itemId)
        .then(setHistory)
        .finally(() => setLoadingHistory(false));
    }
  }

  return (
    <div className="flex flex-col items-end">
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted">
          $
        </span>
        <input
          type="text"
          inputMode="decimal"
          aria-label="Comp price"
          placeholder="0.00"
          value={value}
          disabled={pending}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="field r w-[112px] !pl-6"
        />
      </div>
      {error && <span className="text-[11.5px] text-neg">{error}</span>}
      {current != null && (
        <button
          ref={toggleRef}
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={`mt-[3px] flex items-center gap-1 text-[11.5px] hover:underline ${
            stale ? "text-amber" : "text-ink-muted"
          }`}
        >
          {ageLabel}
          <span className={`transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
        </button>
      )}
      {open &&
        pos &&
        createPortal(
          <div
            ref={popupRef}
            role="dialog"
            aria-label="Comp history"
            style={{ top: pos.top, right: pos.right }}
            className="pop fixed z-50 min-w-[156px] py-1.5"
          >
            {loadingHistory && <p className="px-3 py-[3px] text-ink-muted">Loading…</p>}
            {!loadingHistory && history?.length === 0 && (
              <p className="px-3 py-[3px] text-ink-muted">No history</p>
            )}
            {!loadingHistory &&
              history?.map((h) => (
                <div key={h.id} className="flex justify-between gap-4 whitespace-nowrap px-3 py-[3px]">
                  <span className="text-ink-muted">{h.observed_on}</span>
                  <span className="tabular-nums">{usd(h.price)}</span>
                </div>
              ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
