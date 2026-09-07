"use client";

import { useState } from "react";
import Link from "next/link";
import {
  previewImport,
  commitImport,
  type Preview,
  type CommitResult,
} from "@/app/data/actions";
import { TABLE_NAMES, type TableName } from "@/lib/tables";

export default function DataIO() {
  const [table, setTable] = useState<TableName>("transactions");
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mode, setMode] = useState<"insert" | "update">("insert");
  const [result, setResult] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setPreview(null);
    setResult(null);
    setMode("insert");
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

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Data import / export</h1>
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← dashboard
        </Link>
      </header>

      <section className="space-y-2">
        <label className="text-sm font-medium text-zinc-700">Table</label>
        <select
          value={table}
          onChange={(e) => {
            setTable(e.target.value as TableName);
            reset();
            setCsv("");
            setFileName("");
          }}
          className="ml-2 rounded border border-zinc-300 bg-white px-2 py-1 text-sm"
        >
          {TABLE_NAMES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </section>

      <section className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-medium text-zinc-700">Export</h2>
        <p className="text-xs text-zinc-500">
          Every row, all columns including <code>id</code> — the format{" "}
          <code>restore.py</code> and the import below expect.
        </p>
        <a
          href={`/data/export?table=${table}`}
          className="inline-block rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Download {table}.csv
        </a>
      </section>

      <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-medium text-zinc-700">Import</h2>
        <p className="text-xs text-zinc-500">
          Preview first, then commit. Generated and unknown columns are dropped;
          rows are matched on{" "}
          <code>{table === "inventory_counts" ? "tax_year" : "id"}</code>.
        </p>

        <input
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          className="block text-sm text-zinc-600 file:mr-3 file:rounded file:border file:border-zinc-300 file:bg-zinc-50 file:px-3 file:py-1.5 file:text-sm"
        />

        {busy && <p className="text-sm text-zinc-500">working…</p>}

        {preview && !preview.ok && (
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {preview.error}
          </p>
        )}

        {preview && preview.ok && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                <strong>{preview.total}</strong> rows in {fileName}
              </span>
              <span className="text-green-700">{preview.newCount} new</span>
              <span className="text-zinc-500">
                {preview.existingCount} already present
              </span>
            </div>
            {preview.warnings.map((w, i) => (
              <p key={i} className="text-xs text-amber-700">
                {w}
              </p>
            ))}

            <div className="max-h-64 overflow-auto rounded border border-zinc-200">
              <table className="w-full text-xs">
                <thead className="bg-zinc-50 text-left text-zinc-500">
                  <tr>
                    {Object.keys(preview.sample[0] ?? {}).map((c) => (
                      <th key={c} className="px-2 py-1 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((r, i) => (
                    <tr key={i} className="border-t border-zinc-100">
                      {Object.keys(preview.sample[0] ?? {}).map((c) => (
                        <td key={c} className="whitespace-nowrap px-2 py-1 text-zinc-700">
                          {r[c]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.total > preview.sample.length && (
              <p className="text-xs text-zinc-400">
                showing first {preview.sample.length} of {preview.total}
              </p>
            )}

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1 text-sm text-zinc-700">
                <input
                  type="radio"
                  checked={mode === "insert"}
                  onChange={() => setMode("insert")}
                />
                insert new only
              </label>
              <label className="flex items-center gap-1 text-sm text-zinc-700">
                <input
                  type="radio"
                  checked={mode === "update"}
                  onChange={() => setMode("update")}
                />
                also update existing
              </label>
            </div>
            {mode === "update" && (
              <p className="text-xs text-amber-700">
                Updating rows bypasses the entry-path validation. CHECK
                constraints still apply — a bad edit is rejected.
              </p>
            )}

            <button
              onClick={onCommit}
              disabled={busy}
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              Commit {mode === "insert" ? preview.newCount : preview.total} rows
            </button>
          </div>
        )}

        {result && (
          <p
            className={`rounded px-3 py-2 text-sm ${
              result.ok
                ? "bg-green-50 text-green-800"
                : "bg-red-50 text-red-700"
            }`}
          >
            {result.ok
              ? `Done — ${result.affected} rows ${
                  result.mode === "insert" ? "inserted" : "upserted"
                }.`
              : result.error}
          </p>
        )}
      </section>
    </main>
  );
}
