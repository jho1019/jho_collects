import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/login/actions";
import AppShell from "@/components/AppShell";

// The shell lives HERE, not in the root layout, so /login stays outside it.
// Putting nav in app/layout.tsx would wrap a signed-out user in chrome for a
// dashboard they can't see yet.
//
// One shared top bar (Midnight Scoreboard, phase 1) carries the nav pills,
// theme toggle, Data and Sign out on every authenticated page; below 700px it
// becomes a bottom tab bar + More sheet. It replaced the left sidebar and the
// separate masthead/sign-out header.
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
    <AppShell dealsNeedingReview={count ?? 0} logout={logout}>
      {children}
    </AppShell>
  );
}
