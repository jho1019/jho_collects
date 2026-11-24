import type { Metadata } from "next";
import { fontVariables } from "@/lib/fonts";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "shotime_cards",
  description: "Personal P&L for a sports card reselling business",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the inline script may add data-theme to <html>
    // before React hydrates (see lib/theme.ts).
    <html
      lang="en"
      className={`${fontVariables} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
