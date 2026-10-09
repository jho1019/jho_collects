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
    <div className="min-h-screen bg-page">
      <Sidebar dealsNeedingReview={count ?? 0} logout={logout} />
      <div className="flex min-h-screen flex-col md:pl-56">
        {/* Sign-out lives in Sidebar's own drawer/rail below md — this bar
            would otherwise double up with its sticky mobile top bar. */}
        <header className="hidden items-center justify-end border-b border-on-page/20 px-6 py-3 md:flex">
          <form action={logout}>
            <button
              type="submit"
              className="rounded border border-on-page/40 px-3 py-1.5 text-sm text-on-page hover:bg-on-page/10"
            >
              Sign out
            </button>
          </form>
        </header>
        <div className="flex flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}
