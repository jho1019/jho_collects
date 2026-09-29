import { createClient } from "@/lib/supabase/server";
import { usd } from "@/lib/format";
import CompInput from "@/components/CompInput";
import CopyTitle from "@/components/CopyTitle";
import RowNotes from "@/components/RowNotes";
import AddCardModal from "@/components/AddCardModal";
import CardImageLightbox from "@/components/CardImageLightbox";

export const dynamic = "force-dynamic";

type Target = {
  id: number;
  title: string;
  purpose: string;
  set_name: string | null;
  card_number: string | null;
  search_url: string | null;
  priority: number | null;
  latest_comp: string | number | null;
  comp_age_days: number | null;
  is_stale: boolean;
  max_all_in: string | number | null;
  is_manual: boolean;
  image_path: string | null;
  notes: string | null;
};

type SetProgress = { set_name: string; owned: number; total: number };

const NO_SET = "No set";

// Saved search wins when one is set; otherwise search eBay for the title.
function ebaySearchUrl(title: string) {
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(title)}`;
}

// Same title search with eBay's Sold Items filter (sold + completed).
function ebaySoldUrl(title: string) {
  return `${ebaySearchUrl(title)}&LH_Sold=1&LH_Complete=1`;
}

// 130point shows real Best Offer accepted prices. Its search is a form behind
// a bot check, so this opens the page only — use Copy on the title and paste.
const POINT130_URL = "https://130point.com/sales/";

function safeUrl(u: string | null) {
  return u && /^https?:\/\//i.test(u) ? u : null;
}

export default async function BuyingPage() {
  const supabase = await createClient();

  const [{ data: targets, error }, { data: progress }] = await Promise.all([
    supabase
      .from("buying_targets")
      .select(
        "id, title, purpose, set_name, card_number, search_url, priority, latest_comp, comp_age_days, is_stale, max_all_in, is_manual, image_path, notes",
      )
      .order("priority", { ascending: true, nullsFirst: false })
      .order("title"),
    supabase.from("buying_set_progress").select("set_name, owned, total"),
  ]);

  // Private bucket: signed URLs under the owner's own session, one hour.
  const paths = ((targets ?? []) as Target[])
    .map((t) => t.image_path)
    .filter((p): p is string => !!p);
  const imageUrls = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("card-images")
      .createSignedUrls(paths, 3600);
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) imageUrls.set(s.path, s.signedUrl);
    }
  }

  const progressBySet = new Map(
    ((progress ?? []) as SetProgress[]).map((p) => [p.set_name, p]),
  );

  // purpose -> set -> rows
  const grouped = new Map<string, Map<string, Target[]>>();
  for (const t of (targets ?? []) as Target[]) {
    const bySet = grouped.get(t.purpose) ?? new Map<string, Target[]>();
    const key = t.set_name ?? NO_SET;
    bySet.set(key, [...(bySet.get(key) ?? []), t]);
    grouped.set(t.purpose, bySet);
  }
  const purposes = [...grouped.keys()].sort((a, b) =>
    a === "pc" ? -1 : b === "pc" ? 1 : a.localeCompare(b),
  );

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-surface">Buying list</h1>
          <p className="text-sm text-surface/70">
            Targets are all-in — price plus shipping plus sales tax.
          </p>
        </div>
        <AddCardModal />
      </header>

      {error && (
        <p className="rounded border-l-4 border-accent bg-surface px-3 py-2 text-sm text-accent-ink">
          {error.message}
        </p>
      )}

      {purposes.length === 0 && !error && (
        <p className="rounded bg-surface px-3 py-4 text-sm text-ink-muted">
          Nothing on the buying list yet. Tell Claude what you&rsquo;re hunting
          for and it will add it.
        </p>
      )}

      {purposes.map((purpose) => (
        <section key={purpose} className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-surface">
            {purpose === "pc" ? "Personal collection" : purpose === "flip" ? "Flips" : purpose}
          </h2>
          {[...grouped.get(purpose)!.entries()].map(([setName, rows]) => {
            const p = progressBySet.get(setName);
            return (
              <div key={setName} className="overflow-x-auto rounded bg-surface">
                <div className="flex items-baseline justify-between border-b border-brand-soft/25 px-3 py-2">
                  <h3 className="text-sm font-medium text-ink">{setName}</h3>
                  {p && (
                    <span className="text-xs text-ink-muted">
                      {p.owned} of {p.total} owned
                    </span>
                  )}
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-ink-muted">
                      <th className="px-3 py-1.5 font-medium tracking-wide">Card</th>
                      <th className="px-3 py-1.5 text-right font-medium tracking-wide">Comp</th>
                      <th className="px-3 py-1.5 text-right font-medium tracking-wide">
                        Target all-in
                      </th>
                      <th className="px-3 py-1.5 font-medium tracking-wide">Recent sales</th>
                      <th className="px-3 py-1.5 font-medium tracking-wide">Listings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => {
                      const url = safeUrl(t.search_url) ?? ebaySearchUrl(t.title);
                      const img = t.image_path ? imageUrls.get(t.image_path) : undefined;
                      return (
                        <tr key={t.id} className="border-t border-brand-soft/15">
                          <td className="px-3 py-2 text-ink">
                            <div className="flex items-center gap-3">
                              {img && <CardImageLightbox src={img} alt={t.title} />}
                              <div>
                                <CopyTitle title={t.title}>
                                  {t.title}
                                  {t.card_number && !t.title.includes(`#${t.card_number}`) && (
                                    <span className="text-ink-muted"> #{t.card_number}</span>
                                  )}
                                </CopyTitle>
                                <RowNotes itemId={t.id} initialNotes={t.notes} />
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink">
                            <CompInput
                              itemId={t.id}
                              current={t.latest_comp == null ? null : Number(t.latest_comp)}
                              ageLabel={
                                <>
                                  {t.comp_age_days === 0 ? "today" : `${t.comp_age_days}d old`}
                                  {t.is_stale ? " · stale" : ""}
                                </>
                              }
                            />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink">
                            {t.max_all_in == null ? "—" : usd(t.max_all_in)}
                            {t.is_manual && (
                              <span className="block text-xs text-ink-muted">manual</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <a
                              href={ebaySoldUrl(t.title)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-brand underline"
                            >
                              Ebay
                            </a>
                            <span className="text-ink-muted"> · </span>
                            <a
                              href={POINT130_URL}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-brand underline"
                            >
                              130point
                            </a>
                          </td>
                          <td className="px-3 py-2">
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-brand underline"
                            >
                              eBay
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </section>
      ))}
    </main>
  );
}
