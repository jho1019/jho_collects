"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addBuyingListItem } from "@/app/(app)/buying/actions";

const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const FIELD = "field";

function extractImageFile(items: DataTransferItemList | null): File | null {
  if (!items) return null;
  for (const item of items) {
    if (item.kind === "file" && ACCEPTED.includes(item.type)) {
      return item.getAsFile();
    }
  }
  return null;
}

export default function AddCardModal() {
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  function setImageFile(file: File | null) {
    if (preview) URL.revokeObjectURL(preview);
    setImage(file);
    setPreview(file ? URL.createObjectURL(file) : null);
  }

  function close() {
    setOpen(false);
    setError(null);
    setImageFile(null);
    formRef.current?.reset();
  }

  // Escape closes, as listed in spec B3 (the modal only had the X and
  // scrim click before). Same handler pattern as CardImageLightbox.
  useEffect(() => {
    if (!open) return;
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function submit(formData: FormData) {
    setError(null);
    if (image) formData.set("image", image);
    startTransition(async () => {
      const res = await addBuyingListItem(formData);
      if (res.error) {
        setError(res.error);
        return;
      }
      close();
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn pri"
      >
        <span aria-hidden>+</span> Add card
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-3 sm:p-8"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-card-title"
            className="board bd my-2 w-full max-w-lg"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2
                id="add-card-title"
                className="num text-[28px] font-black uppercase leading-none tracking-[0.02em] text-ink"
              >
                Add card
              </h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="btn sm"
              >
                ✕
              </button>
            </div>

            <form ref={formRef} action={submit} className="space-y-3">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const file = e.dataTransfer.files[0];
                  if (file && ACCEPTED.includes(file.type)) setImageFile(file);
                }}
                onPaste={(e) => {
                  const file = extractImageFile(e.clipboardData?.items ?? null);
                  if (file) setImageFile(file);
                }}
                tabIndex={0}
                className={`flex min-h-24 items-center justify-center rounded-[4px] border border-dashed bg-cell px-3 py-3 text-center text-[12.5px] ${
                  dragOver ? "border-amber text-amber" : "border-line text-ink-muted"
                }`}
              >
                {preview ? (
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={preview} alt="Card preview" className="h-20 w-auto rounded-[3px] border border-line" />
                    <button
                      type="button"
                      onClick={() => setImageFile(null)}
                      className="lk text-xs"
                    >
                      Remove image
                    </button>
                  </div>
                ) : (
                  <span>Drag an image here, or click and paste (Ctrl+V)</span>
                )}
              </div>

              <input name="title" placeholder="Title *" required className={`w-full ${FIELD}`} />
              <div className="grid grid-cols-2 gap-2">
                <input name="player" placeholder="Player" className={FIELD} />
                <input name="year" type="number" placeholder="Year" className={FIELD} />
                <input
                  name="set_name"
                  placeholder="Set (e.g. 2018 Topps Heritage)"
                  className={`col-span-2 ${FIELD}`}
                />
                <input name="card_number" placeholder="Card #" className={FIELD} />
                <input name="parallel" placeholder="Parallel" className={FIELD} />
                <input name="grader" placeholder="Grader (PSA, BGS…)" className={FIELD} />
                <input
                  name="grade_min"
                  type="number"
                  step="0.5"
                  placeholder="Grade or better"
                  className={FIELD}
                />
                <select name="purpose" defaultValue="pc" className={FIELD}>
                  <option value="pc">Personal collection</option>
                  <option value="flip">Flip</option>
                </select>
                <input
                  name="max_price"
                  type="number"
                  step="0.01"
                  placeholder="Max price (overrides formula)"
                  className={FIELD}
                />
                <input
                  name="search_url"
                  placeholder="Saved search URL"
                  className={`col-span-2 ${FIELD}`}
                />
                <input name="priority" type="number" placeholder="Priority" className={FIELD} />
                <textarea
                  name="notes"
                  placeholder="Notes — why you want this one"
                  rows={2}
                  className={`col-span-2 resize-y ${FIELD}`}
                />
              </div>

              {error && (
                <p className="ban err" role="alert">
                  <span>{error}</span>
                </p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={close}
                  className="btn"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="btn pri"
                >
                  {pending ? "Adding…" : "Add card"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
