export function usd(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

export function isoDay(d: string | Date): string {
  return (typeof d === "string" ? new Date(d) : d).toISOString().slice(0, 10);
}
