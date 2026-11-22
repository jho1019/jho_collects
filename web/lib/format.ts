// Display formatting for money. Display only: never feed these strings back
// into a calculation or a CSV.
//
// Sign rules (SPEC_E_SCOREBOARD.md section 0.6 and 7, Johnny Nov 22):
//   * negatives use U+2212 "−", not an ASCII hyphen;
//   * zero is "$0.00" — never "+$0.00", never "-$0.00", never green;
//   * signed figures (P&L, net cash) carry an explicit "+" via signedUsd().

export const MINUS = "−";

function cents(n: number | string | null | undefined): number {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  if (!Number.isFinite(v)) return 0;
  // Round to cents first so -0.004 is zero, not "−$0.00".
  return Math.round(v * 100);
}

function abs(c: number): string {
  return (Math.abs(c) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** "$12.50", "−$12.50", "$0.00". No "+" on positives. */
export function usd(n: number | string | null | undefined): string {
  const c = cents(n);
  return c < 0 ? `${MINUS}${abs(c)}` : abs(c);
}

/** "+$12.50", "−$12.50", "$0.00". For P&L and net cash figures. */
export function signedUsd(n: number | string | null | undefined): string {
  const c = cents(n);
  return c > 0 ? `+${abs(c)}` : c < 0 ? `${MINUS}${abs(c)}` : abs(c);
}

/** Whole dollars, signed: "+$13", "−$64", "$0" (calendar day cells). */
export function signedUsdWhole(n: number | string | null | undefined): string {
  const d = Math.round(cents(n) / 100);
  const s = `$${Math.abs(d).toLocaleString("en-US")}`;
  return d > 0 ? `+${s}` : d < 0 ? `${MINUS}${s}` : s;
}

/** Text colour utility for a signed figure; zero stays neutral. */
export function toneClass(
  n: number | string | null | undefined,
  zero = "",
): string {
  const c = cents(n);
  return c > 0 ? "text-pos" : c < 0 ? "text-neg" : zero;
}

/** Axis tick: "−$900", "$0", "$300". */
export function axisUsd(n: number): string {
  const d = Math.round(n);
  return `${d < 0 ? MINUS : ""}$${Math.abs(d).toLocaleString("en-US")}`;
}

export function isoDay(d: string | Date): string {
  return (typeof d === "string" ? new Date(d) : d).toISOString().slice(0, 10);
}
