"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { uploadReleaseImage } from "@/app/(app)/releases/actions";
import CardImageLightbox from "@/components/CardImageLightbox";

// Thumbnail (click to enlarge) with an upload/replace control. With no image,
// the dashed placeholder is itself the upload button. An image can also be
// pasted (Ctrl/Cmd+V) while the pointer is over this cell or it has focus, or
// dropped onto it.
export default function ReleaseImage({
  releaseId,
  title,
  src,
}: {
  releaseId: number;
  title: string;
  src?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onPick(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("That isn't an image.");
      return;
    }
    const fd = new FormData();
    fd.set("image", file);
    startTransition(async () => {
      const res = await uploadReleaseImage(releaseId, fd);
      setError(res.error ?? null);
      if (inputRef.current) inputRef.current.value = "";
    });
  }

  // Document-level so the user needn't click first: hover the cell and paste.
  // Skipped when typing in a field (e.g. the quantity box) so text paste works.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const active = document.activeElement;
      const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (typing) return;
      if (!hovered.current && !wrapRef.current?.contains(active)) return;
      const file = Array.from(e.clipboardData?.files ?? []).find((f) =>
        f.type.startsWith("image/"),
      );
      if (!file) return;
      e.preventDefault();
      onPick(file);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [releaseId]);

  return (
    <div
      ref={wrapRef}
      onMouseEnter={() => (hovered.current = true)}
      onMouseLeave={() => (hovered.current = false)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onPick(e.dataTransfer.files[0]);
      }}
      className="flex flex-col items-start gap-1"
    >
      {src ? (
        <CardImageLightbox src={src} alt={title} />
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={pending}
          aria-label={`Upload image for ${title}`}
          className="flex h-16 w-12 items-center justify-center rounded border border-dashed border-brand-soft/40 text-lg text-ink-muted hover:border-brand hover:text-ink"
        >
          {pending ? "…" : "+"}
        </button>
      )}
      {!src && !pending && (
        <span className="text-[10px] leading-tight text-ink-muted">or paste</span>
      )}
      {src && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={pending}
          className="text-xs text-ink-muted underline hover:text-ink"
        >
          {pending ? "Uploading…" : "Replace"}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0])}
      />
      {error && <span className="max-w-32 text-xs text-accent-ink">{error}</span>}
    </div>
  );
}
