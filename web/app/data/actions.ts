"use server";

import { createClient } from "@/lib/supabase/server";
import { parseCsv } from "@/lib/csv";
import { TABLES, TABLE_NAMES, coerce, type TableName } from "@/lib/tables";

export type Preview =
  | {
      ok: true;
      table: TableName;
      header: string[];
      total: number;
      newCount: number;
      existingCount: number;
      dropped: string[];
      sample: Record<string, string>[];
      warnings: string[];
    }
  | { ok: false; error: string };

export type CommitResult =
  | { ok: true; mode: "insert" | "update"; affected: number }
  | { ok: false; error: string };

function readTable(fd: FormData): TableName {
  const t = String(fd.get("table") ?? "");
  if (!TABLE_NAMES.includes(t as TableName)) throw new Error(`unknown table: ${t}`);
  return t as TableName;
}

function rowsFromCsv(csv: string, table: TableName) {
  const { header, rows } = parseCsv(csv);
  const meta = TABLES[table];
  const unknown = header.filter((h) => !meta.columns.includes(h));
  const keep = header.filter(
    (h) => meta.columns.includes(h) && !meta.generated.includes(h),
  );
  const dropped = header.filter(
    (h) => meta.generated.includes(h) || unknown.includes(h),
  );
  const objs = rows.map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => {
      if (keep.includes(h)) o[h] = r[i] ?? "";
    });
    return o;
  });
  return { header, keep, dropped, unknown, objs };
}

export async function previewImport(fd: FormData): Promise<Preview> {
  try {
    const table = readTable(fd);
    const csv = String(fd.get("csv") ?? "");
    const { header, keep, dropped, unknown, objs } = rowsFromCsv(csv, table);

    if (objs.length === 0) return { ok: false, error: "no data rows" };
    if (keep.length === 0)
      return { ok: false, error: "no recognised columns in the header" };

    const warnings: string[] = [];
    if (unknown.length) warnings.push(`ignored unknown columns: ${unknown.join(", ")}`);
    if (dropped.some((d) => TABLES[table].generated.includes(d)))
      warnings.push("generated columns are re-derived on import, not written");

    const supabase = await createClient();
    const target = TABLES[table].conflictTarget;
    let existingCount = 0;

    if (target === "id" && keep.includes("id")) {
      const ids = objs.map((o) => o.id).filter(Boolean);
      const { data } = await supabase.from(table).select("id").in("id", ids);
      existingCount = data?.length ?? 0;
    } else if (target === "user_id,tax_year" && keep.includes("tax_year")) {
      const years = objs.map((o) => Number(o.tax_year)).filter(Number.isFinite);
      const { data } = await supabase
        .from(table)
        .select("tax_year")
        .in("tax_year", years);
      existingCount = data?.length ?? 0;
    }

    return {
      ok: true,
      table,
      header,
      total: objs.length,
      newCount: objs.length - existingCount,
      existingCount,
      dropped,
      sample: objs.slice(0, 20),
      warnings,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function commitImport(fd: FormData): Promise<CommitResult> {
  try {
    const table = readTable(fd);
    const csv = String(fd.get("csv") ?? "");
    const mode = String(fd.get("mode") ?? "insert") as "insert" | "update";
    const { keep, objs } = rowsFromCsv(csv, table);
    if (objs.length === 0) return { ok: false, error: "no data rows" };

    const payload = objs.map((o) => {
      const row: Record<string, string | boolean | null> = {};
      keep.forEach((k) => (row[k] = coerce(o[k] ?? "")));
      return row;
    });

    const supabase = await createClient();
    const target = TABLES[table].conflictTarget;
    const q = supabase
      .from(table)
      .upsert(payload, {
        onConflict: target,
        ignoreDuplicates: mode === "insert",
      })
      .select(target.split(",")[0]);

    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    return { ok: true, mode, affected: data?.length ?? 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
