// Reference pages published as private claude.ai artifacts. They open only
// while signed in to claude.ai, which is fine for a single-owner app.
const GUIDES = {
  playbook: {
    href: "https://claude.ai/artifact/H8LzhqTFKnftzWaPnmyGf5",
    label: "Show-day playbook",
  },
  calendar: {
    href: "https://claude.ai/artifact/7BB5cRDV5jxQxZCx6H8Yc5",
    label: "Buy/sell calendar",
    note: "data as of Oct 2026",
  },
} as const;

export default function GuideLink({ guide }: { guide: keyof typeof GUIDES }) {
  const g: { href: string; label: string; note?: string } = GUIDES[guide];
  return (
    <a
      href={g.href}
      target="_blank"
      rel="noopener noreferrer"
      title={g.note}
      className="btn guide"
    >
      {g.label}
      <span aria-hidden>↗</span>
      {g.note && <span className="text-ink-muted">· {g.note}</span>}
    </a>
  );
}
