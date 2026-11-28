// Card Dealer Pro inventory import — CLI.            docs/inventory-import.md
//
//   npx tsx scripts/cdp-inventory-import.ts --file batch.csv --existing snapshot.json [options]
//
// Dry run by default: writes <out>/<name>.json and <name>.md and prints the
// markdown. Touches no database, ever. --commit additionally writes
// <name>.commit.sql — one idempotent begin/commit script to review and apply
// through the Supabase connector (or psql). It refuses while the plan has
// unresolved blocking flags unless --allow-flags (flagged rows are then left
// out of the SQL).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  InventoryParseError, OverridesError, cdpBatchNumber, committedRows, parseInventoryCsv, parseOverrides,
  planImport, planToMarkdown, planToSql, type Existing, type Mode, type Overrides, type PriorFile,
} from "../lib/inventory-import";

const USAGE = `usage: npx tsx scripts/cdp-inventory-import.ts --file <cdp.csv> --existing <snapshot.json> [options]

  --mode bulk|holds         batch mode (default bulk)
  --overrides <file.json>   Johnny's overrides (docs/inventory-import.md)
  --prior <file.csv>        a file applied before this one (repeatable): cross-file duplicates
  --valued-on YYYY-MM-DD    est_valued_on (default: date in the file name, else today)
  --batch-id <id>           idempotency key (default: cdp-<CDP batch number>, else a content hash)
  --fuzzy-threshold <0..1>  trigram similarity that flags possible_duplicate (default 0.6)
  --out-dir <dir>           where reports go (default ./inventory-import-out)
  --commit                  also write <name>.commit.sql
  --allow-flags             with --commit: emit SQL even with unresolved flags (flagged rows left out)
  --user-id <uuid>          owner (default: the single user_id in the snapshot)
  --quiet                   do not print the markdown report`;

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    existing: { type: "string" },
    mode: { type: "string", default: "bulk" },
    overrides: { type: "string" },
    prior: { type: "string", multiple: true, default: [] },
    "valued-on": { type: "string" },
    "batch-id": { type: "string" },
    "fuzzy-threshold": { type: "string" },
    "out-dir": { type: "string", default: "inventory-import-out" },
    commit: { type: "boolean", default: false },
    "allow-flags": { type: "boolean", default: false },
    "user-id": { type: "string" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) { console.log(USAGE); process.exit(0); }
if (!values.file || !values.existing) die(USAGE);
const mode = values.mode as Mode;
if (mode !== "bulk" && mode !== "holds") die(`--mode must be bulk or holds, not ${values.mode}`);

const read = (p: string) => {
  try { return readFileSync(p, "utf8"); } catch (e) { die(`cannot read ${p}: ${(e as Error).message}`); }
};

// ---- input file
const text = read(values.file);
let parsed;
try { parsed = parseInventoryCsv(text); }
catch (e) { if (e instanceof InventoryParseError) die(`${values.file}: ${e.message}`); throw e; }

// ---- snapshot of existing rows
type Row = Record<string, unknown> & { user_id?: string };
type Snapshot = { cards?: Row[]; bulk_lots?: Row[]; bulk_lot_events?: Row[] };
let snap: Snapshot;
try { snap = JSON.parse(read(values.existing)); } catch { die(`${values.existing} is not JSON`); }
if (!Array.isArray(snap.cards)) die(`${values.existing}: expected {"cards": [...], "bulk_lots": [...]}`);
const owners = [...new Set(snap.cards.map((c) => c.user_id).filter(Boolean))] as string[];
const userId = values["user-id"] ?? (owners.length === 1 ? owners[0] : undefined);
if (values.commit && !userId) die(`--user-id is required: the snapshot has ${owners.length} owners`);
const mine = <T extends { user_id?: string }>(rows: T[]) => rows.filter((r) => !userId || !r.user_id || r.user_id === userId);
const existing = {
  cards: mine(snap.cards),
  bulk_lots: mine(Array.isArray(snap.bulk_lots) ? snap.bulk_lots : []),
  bulk_lot_events: mine(Array.isArray(snap.bulk_lot_events) ? snap.bulk_lot_events : []),
} as unknown as Existing;

// ---- overrides
let overrides: Overrides | undefined;
if (values.overrides) {
  try { overrides = parseOverrides(JSON.parse(read(values.overrides))); }
  catch (e) {
    if (e instanceof OverridesError) die(e.message);
    die(`${values.overrides}: ${(e as Error).message}`);
  }
}

// ---- prior files
const prior: PriorFile[] = (values.prior as string[]).map((p) => {
  try { return { name: basename(p), rows: parseInventoryCsv(read(p)).rows }; }
  catch (e) { die(`${p}: ${(e as Error).message}`); }
});

// ---- dates / ids
const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
const valuedOn = values["valued-on"] ?? /(\d{4}-\d{2}-\d{2})/.exec(basename(values.file))?.[1] ?? today;
if (!/^\d{4}-\d{2}-\d{2}$/.test(valuedOn)) die("--valued-on must be YYYY-MM-DD");
const cdpBatch = cdpBatchNumber(parsed);
const batchId = values["batch-id"] ??
  (cdpBatch ? `cdp-${cdpBatch}` : `sha-${createHash("sha256").update(text).digest("hex").slice(0, 12)}`);
const threshold = values["fuzzy-threshold"] === undefined ? undefined : Number(values["fuzzy-threshold"]);
if (threshold !== undefined && !(threshold > 0 && threshold <= 1)) die("--fuzzy-threshold must be in (0, 1]");

// ---- plan
const plan = planImport({
  file: basename(values.file), parsed, mode, existing, overrides, valuedOn, batchId, prior, fuzzyThreshold: threshold,
});

const outDir = values["out-dir"]!;
mkdirSync(outDir, { recursive: true });
const stem = basename(values.file).replace(/\.csv$/i, "");
const md = planToMarkdown(plan);
writeFileSync(join(outDir, `${stem}.json`), JSON.stringify(plan, null, 2) + "\n");
writeFileSync(join(outDir, `${stem}.md`), md);
if (!values.quiet) console.log(md);

const t = plan.totals;
console.error(`[dry run] ${plan.file}: ${t.rows_read} rows, ${t.skipped_blank} blank, ${t.inserts} insert, ${t.updates} update, ` +
  `${t.bulk_cards_added} into bulk (${plan.lots.map((l) => `${l.bucket}+${l.already_applied ? "0 (applied)" : l.delta}`).join(" ") || "-"}), ${t.pc} pc, ` +
  `${t.excluded} excluded, ${t.unresolved_blocking} unresolved flag(s). Reports: ${join(outDir, stem)}.{md,json}`);

if (values.commit) {
  if (t.unresolved_blocking && !values["allow-flags"]) {
    die(`refusing to write commit SQL: ${t.unresolved_blocking} unresolved blocking flag(s) on ${t.excluded} row(s). ` +
      "Resolve them in an overrides file, or pass --allow-flags to leave those rows out.", 2);
  }
  const sql = planToSql(plan, { userId: userId!, generatedAt: new Date().toISOString() });
  const sqlPath = join(outDir, `${stem}.commit.sql`);
  writeFileSync(sqlPath, sql);
  console.error(`[commit sql] ${sqlPath}: ${committedRows(plan).length} card statement(s), ${plan.lots.length} bulk increment(s)` +
    `${t.excluded ? `; ${t.excluded} flagged row(s) left out` : ""}. Nothing applied — review it, then run it through the Supabase connector.`);
}
