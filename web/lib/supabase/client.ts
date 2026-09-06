import { createBrowserClient } from "@supabase/ssr";

// Browser Supabase client. Publishable (anon) key only; safe to ship because
// RLS is enforced on every table and view.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
