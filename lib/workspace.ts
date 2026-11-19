import "server-only";

import type { Collection, Library, LibraryCommand } from "@/lib/library";
import { currentProfile, serverSupabase, type Profile, type Supabase } from "@/lib/supabase";
import { searchTerms, tagTerms } from "@/lib/video-entry";
import type { SearchQuery, Video } from "@/lib/videos";

export async function workspace() {
  const supabase = await serverSupabase();
  if (!supabase) return { mode: "demo" } as const;
  const profile = await currentProfile(supabase);
  if (!profile) return { mode: "locked" } as const;
  return { mode: "team", supabase, profile } as const;
}

const videoColumns = "id, platform, external_id, url, author, title, description, hashtags, published_at, views, likes, cover, is_mock";
type VideoRow = Omit<Video, "externalId" | "publishedAt" | "isMock"> & {
  external_id: string;
  published_at: string | null;
  is_mock: boolean;
};
type VideoLink = { video_id: string; videos: VideoRow | null };
type CollectionRow = {
  id: string;
  owner_id: string;
  name: string;
  shared: boolean;
  collection_videos: VideoLink[];
};

export function toVideo({ external_id, published_at, is_mock, ...video }: VideoRow): Video {
  return { ...video, externalId: external_id, publishedAt: published_at, isMock: is_mock };
}

export async function searchCatalog(supabase: Supabase, query: SearchQuery): Promise<Video[]> {
  const { data, error } = await supabase.rpc("search_saved_videos", {
    p_platform: query.platform === "all" ? null : query.platform,
    p_keywords: searchTerms(query.keywords),
    p_hashtags: tagTerms(query.hashtags),
    p_from: query.from || null,
    p_to: query.to || null,
    p_min_views: query.minViews,
    p_min_likes: query.minLikes,
    p_sort: query.sort,
    p_limit: query.limit,
  }).select(videoColumns).returns<VideoRow[]>();
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error("Unexpected catalog response.");
  return data.map(toVideo);
}

export type SavedVideoRow = { video: VideoRow; created: boolean };

export async function readLibrary(supabase: Supabase): Promise<Library> {
  const [favorites, collections] = await Promise.all([
    supabase.from("favorites").select(`video_id, videos(${videoColumns})`)
      .order("created_at", { ascending: false }).returns<VideoLink[]>(),
    supabase.from("collections")
      .select(`id, owner_id, name, shared, collection_videos(video_id, videos(${videoColumns}))`)
      .order("created_at", { ascending: false }).returns<CollectionRow[]>(),
  ]);

  if (favorites.error) throw favorites.error;
  if (collections.error) throw collections.error;

  const videos: Record<string, Video> = {};
  function ids(links: VideoLink[]) {
    return links.flatMap(({ video_id, videos: row }) => {
      if (!row) return [];
      videos[video_id] = toVideo(row);
      return [video_id];
    });
  }

  const favoriteIds = ids(favorites.data);
  const collectionList: Collection[] = collections.data.map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    shared: row.shared,
    videoIds: ids(row.collection_videos),
  }));

  return { favorites: favoriteIds, collections: collectionList, videos };
}

export async function changeLibrary(
  supabase: Supabase,
  profile: Profile,
  command: LibraryCommand,
) {
  if (command.kind === "favorite") {
    const { error } = command.saved
      ? await supabase.from("favorites").upsert({ video_id: command.videoId }, { ignoreDuplicates: true })
      : await supabase.from("favorites").delete().eq("video_id", command.videoId);
    if (error) throw error;
    return;
  }

  if (profile.role === "viewer") throw new Error("Collection editing is unavailable for viewers.");

  if (command.kind === "create") {
    const { error } = await supabase.from("collections")
      .insert({ name: command.name, shared: command.shared });
    if (error) throw error;
    return;
  }

  if (command.kind === "delete") {
    const { data, error } = await supabase.from("collections").delete()
      .eq("id", command.collectionId).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Collection unavailable.");
    return;
  }

  const { error } = command.saved
    ? await supabase.from("collection_videos").upsert({
      collection_id: command.collectionId, video_id: command.videoId,
    }, { ignoreDuplicates: true })
    : await supabase.from("collection_videos").delete()
      .eq("collection_id", command.collectionId).eq("video_id", command.videoId);

  if (error) throw error;
}
