"use client";

import { useRef } from "react";
import { RANGES, RANGE_LABEL, type RangeKey } from "@/lib/dashboard/range";

// Segmented 30D | 90D | 1Y | ALL (spec 6.5) as a radiogroup: one tab stop,
// arrow keys move and select, Home/End jump. The URL (?range=) is the state.
export default function RangeControl({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (r: RangeKey) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function move(to: number) {
    const i = (to + RANGES.length) % RANGES.length;
    refs.current[i]?.focus();
    onChange(RANGES[i]);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Chart range"
      className="sb-seg"
      onKeyDown={(e) => {
        const i = RANGES.indexOf(value);
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(i + 1); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(i - 1); }
        else if (e.key === "Home") { e.preventDefault(); move(0); }
        else if (e.key === "End") { e.preventDefault(); move(RANGES.length - 1); }
      }}
    >
      {RANGES.map((r, i) => (
        <button
          key={r}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={r === value}
          tabIndex={r === value ? 0 : -1}
          onClick={() => onChange(r)}
        >
          {RANGE_LABEL[r]}
        </button>
      ))}
    </div>
  );
}
