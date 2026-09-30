"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { brandFont } from "@/lib/fonts";

type NavItem = {
  href: string;
  label: string;
  icon: (active: boolean) => React.ReactNode;
};

// Seven sections (Releases added after Phase 13), in the order Phase 9 specifies plus Releases. /data is a utility and sits
// below the separator, not among them. Home is the calendar as of Phase 9;
// what Home used to show (position cards, chart, ledger) moved to /ledger.
const SECTIONS: NavItem[] = [
  { href: "/", label: "Home", icon: iconCalendar },
  { href: "/ledger", label: "Ledger", icon: iconTable },
  { href: "/buying", label: "Buying", icon: iconTag },
  { href: "/releases", label: "Releases", icon: iconRelease },
  { href: "/deals", label: "Deals", icon: iconHandshake },
  { href: "/inventory", label: "Inventory", icon: iconBox },
  { href: "/people", label: "Buyers", icon: iconPeople },
];

// Phase 12: below `md` there's no room for a 224px side rail, so it only
// renders at md and up. Mobile gets a sticky top bar instead — logo plus a
// single hamburger — and the same nav list reappears as a slide-in drawer.
// Sign-out moves in here too (it lived in the layout's own header, which is
// desktop-only now) so it's still reachable with the rail gone.
export default function Sidebar({
  dealsNeedingReview,
  logout,
}: {
  dealsNeedingReview: number;
  logout: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [open]);

  function isActive(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  const logo = (
    <Link
      href="/"
      onClick={() => setOpen(false)}
      className="flex items-center gap-2 rounded-md px-2 hover:opacity-80"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.webp" alt="" className="h-10 w-10 shrink-0 rounded-md" />
      <span
        className={`${brandFont.className} truncate text-xl leading-none tracking-wide text-ink`}
      >
        jho_collects
      </span>
    </Link>
  );

  const links = (
    <ul className="space-y-0.5">
      {SECTIONS.map((item) => {
        const active = isActive(item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={() => setOpen(false)}
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
  );

  const footer = (
    <div className="space-y-0.5 border-t border-brand-soft/25 pt-3">
      <Link
        href="/data"
        onClick={() => setOpen(false)}
        aria-current={isActive("/data") ? "page" : undefined}
        className={`flex items-center gap-2 rounded-md border-l-2 px-2.5 py-2 text-sm transition-colors ${
          isActive("/data")
            ? "border-brand bg-brand/10 font-medium text-brand"
            : "border-transparent text-ink-muted hover:bg-brand-soft/10"
        }`}
      >
        <span className={isActive("/data") ? "text-brand" : "text-brand-soft"}>{iconData()}</span>
        Data
      </Link>
      <form action={logout}>
        <button
          type="submit"
          className="flex w-full items-center gap-2 rounded-md border-l-2 border-transparent px-2.5 py-2 text-left text-sm text-ink-muted hover:bg-brand-soft/10"
        >
          <span className="text-brand-soft">{iconSignOut()}</span>
          Sign out
        </button>
      </form>
    </div>
  );

  return (
    <>
      {/* Desktop rail — unchanged from before Phase 12, just gated to md+. */}
      <nav className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col justify-between border-r border-brand-soft/25 bg-surface px-3 py-4 md:flex">
        <div>
          <div className="mb-4">{logo}</div>
          {links}
        </div>
        {footer}
      </nav>

      {/* Mobile top bar. Sticky, not fixed — it's the first thing in normal
          flow, so the page needs no manual offset padding for it. */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-brand-soft/25 bg-surface px-3 py-2 md:hidden">
        <Link href="/" className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.webp" alt="" className="h-8 w-8 shrink-0 rounded-md" />
          <span
            className={`${brandFont.className} text-lg leading-none tracking-wide text-ink`}
          >
            jho_collects
          </span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          className="rounded-md p-2 text-ink-muted hover:bg-brand-soft/10"
        >
          <MenuIcon />
        </button>
      </div>

      {/* Mobile drawer, only mounted while open. */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-ink/40"
          />
          <nav className="absolute inset-y-0 left-0 flex w-64 max-w-[80vw] flex-col justify-between bg-surface px-3 py-4 shadow-xl">
            <div>
              <div className="mb-4 flex items-center justify-between">
                {logo}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close menu"
                  className="rounded-md p-1 text-ink-muted hover:bg-brand-soft/10"
                >
                  <CloseIcon />
                </button>
              </div>
              {links}
            </div>
            {footer}
          </nav>
        </div>
      )}
    </>
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
function iconRelease() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" />
      <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
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
function iconTag() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 8.5V2.5h6l7 7-6 6z" stroke="currentColor" strokeLinejoin="round" />
      <circle cx="5" cy="5.5" r="1" stroke="currentColor" />
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
function iconSignOut() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M6.5 1.5H3a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 3 14.5h3.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 11 14 7.5l-3.5-3.5M14 7.5H5.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
      <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <path d="M3 3l10 10M13 3 3 13" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}
