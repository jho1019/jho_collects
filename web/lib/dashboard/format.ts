// Money display for the scoreboard. All amounts are integer cents.
//
// Rules (spec 6.3, 7 cross-cutting, Johnny Nov 22):
//   * positive figures carry "+", negative carry U+2212 "−" (display only);
//   * zero is "$0.00" — never "+$0.00", never green;
//   * aria labels use an ASCII "-" because some screen readers skip U+2212.

export const MINUS = "−";

export type Tone = "pos" | "neg" | "zero";

export function tone(cents: number): Tone {
  return cents > 0 ? "pos" : cents < 0 ? "neg" : "zero";
}

function abs(cents: number, decimals: 0 | 2): string {
  const v = Math.abs(cents) / 100;
  return v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** "+$165.70", "−$38.40", "$0.00". `signed: false` drops the "+" only. */
export function money(
  cents: number,
  { decimals = 2, signed = true }: { decimals?: 0 | 2; signed?: boolean } = {},
): string {
  const rounded = decimals === 0 ? Math.round(cents / 100) * 100 : cents;
  const sign = rounded < 0 ? MINUS : rounded > 0 && signed ? "+" : "";
  return `${sign}$${abs(rounded, decimals)}`;
}

/** Same as money() with an ASCII minus, for aria-label text. */
export function moneyAria(cents: number, signed = true): string {
  return money(cents, { signed }).replace(MINUS, "-");
}

/** Line-score cell / vs numbers without "$": "+112.70", "−38", "0.00". */
export function bare(cents: number, decimals: 0 | 2 = 2, signed = true): string {
  return money(cents, { decimals, signed }).replace("$", "");
}

/** Chart axis ticks: "−$900", "$0", "$300" (same as the mock's fmtAxis). */
export function fmtAxis(dollars: number): string {
  const sign = dollars < 0 ? MINUS : "";
  return `${sign}$${Math.abs(dollars).toLocaleString("en-US")}`;
}

/** "18.3%" from a ratio; null-safe callers decide what to show. */
export function pct(ratio: number, decimals = 1): string {
  return `${(Math.abs(ratio) * 100).toFixed(decimals)}%`;
}

/** Nice axis scale that always includes 0 (spec 6.6 / 6.7). Dollars in, dollars out. */
export function niceScale(
  min: number,
  max: number,
  ticks = 4,
): { lo: number; hi: number; step: number; ticks: number[] } {
  const hiIn = Math.max(max, 0);
  const loIn = Math.min(min, 0);
  if (hiIn === 0 && loIn === 0) {
    return { lo: 0, hi: 100, step: 25, ticks: [0, 25, 50, 75, 100] };
  }
  const raw = Math.max(hiIn - loIn, 1) / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((x) => x >= raw)!;
  const lo = Math.floor(loIn / step) * step;
  const hi = Math.ceil(hiIn / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) out.push(Math.round(v * 100) / 100);
  return { lo, hi, step, ticks: out };
}

/**
 * Profit-bar Y scale (spec 16.2 nice-to-have 5): the top is nice(max × 1.22)
 * from the positive stack alone, so a −$180 week no longer drags a $540 bar's
 * axis up to $1,000. The negative side snaps down to the same step. When the
 * negatives dominate (more than 6 steps), fall back to the full-span scale.
 */
export function barScale(minNeg: number, maxPos: number): ReturnType<typeof niceScale> {
  const lo0 = Math.min(minNeg, 0);
  const top = Math.max(maxPos, 0) * 1.22;
  if (top === 0) return niceScale(lo0, 0, 3);
  const pos = niceScale(0, top, 3);
  const lo = Math.floor(lo0 / pos.step) * pos.step;
  if ((pos.hi - lo) / pos.step > 6) return niceScale(lo0, top, 3);
  const ticks: number[] = [];
  for (let v = lo; v <= pos.hi + pos.step / 1e6; v += pos.step) ticks.push(Math.round(v * 100) / 100);
  return { lo, hi: pos.hi, step: pos.step, ticks };
}
