"use client";

import { useEffect, useState } from "react";
import { usd } from "@/lib/format";

const KEY = "estimatedInventoryValue";

// Net cash is real. Estimated inventory value is a gut-feel market number the
// owner types in (stored per-browser). Adjusted position = the two together —
// a rough "where do I stand" figure, not an accounting number.
export default function PositionCards({ netCash }: { netCash: number }) {
  const [estimate, setEstimate] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw !== null && raw !== "") {
        setEstimate(Number(raw));
        setDraft(raw);
      }
    } catch {
      /* private window / storage blocked — just skip */
    }
  }, []);

  function save() {
    const n = draft.trim() === "" ? null : Number(draft);
    if (n !== null && Number.isNaN(n)) return;
    setEstimate(n);
    try {
      if (n === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(n));
    } catch {
      /* ignore */
    }
  }

  const adjusted = estimate === null ? null : netCash + estimate;

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Card
        label="Net cash"
        value={usd(netCash)}
        sub="cash in − cash out"
        negative={netCash < 0}
      />

      <div className="rounded-lg border border-brand-soft/25 bg-surface p-3">
        <div className="text-xs uppercase text-ink-muted">
          Est. inventory value
        </div>
        <div className="mt-1 flex items-center gap-1">
          <span className="text-ink-muted">$</span>
          <input
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            placeholder="0.00"
            className="w-full rounded border border-brand-soft/40 px-2 py-1 text-lg font-semibold tabular-nums text-ink outline-none focus:border-brand"
          />
        </div>
        <div className="mt-1 text-xs text-ink-muted">manual, this browser</div>
      </div>

      <Card
        label="Adjusted position"
        value={adjusted === null ? "—" : usd(adjusted)}
        sub={adjusted === null ? "enter an estimate" : "net cash + inventory"}
        negative={adjusted !== null && adjusted < 0}
      />
    </div>
  );
}

function Card({
  label,
  value,
  sub,
  negative,
}: {
  label: string;
  value: string;
  sub: string;
  negative: boolean;
}) {
  return (
    <div className="rounded-lg border border-brand-soft/25 bg-surface p-3">
      <div className="text-xs uppercase text-ink-muted">{label}</div>
      <div
        className={`mt-1 text-lg font-semibold tabular-nums ${
          negative ? "text-accent-ink" : "text-brand"
        }`}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-ink-muted">{sub}</div>
    </div>
  );
}
