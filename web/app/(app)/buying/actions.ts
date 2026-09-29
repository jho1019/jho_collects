"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Adds one dated comp observation. Never overwrites: each entry is a new row
// (observed_on defaults to today), so the history stays. buying_targets picks
// up the latest comp and recomputes the target on the next render.
export async function addComp(
  buyingListId: number,
  price: number,
): Promise<{ error?: string }> {
  if (!Number.isFinite(price) || price <= 0 || price >= 100_000_000) {
    return { error: "Enter a price above $0." };
  }
  const supabase = await createClient();
  const { error } = await supabase.from("comps").insert({
    buying_list_id: buyingListId,
    price: Math.round(price * 100) / 100,
    source: "manual",
  });
  if (error) return { error: error.message };
  revalidatePath("/buying");
  return {};
}

export type CompHistoryRow = {
  id: number;
  price: number;
  source: string | null;
  observed_on: string;
};

// Full comp history for one item, newest first — nothing is ever overwritten,
// so this is every price ever entered, not just the latest.
export async function getCompHistory(buyingListId: number): Promise<CompHistoryRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("comps")
    .select("id, price, source, observed_on")
    .eq("buying_list_id", buyingListId)
    .order("observed_on", { ascending: false })
    .order("created_at", { ascending: false });
  return (data ?? []).map((r) => ({ ...r, price: Number(r.price) }));
}

// Edits the note on an existing row. Always with a WHERE — one row by id.
export async function updateBuyingListNotes(
  itemId: number,
  notes: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("buying_list")
    .update({ notes: notes.trim() === "" ? null : notes.trim() })
    .eq("id", itemId);
  if (error) return { error: error.message };
  revalidatePath("/buying");
  return {};
}

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function str(fd: FormData, key: string): string | null {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function num(fd: FormData, key: string): number | null {
  const v = str(fd, key);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Adds a buying-list row from the "Add card" modal, with an optional image
// (dragged or pasted in). The image is uploaded under the caller's own
// storage folder — no service-role key involved, same RLS as everything
// else the browser writes.
export async function addBuyingListItem(
  formData: FormData,
): Promise<{ error?: string }> {
  const title = str(formData, "title");
  if (!title) return { error: "Title is required." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: row, error } = await supabase
    .from("buying_list")
    .insert({
      title,
      player: str(formData, "player"),
      year: num(formData, "year"),
      set_name: str(formData, "set_name"),
      card_number: str(formData, "card_number"),
      parallel: str(formData, "parallel"),
      grader: str(formData, "grader"),
      grade_min: num(formData, "grade_min"),
      purpose: str(formData, "purpose") ?? "pc",
      max_price: num(formData, "max_price"),
      search_url: str(formData, "search_url"),
      priority: num(formData, "priority"),
      notes: str(formData, "notes"),
    })
    .select("id")
    .single();
  if (error || !row) return { error: error?.message ?? "Insert failed." };

  const image = formData.get("image");
  if (image instanceof File && image.size > 0) {
    const ext = IMAGE_TYPES[image.type];
    if (!ext) {
      return { error: "Card added, but that image type isn't supported (use JPEG, PNG, WEBP or GIF)." };
    }
    const path = `${user.id}/buying/${row.id}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("card-images")
      .upload(path, image, { contentType: image.type, upsert: true });
    if (uploadError) {
      return { error: `Card added, but the image failed to upload: ${uploadError.message}` };
    }
    await supabase.from("buying_list").update({ image_path: path }).eq("id", row.id);
  }

  revalidatePath("/buying");
  return {};
}
