"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import ThemeToggle from "@/components/ThemeToggle";

// Midnight Scoreboard shell (SPEC_E_SCOREBOARD.md sections 0.2, 2, 6.1, 12.1).
// Replaces the old left Sidebar and the separate masthead/sign-out header.
//
//   >= lg (1180)  full top bar: logo + wordmark, 8 pills, theme / Data / Sign out
//   md..lg        pills tighten; Data + Sign out fold into an account menu
//   sm..md        pills hide behind a Menu button that opens the sheet
//   < sm (700)    top bar is logo + wordmark only; bottom tab bar + More sheet
//
// Lives in app/(app)/layout.tsx, never the root layout, so /login stays
// outside it.

type Dest = { href: string; label: string };

// Same seven sections the sidebar had, plus Dashboard. "/" is the calendar,
// labelled Calendar (it was "Home"). /data is a utility link, not a pill.
const NAV: Dest[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/", label: "Calendar" },
  { href: "/ledger", label: "Ledger" },
  { href: "/buying", label: "Buying" },
  { href: "/releases", label: "Releases" },
  { href: "/deals", label: "Deals" },
  { href: "/inventory", label: "Inventory" },
  { href: "/people", label: "Buyers" },
];

const TABS: Dest[] = [
  { href: "/dashboard", label: "Dash" },
  { href: "/", label: "Cal" },
  { href: "/ledger", label: "Ledger" },
  { href: "/buying", label: "Buying" },
];

// What the mobile More sheet holds (everything not on a bottom tab).
const MORE: Dest[] = [
  { href: "/releases", label: "Releases" },
  { href: "/deals", label: "Deals" },
  { href: "/inventory", label: "Inventory" },
  { href: "/people", label: "Buyers" },
  { href: "/data", label: "Data import / export" },
];

const pillBase =
  "inline-flex items-center whitespace-nowrap rounded-[3px] border font-display font-bold uppercase leading-[1.45] tracking-[0.13em] transition-colors";
const pillIdle = "border-line bg-chip-bg text-ink-muted hover:text-ink";
const pillOn = "border-amber bg-amber text-on-amber";
const textLink =
  "whitespace-nowrap px-1 py-[5px] font-display text-[13px] font-bold uppercase tracking-[0.13em] transition-colors";

function DealsBadge({ count, className = "" }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={`rounded-[2px] bg-neg px-[5px] font-mono text-[11px] font-bold tracking-normal text-[#14080a] ${className}`}
    >
      {count}
      <span className="sr-only"> need review</span>
    </span>
  );
}

export default function AppShell({
  dealsNeedingReview,
  logout,
  children,
}: {
  dealsNeedingReview: number;
  logout: () => Promise<void>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // null = closed. "more" = mobile More sheet; "menu" = the 700-899 Menu
  // sheet, which also lists the destinations the hidden pills carried.
  const [sheet, setSheet] = useState<"more" | "menu" | null>(null);
  const closeSheet = useCallback(() => setSheet(null), []);

  function isActive(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }
  const moreActive = MORE.some((d) => isActive(d.href));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="relative z-30 flex items-center gap-2.5 border-b-[3px] border-shadow bg-bar px-3.5 py-2.5 shadow-[inset_0_-1px_0_var(--color-line)] sm:gap-4 sm:px-5 xl:px-7">
        <Link
          href="/"
          className="flex min-w-0 shrink-0 items-center gap-2.5 hover:opacity-90 sm:gap-3"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.webp"
            alt=""
            className="size-[38px] shrink-0 rounded-full border-2 border-amber object-cover sm:size-[46px]"
          />
          {/* 900-1179 shows the logo only: wordmark + 8 pills + theme + menu
              need ~1060px. It stays the link's accessible name. */}
          <span className="min-w-0 font-wordmark text-[17px] leading-tight tracking-[0.02em] whitespace-nowrap text-ink sm:text-[21px] md:max-lg:sr-only">
            Shotime Ledger
            <small className="block font-mono text-[9.5px] font-medium leading-normal tracking-[0.24em] text-amber">
              BOX SCORE · SEASON 2026
            </small>
          </span>
        </Link>

        {/* Pills: md and up. Tight (5px 8px, 12px) below xl: the spec's
            full-size pills plus Data / Sign out need ~1210px, so at 1180 they
            would collide with the right cluster. Full size from 1440. */}
        <nav aria-label="Primary" className="ml-1 hidden min-w-0 gap-1.5 md:flex xl:ml-3.5">
          {NAV.map((d) => {
            const active = isActive(d.href);
            return (
              <Link
                key={d.href}
                href={d.href}
                aria-current={active ? "page" : undefined}
                className={`${pillBase} px-2 py-[5px] text-[12px] xl:px-2.5 xl:text-[13px] ${
                  active ? pillOn : pillIdle
                }`}
              >
                {d.label}
                {d.href === "/deals" && (
                  <DealsBadge count={dealsNeedingReview} className="ml-[5px]" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {/* Theme stays in the bar from md up; below md it is in the sheet. */}
          <div className="hidden md:block">
            <ThemeToggle />
          </div>

          {/* lg+: Data and Sign out as text links. */}
          <Link
            href="/data"
            aria-current={isActive("/data") ? "page" : undefined}
            className={`${textLink} hidden lg:inline ${
              isActive("/data") ? "text-amber" : "text-ink-muted hover:text-amber"
            }`}
          >
            Data
          </Link>
          <form action={logout} className="hidden lg:block">
            <button type="submit" className={`${textLink} text-ink-muted hover:text-amber`}>
              Sign out
            </button>
          </form>

          {/* md..lg: Data and Sign out fold into this menu. */}
          <AccountMenu
            className="hidden md:block lg:hidden"
            logout={logout}
            dataActive={isActive("/data")}
          />

          {/* sm..md: the pills are gone; Menu opens the sheet. */}
          <div className="hidden sm:block md:hidden">
            <button
              type="button"
              onClick={() => setSheet("menu")}
              aria-haspopup="dialog"
              aria-expanded={sheet === "menu"}
              className={`${pillBase} ${pillIdle} min-h-9 px-3 py-[5px] text-[13px]`}
            >
              Menu
              {dealsNeedingReview > 0 && (
                <>
                  <span aria-hidden="true" className="ml-2 size-2 rounded-full bg-neg" />
                  <span className="sr-only">, deals need review</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Bottom padding below sm keeps the fixed tab bar off the last row. */}
      <div className="flex flex-1 flex-col pb-24 sm:pb-0">{children}</div>

      {/* Mobile bottom tab bar. */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t-[3px] border-shadow bg-bar px-1.5 pt-2 pb-[max(14px,env(safe-area-inset-bottom))] sm:hidden"
      >
        {TABS.map((d) => {
          const active = isActive(d.href);
          return (
            <Link
              key={d.href}
              href={d.href}
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-[3px] px-2.5 font-display text-[12px] font-bold uppercase tracking-[0.12em] ${
                active ? "bg-amber text-on-amber" : "text-ink-muted"
              }`}
            >
              {d.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setSheet("more")}
          aria-haspopup="dialog"
          aria-expanded={sheet === "more"}
          className={`relative inline-flex min-h-11 items-center rounded-[3px] px-2.5 font-display text-[12px] font-bold uppercase tracking-[0.12em] ${
            moreActive ? "bg-amber text-on-amber" : "text-ink-muted"
          }`}
        >
          More
          {dealsNeedingReview > 0 && (
            <>
              <span
                aria-hidden="true"
                className="absolute top-0.5 right-0 size-2 rounded-full bg-neg"
              />
              <span className="sr-only">, deals need review</span>
            </>
          )}
        </button>
      </nav>

      {sheet && (
        <Sheet
          title={sheet === "menu" ? "Menu" : "More"}
          items={sheet === "menu" ? [...NAV, MORE[MORE.length - 1]] : MORE}
          isActive={isActive}
          dealsNeedingReview={dealsNeedingReview}
          logout={logout}
          onClose={closeSheet}
        />
      )}
    </div>
  );
}

// Bottom sheet with scrim. Escape and scrim tap close it (carried over from
// the old drawer). Hidden from md up, where the bar carries everything.
function Sheet({
  title,
  items,
  isActive,
  dealsNeedingReview,
  logout,
  onClose,
}: {
  title: string;
  items: Dest[];
  isActive: (href: string) => boolean;
  dealsNeedingReview: number;
  logout: () => Promise<void>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  const cell =
    "flex min-h-11 items-center justify-between rounded-[3px] border border-line bg-chip-bg px-3 py-2.5 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-ink";

  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <button
        type="button"
        aria-label={`Close ${title.toLowerCase()}`}
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-xl border-t-[3px] border-amber bg-board px-[18px] pt-3.5 pb-[max(22px,env(safe-area-inset-bottom))] shadow-[0_-20px_60px_rgb(0_0_0/0.6)] focus:outline-none"
      >
        <div className="mb-2.5 flex items-center justify-between gap-2.5">
          <h2
            id={titleId}
            className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-amber"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 px-1 font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-muted hover:text-ink"
          >
            <span aria-hidden="true">✕ </span>Close
          </button>
        </div>

        <nav aria-label={title}>
          <ul className="grid grid-cols-2 gap-2">
            {items.map((d) => {
              const active = isActive(d.href);
              return (
                <li key={d.href} className="min-w-0">
                  <Link
                    href={d.href}
                    onClick={onClose}
                    aria-current={active ? "page" : undefined}
                    className={`${cell} ${active ? "border-amber text-amber" : ""}`}
                  >
                    <span className="truncate">{d.label}</span>
                    {d.href === "/deals" && dealsNeedingReview > 0 && (
                      <span className="font-mono text-[13px] tracking-normal text-neg">
                        {dealsNeedingReview}
                        <span className="sr-only"> need review</span>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
            <li className="min-w-0">
              <form action={logout}>
                <button type="submit" className={`${cell} w-full text-left`}>
                  Sign out
                </button>
              </form>
            </li>
          </ul>
        </nav>

        <h3 className="mt-3.5 mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-amber">
          Theme
        </h3>
        <ThemeToggle variant="segmented" />
      </div>
    </div>
  );
}

// 900-1179: Data and Sign out live behind this button. A disclosure (button +
// list), not an ARIA menu: two items do not need roving focus.
function AccountMenu({
  className,
  logout,
  dataActive,
}: {
  className: string;
  logout: () => Promise<void>;
  dataActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const item =
    "block w-full px-3.5 py-2 text-left font-display text-[13px] font-bold uppercase tracking-[0.13em] hover:text-amber";

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Account menu"
        title="Account"
        className={`grid size-[30px] place-items-center rounded-full border-2 bg-chip-bg ${
          open || dataActive ? "border-amber text-amber" : "border-line text-ink-muted hover:text-ink"
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="5.5" r="2.75" stroke="currentColor" strokeWidth="1.5" />
          <path d="M2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div
          id={listId}
          className="absolute top-full right-0 z-40 mt-2 min-w-36 rounded-[4px] border border-line bg-tip py-1 shadow-[0_12px_30px_rgb(0_0_0/0.6)]"
        >
          <Link
            href="/data"
            onClick={() => setOpen(false)}
            aria-current={dataActive ? "page" : undefined}
            className={`${item} ${dataActive ? "text-amber" : "text-ink"}`}
          >
            Data
          </Link>
          <form action={logout}>
            <button type="submit" className={`${item} text-ink`}>
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
