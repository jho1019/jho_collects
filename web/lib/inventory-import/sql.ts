import type { CardDraft, LotPlan, Plan, PlanRow } from "./plan";

// ============================================================================
// Plan -> one reviewable, idempotent SQL script (begin; ... commit;).
// ============================================================================
//
// Written for the Supabase connector (Bowser Jr. / Toad apply it as one
// execute_sql call) or psql. It needs no service-role key on the box.
//
//   * The owner's user_id is written explicitly on every row and in every
//     WHERE. Under the connector auth.uid() is null, so column defaults
//     (cards.user_id, bulk_lots.user_id default auth.uid()) would be null.
//   * Cards are matched AT APPLY TIME by cdp_sku, then grader+cert:
//       UPDATE ... fills only null fields (plus the CDP est_value refresh,
//         location, and anything an override set explicitly);
//       INSERT ... WHERE NOT EXISTS (same key) ON CONFLICT DO NOTHING.
//     So a rerun finds the rows the first run inserted and changes nothing.
//   * Each bulk-lot increment is guarded by a marker in
//     bulk_lot_events.notes ("cdp-import:<batch>:<bucket>:<location>"). If the
//     marker exists the increment is skipped, so a rerun never double-counts.
//     The 6_20 unit price is recomputed at apply time as a weighted average
//     with whatever the lot holds then.
//   * Never touches transactions. Never sets status other than 'held' on
//     insert; never changes status on update. Never writes generated columns
//     (search_text, total_value). No DELETE; every UPDATE has a WHERE.
// ============================================================================

export class SqlEmitError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY = /^\d+(\.\d{1,4})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** SQL string literal. Rejects NUL (Postgres text cannot hold it). */
export function lit(v: string | null | undefined): string {
  if (v === null || v === undefined) return "null";
  if (v.includes("\u0000")) throw new SqlEmitError("NUL byte in a value");
  return `'${v.replace(/'/g, "''")}'`;
}
const num = (v: string | null) => {
  if (v === null) return "null";
  if (!MONEY.test(v)) throw new SqlEmitError(`not a numeric literal: ${v}`);
  return v;
};
const date = (v: string | null) => {
  if (v === null) return "null";
  if (!DATE.test(v)) throw new SqlEmitError(`not a date: ${v}`);
  return `'${v}'::date`;
};

/** Apply-time key: cdp_sku first, then grader + cert. Null when the row has neither. */
function keyPredicate(c: CardDraft, u: string, alias = ""): string | null {
  const p = alias ? `${alias}.` : "";
  const parts: string[] = [];
  if (c.cdp_sku) parts.push(`${p}cdp_sku = ${lit(c.cdp_sku)}`);
  if (c.cert_number && c.grader) parts.push(`(${p}grader = ${lit(c.grader)} and ${p}cert_number = ${lit(c.cert_number)})`);
  if (!parts.length) return null;
  return `${p}user_id = ${lit(u)} and (${parts.join(" or ")})`;
}

/** Fallback key for a manual add with no sku/cert: same title, set and number, not CDP-scanned. */
function manualKey(c: CardDraft, u: string): string {
  return `user_id = ${lit(u)} and cdp_sku is null and title = ${lit(c.title)} ` +
    `and coalesce(set_name, '') = ${lit(c.set_name ?? "")} and coalesce(card_number, '') = ${lit(c.card_number ?? "")}`;
}

const TEXT_FILL = ["player", "year", "set_name", "card_number", "parallel", "grader", "grade", "cert_number", "sport", "serial_number", "cdp_sku", "notes"] as const;

function updateSet(r: PlanRow): string[] {
  const c = r.card!;
  const ov = r.override;
  const set: string[] = [];
  for (const f of TEXT_FILL) if (c[f] !== null) set.push(`${f} = coalesce(${f}, ${lit(c[f])})`);
  if (c.acquisition_cost !== null) set.push(`acquisition_cost = coalesce(acquisition_cost, ${num(c.acquisition_cost)})`);
  if (c.acquired_on !== null) set.push(`acquired_on = coalesce(acquired_on, ${date(c.acquired_on)})`);
  if (c.est_value !== null) {
    // Refresh only a CDP-sourced or empty estimate; a hand/comp estimate is kept.
    const refresh = "est_value is null or est_value_source = 'cdp'";
    set.push(`est_value = case when ${refresh} then ${num(c.est_value)} else est_value end`);
    set.push(`est_value_source = case when ${refresh} then 'cdp' else est_value_source end`);
    set.push(`est_valued_on = case when ${refresh} then ${date(c.est_valued_on)} else est_valued_on end`);
  }
  if (c.location !== null) set.push(`location = ${lit(c.location)}`);
  // category only ever changes through an explicit override.
  if (ov?.category) {
    set.push(`category = ${lit(ov.category)}::card_category`);
    if (ov.category === "pc") set.push("intent = null");
  }
  if (ov && "intent" in ov && ov.category !== "pc") set.push(`intent = ${lit(ov.intent ?? null)}`);
  else if (!ov?.category && c.intent) set.push(`intent = case when category = 'pc' then intent else coalesce(intent, ${lit(c.intent)}) end`);
  if (ov?.list_price) set.push(`list_price = ${num(ov.list_price)}`);
  return set;
}

const INSERT_COLS = [
  "user_id", "title", "player", "year", "set_name", "card_number", "parallel", "grader", "grade", "cert_number",
  "sport", "serial_number", "cdp_sku", "location", "category", "intent", "list_price", "est_value",
  "est_value_source", "est_valued_on", "acquisition_cost", "acquired_on", "notes", "status",
];

function insertValues(c: CardDraft, u: string): string[] {
  return [
    `${lit(u)}::uuid`, lit(c.title), lit(c.player), lit(c.year), lit(c.set_name), lit(c.card_number), lit(c.parallel),
    lit(c.grader), lit(c.grade), lit(c.cert_number), lit(c.sport), lit(c.serial_number), lit(c.cdp_sku), lit(c.location),
    `${lit(c.category)}::card_category`, lit(c.intent), num(c.list_price), num(c.est_value), lit(c.est_value_source),
    date(c.est_valued_on), num(c.acquisition_cost), date(c.acquired_on), lit(c.notes), "'held'::card_status",
  ];
}

const comment = (s: string) => `-- ${s.replace(/[\r\n]+/g, " ")}`;

function cardSql(r: PlanRow, u: string): string {
  const c = r.card!;
  const head = comment(`${r.source === "manual" ? "manual add" : `line ${r.line}`} · cdp_sku ${r.cdp_sku ?? "-"} · ${r.outcome}` +
    `${r.match ? ` (card ${r.match.card_id} by ${r.match.by})` : ""} · ${c.category}${c.intent ? `/${c.intent}` : ""} · ${c.title}`);
  const out = [head];
  const set = updateSet(r);

  if (!set.length && r.match?.by === "override") return [head, comment("nothing to fill")].join("\n");
  if (r.match?.by === "override") {
    // merge into a named card: update that card only, never insert
    out.push(`update cards set\n  ${set.join(",\n  ")}\nwhere user_id = ${lit(u)} and id = ${Number(r.match.card_id)};`);
    return out.join("\n");
  }

  const key = keyPredicate(c, u);
  if (key) {
    const k2 = keyPredicate(c, u, "k")!;
    const prefer = c.cdp_sku ? `(k.cdp_sku = ${lit(c.cdp_sku)}) desc nulls last, ` : "";
    out.push(`update cards set\n  ${set.join(",\n  ")}\nwhere id = (select k.id from cards k where ${k2} order by ${prefer}k.id limit 1);`);
    out.push(`insert into cards (${INSERT_COLS.join(", ")})\nselect ${insertValues(c, u).join(", ")}\nwhere not exists (select 1 from cards where ${key})\non conflict do nothing;`);
  } else {
    out.push(`insert into cards (${INSERT_COLS.join(", ")})\nselect ${insertValues(c, u).join(", ")}\nwhere not exists (select 1 from cards where ${manualKey(c, u)})\non conflict do nothing;`);
  }
  return out.join("\n");
}

function lotSql(l: LotPlan, u: string, occurredOn: string): string {
  const loc = lit(l.location);
  const unitExpr = l.bucket === "6_20"
    ? `round((v_count * v_unit + ${num(l.batch_sum)}) / (v_count + ${l.delta}), 2)`
    : "v_unit";
  const initUnit = l.bucket === "6_20" ? "0" : num(l.bucket === "1" ? "1.00" : l.bucket === "3" ? "3.00" : "5.00");
  const body = `
declare
  v_lot bigint; v_count int; v_unit numeric;
begin
  if exists (select 1 from bulk_lot_events
              where user_id = ${lit(u)} and reason = 'scan_add' and notes = ${lit(l.marker)}) then
    raise notice 'already applied: %', ${lit(l.marker)};
    return;
  end if;
  insert into bulk_lots (user_id, bucket, card_count, unit_price, location)
  values (${lit(u)}, ${lit(l.bucket)}, 0, ${initUnit}, ${loc})
  on conflict (user_id, bucket, coalesce(location, '')) do nothing;
  select id, card_count, unit_price into v_lot, v_count, v_unit
    from bulk_lots
   where user_id = ${lit(u)} and bucket = ${lit(l.bucket)} and coalesce(location, '') = coalesce(${loc}, '')
   for update;
  update bulk_lots
     set card_count = card_count + ${l.delta},
         unit_price = ${unitExpr}
   where id = v_lot and user_id = ${lit(u)};
  insert into bulk_lot_events (user_id, lot_id, delta, reason, occurred_on, notes)
  values (${lit(u)}, v_lot, ${l.delta}, 'scan_add', ${date(occurredOn)}, ${lit(l.marker)});
end`;
  if (body.includes("$lot$")) throw new SqlEmitError("value contains the dollar-quote tag");
  return [
    comment(`bulk lot ${l.bucket} @ ${l.location ?? "(no location)"}: +${l.delta}${l.hand_count ? " (hand count)" : ""}` +
      `${l.bucket === "6_20" ? `, batch sum ${l.batch_sum}` : ""} · skus ${l.skus.join(",") || "-"}`),
    `do $lot$${body} $lot$;`,
  ].join("\n");
}

export interface SqlOptions {
  userId: string;
  /** For the header only. */
  generatedAt?: string;
}

/** Rows written by the commit: inserts and updates. Excluded and skipped rows are not. */
export const committedRows = (p: Plan) => p.rows.filter((r) => (r.outcome === "insert" || r.outcome === "update") && r.card);

export function planToSql(plan: Plan, opts: SqlOptions): string {
  if (!UUID.test(opts.userId)) throw new SqlEmitError("userId must be a UUID");
  const u = opts.userId.toLowerCase();
  const cards = committedRows(plan);
  const t = plan.totals;
  const out: string[] = [
    comment(`Card Dealer Pro inventory import — ${plan.file}`),
    comment(`batch ${plan.batch_id} · mode ${plan.mode} · valued_on ${plan.valued_on}${opts.generatedAt ? ` · generated ${opts.generatedAt}` : ""}`),
    comment(`cards: ${cards.filter((r) => r.outcome === "insert").length} insert, ${cards.filter((r) => r.outcome === "update").length} update · ` +
      `bulk: ${plan.lots.map((l) => `${l.bucket}+${l.delta}`).join(" ") || "none"} · excluded ${t.excluded} · skipped ${t.skipped_by_override}`),
    comment("Idempotent: safe to run twice. Never touches transactions. Review before applying."),
    "",
    "begin;",
    "",
    `do $guard$ begin\n  if not exists (select 1 from auth.users where id = ${lit(u)}) then\n    raise exception 'owner % is not in auth.users', ${lit(u)};\n  end if;\nend $guard$;`,
    "",
  ];
  for (const r of cards) out.push(cardSql(r, u), "");
  for (const l of plan.lots) out.push(lotSql(l, u, plan.valued_on), "");
  out.push("commit;", "");
  return out.join("\n");
}
