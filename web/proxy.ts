import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/session";

// Next 16 renamed the `middleware` convention to `proxy`. Same semantics.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // everything except Next internals and static assets
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
