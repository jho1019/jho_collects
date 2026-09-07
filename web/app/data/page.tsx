import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import DataIO from "@/components/DataIO";

export const dynamic = "force-dynamic";

export default async function DataPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return <DataIO />;
}
