"use client";

import { usePathname, useRouter } from "next/navigation";

const OPTIONS = [5, 10, 50] as const;

// Changing page size always resets to page one — staying on page 7 while
// switching from 5 rows to 50 would land the user somewhere arbitrary.
export default function LedgerPageSizeSelect({ rows }: { rows: number }) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <label className="flex items-center gap-1.5 text-xs text-surface/80">
      Show
      <select
        value={rows}
        onChange={(e) => router.push(`${pathname}?rows=${e.target.value}&page=1`)}
        className="rounded border border-surface/40 bg-surface px-1.5 py-0.5 text-xs text-ink"
      >
        {OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      transactions
    </label>
  );
}
