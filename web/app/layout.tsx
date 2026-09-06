import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Card ledger",
  description: "Personal P&L for a sports card reselling business",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-zinc-50 text-zinc-900">{children}</body>
    </html>
  );
}
