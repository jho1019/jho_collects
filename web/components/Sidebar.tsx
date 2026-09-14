"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  href: string;
  label: string;
  icon: (active: boolean) => React.ReactNode;
};

// Six sections, in the order Phase 9 specifies. /data is a utility and sits
// below the separator, not among them. Home is the calendar as of Phase 9;
// what Home used to show (position cards, chart, ledger) moved to /ledger.
const SECTIONS: NavItem[] = [
  { href: "/", label: "Home", icon: iconCalendar },
  { href: "/ledger", label: "Ledger", icon: iconTable },
  { href: "/deals", label: "Deals", icon: iconHandshake },
  { href: "/inventory", label: "Inventory", icon: iconBox },
  { href: "/insights", label: "Insights", icon: iconChart },
  { href: "/people", label: "People", icon: iconPeople },
];

export default function Sidebar({ dealsNeedingReview }: { dealsNeedingReview: number }) {
  const pathname = usePathname();

  // Exact match for "/", prefix match otherwise, so /deals/anything (if it
  // ever exists) still lights up "Deals".
  function isActive(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  return (
    <nav className="fixed inset-y-0 left-0 flex w-56 flex-col justify-between border-r border-brand-soft/25 bg-surface px-3 py-4">
      <div>
        <div className="mb-4 px-2">
          <span className="text-sm font-semibold text-ink">jho_collects</span>
        </div>
        <ul className="space-y-0.5">
          {SECTIONS.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center justify-between gap-2 rounded-md border-l-2 px-2.5 py-2 text-sm transition-colors ${
                    active
                      ? "border-brand bg-brand/10 font-medium text-brand"
                      : "border-transparent text-ink-muted hover:bg-brand-soft/10"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className={active ? "text-brand" : "text-brand-soft"}>
                      {item.icon(active)}
                    </span>
                    {item.label}
                  </span>
                  {item.href === "/deals" && dealsNeedingReview > 0 && (
                    <span className="rounded-full bg-accent-ink px-1.5 py-0.5 text-[10px] font-semibold leading-none text-surface">
                      {dealsNeedingReview}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="border-t border-brand-soft/25 pt-3">
        <Link
          href="/data"
          aria-current={isActive("/data") ? "page" : undefined}
          className={`flex items-center gap-2 rounded-md border-l-2 px-2.5 py-2 text-sm transition-colors ${
            isActive("/data")
              ? "border-brand bg-brand/10 font-medium text-brand"
              : "border-transparent text-ink-muted hover:bg-brand-soft/10"
          }`}
        >
          <span className={isActive("/data") ? "text-brand" : "text-brand-soft"}>
            {iconData()}
          </span>
          Data
        </Link>
      </div>
    </nav>
  );
}

// Minimal inline icons — no icon package, kept to a shared 18x18 stroke style.
function iconCalendar() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" stroke="currentColor" />
      <path d="M1.5 6h13M4.5 1v3M11.5 1v3" stroke="currentColor" strokeLinecap="round" />
      <path d="M4.5 9h2M9.5 9h2M4.5 12h2M9.5 12h2" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}
function iconTable() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
      <path d="M1.5 6.5h13M5.5 6.5v7" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}
function iconHandshake() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 7 4 4.5l2 1.5 2-1.5 2 1.5 2.5-2.5M1.5 7v4l2.5 2 2-1.5 2 1.5 2-1.5 2.5 1.5V7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function iconBox() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 4.5 8 1.5l6.5 3v7L8 14.5l-6.5-3z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      <path d="M1.5 4.5 8 7.5l6.5-3M8 7.5v7" stroke="currentColor" strokeLinejoin="round" />
    </svg>
  );
}
function iconChart() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 13.5V2M2 13.5h12M5 11V7.5M8.5 11V5M12 11V8.5"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}
function iconPeople() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="5.5" cy="5" r="2" stroke="currentColor" />
      <circle cx="11" cy="6" r="1.75" stroke="currentColor" />
      <path
        d="M1.5 14c.3-2.5 1.9-4 4-4s3.7 1.5 4 4M9.5 14c.25-2 1.4-3.25 3-3.25S15.25 12 15.5 14"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}
function iconData() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <ellipse cx="8" cy="3.5" rx="5.5" ry="2" stroke="currentColor" />
      <path
        d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}
