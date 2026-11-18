import { z } from "zod";

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
  publishedAt: string;
  views: number;
  likes: number;
  cover: string;
  isMock: boolean;
}

export const sortOptions = {
  recent: "Сначала новые",
  views: "По просмотрам",
  likes: "По отметкам «Нравится»",
} as const;
export type Sort = keyof typeof sortOptions;

const publicationDate = z.union([z.literal(""), z.iso.date()]);
export const searchSchema = z.object({
  platform: z.enum(["all", ...platforms]),
  keywords: z.string().trim().max(200),
  hashtags: z.string().trim().max(200),
  from: publicationDate,
  to: publicationDate,
  limit: z.number().int().min(1).max(100),
  minViews: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  minLikes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
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
  minViews: 0,
  minLikes: 0,
  sort: "recent",
};

export function sortVideos(videos: Video[], sort: Sort): Video[] {
  return [...videos].sort((a, b) => {
    const metric = sort === "views" ? b.views - a.views : sort === "likes" ? b.likes - a.likes : 0;
    return metric || b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id);
  });
}

export function officialEmbed(video: Pick<Video, "platform" | "url" | "isMock">): string | null {
  if (video.isMock || !video.url) return null;

  let url: URL;
  try {
    url = new URL(video.url);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  const host = url.hostname;
  if (video.platform === "tiktok" && ["www.tiktok.com", "tiktok.com"].includes(host)) {
    const match = /^\/@[\w.]+\/video\/(\d{8,25})\/?$/.exec(url.pathname);
    return match ? `https://www.tiktok.com/player/v1/${match[1]}` : null;
  }

  if (video.platform === "instagram" && ["www.instagram.com", "instagram.com"].includes(host)) {
    const match = /^\/(p|reel|tv)\/([\w-]{1,64})\/?$/.exec(url.pathname);
    return match ? `https://www.instagram.com/${match[1]}/${match[2]}/embed/` : null;
  }

  return null;
}
