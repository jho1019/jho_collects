// A single small spinner, reused by loading.tsx boundaries and any
// in-place pending state (e.g. Calendar's day-detail panel) so there is
// one visual language for "fetching" across the app instead of one per
// call site.
export default function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={`${className} animate-spin rounded-full border-2 border-brand-soft/30 border-t-brand`}
    />
  );
}
