import { Big_Shoulders, IBM_Plex_Mono, Rye } from "next/font/google";

// Midnight Scoreboard type system (SPEC_E_SCOREBOARD.md section 5). All three
// are self-hosted by next/font, so there is no request to Google at runtime.
// Each exposes a CSS variable that globals.css maps onto the Tailwind font
// tokens (--font-display, --font-mono, --font-wordmark, --font-sans).

// Scoreboard numerals, headings, nav pills. The spec names "Big Shoulders
// Display"; Google has since merged Display/Text into one "Big Shoulders"
// family with an optical-size axis. We load the variable font with that
// axis, and globals.css pins `opsz` to 72 wherever font-display is used, which
// gives the Display cut. Variable weight covers the spec's 500/700/800/900.
export const displayFont = Big_Shoulders({
  subsets: ["latin"],
  display: "swap",
  weight: "variable",
  axes: ["opsz"],
  variable: "--font-big-shoulders",
  // next/font has no metrics for this family yet, so it cannot build a
  // size-adjusted fallback; fall back to a plain condensed stack instead.
  adjustFontFallback: false,
  fallback: ["Arial Narrow", "sans-serif"],
});

// Body, labels, tables. Monospaced, so money columns line up with no extra
// work, though tabular-nums stays on money columns anyway.
export const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});

// The "Shotime Ledger" wordmark in the top bar. Nothing else uses it.
export const wordmarkFont = Rye({
  subsets: ["latin"],
  display: "swap",
  weight: "400",
  variable: "--font-rye",
});

export const fontVariables = `${displayFont.variable} ${monoFont.variable} ${wordmarkFont.variable}`;
