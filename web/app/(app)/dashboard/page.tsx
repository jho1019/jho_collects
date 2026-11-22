import type { Metadata } from "next";

export const metadata: Metadata = { title: "Dashboard · shotime_cards" };

// Placeholder so the new Dashboard nav destination does not 404. The
// scoreboard itself (hero, line score, charts, KPIs) ships in the next PR.
// Login still lands on "/" until then.
export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-[1100px] space-y-6 px-3.5 py-6 sm:px-8">
      <h1 className="font-display text-[38px] leading-none font-black tracking-[0.02em] text-on-page uppercase sm:text-[44px]">
        Dashboard
      </h1>
      <section className="board px-3.5 py-4 sm:px-6 sm:py-5">
        <h2 className="font-mono text-[11px] font-semibold tracking-[0.2em] text-amber uppercase">
          Scoreboard
        </h2>
        <p className="mt-2 text-[13px] text-ink-muted">
          Scoreboard is coming in the next pull request.
        </p>
      </section>
    </main>
  );
}
