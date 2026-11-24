// Calendar-day helpers for the dashboard. Every date is an ISO "YYYY-MM-DD"
// string: occurred_on is a calendar day, not an instant, so arithmetic is
// done on UTC midnights and never touches the server's local zone.

export const PT = "America/Los_Angeles";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Today in Pacific time — same rule as the Calendar page (schema/023). */
export function todayPT(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: PT });
}

function toUTC(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = toUTC(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86_400_000);
}

/** Monday on or before the day (weeks are Monday-start). */
export function mondayOf(iso: string): string {
  const dow = (toUTC(iso).getUTCDay() + 6) % 7; // Mon = 0
  return addDays(iso, -dow);
}

export function monthStart(iso: string): string {
  return iso.slice(0, 8) + "01";
}

export function addMonths(iso: string, n: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return fromUTC(d);
}

export function monthEnd(iso: string): string {
  return addDays(addMonths(monthStart(iso), 1), -1);
}

export function quarterStart(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const qm = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(qm).padStart(2, "0")}-01`;
}

export function monthName(iso: string): string {
  return MONTHS[Number(iso.slice(5, 7)) - 1];
}

/** "OCT" */
export function monthAbbr(iso: string): string {
  return monthName(iso).slice(0, 3).toUpperCase();
}

/** "Oct 4" */
export function shortDate(iso: string): string {
  return `${monthName(iso).slice(0, 3)} ${Number(iso.slice(8, 10))}`;
}

/** "10/4" */
export function slashDate(iso: string): string {
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}
