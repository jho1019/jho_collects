"use client";

import { useEffect, useState } from "react";

// The table's thumbnail: a hover magnifying-glass hint, click opens the full
// image over the page. Plain `position: fixed` (no portal) is enough here —
// unlike CompInput's small anchored popup, a full-viewport overlay isn't
// clipped by the table's overflow-x-auto ancestor.
export default function CardImageLightbox({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View larger image of ${alt}`}
        className="group relative block shrink-0 cursor-zoom-in"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="h-28 w-auto rounded border border-brand-soft/25" />
        <span className="absolute inset-0 flex items-center justify-center rounded bg-ink/0 opacity-0 transition-opacity group-hover:bg-ink/40 group-hover:opacity-100">
          <MagnifierIcon />
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/75 p-6"
          onClick={() => setOpen(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="absolute right-6 top-6 text-2xl leading-none text-surface hover:opacity-80"
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

function MagnifierIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <circle cx="10" cy="10" r="6" stroke="white" strokeWidth="2" />
      <path d="M14.5 14.5 20 20" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
