"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Records whether the drop was actually bought and how many. Unchecking clears
// the quantity so the table's CHECK (quantity only when purchased) holds.
export async function setReleasePurchase(
  releaseId: number,
  purchased: boolean,
  quantity: number | null,
): Promise<{ error?: string }> {
  if (purchased && quantity != null && (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000)) {
    return { error: "Quantity must be a whole number of 1 or more." };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("releases")
    .update({
      purchased,
      quantity_purchased: purchased ? quantity : null,
    })
    .eq("id", releaseId);
  if (error) return { error: error.message };
  revalidatePath("/releases");
  return {};
}

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Uploads (or replaces) a release's product image under the caller's own
// storage folder — same bucket and RLS as buying-list images, no service key.
export async function uploadReleaseImage(
  releaseId: number,
  formData: FormData,
): Promise<{ error?: string }> {
  const image = formData.get("image");
  if (!(image instanceof File) || image.size === 0) return { error: "Choose an image." };
  const ext = IMAGE_TYPES[image.type];
  if (!ext) return { error: "Use a JPEG, PNG, WEBP or GIF." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: existing } = await supabase
    .from("releases")
    .select("image_path")
    .eq("id", releaseId)
    .single();
  if (!existing) return { error: "Release not found." };

  const path = `${user.id}/releases/${releaseId}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from("card-images")
    .upload(path, image, { contentType: image.type, upsert: true });
  if (uploadError) return { error: uploadError.message };

  const { error } = await supabase
    .from("releases")
    .update({ image_path: path })
    .eq("id", releaseId);
  if (error) return { error: error.message };

  // Replacing a .jpg with a .png leaves the old object orphaned; best-effort remove.
  if (existing.image_path && existing.image_path !== path) {
    await supabase.storage.from("card-images").remove([existing.image_path]);
  }

  revalidatePath("/releases");
  return {};
}
