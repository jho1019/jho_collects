"use client";

import { useState } from "react";
import {
  previewEbay,
  commitEbay,
  type EbayPreview,
  type EbayCommit,
} from "@/app/(app)/data/ebay/actions";
import { signedUsd, toneClass, usd } from "@/lib/format";

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
    <section className="board bd space-y-3">
      <h2 className="bl">eBay report import</h2>
      <p className="sub">
        The raw Seller Hub <strong>Transaction report</strong> CSV. Payout /
        charge / transfer rows are ignored; sale &amp; refund rows dedupe on
        eBay&apos;s transaction id, so re-importing an overlapping range is safe.
      </p>

      <input
        type="file"
        accept=".csv,text/csv"
        onChange={onFile}
        aria-label="eBay transaction report CSV"
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
              <strong>{preview.rowCount}</strong> rows in {fileName}
            </span>
            <span className="font-medium text-pos">{preview.newCount} new</span>
            <span className="text-ink-muted">
              {preview.dupCount} already imported
            </span>
            {Object.keys(preview.ignored).length > 0 && (
              <span className="text-ink-muted">
                ignored{" "}
                {Object.entries(preview.ignored)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(", ")}
              </span>
            )}
          </div>

          <div className="cellrow text-xs">
            <div className="mb-1.5 font-semibold uppercase tracking-[0.14em] text-[10.5px] text-amber">
              Cross-check against eBay&apos;s own figures
            </div>
            <div className="grid grid-cols-2 gap-x-6 tabular-nums text-ink sm:grid-cols-3">
              <span>gross buyer payments {usd(preview.totals.grossBuyerPayments)}</span>
              <span>order proceeds ex-tax {usd(preview.totals.orderProceedsExTax)}</span>
              <span>eBay fees {usd(preview.totals.fees)}</span>
              <span>shipping labels {usd(preview.totals.labels)}</span>
              <span>
                net cash{" "}
                <span className={toneClass(preview.totals.netCash)}>
                  {signedUsd(preview.totals.netCash)}
                </span>
              </span>
            </div>
          </div>

          {preview.orphansResolvable.length > 0 && (
            <p className="text-xs text-ink-muted">
              {preview.orphansResolvable.length} orphan shipping label(s) will
              attach to an earlier order: {preview.orphansResolvable.join(", ")}
            </p>
          )}
          {preview.orphansUnresolvable.length > 0 && (
            <p className="text-xs text-amber">
              {preview.orphansUnresolvable.length} orphan label(s) have no
              matching order in the ledger and will be skipped:{" "}
              {preview.orphansUnresolvable.join(", ")}
            </p>
          )}

          <div className="max-h-64 overflow-auto rounded-[4px] border border-line bg-cell">
            <table className="tb !text-[12px]">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Buyer</th>
                  <th className="r">Item</th>
                  <th className="r">Fee</th>
                  <th className="r">Label</th>
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((r, i) => (
                  <tr key={i}>
                    <td className="mute whitespace-nowrap tabular-nums">{r.occurred_on}</td>
                    <td className="mute">{r.type}</td>
                    <td>{r.buyer_username ?? "—"}</td>
                    <td className="r">{usd(r.item_amount)}</td>
                    <td className="r">{usd(r.platform_fees)}</td>
                    <td className="r">{usd(r.shipping_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rowCount > preview.sample.length && (
            <p className="text-xs text-ink-muted">
              showing first {preview.sample.length} of {preview.rowCount}
            </p>
          )}

          <button
            onClick={onCommit}
            disabled={busy}
            className="btn pri"
          >
            Import {preview.newCount} new row{preview.newCount === 1 ? "" : "s"}
          </button>
        </div>
      )}

      {result && (
        <div
          className={result.ok ? "space-y-2" : "ban err"}
          role={result.ok ? "status" : "alert"}
        >
          {result.ok ? (
            <>
              {/* X5: result summary (rows added / duplicates / skipped). */}
              <h3 className="bl">Import result</h3>
              <div className="strip s3">
                <div>
                  <small>Added</small>
                  <b className={result.inserted > 0 ? "text-pos" : undefined}>{result.inserted}</b>
                </div>
                <div>
                  <small>Duplicates</small>
                  <b>{result.alreadyPresent}</b>
                </div>
                <div>
                  <small>Skipped labels</small>
                  <b className={result.orphansUnresolved.length > 0 ? "text-amber" : undefined}>
                    {result.orphansUnresolved.length}
                  </b>
                </div>
              </div>
              <p className="sub">
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
              </p>
            </>
          ) : (
            <span>{result.error}</span>
          )}
        </div>
      )}
    </section>
  );
}
