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
    <main className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-on-page">
          Data import / export
        </h1>
        <Link href="/" className="text-sm text-on-page/70 hover:text-on-page">
          ← dashboard
        </Link>
      </header>

      <div className="flex gap-1 border-b border-on-page/30">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.id
                ? "border-on-page font-medium text-on-page"
                : "border-transparent text-on-page/70 hover:text-on-page"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "table" ? <DataIO embedded /> : <EbayImport />}
    </main>
  );
}
