import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { toCsv } from "@/lib/csv";
import { TABLES, TABLE_NAMES, type TableName } from "@/lib/tables";

export async function GET(req: NextRequest) {
  const table = req.nextUrl.searchParams.get("table") as TableName | null;
  if (!table || !TABLE_NAMES.includes(table)) {
    return NextResponse.json({ error: "unknown table" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cols = TABLES[table].columns;
  const { data, error } = await supabase
    .from(table)
    .select(cols.join(","))
    .order(table === "inventory_counts" ? "tax_year" : "id", {
      ascending: true,
    });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = ((data ?? []) as unknown as Record<string, unknown>[]).map((r) =>
    cols.map((c) => r[c] as string | number | boolean | null),
  );
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(toCsv(cols, rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${table}_${stamp}.csv"`,
    },
  });
}
