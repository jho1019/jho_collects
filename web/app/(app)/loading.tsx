// Next.js shows this automatically via Suspense while a route segment's
// Server Component is fetching. One boundary here covers every page in the
// (app) group; the shell (top bar / bottom tabs) stays mounted and live.
//
// A simple Midnight skeleton board (spec 6.14): shimmer from skel to skel-2,
// static under prefers-reduced-motion (see .skel in globals.css). Per-route
// skeletons come with the page restyles.
export default function Loading() {
  return (
    <main
      aria-busy="true"
      className="mx-auto w-full max-w-[1100px] space-y-6 px-3.5 py-6 sm:px-8"
    >
      <p role="status" className="sr-only">
        Loading…
      </p>
      <div aria-hidden="true" className="space-y-6">
        <div className="skel h-10 w-48" />
        <div className="board space-y-4 px-3.5 py-4 sm:px-6 sm:py-5">
          <div className="skel h-3 w-32" />
          <div className="skel h-12 w-56 max-w-full" />
          <div className="skel h-40 w-full" />
        </div>
        <div className="board space-y-3 px-3.5 py-4 sm:px-6 sm:py-5">
          <div className="skel h-3 w-24" />
          <div className="skel h-4 w-full" />
          <div className="skel h-4 w-full" />
          <div className="skel h-4 w-2/3" />
        </div>
      </div>
    </main>
  );
}
