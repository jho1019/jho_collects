"use client";

import { useEffect, useId, useRef } from "react";

// Shared mobile bottom sheet (the shell's More / Menu sheet chrome, also the
// dashboard's Selling breakdown). Scrim, rounded panel with the 3px amber top
// border, amber title row and a Close button. Escape and scrim tap close it;
// focus moves into the panel on open and back to the opener on close.
// Hidden from md up, where the callers use a bar / popover instead.
export default function BottomSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <button
        type="button"
        aria-label={`Close ${title.toLowerCase()}`}
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-xl border-t-[3px] border-amber bg-board px-[18px] pt-3.5 pb-[max(22px,env(safe-area-inset-bottom))] shadow-[0_-20px_60px_rgb(0_0_0/0.6)] focus:outline-none"
      >
        <div className="mb-2.5 flex items-center justify-between gap-2.5">
          <h2
            id={titleId}
            className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-amber"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 px-1 font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-muted hover:text-ink"
          >
            <span aria-hidden="true">✕ </span>Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
