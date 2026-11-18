"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

const OPTIONS: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "Light", icon: <SunIcon /> },
  { value: "dark", label: "Dark", icon: <MoonIcon /> },
  { value: "system", label: "System", icon: <MonitorIcon /> },
];

// Same-tab writes don't fire "storage", so the toggle dispatches this event
// itself; "storage" keeps other open tabs in step.
const CHANGE_EVENT = "themechange";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

// Light / dark / system. The pre-paint script in app/layout.tsx sets the
// attribute on hard loads; this keeps it in step after that.
// tone="page" sits directly on the blue page (desktop header); "surface" sits
// inside the grey sidebar/drawer — see the token notes in globals.css.
const TONES = {
  page: {
    group: "border-on-page/40",
    button: "text-on-page",
    active: "bg-on-page/20",
    idle: "opacity-70 hover:bg-on-page/10 hover:opacity-100",
  },
  surface: {
    group: "border-brand-soft/40",
    button: "",
    active: "bg-brand/10 text-brand",
    idle: "text-ink-muted hover:bg-brand-soft/10",
  },
};

export default function ThemeToggle({
  tone = "page",
  className = "",
}: {
  tone?: keyof typeof TONES;
  className?: string;
}) {
  const t = TONES[tone];
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);

  // Re-apply on mount (React's dev Strict Mode remount clears attributes the
  // inline script set on <html>) and whenever another tab changes the choice.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function choose(next: Theme) {
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable: still switch for this page view.
    }
    applyTheme(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={`inline-flex items-center gap-0.5 rounded border p-0.5 ${t.group} ${className}`}
    >
      {OPTIONS.map((o) => {
        const active = theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            title={o.label}
            onClick={() => choose(o.value)}
            className={`rounded-sm p-1 transition-colors ${t.button} ${active ? t.active : t.idle}`}
          >
            {o.icon}
          </button>
        );
      })}
    </div>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" />
      <path
        d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function MonitorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" />
      <path d="M5.5 14.5h5M8 11.5v3" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}
