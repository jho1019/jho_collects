import { createClient } from "@/lib/supabase/server";
import { usd } from "@/lib/format";
import CompInput from "@/components/CompInput";
import CopyTitle from "@/components/CopyTitle";
import RowNotes from "@/components/RowNotes";
import GuideLink from "@/components/GuideLink";
import AddCardModal from "@/components/AddCardModal";
import CardImageLightbox from "@/components/CardImageLightbox";
import CollapsibleSection from "@/components/CollapsibleSection";
import BuyingTargetCard from "@/components/BuyingTargetCard";

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

function purposeLabel(purpose: string) {
  return purpose === "pc" ? "PC" : purpose === "flip" ? "Investing" : purpose;
}

export default async function BuyingPage() {
  const supabase = await createClient();

  const { data: targets, error } = await supabase
    .from("buying_targets")
    .select(
      "id, title, purpose, set_name, card_number, search_url, priority, latest_comp, comp_age_days, is_stale, max_all_in, is_manual, image_path, notes",
    )
    .order("priority", { ascending: true, nullsFirst: false })
    .order("title");

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

  // One table per purpose — pc and flip/"Investing" — not one per set. Each
  // set used to get its own bordered sub-table; that's what "separate
  // sections for each card's type" meant to fix.
  const grouped = new Map<string, Target[]>();
  for (const t of (targets ?? []) as Target[]) {
    grouped.set(t.purpose, [...(grouped.get(t.purpose) ?? []), t]);
  }
  // Both sections always render, even with zero rows — otherwise collapsing
  // the only section that currently has cards leaves nothing on the page.
  const purposes = [...new Set(["pc", "flip", ...grouped.keys()])].sort((a, b) =>
    a === "pc" ? -1 : b === "pc" ? 1 : a.localeCompare(b),
  );

  return (
    <main className="pg">
      <header className="pg-head">
        <div>
          <h1 className="pg-h1">Buying list</h1>
          <p className="pg-lead">
            Targets are all-in — price plus shipping plus sales tax.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <GuideLink guide="calendar" />
          <AddCardModal />
        </div>
      </header>

      {error && (
        <p className="ban err" role="alert">
          <span>
            <b>Couldn&rsquo;t load the buying list.</b> {error.message}
          </span>
        </p>
      )}

      {(targets ?? []).length === 0 && !error && (
        <p className="board bd text-sm text-ink-muted">
          Nothing on the buying list yet. Tell Claude what you&rsquo;re hunting
          for and it will add it.
        </p>
      )}

      {purposes.map((purpose) => {
        const rows = grouped.get(purpose) ?? [];
        return (
          <CollapsibleSection key={purpose} title={purposeLabel(purpose)} count={rows.length}>
            {rows.length === 0 ? (
              <p className="board bd text-sm text-ink-muted">Nothing here yet.</p>
            ) : (
            <>
            {/* Below 700px: image + title only, rest behind "See more" — a
                five-column table is unreadable at phone width, and at a show
                the only question is "is this the card I'm hunting". */}
            <div className="board bd grid gap-2.5 sm:hidden">
              {rows.map((t) => {
                const url = safeUrl(t.search_url) ?? ebaySearchUrl(t.title);
                const img = t.image_path ? imageUrls.get(t.image_path) : undefined;
                return (
                  <BuyingTargetCard
                    key={t.id}
                    id={t.id}
                    title={t.title}
                    img={img}
                    latestComp={t.latest_comp == null ? null : Number(t.latest_comp)}
                    compAgeDays={t.comp_age_days}
                    isStale={t.is_stale}
                    maxAllIn={t.max_all_in}
                    isManual={t.is_manual}
                    notes={t.notes}
                    soldUrl={ebaySoldUrl(t.title)}
                    searchUrl={url}
                    pointUrl={POINT130_URL}
                  />
                );
              })}
            </div>
            <div className="board bd-tight hidden overflow-x-auto sm:block">
              <table className="tb">
                <thead>
                  <tr>
                    <th>Card</th>
                    <th className="r">Comp</th>
                    <th className="r">Target price</th>
                    <th>Recent sales</th>
                    <th>Listings</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => {
                    const url = safeUrl(t.search_url) ?? ebaySearchUrl(t.title);
                    const img = t.image_path ? imageUrls.get(t.image_path) : undefined;
                    return (
                      <tr key={t.id}>
                        <td>
                          <div className="flex items-center gap-3.5">
                            {img && <CardImageLightbox src={img} alt={t.title} size="sm" />}
                            <div className="min-w-0">
                              <CopyTitle title={t.title}>{t.title}</CopyTitle>
                              <RowNotes itemId={t.id} initialNotes={t.notes} />
                            </div>
                          </div>
                        </td>
                        <td className="r">
                          <CompInput
                            itemId={t.id}
                            current={t.latest_comp == null ? null : Number(t.latest_comp)}
                            stale={t.is_stale}
                            ageLabel={
                              <>
                                {t.comp_age_days === 0 ? "today" : `${t.comp_age_days}d old`}
                                {t.is_stale ? " · stale" : ""}
                              </>
                            }
                          />
                        </td>
                        <td className="r whitespace-nowrap">
                          {t.max_all_in == null ? "—" : usd(t.max_all_in)}
                          {t.is_manual && (
                            <span className="block text-[11.5px] text-ink-muted">manual</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          <a
                            href={ebaySoldUrl(t.title)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="lk"
                          >
                            eBay
                          </a>
                          <span className="text-ink-muted"> · </span>
                          <a
                            href={POINT130_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="lk"
                          >
                            130point
                          </a>
                        </td>
                        <td>
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="lk"
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
            </>
            )}
          </CollapsibleSection>
        );
      })}
    </main>
  );
}
