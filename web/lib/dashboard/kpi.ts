// Small display decisions for the scoreboard KPIs, kept out of the component
// so they can be unit-tested (spec 16.2).

/** A change above 999% is noise, not information (spec 16.2 must-fix 1). */
export const DELTA_CAP = 9.99;
/** A prior window under $50 (either sign) is too small to compare against. */
export const SMALL_PRIOR_CENTS = 5000;

/**
 * Ratio change vs a prior window, or null when it isn't worth showing: no
 * prior, a prior under $50, or a change over 999%. Callers fall back to a
 * `since {start}` caption (KPIs) or drop the chip (hero).
 */
export function informativeDelta(current: number, prior: number | null): number | null {
  if (prior == null || Math.abs(prior) < SMALL_PRIOR_CENTS) return null;
  const d = (current - prior) / Math.abs(prior);
  return Math.abs(d) > DELTA_CAP ? null : d;
}

/**
 * Goal card big number (spec 16.2 must-fix 3). With no goal set it is "—",
 * never the MTD profit and never "$0.00". With a goal it is MTD profit, muted
 * until positive. Goals have no storage yet (gap 7), so callers pass null.
 */
export function goalValue(
  goalCents: number | null,
  mtdCents: number,
  fmt: (c: number) => string,
): { text: string; muted: boolean } {
  if (goalCents == null) return { text: "—", muted: true };
  return { text: mtdCents > 0 ? fmt(mtdCents) : fmt(0), muted: mtdCents <= 0 };
}
