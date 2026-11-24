"use client";

import { useState } from "react";

// Shows a small "copy" button while hovering (or keyboard-focusing) the card
// name; copies the title text to the clipboard.
export default function CopyTitle({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(title);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context or denied) — nothing to fall back to.
    }
  }

  return (
    <span className="group inline-flex flex-wrap items-center gap-2">
      <span className="text-ink">{children}</span>
      <button
        type="button"
        onClick={copy}
        className="rounded-[2px] border border-line bg-chip-bg px-1.5 text-[10.5px] uppercase tracking-[0.06em] text-ink-muted opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
