"use client";

import { useState } from "react";

// Section header that toggles its children. Collapsed, only the header (and
// its count) stays visible — the point of splitting PC/Investing out of a
// per-set breakdown that used to render a header for every set.
export default function CollapsibleSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <span
          className={`text-on-page transition-transform ${open ? "" : "-rotate-90"}`}
          aria-hidden
        >
          ▾
        </span>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-on-page">
          {title}
          <span className="ml-1 font-normal normal-case text-on-page/60">({count})</span>
        </h2>
      </button>
      {open && children}
    </section>
  );
}
