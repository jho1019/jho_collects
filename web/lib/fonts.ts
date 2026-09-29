import { Bebas_Neue, Plus_Jakarta_Sans } from "next/font/google";

// Wordmark font for the sidebar/nav brand text, next to the logo mark.
// Condensed, all-caps display face — a sports-branding staple, and a fit for
// a card business. Self-hosted by next/font, so no external font request.
export const brandFont = Bebas_Neue({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
});

// App-wide body font, replacing the plain system-ui stack. Friendlier and
// rounder without giving up the sturdier, geometric letterforms a screen
// full of money tables needs. Ships tabular figures, which `tabular-nums`
// (used across every money/date/count column) needs to actually do anything.
export const bodyFont = Plus_Jakarta_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});
