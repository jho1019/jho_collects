-- 020_buying_list_image_write.sql — let the owner upload their own card
-- images from the browser, under their own session (no service-role key).
--
-- 019 only granted SELECT on storage.objects. The new "Add card" modal
-- uploads client-triggered, server-executed, so it needs INSERT/UPDATE too,
-- scoped the same way: only inside the caller's own <user_id>/ folder.

create policy own_card_images_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy own_card_images_update on storage.objects
  for update to authenticated
  using (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text);
