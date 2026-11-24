"use client";

import { usePathname, useRouter } from "next/navigation";

const OPTIONS = [5, 10, 50] as const;

// Changing page size always resets to page one — staying on page 7 while
// switching from 5 rows to 50 would land the user somewhere arbitrary.
export default function LedgerPageSizeSelect({ rows }: { rows: number }) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <label className="flex items-center gap-2 text-xs normal-case tracking-normal text-ink-muted">
      Show
      <select
        value={rows}
        onChange={(e) => router.push(`${pathname}?rows=${e.target.value}&page=1`)}
        aria-label="Rows per page"
        className="field field-sm"
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
