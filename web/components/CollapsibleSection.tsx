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
    <section className="grid min-w-0 gap-2.5">
      <h2>
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          className="cs"
        >
          <span
            className={`inline-block transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
            aria-hidden
          >
            ▾
          </span>
          {title}
          <span className="cs-n">({count})</span>
        </button>
      </h2>
      {open && children}
    </section>
  );
}
