import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { cloudBrowserBinding } from "@/lib/cloud-browser-binding";
import { emptyLibrary } from "@/lib/library";
import { searchVideos } from "@/lib/providers";
import { defaultSearch } from "@/lib/videos";
import { readLibrary, searchCatalog, workspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await workspace();
  if (session.mode === "locked") redirect("/login");

  const [videos, library] = await Promise.all([
    session.mode === "team" ? searchCatalog(session.supabase, defaultSearch) : searchVideos(defaultSearch),
    session.mode === "team" ? readLibrary(session.supabase) : emptyLibrary,
  ]);

  return <Dashboard
    initialVideos={videos}
    initialLibrary={library}
    profile={session.mode === "team" ? session.profile : null}
    cloudBrowserSearch={session.mode === "team" && session.profile.role !== "viewer" && !!cloudBrowserBinding()}
  />;
}
