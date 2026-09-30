import { createClient } from "@/lib/supabase/server";
import CollapsibleSection from "@/components/CollapsibleSection";
import ReleaseImage from "@/components/ReleaseImage";
import ReleasePurchase from "@/components/ReleasePurchase";

export const dynamic = "force-dynamic";

const TZ = "America/Los_Angeles";

type Release = {
  id: number;
  release_on: string;
  release_at: string | null;
  time_unconfirmed: boolean;
  title: string;
  url: string | null;
  image_path: string | null;
  purchased: boolean;
  quantity_purchased: number | null;
};

// release_on is a calendar day in Pacific time; compare against today's
// Pacific date, not the server's (UTC) one.
function todayPacific() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

function safeUrl(u: string | null) {
  return u && /^https?:\/\//i.test(u) ? u : null;
}

function formatDay(day: string) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(r: Release) {
  if (!r.release_at) return r.time_unconfirmed ? "Time TBD" : "—";
  return (
    new Date(r.release_at).toLocaleTimeString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
    }) + " PT"
  );
}

export default async function ReleasesPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("releases")
    .select(
      "id, release_on, release_at, time_unconfirmed, title, url, image_path, purchased, quantity_purchased",
    )
    .order("release_on", { ascending: true })
    .order("release_at", { ascending: true, nullsFirst: false })
    .order("id");

  const all = (data ?? []) as Release[];
  const today = todayPacific();
  const upcoming = all.filter((r) => r.release_on >= today);
  // Most recent first for the past section.
  const past = all.filter((r) => r.release_on < today).reverse();

  // Private bucket: signed URLs under the owner's own session, one hour.
  const paths = all.map((r) => r.image_path).filter((p): p is string => !!p);
  const imageUrls = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("card-images")
      .createSignedUrls(paths, 3600);
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) imageUrls.set(s.path, s.signedUrl);
    }
  }

  function table(rows: Release[], empty: string) {
    if (rows.length === 0) {
      return <p className="rounded bg-surface px-3 py-4 text-sm text-ink-muted">{empty}</p>;
    }
    return (
      <div className="overflow-x-auto rounded bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-muted">
              <th className="px-3 py-1.5 font-medium tracking-wide">Image</th>
              <th className="px-3 py-1.5 font-medium tracking-wide">Title</th>
              <th className="px-3 py-1.5 font-medium tracking-wide">Release</th>
              <th className="px-3 py-1.5 font-medium tracking-wide">Link</th>
              <th className="px-3 py-1.5 font-medium tracking-wide">Purchased</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-brand-soft/15 align-middle">
                <td className="px-3 py-2">
                  <ReleaseImage
                    releaseId={r.id}
                    title={r.title}
                    src={r.image_path ? imageUrls.get(r.image_path) : undefined}
                  />
                </td>
                <td className="min-w-48 px-3 py-2 text-ink">{r.title}</td>
                <td className="whitespace-nowrap px-3 py-2 text-ink">
                  {formatDay(r.release_on)}
                  <span className="block text-xs text-ink-muted">{formatTime(r)}</span>
                </td>
                <td className="px-3 py-2">
                  {safeUrl(r.url) ? (
                    <a
                      href={safeUrl(r.url)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand underline"
                    >
                      Open
                    </a>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <ReleasePurchase
                    releaseId={r.id}
                    initialPurchased={r.purchased}
                    initialQuantity={r.quantity_purchased}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <header>
        <h1 className="text-xl font-bold text-surface">Releases</h1>
        <p className="text-sm text-surface/70">
          Dates and times are Pacific. Add releases by pasting a schedule to Claude.
        </p>
      </header>

      {error && (
        <p className="rounded border-l-4 border-accent bg-surface px-3 py-2 text-sm text-accent-ink">
          {error.message}
        </p>
      )}

      <CollapsibleSection title="Upcoming" count={upcoming.length}>
        {table(upcoming, "No upcoming releases.")}
      </CollapsibleSection>
      <CollapsibleSection title="Past" count={past.length}>
        {table(past, "No past releases.")}
      </CollapsibleSection>
    </main>
  );
}
