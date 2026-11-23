"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  previewImport,
  commitImport,
  type Preview,
  type CommitResult,
} from "@/app/(app)/data/actions";
import { TABLE_NAMES, type TableName } from "@/lib/tables";

export default function DataIO({ embedded = false }: { embedded?: boolean }) {
  const [table, setTable] = useState<TableName>("transactions");
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mode, setMode] = useState<"insert" | "update">("insert");
  const [result, setResult] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setPreview(null);
    setResult(null);
    setMode("insert");
  }

  // X4 (spec 17.1 Q5): back to "Choose file / No file chosen". Clearing the
  // input's value also means re-picking the same file fires onChange again.
  function cancel() {
    reset();
    setCsv("");
    setFileName("");
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    reset();
    setFileName(f?.name ?? "");
    if (!f) return setCsv("");
    const text = await f.text();
    setCsv(text);
    setBusy(true);
    const fd = new FormData();
    fd.set("table", table);
    fd.set("csv", text);
    setPreview(await previewImport(fd));
    setBusy(false);
  }

  async function onCommit() {
    setBusy(true);
    const fd = new FormData();
    fd.set("table", table);
    fd.set("csv", csv);
    fd.set("mode", mode);
    setResult(await commitImport(fd));
    setBusy(false);
  }

  const body = (
    <div className="grid gap-[22px]">
      <section className="flex items-center gap-3">
        <label htmlFor="data-table" className="bl">Table</label>
        <select
          id="data-table"
          value={table}
          onChange={(e) => {
            setTable(e.target.value as TableName);
            cancel();
          }}
          className="field"
        >
          {TABLE_NAMES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </section>

      <section className="board bd space-y-3">
        <h2 className="bl">Export</h2>
        <p className="sub">
          Every row, all columns including <code>id</code> — the format{" "}
          <code>restore.py</code> and the import below expect.
        </p>
        <a
          href={`/data/export?table=${table}`}
          className="btn pri"
        >
          Download {table}.csv
        </a>
      </section>

      <section className="board bd space-y-3">
        <h2 className="bl">Import</h2>
        <p className="sub">
          Preview first, then commit. Generated and unknown columns are dropped;
          rows are matched on{" "}
          <code>{table === "inventory_counts" ? "tax_year" : "id"}</code>.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          aria-label="CSV file to import"
          className="field-file block"
        />

        {busy && <p className="sub" role="status">working…</p>}

        {preview && !preview.ok && (
          <p className="ban err" role="alert">
            <span>{preview.error}</span>
          </p>
        )}

        {preview && preview.ok && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-ink">
              <span>
                <strong>{preview.total}</strong> rows in {fileName}
              </span>
              <span className="text-pos">{preview.newCount} new</span>
              <span className="text-ink-muted">
                {preview.existingCount} already present
              </span>
            </div>
            {preview.warnings.map((w, i) => (
              <p key={i} className="text-xs text-amber">
                {w}
              </p>
            ))}

            <div className="max-h-64 overflow-auto rounded-[4px] border border-line bg-cell">
              <table className="tb !text-[12px]">
                <thead>
                  <tr>
                    {Object.keys(preview.sample[0] ?? {}).map((c) => (
                      <th key={c}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((r, i) => (
                    <tr key={i}>
                      {Object.keys(preview.sample[0] ?? {}).map((c) => (
                        <td key={c} className="whitespace-nowrap">
                          {r[c]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.total > preview.sample.length && (
              <p className="text-xs text-ink-muted">
                showing first {preview.sample.length} of {preview.total}
              </p>
            )}

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[13px] text-ink">
                <input
                  type="radio"
                  className="accent-amber"
                  checked={mode === "insert"}
                  onChange={() => setMode("insert")}
                />
                insert new only
              </label>
              <label className="flex items-center gap-1.5 text-[13px] text-ink">
                <input
                  type="radio"
                  className="accent-amber"
                  checked={mode === "update"}
                  onChange={() => setMode("update")}
                />
                also update existing
              </label>
            </div>
            {mode === "update" && (
              <p className="text-xs text-amber">
                Updating rows bypasses the entry-path validation. CHECK
                constraints still apply — a bad edit is rejected.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={onCommit}
                disabled={busy}
                className="btn pri"
              >
                Commit {mode === "insert" ? preview.newCount : preview.total} rows
              </button>
              <button type="button" onClick={cancel} disabled={busy} className="btn">
                Cancel
              </button>
            </div>
          </div>
        )}

        {result && (
          <p className={`ban ${result.ok ? "" : "err"}`} role={result.ok ? "status" : "alert"}>
            {result.ok
              ? `Done — ${result.affected} rows ${
                  result.mode === "insert" ? "inserted" : "upserted"
                }.`
              : result.error}
          </p>
        )}
      </section>
    </div>
  );

  if (embedded) return body;

  return (
    <main className="pg">
      <header className="pg-head">
        <h1 className="pg-h1">Data import / export</h1>
        <Link href="/dashboard" className="lk text-[12.5px]">
          ← dashboard
        </Link>
      </header>
      {body}
    </main>
  );
}
