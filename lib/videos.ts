import { z } from "zod";
import { parseVideoLink } from "@/lib/public-video-url";
import { optionalPublicationDate } from "@/lib/video-entry";

export const platforms = ["tiktok", "instagram"] as const;
export const platformNames = { tiktok: "TikTok", instagram: "Instagram" };
export type Platform = (typeof platforms)[number];

export interface Video {
  id: string;
  platform: Platform;
  externalId: string;
  url: string | null;
  author: string;
  title: string;
  description: string;
  hashtags: string[];
  publishedAt: string | null;
  views: number | null;
  likes: number | null;
  cover: string;
  isMock: boolean;
}

export interface VideoPreview {
  title?: string;
  authorName?: string;
  thumbnailUrl?: string;
}

export function platformVideoTitle(platform: Platform) {
  return platform === "tiktok" ? "Видео TikTok" : "Публикация Instagram";
}

export function videoLabel(video: Video, preview?: VideoPreview) {
  const fallback = platformVideoTitle(video.platform);
  const legacy = `Видео ${platformNames[video.platform]} · ${video.externalId}`;
  const manual = video.title === legacy || video.title === fallback ? "" : video.title.trim();
  const title = manual || preview?.title || video.description.split(/\r?\n/, 1)[0]?.trim() || fallback;
  const author = preview?.authorName || (video.author ? `@${video.author}` : "");
  return { title, author, editableTitle: manual || preview?.title?.slice(0, 120) || "" };
}

export const sortOptions = {
  recent: "Сначала новые",
  views: "По просмотрам",
  likes: "По отметкам «Нравится»",
} as const;
export type Sort = keyof typeof sortOptions;

const minimum = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
export const searchSchema = z.object({
  platform: z.enum(["all", ...platforms]),
  keywords: z.string().trim().max(200),
  hashtags: z.string().trim().max(200),
  from: optionalPublicationDate,
  to: optionalPublicationDate,
  limit: z.number().int().min(1).max(100),
  minViews: minimum,
  minLikes: minimum,
  sort: z.enum(["recent", "views", "likes"]),
}).refine(({ from, to }) => !from || !to || from <= to, {
  error: "Дата начала должна быть раньше даты окончания или совпадать с ней.",
  path: ["from"],
});

export type SearchQuery = z.infer<typeof searchSchema>;
export const defaultSearch: SearchQuery = {
  platform: "all",
  keywords: "",
  hashtags: "",
  from: "",
  to: "",
  limit: 24,
  minViews: null,
  minLikes: null,
  sort: "recent",
};

export function sortVideos(videos: Video[], sort: Sort): Video[] {
  return [...videos].sort((a, b) => {
    const metric = sort === "views" ? (b.views ?? -1) - (a.views ?? -1)
      : sort === "likes" ? (b.likes ?? -1) - (a.likes ?? -1) : 0;
    return metric || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || a.id.localeCompare(b.id);
  });
}

export function officialEmbed(video: Pick<Video, "platform" | "url" | "isMock">): string | null {
  if (video.isMock || !video.url) return null;
  const link = parseVideoLink(video.url);
  if (link?.kind !== "video" || link.video.platform !== video.platform) return null;

  return link.video.platform === "tiktok"
    ? `https://www.tiktok.com/player/v1/${link.video.externalId}`
    : `${link.video.url}embed/`;
}

export function officialCatalogFrame(video: Pick<Video, "platform" | "url" | "isMock">): string | null {
  if (video.platform !== "tiktok") return null;
  const src = officialEmbed(video);
  return src ? `${src}?autoplay=0&controls=0&rel=0` : null;
}
