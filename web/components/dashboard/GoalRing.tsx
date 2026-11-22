// Monthly goal ring (spec 6.9): 40 tick marks + a stroke-dasharray arc.
// There is no goal storage yet (gap 7, open question 13.3), so this renders
// the unset state only: track and unlit ticks, no arc, an em dash inside.
// When goals exist, pass `pct` and the arc appears; at 0% it is omitted so no
// stray round cap shows.
export default function GoalRing({ pct, size = 110 }: { pct: number | null; size?: number }) {
  const th = 12;
  const c = size / 2;
  const r = size / 2 - th / 2 - 2;
  const circ = 2 * Math.PI * r;
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  // rounded: server and browser Math.cos can differ in the last digit,
  // which breaks hydration
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const ticks = Array.from({ length: 40 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2 - Math.PI / 2;
    const lit = i / 40 < p / 100;
    return (
      <line
        key={i}
        x1={r2(c + (r - th) * Math.cos(a))}
        y1={r2(c + (r - th) * Math.sin(a))}
        x2={r2(c + (r - th - 6) * Math.cos(a))}
        y2={r2(c + (r - th - 6) * Math.sin(a))}
        stroke={lit ? "var(--color-amber)" : "var(--color-grid)"}
        strokeWidth={2}
      />
    );
  });
  return (
    <svg
      width={size}
      height={size}
      role="img"
      aria-label={pct == null ? "Monthly goal not set" : `Monthly goal ${Math.round(p)} percent`}
      style={{ flex: "none" }}
    >
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--color-grid)" strokeWidth={th} />
      {p > 0 && (
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke="var(--color-amber)"
          strokeWidth={th}
          strokeLinecap="round"
          strokeDasharray={`${r2((circ * p) / 100)} ${r2(circ)}`}
          transform={`rotate(-90 ${c} ${c})`}
        />
      )}
      {ticks}
      <text
        x={c}
        y={c + size * 0.07}
        textAnchor="middle"
        fontSize={size * 0.2}
        fontWeight={800}
        fill={pct == null ? "var(--color-ink-muted)" : "var(--color-ink)"}
        style={{ fontFamily: "var(--font-display)" }}
      >
        {pct == null ? "—" : `${Math.round(p)}%`}
      </text>
    </svg>
  );
}
