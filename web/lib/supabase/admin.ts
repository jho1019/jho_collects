import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ConfigError } from "@/lib/ebay-api/errors";

// Service-role Supabase client. BYPASSES RLS. Server-only by construction:
// `server-only` makes any client-component import a build error, and the key
// has no NEXT_PUBLIC_ prefix so Next never inlines it into a browser bundle.
//
// Used only by the /api/ebay/* route handlers, whose tables (schema/024) are
// RLS-locked with no policies — there is no signed-in user on a machine
// request, so the anon key would see nothing. The dashboard still uses the
// anon key everywhere (docs/DECISIONS.md, "Dashboard: local now, Vercel
// later"); do not reach for this client from a page.

let cached: SupabaseClient | null = null;

export function createAdminClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    !url && "NEXT_PUBLIC_SUPABASE_URL",
    !key && "SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean);
  if (missing.length) throw new ConfigError("Supabase admin client is not configured", { missing_env: missing });
  cached = createClient(url!, key!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return cached;
}
