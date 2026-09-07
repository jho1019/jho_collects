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
      <Card label="Net cash" value={usd(netCash)} sub="cash in − cash out" />

      <div className="rounded-lg border border-zinc-200 bg-white p-3">
        <div className="text-xs uppercase text-zinc-500">
          Est. inventory value
        </div>
        <div className="mt-1 flex items-center gap-1">
          <span className="text-zinc-400">$</span>
          <input
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            placeholder="0.00"
            className="w-full rounded border border-zinc-200 px-2 py-1 text-lg font-semibold tabular-nums outline-none focus:border-zinc-400"
          />
        </div>
        <div className="mt-1 text-xs text-zinc-400">manual, this browser</div>
      </div>

      <Card
        label="Adjusted position"
        value={adjusted === null ? "—" : usd(adjusted)}
        sub={adjusted === null ? "enter an estimate" : "net cash + inventory"}
      />
    </div>
  );
}

function Card({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <div className="text-xs uppercase text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-zinc-900">
        {value}
      </div>
      <div className="mt-1 text-xs text-zinc-400">{sub}</div>
    </div>
  );
}
