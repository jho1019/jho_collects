import { ApiError } from "./errors";

// Money crosses this service as a decimal STRING ("12.34") — the format eBay
// uses on the wire and that Postgres numeric(10,2) accepts exactly. Floats
// appear only inside statistics (comps), and are rounded on the way out.

const PRICE_RE = /^\d{1,8}(\.\d{1,2})?$/;

/**
 * Validates a caller-supplied price: positive, at most 2 decimal places, fits
 * numeric(10,2). Accepts a JSON number or string. Returns "12.30" form.
 */
export function parsePrice(input: unknown, field = "price"): string {
  const raw =
    typeof input === "number" ? (Number.isFinite(input) ? String(input) : "") :
    typeof input === "string" ? input.trim() : "";
  if (!PRICE_RE.test(raw)) {
    throw new ApiError(400, "invalid_price",
      `${field} must be a positive number with at most 2 decimal places`, { [field]: input ?? null });
  }
  const [whole, frac = ""] = raw.split(".");
  const normalized = `${BigInt(whole).toString()}.${frac.padEnd(2, "0")}`;
  if (normalized === "0.00") {
    throw new ApiError(400, "invalid_price", `${field} must be greater than 0`, { [field]: input });
  }
  return normalized;
}

/** Lenient parse of a money-ish cell from a CSV ("$1,234.50"). null if blank/invalid. */
export function moneyCell(s: string | undefined): string | null {
  const t = (s ?? "").replace(/[$,\s]/g, "");
  if (!t) return null;
  try {
    return parsePrice(t);
  } catch {
    return null;
  }
}

/** Round a float statistic to cents. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
