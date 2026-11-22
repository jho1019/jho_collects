import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server-side Supabase client, bound to the request's auth cookies. Uses the
// publishable (anon) key only — RLS is the access model in every environment.
// The dashboard never uses the service key. The one exception is the machine-
// facing /api/ebay/* routes (lib/supabase/admin.ts); see docs/DECISIONS.md,
// "The service-role key exists only for /api/ebay/*".
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — the proxy refreshes the
            // session, so this is safe to ignore.
          }
        },
      },
    },
  );
}
