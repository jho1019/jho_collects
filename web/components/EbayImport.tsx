"use client";

import { useState } from "react";
import {
  previewEbay,
  commitEbay,
  type EbayPreview,
  type EbayCommit,
} from "@/app/data/ebay/actions";
import { usd } from "@/lib/format";

export default function EbayImport() {
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<EbayPreview | null>(null);
  const [result, setResult] = useState<EbayCommit | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    setPreview(null);
    setResult(null);
    setFileName(f?.name ?? "");
    if (!f) return setCsv("");
    const text = await f.text();
    setCsv(text);
    setBusy(true);
    const fd = new FormData();
    fd.set("csv", text);
    setPreview(await previewEbay(fd));
    setBusy(false);
  }

  async function onCommit() {
    setBusy(true);
    const fd = new FormData();
    fd.set("csv", csv);
    setResult(await commitEbay(fd));
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        The raw Seller Hub <strong>Transaction report</strong> CSV. Payout /
        charge / transfer rows are ignored; sale &amp; refund rows dedupe on
        eBay&apos;s transaction id, so re-importing an overlapping range is safe.
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
              <strong>{preview.rowCount}</strong> rows in {fileName}
            </span>
            <span className="text-green-700">{preview.newCount} new</span>
            <span className="text-zinc-500">
              {preview.dupCount} already imported
            </span>
            {Object.keys(preview.ignored).length > 0 && (
              <span className="text-zinc-400">
                ignored{" "}
                {Object.entries(preview.ignored)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(", ")}
              </span>
            )}
          </div>

          <div className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs">
            <div className="mb-1 font-medium text-zinc-600">
              Cross-check against eBay&apos;s own figures
            </div>
            <div className="grid grid-cols-2 gap-x-6 tabular-nums text-zinc-700 sm:grid-cols-3">
              <span>gross buyer payments {usd(preview.totals.grossBuyerPayments)}</span>
              <span>order proceeds ex-tax {usd(preview.totals.orderProceedsExTax)}</span>
              <span>eBay fees {usd(preview.totals.fees)}</span>
              <span>shipping labels {usd(preview.totals.labels)}</span>
              <span>net cash {usd(preview.totals.netCash)}</span>
            </div>
          </div>

          {preview.orphansResolvable.length > 0 && (
            <p className="text-xs text-zinc-600">
              {preview.orphansResolvable.length} orphan shipping label(s) will
              attach to an earlier order: {preview.orphansResolvable.join(", ")}
            </p>
          )}
          {preview.orphansUnresolvable.length > 0 && (
            <p className="text-xs text-amber-700">
              {preview.orphansUnresolvable.length} orphan label(s) have no
              matching order in the ledger and will be skipped:{" "}
              {preview.orphansUnresolvable.join(", ")}
            </p>
          )}

          <div className="max-h-64 overflow-auto rounded border border-zinc-200">
            <table className="w-full text-xs">
              <thead className="bg-zinc-50 text-left text-zinc-500">
                <tr>
                  <th className="px-2 py-1 font-medium">Date</th>
                  <th className="px-2 py-1 font-medium">Type</th>
                  <th className="px-2 py-1 font-medium">Buyer</th>
                  <th className="px-2 py-1 text-right font-medium">Item</th>
                  <th className="px-2 py-1 text-right font-medium">Fee</th>
                  <th className="px-2 py-1 text-right font-medium">Label</th>
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((r, i) => (
                  <tr key={i} className="border-t border-zinc-100">
                    <td className="px-2 py-1 tabular-nums text-zinc-600">
                      {r.occurred_on}
                    </td>
                    <td className="px-2 py-1 text-zinc-600">{r.type}</td>
                    <td className="px-2 py-1 text-zinc-700">
                      {r.buyer_username ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-zinc-700">
                      {usd(r.item_amount)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-zinc-700">
                      {usd(r.platform_fees)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-zinc-700">
                      {usd(r.shipping_cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rowCount > preview.sample.length && (
            <p className="text-xs text-zinc-400">
              showing first {preview.sample.length} of {preview.rowCount}
            </p>
          )}

          <button
            onClick={onCommit}
            disabled={busy}
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            Import {preview.newCount} new row{preview.newCount === 1 ? "" : "s"}
          </button>
        </div>
      )}

      {result && (
        <div
          className={`rounded px-3 py-2 text-sm ${
            result.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"
          }`}
        >
          {result.ok ? (
            <>
              Imported {result.inserted} transaction
              {result.inserted === 1 ? "" : "s"}
              {result.alreadyPresent > 0 &&
                `, ${result.alreadyPresent} already present`}
              . {result.buyersUpserted} buyer(s) upserted
              {result.cardsClosed > 0 &&
                `, ${result.cardsClosed} card(s) closed by SKU`}
              {result.orphansApplied.length > 0 &&
                `, orphan labels applied: ${result.orphansApplied.join(", ")}`}
              {result.orphansUnresolved.length > 0 &&
                `, unresolved orphan labels: ${result.orphansUnresolved.join(", ")}`}
              .
            </>
          ) : (
            result.error
          )}
        </div>
      )}
    </div>
  );
}
