"use client";

import { useState, useTransition } from "react";
import { updateBuyingListNotes } from "@/app/(app)/buying/actions";

// Sits under the card title. Collapsed, it's a one-line "why" or a quiet
// "+ note" prompt when empty; clicking either expands an editable textarea
// that saves on blur, same pattern as CompInput.
export default function RowNotes({
  itemId,
  initialNotes,
}: {
  itemId: number;
  initialNotes: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState(initialNotes ?? "");
  const [saved, setSaved] = useState(initialNotes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    if (value === saved) return;
    startTransition(async () => {
      const res = await updateBuyingListNotes(itemId, value);
      if (res.error) setError(res.error);
      else {
        setError(null);
        setSaved(value);
      }
    });
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-0.5 block max-w-xs truncate text-left text-xs text-ink-muted hover:text-ink"
      >
        {saved ? saved : "+ note"}
      </button>
    );
  }

  return (
    <div className="mt-1">
      <textarea
        autoFocus
        rows={2}
        value={value}
        disabled={pending}
        placeholder="Why you want this one"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          save();
          setExpanded(false);
        }}
        className="w-full max-w-xs resize-y rounded border border-brand-soft/40 bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-muted"
      />
      {error && <span className="block text-xs text-accent-ink">{error}</span>}
    </div>
  );
}
