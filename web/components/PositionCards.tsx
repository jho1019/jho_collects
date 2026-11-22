"use client";

import { useState, useSyncExternalStore } from "react";
import { signedUsd, toneClass } from "@/lib/format";

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
    <section className="grid grid-cols-1 gap-[18px] sm:grid-cols-3">
      <Card
        label="Net cash"
        value={signedUsd(netCash)}
        sub="cash in − cash out"
        tone={toneClass(netCash, "text-ink")}
      />

      <div className="board bd">
        <div className="bl">
          <label htmlFor="est-inventory-value">Est. inventory value</label>
        </div>
        <div className="mb-1.5 mt-2.5 flex items-center gap-2">
          <span className="text-ink-muted">$</span>
          <input
            id="est-inventory-value"
            inputMode="decimal"
            value={draft ?? stored ?? ""}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            placeholder="0.00"
            className="field r w-full !text-[18px]"
          />
        </div>
        <div className="sub">manual, this browser</div>
      </div>

      <Card
        label="Adjusted position"
        value={adjusted === null ? "—" : signedUsd(adjusted)}
        sub={adjusted === null ? "enter an estimate" : "net cash + inventory"}
        tone={adjusted === null ? "text-ink-muted" : toneClass(adjusted, "text-ink")}
      />
    </section>
  );
}

function Card({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: string;
}) {
  return (
    <div className="board bd">
      <div className="bl">{label}</div>
      <div
        className={`num mb-1.5 mt-2.5 text-[44px] font-extrabold leading-none sm:text-[52px] ${tone}`}
      >
        {value}
      </div>
      <div className="sub">{sub}</div>
    </div>
  );
}
