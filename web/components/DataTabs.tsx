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
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-surface">
          Data import / export
        </h1>
        <Link href="/" className="text-sm text-surface/70 hover:text-surface">
          ← dashboard
        </Link>
      </header>

      <div className="flex gap-1 border-b border-surface/30">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.id
                ? "border-surface font-medium text-surface"
                : "border-transparent text-surface/70 hover:text-surface"
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
