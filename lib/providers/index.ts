import "server-only";

import { platforms, sortVideos, type Platform, type SearchQuery, type Video } from "@/lib/videos";
import { searchTerms, tagTerms } from "@/lib/video-entry";
import { mockVideos } from "./fixtures";

export interface VideoProvider {
  readonly platform: Platform;
  search(query: Readonly<Omit<SearchQuery, "platform">>): Promise<Video[]>;
}

class MockVideoProvider implements VideoProvider {
  constructor(readonly platform: Platform) {}

  async search(query: Readonly<Omit<SearchQuery, "platform">>): Promise<Video[]> {
    const keywords = searchTerms(query.keywords);
    const hashtags = tagTerms(query.hashtags);

    const matches = mockVideos.filter((video) => {
      const text = [video.title, video.description, video.author, ...video.hashtags].join(" ").toLocaleLowerCase("ru");
      const date = video.publishedAt?.slice(0, 10);

      return video.platform === this.platform
        && keywords.every((word) => text.includes(word))
        && hashtags.every((tag) => video.hashtags.includes(tag))
        && (!query.from || (date && date >= query.from))
        && (!query.to || (date && date <= query.to))
        && (query.minViews === null || (video.views !== null && video.views >= query.minViews))
        && (query.minLikes === null || (video.likes !== null && video.likes >= query.minLikes));
    });

    return sortVideos(matches, query.sort).slice(0, query.limit);
  }
}

const providers = Object.fromEntries(platforms.map((platform) => [
  platform, new MockVideoProvider(platform),
])) as Record<Platform, VideoProvider>;

export async function searchVideos(query: SearchQuery): Promise<Video[]> {
  const selected = query.platform === "all" ? platforms : [query.platform];
  const results = await Promise.all(selected.map((platform) => providers[platform].search(query)));
  return sortVideos(results.flat(), query.sort).slice(0, query.limit);
}
