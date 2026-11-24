import type { Bucket } from "@/lib/dashboard/model";
import { bare, money, moneyAria } from "@/lib/dashboard/format";

// The line score (spec 6.4): a real table. Columns are the range's buckets
// plus TOT. Whole dollars past 8 columns; the title attribute always carries
// cents. Zero is "–" (muted) except a PROFIT cell for a period that had
// sales, which prints a neutral 0.00.
type RowKey = "ebay" | "shows" | "other" | "profit" | "sales";

export default function LineScore({
  buckets,
  unit,
  hasOther,
  missingCurrent,
}: {
  buckets: Bucket[];
  unit: "week" | "month" | "quarter";
  hasOther: boolean;
  missingCurrent: boolean;
}) {
  const dense = buckets.length > 8;
  const dec = dense ? 0 : 2;
  const tot = buckets.reduce(
    (t, b) => ({
      ebay: t.ebay + b.ebay,
      shows: t.shows + b.shows,
      other: t.other + b.other,
      profit: t.profit + b.profit,
      sales: t.sales + b.sales,
    }),
    { ebay: 0, shows: 0, other: 0, profit: 0, sales: 0 },
  );

  function cell(k: RowKey, v: number, sales: number) {
    if (k === "sales") return { text: v ? String(v) : "–", cls: v ? "" : "sb-nil", title: undefined };
    if (v === 0 && (k !== "profit" || sales === 0)) return { text: "–", cls: "sb-nil", title: undefined };
    const rounded = dense ? Math.round(v / 100) * 100 : v;
    return {
      text: bare(v, dec, false),
      cls: rounded < 0 ? "sb-neg" : rounded === 0 ? "sb-zero" : "",
      title: moneyAria(v),
    };
  }

  const rows: { k: RowKey; label: string }[] = [
    { k: "ebay", label: "EBAY" },
    { k: "shows", label: "SHOWS" },
    ...(hasOther ? [{ k: "other" as const, label: "OTHER" }] : []),
    { k: "profit", label: "PROFIT" },
    { k: "sales", label: "SALES" },
  ];

  return (
    <>
      <div className={`sb-lsw ${buckets.length <= 4 ? "sb-noscroll" : ""}`}>
        <div className="sb-sc">
          <table className={`sb-ls ${dense ? "sb-dense" : ""}`} aria-label={`Line score, profit by ${unit}`}>
            <caption className="sr-only">
              Line score, profit by {unit}. Total profit {money(tot.profit).replace("−", "-")}, {tot.sales} sales.
            </caption>
            <thead>
              <tr>
                <td />
                {buckets.map((b) => (
                  <th key={b.start} scope="col">{b.label}</th>
                ))}
                <th scope="col">TOT</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ k, label }) => (
                <tr key={k} className={k === "profit" ? "sb-tot" : undefined}>
                  <th scope="row">{label}</th>
                  {buckets.map((b) => {
                    const c = cell(k, b[k], b.sales);
                    const outline = b.current ? (k === "profit" && missingCurrent ? "sb-prov" : "sb-mtd") : "";
                    return (
                      <td key={b.start} className={`${c.cls} ${outline}`} title={c.title}>
                        {c.text}
                      </td>
                    );
                  })}
                  {(() => {
                    const c = cell(k, tot[k], tot.sales);
                    return <td className={`sb-t ${c.cls}`} title={c.title}>{c.text}</td>;
                  })()}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {buckets.length > 4 && <div className="sb-hint" aria-hidden="true">SWIPE FOR MORE ›</div>}
    </>
  );
}
