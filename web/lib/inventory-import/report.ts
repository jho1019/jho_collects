import type { Plan, PlanRow } from "./plan";

// Plan -> readable markdown. The JSON report is the Plan itself.

const esc = (s: string | null | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const money = (s: string | null | undefined) => (s ? `$${s}` : "—");

function cardCell(r: PlanRow): string {
  const c = r.card;
  if (!c) return "";
  const bits = [c.category + (c.intent ? `/${c.intent}` : ""), c.grader ? `${c.grader} ${c.grade ?? ""}`.trim() : "raw"];
  if (c.cert_number) bits.push(`cert ${c.cert_number}`);
  if (c.acquisition_cost) bits.push(`cost ${money(c.acquisition_cost)}`);
  if (c.list_price) bits.push(`list ${money(c.list_price)}`);
  if (c.location) bits.push(`@ ${c.location}`);
  return bits.join(", ");
}

function flagCell(r: PlanRow): string {
  return r.flags.map((f) => `${f.blocking ? (f.resolved ? "✔" : "⛔") : "ℹ"}${f.code}`).join(" ");
}

export function planToMarkdown(p: Plan): string {
  const t = p.totals;
  const L: string[] = [];
  L.push(`# CDP inventory import — ${p.file}`, "");
  L.push(`Dry run. **Nothing was written.** Batch \`${p.batch_id}\`, mode **${p.mode}**, valued on ${p.valued_on}, ` +
    `layout ${p.layout === "title_row" ? "title row above header" : "header first"} (header on line ${p.header_line}), fuzzy threshold ${p.fuzzy_threshold}.`, "");

  L.push("## Totals", "");
  L.push("| | |", "|---|---|");
  L.push(`| rows read | ${t.rows_read} |`);
  L.push(`| skipped (blank title) | ${t.skipped_blank} |`);
  L.push(`| cards: insert | ${t.inserts} (est value ${money(t.insert_est_value)}) |`);
  L.push(`| cards: update | ${t.updates} |`);
  L.push(`| bulk rows → cards added | ${t.bulk_rows} → ${t.bulk_cards_added} (value ${money(t.bulk_value_added)}) |`);
  L.push(`| PC | ${t.pc} |`);
  L.push(`| skipped by override | ${t.skipped_by_override} |`);
  L.push(`| manual adds | ${t.manual_adds} |`);
  L.push(`| **excluded (unresolved flags)** | **${t.excluded}** |`);
  L.push(`| flags | ${Object.entries(t.flags).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} |`);
  L.push(`| unresolved blocking flags | ${t.unresolved_blocking} |`);
  if (p.rows.some((r) => r.bowser)) L.push(`| disagreements with Bowser's hints | ${t.bowser_disagreements} |`);
  L.push("");

  L.push("## Bulk lot increments", "");
  if (!p.lots.length) L.push("None.", "");
  else {
    L.push("| bucket | location | scanned | +count | existing | resulting count | unit price | total value |", "|---|---|---|---|---|---|---|---|");
    for (const l of p.lots) {
      L.push(`| ${l.bucket} | ${esc(l.location) || "—"} | ${l.scanned} | ${l.already_applied ? `already applied (+${l.delta} skipped)` : `+${l.delta}`}${l.hand_count ? " (hand count)" : ""} | ${l.existing_count} | ${l.resulting_count} | ${money(l.unit_price)} | ${money(l.resulting_total_value)} |`);
    }
    L.push("", "Resulting figures are against the snapshot; the commit SQL recomputes them at apply time.", "");
  }

  const section = (title: string, rows: PlanRow[], extra?: (r: PlanRow) => string) => {
    L.push(`## ${title} (${rows.length})`, "");
    if (!rows.length) { L.push("None.", ""); return; }
    L.push("| line | sku | title | market | card | match / best score | flags |", "|---|---|---|---|---|---|---|");
    for (const r of rows) {
      const m = r.match ? `card ${r.match.card_id} by ${r.match.by}${r.fills.length ? `; fills ${r.fills.join(", ")}` : "; no change"}` :
        r.best_score !== null ? `best ${r.best_score}` : "";
      L.push(`| ${r.line ?? "manual"} | ${esc(r.cdp_sku) || "—"} | ${esc(r.title)} | ${money(r.market_price)} | ${esc(cardCell(r))} | ${esc(m)}${extra ? ` ${esc(extra(r))}` : ""} | ${flagCell(r)} |`);
    }
    L.push("");
  };
  section("Inserts", p.rows.filter((r) => r.outcome === "insert"));
  section("Updates", p.rows.filter((r) => r.outcome === "update"));
  section("Excluded until resolved", p.rows.filter((r) => r.outcome === "excluded"), (r) => (r.would_be ? `(would be ${r.would_be}${r.bucket ? ` ${r.bucket}` : ""})` : ""));
  section("Bulk", p.rows.filter((r) => r.outcome === "bulk"), (r) => `→ ${r.bucket}`);
  section("Skipped by override", p.rows.filter((r) => r.outcome === "skip"));

  L.push(`## Skipped: blank title (${p.skipped_blank.length})`, "");
  if (p.skipped_blank.length) L.push(p.skipped_blank.map((b) => `- line ${b.line}, sku ${b.sku ?? "—"}${b.bowser_bucket ? ` (Bowser: ${b.bowser_bucket})` : ""}`).join("\n"), "");
  else L.push("None.", "");

  const flagged = p.rows.filter((r) => r.flags.length);
  L.push(`## Flags in detail (${flagged.length} rows)`, "");
  for (const r of flagged) {
    L.push(`- **line ${r.line ?? "manual"}** sku ${r.cdp_sku ?? "—"} — ${esc(r.title)}`);
    for (const f of r.flags) L.push(`  - ${f.blocking ? (f.resolved ? "resolved by override" : "BLOCKING") : "info"} \`${f.code}\`: ${esc(f.message)}`);
  }
  if (!flagged.length) L.push("None.");
  L.push("");

  const dup = p.rows.filter((r) => r.candidates.length);
  L.push(`## Duplicate candidates (${dup.length} rows)`, "");
  for (const r of dup) {
    L.push(`- line ${r.line ?? "manual"} (sku ${r.cdp_sku ?? "—"}) ${esc(r.title)}: ` + r.candidates.map((c) =>
      c.source === "db" ? `card ${c.card_id} "${esc(c.title)}" [${c.status}] ${c.score}${c.contradiction ? ` (not flagged: ${c.contradiction})` : ""}` :
      c.source === "batch" ? `this file line ${c.line} (sku ${c.cdp_sku})` : `${c.file} line ${c.line} (sku ${c.cdp_sku})`).join("; "));
  }
  if (!dup.length) L.push("None.");
  L.push("");

  const bow = p.rows.filter((r) => r.bowser && (r.bowser.agrees_bucket === false || r.bowser.agrees_pc === false));
  if (p.rows.some((r) => r.bowser)) {
    L.push(`## Disagreements with Bowser Jr.'s bucket / pc_flag (${bow.length})`, "");
    if (bow.length) {
      L.push("| line | sku | title | Bowser bucket | ours | Bowser pc_flag | why |", "|---|---|---|---|---|---|---|");
      for (const r of bow) {
        const why = r.pc.kind === "pc" ? `PC rule ${r.pc.ruleId}` :
          r.bowser!.pc_flag && /^y/i.test(r.bowser!.pc_flag) ? "no PC rule matches (2026 Heritage is business)" :
          r.flags.map((f) => f.code).join(", ");
        L.push(`| ${r.line} | ${esc(r.cdp_sku)} | ${esc(r.title)} | ${esc(r.bowser!.bucket)} | ${esc(r.bowser!.ours)} | ${esc(r.bowser!.pc_flag)} | ${esc(why)} |`);
      }
    } else L.push("None.");
    L.push("");
  }

  const warn = [...p.warnings, ...p.rows.flatMap((r) => r.warnings.map((w) => `line ${r.line ?? "manual"} (sku ${r.cdp_sku ?? "—"}): ${w}`))];
  L.push(`## Warnings (${warn.length})`, "");
  L.push(warn.length ? warn.map((w) => `- ${esc(w)}`).join("\n") : "None.", "");
  return L.join("\n");
}
