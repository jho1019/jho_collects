import Spinner from "@/components/Spinner";

// Next.js shows this automatically via Suspense while a route segment's
// Server Component is fetching — one boundary here covers every page in
// the (app) group during tab-to-tab navigation, since the shared layout
// (sidebar, masthead) stays mounted and only the page content suspends.
export default function Loading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  );
}
