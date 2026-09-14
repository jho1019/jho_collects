import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/login/actions";
import Sidebar from "@/components/Sidebar";

// The sidebar lives HERE, not in the root layout, so /login stays outside it.
// Putting nav in app/layout.tsx would wrap a signed-out user in chrome for a
// dashboard they can't see yet.
//
// The masthead + sign-out button live here too, as of Phase 9. They used to
// be Home's own header, but Home is the calendar now and every other route
// still needs a way to sign out — one shared bar beats duplicating it, or
// worse, making sign-out reachable only from /ledger.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { count } = await supabase
    .from("deals")
    .select("id", { count: "exact", head: true })
    .eq("needs_review", true);

  return (
    <div className="min-h-full bg-page">
      <Sidebar dealsNeedingReview={count ?? 0} />
      <div className="pl-56">
        <header className="flex items-center justify-end border-b border-surface/20 px-6 py-3">
          <form action={logout}>
            <button
              type="submit"
              className="rounded border border-surface/40 px-3 py-1.5 text-sm text-surface hover:bg-surface/10"
            >
              Sign out
            </button>
          </form>
        </header>
        {children}
      </div>
    </div>
  );
}
