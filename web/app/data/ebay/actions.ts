"use server";

import { createClient } from "@/lib/supabase/server";
import { parseEbayReport, type EbayRow } from "@/lib/ebay/parse";

// Port of importers/load_ebay.py. Idempotent: sale/refund rows dedupe on
// source_ref, buyers upsert on (user_id, platform, platform_username),
// orphan labels are guarded by a note marker.

export type EbayPreview =
  | {
      ok: true;
      rowCount: number;
      newCount: number;
      dupCount: number;
      ignored: Record<string, number>;
      orphansResolvable: string[];
      orphansUnresolvable: string[];
      totals: ReturnType<typeof parseEbayReport>["totals"];
      sample: {
        occurred_on: string;
        type: string;
        item_amount: number;
        platform_fees: number;
        shipping_cost: number;
        buyer_username: string | null;
      }[];
    }
  | { ok: false; error: string };

export type EbayCommit =
  | {
      ok: true;
      buyersUpserted: number;
      inserted: number;
      alreadyPresent: number;
      orphansApplied: string[];
      orphansUnresolved: string[];
      cardsClosed: number;
    }
  | { ok: false; error: string };

const TXN_INSERT_COLS = [
  "occurred_on", "type", "platform", "description", "qty", "item_amount",
  "shipping_charged", "sales_tax_collected", "platform_fees", "shipping_cost",
  "other_cost", "source_ref", "order_ref", "item_number", "shipping_service",
  "tracking_number", "fees_estimated",
] as const;

async function parseFromForm(fd: FormData) {
  const csv = String(fd.get("csv") ?? "");
  if (!csv.trim()) throw new Error("empty file");
  return parseEbayReport(csv);
}

export async function previewEbay(fd: FormData): Promise<EbayPreview> {
  try {
    const { rows, ignored, orphanLabels, totals } = await parseFromForm(fd);
    if (rows.length === 0 && orphanLabels.length === 0)
      return { ok: false, error: "nothing to import" };

    const supabase = await createClient();
    const refs = rows.map((r) => r.source_ref).filter(Boolean) as string[];
    const { data: existing } = await supabase
      .from("transactions")
      .select("source_ref")
      .eq("platform", "ebay")
      .in("source_ref", refs);
    const have = new Set((existing ?? []).map((e) => e.source_ref));
    const dupCount = rows.filter((r) => r.source_ref && have.has(r.source_ref)).length;

    const orphanOrderRefs = orphanLabels.map((o) => o.order_ref);
    const { data: orphanHits } = await supabase
      .from("transactions")
      .select("order_ref")
      .in("order_ref", orphanOrderRefs.length ? orphanOrderRefs : ["__none__"]);
    const orphanTargets = new Set((orphanHits ?? []).map((o) => o.order_ref));

    return {
      ok: true,
      rowCount: rows.length,
      newCount: rows.length - dupCount,
      dupCount,
      ignored,
      orphansResolvable: orphanLabels
        .filter((o) => orphanTargets.has(o.order_ref))
        .map((o) => o.order_ref),
      orphansUnresolvable: orphanLabels
        .filter((o) => !orphanTargets.has(o.order_ref))
        .map((o) => o.order_ref),
      totals,
      sample: rows.slice(0, 20).map((r) => ({
        occurred_on: r.occurred_on,
        type: r.type,
        item_amount: r.item_amount,
        platform_fees: r.platform_fees,
        shipping_cost: r.shipping_cost,
        buyer_username: r.buyer_username,
      })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function commitEbay(fd: FormData): Promise<EbayCommit> {
  try {
    const { rows, orphanLabels } = await parseFromForm(fd);
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "not signed in" };
    const uid = user.id;

    // --- buyers: aggregate, merge with existing (widen the seen window) ---
    const agg = new Map<
      string,
      {
        display_name: string | null;
        last_city: string | null;
        last_state: string | null;
        last_country: string | null;
        first_seen_on: string;
        last_seen_on: string;
        _latest: string;
      }
    >();
    for (const r of rows) {
      const u = r.buyer_username;
      if (!u) continue;
      const cur = agg.get(u) ?? {
        display_name: null, last_city: null, last_state: null,
        last_country: null, first_seen_on: r.occurred_on,
        last_seen_on: r.occurred_on, _latest: "",
      };
      cur.first_seen_on = r.occurred_on < cur.first_seen_on ? r.occurred_on : cur.first_seen_on;
      cur.last_seen_on = r.occurred_on > cur.last_seen_on ? r.occurred_on : cur.last_seen_on;
      if (r.occurred_on >= cur._latest) {
        cur._latest = r.occurred_on;
        cur.display_name = r.buyer_name ?? cur.display_name;
        cur.last_city = r.ship_to_city ?? cur.last_city;
        cur.last_state = r.ship_to_state ?? cur.last_state;
        cur.last_country = r.ship_to_country ?? cur.last_country;
      }
      agg.set(u, cur);
    }

    let buyerIds = new Map<string, number>();
    if (agg.size) {
      const usernames = [...agg.keys()];
      const { data: existingBuyers } = await supabase
        .from("buyers")
        .select("platform_username, first_seen_on, last_seen_on")
        .eq("platform", "ebay")
        .in("platform_username", usernames);
      const prev = new Map(
        (existingBuyers ?? []).map((b) => [b.platform_username, b]),
      );
      const payload = usernames.map((u) => {
        const a = agg.get(u)!;
        const p = prev.get(u);
        const first =
          p?.first_seen_on && p.first_seen_on < a.first_seen_on
            ? p.first_seen_on
            : a.first_seen_on;
        const last =
          p?.last_seen_on && p.last_seen_on > a.last_seen_on
            ? p.last_seen_on
            : a.last_seen_on;
        return {
          user_id: uid,
          platform: "ebay",
          platform_username: u,
          display_name: a.display_name,
          last_city: a.last_city,
          last_state: a.last_state,
          last_country: a.last_country,
          first_seen_on: first,
          last_seen_on: last,
        };
      });
      const { data: upserted, error } = await supabase
        .from("buyers")
        .upsert(payload, { onConflict: "user_id,platform,platform_username" })
        .select("id, platform_username");
      if (error) return { ok: false, error: `buyers: ${error.message}` };
      buyerIds = new Map((upserted ?? []).map((b) => [b.platform_username, b.id]));
    }

    // --- transactions: pre-filter existing source_refs, insert the rest ---
    const refs = rows.map((r) => r.source_ref).filter(Boolean) as string[];
    const { data: existing } = await supabase
      .from("transactions")
      .select("source_ref")
      .eq("platform", "ebay")
      .in("source_ref", refs.length ? refs : ["__none__"]);
    const have = new Set((existing ?? []).map((e) => e.source_ref));
    const fresh = rows.filter((r) => !r.source_ref || !have.has(r.source_ref));

    let inserted = 0;
    if (fresh.length) {
      const payload = fresh.map((r) => {
        const row: Record<string, unknown> = { user_id: uid };
        for (const c of TXN_INSERT_COLS) row[c] = (r as unknown as Record<string, unknown>)[c];
        row.buyer_id = r.buyer_username ? (buyerIds.get(r.buyer_username) ?? null) : null;
        row.ship_to_name = r.buyer_name;
        row.ship_to_city = r.ship_to_city;
        row.ship_to_state = r.ship_to_state;
        row.ship_to_zip = r.ship_to_zip;
        row.ship_to_country = r.ship_to_country;
        return row;
      });
      const { data, error } = await supabase
        .from("transactions")
        .insert(payload)
        .select("id");
      if (error) return { ok: false, error: `transactions: ${error.message}` };
      inserted = data?.length ?? 0;
    }

    // --- orphan shipping labels ---
    const orphansApplied: string[] = [];
    const orphansUnresolved: string[] = [];
    for (const o of orphanLabels) {
      const marker = `[orphan-label ${o.order_ref}]`;
      const { data: targets } = await supabase
        .from("transactions")
        .select("id, item_amount, shipping_cost, notes, tracking_number, shipping_service")
        .eq("order_ref", o.order_ref)
        .in("type", ["sale", "refund"]);
      const pending = (targets ?? []).filter(
        (t) => !(t.notes ?? "").includes(marker),
      );
      if (!targets || targets.length === 0) {
        orphansUnresolved.push(o.order_ref);
        continue;
      }
      if (pending.length === 0) continue; // already applied
      const total =
        pending.reduce((s, t) => s + Number(t.item_amount), 0) || pending.length;
      for (const t of pending) {
        const share = total ? Number(t.item_amount) / total : 1 / pending.length;
        const portion = Math.round(o.amount * share * 100) / 100;
        const { error } = await supabase
          .from("transactions")
          .update({
            shipping_cost: Number(t.shipping_cost) + portion,
            tracking_number: t.tracking_number ?? o.tracking_number,
            shipping_service: t.shipping_service ?? o.shipping_service,
            notes: [t.notes, marker].filter(Boolean).join(" "),
          })
          .eq("id", t.id);
        if (error) return { ok: false, error: `orphan label: ${error.message}` };
      }
      orphansApplied.push(o.order_ref);
    }

    // --- close tracked cards by SKU ---
    let cardsClosed = 0;
    for (const r of rows) {
      if (!r.custom_label || !r.source_ref || r.type !== "sale") continue;
      const { data: t } = await supabase
        .from("transactions")
        .select("id, occurred_on")
        .eq("platform", "ebay")
        .eq("source_ref", r.source_ref)
        .maybeSingle();
      if (!t) continue;
      const { data: closed } = await supabase
        .from("cards")
        .update({
          status: "sold",
          sale_transaction_id: t.id,
          sold_on: t.occurred_on,
        })
        .eq("sku", r.custom_label)
        .neq("status", "sold")
        .select("id");
      cardsClosed += closed?.length ?? 0;
    }

    return {
      ok: true,
      buyersUpserted: buyerIds.size,
      inserted,
      alreadyPresent: rows.length - fresh.length,
      orphansApplied,
      orphansUnresolved,
      cardsClosed,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
