import "server-only";

import { platforms, sortVideos, type Platform, type SearchQuery, type Video } from "@/lib/videos";
import { mockVideos } from "./fixtures";

export interface VideoProvider {
  readonly platform: Platform;
  search(query: Readonly<Omit<SearchQuery, "platform">>): Promise<Video[]>;
}

const normalize = (value: string) => value.toLocaleLowerCase("ru");
const terms = (value: string) => normalize(value).split(/[\s,]+/).filter(Boolean);

class MockVideoProvider implements VideoProvider {
  constructor(readonly platform: Platform) {}

  async search(query: Readonly<Omit<SearchQuery, "platform">>): Promise<Video[]> {
    const keywords = terms(query.keywords);
    const hashtags = terms(query.hashtags).map((tag) => tag.replace(/^#/, "")).filter(Boolean);

    const matches = mockVideos.filter((video) => {
      const text = normalize([video.title, video.description, video.author, ...video.hashtags].join(" "));
      const date = video.publishedAt.slice(0, 10);

      return video.platform === this.platform
        && keywords.every((word) => text.includes(word))
        && hashtags.every((tag) => video.hashtags.includes(tag))
        && (!query.from || date >= query.from)
        && (!query.to || date <= query.to)
        && video.views >= query.minViews
        && video.likes >= query.minLikes;
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
