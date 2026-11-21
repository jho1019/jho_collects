"use client";

import { useState, useSyncExternalStore } from "react";
import { usd } from "@/lib/format";

const KEY = "estimatedInventoryValue";
// `storage` only fires in *other* tabs; this one notifies the current tab.
const LOCAL_EVENT = "estimatedInventoryValue:change";

// localStorage is an external store, so it is read with
// useSyncExternalStore rather than copied into state from an effect. The
// server snapshot is null, which keeps hydration identical to the server HTML.
function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(LOCAL_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(LOCAL_EVENT, onChange);
  };
}

function readStored(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null || raw === "" ? null : raw;
  } catch {
    return null; // private window / storage blocked — just skip
  }
}

// Net cash is real. Estimated inventory value is a gut-feel market number the
// owner types in (stored per-browser). Adjusted position = the two together —
// a rough "where do I stand" figure, not an accounting number.
export default function PositionCards({ netCash }: { netCash: number }) {
  const stored = useSyncExternalStore(subscribe, readStored, () => null);
  // null = not being edited; the input shows the stored value.
  const [draft, setDraft] = useState<string | null>(null);
  const estimate = stored === null ? null : Number(stored);

  function save() {
    const text = draft ?? stored ?? "";
    const n = text.trim() === "" ? null : Number(text);
    if (n !== null && Number.isNaN(n)) return;
    try {
      if (n === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(n));
      window.dispatchEvent(new Event(LOCAL_EVENT));
    } catch {
      /* ignore */
    }
    setDraft(null);
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
        <div className="text-xs uppercase tracking-wide text-ink-muted">
          Est. inventory value
        </div>
        <div className="mt-1 flex items-center gap-1">
          <span className="text-ink-muted">$</span>
          <input
            inputMode="decimal"
            value={draft ?? stored ?? ""}
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
      <div className="text-xs uppercase tracking-wide text-ink-muted">{label}</div>
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
