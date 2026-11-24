"use client";

import "./dashboard.css";

// Uncaught render errors on /dashboard (query failures are handled inside the
// page and keep the last good numbers; this is the backstop). Same banner and
// copy as spec 7: "Couldn't load your scoreboard. Try again." + retry.
export default function DashboardError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="sb-page">
      <div className="sb-ban sb-err" role="alert">
        <span><b>Couldn&rsquo;t load your scoreboard.</b> Try again.</span>
        <button type="button" className="sb-btn sb-pri" onClick={() => retry()}>
          Retry
        </button>
      </div>
    </main>
  );
}
