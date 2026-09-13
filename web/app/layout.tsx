import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "jho_collects",
  description: "Personal P&L for a sports card reselling business",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
