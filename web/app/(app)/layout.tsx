import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Sidebar from "@/components/Sidebar";

// The sidebar lives HERE, not in the root layout, so /login stays outside it.
// Putting nav in app/layout.tsx would wrap a signed-out user in chrome for a
// dashboard they can't see yet.
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
      <div className="pl-56">{children}</div>
    </div>
  );
}
