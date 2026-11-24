"use client";

import { useState } from "react";
import Link from "next/link";
import DataIO from "@/components/DataIO";
import EbayImport from "@/components/EbayImport";

const TABS = [
  { id: "table", label: "Table CSV" },
  { id: "ebay", label: "eBay report" },
] as const;

export default function DataTabs() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("table");

  return (
    <main className="pg">
      <header className="pg-head">
        <h1 className="pg-h1">Data import / export</h1>
        {/* X1: the link now targets the scoreboard, which is what it says. */}
        <Link href="/dashboard" className="lk text-[12.5px]">
          ← dashboard
        </Link>
      </header>

      <div className="tabs" role="tablist" aria-label="Data source">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`data-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`data-panel-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`data-panel-${tab}`} aria-labelledby={`data-tab-${tab}`}>
        {tab === "table" ? <DataIO embedded /> : <EbayImport />}
      </div>
    </main>
  );
}
