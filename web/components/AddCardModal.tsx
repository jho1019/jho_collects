"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addBuyingListItem } from "@/app/(app)/buying/actions";

const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const FIELD =
  "rounded border border-brand-soft/40 bg-surface px-2 py-1.5 text-sm text-ink placeholder:text-ink-muted";

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
        className="rounded bg-brand px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90"
      >
        Add card
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/50 p-3 sm:p-6"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="w-full max-w-lg rounded-lg bg-surface p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">Add card</h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="text-ink-muted hover:text-ink"
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
                className={`flex min-h-24 items-center justify-center rounded border-2 border-dashed px-3 py-3 text-center text-sm outline-none ${
                  dragOver ? "border-brand bg-brand/10 text-brand" : "border-brand-soft/50 text-ink-muted"
                }`}
              >
                {preview ? (
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={preview} alt="Card preview" className="h-20 w-auto rounded" />
                    <button
                      type="button"
                      onClick={() => setImageFile(null)}
                      className="text-xs text-ink-muted underline hover:text-ink"
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

              {error && <p className="text-sm text-accent-ink">{error}</p>}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={close}
                  className="rounded border border-brand-soft/40 px-3 py-1.5 text-sm text-ink"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded bg-brand px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-50"
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
