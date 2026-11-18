import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { emptyLibrary } from "@/lib/library";
import { searchVideos } from "@/lib/providers";
import { defaultSearch } from "@/lib/videos";
import { readLibrary, workspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await workspace();
  if (session.mode === "locked") redirect("/login");

  const [videos, library] = await Promise.all([
    searchVideos(defaultSearch),
    session.mode === "team" ? readLibrary(session.supabase) : emptyLibrary,
  ]);

  return <Dashboard
    initialVideos={videos}
    initialLibrary={library}
    profile={session.mode === "team" ? session.profile : null}
  />;
}
