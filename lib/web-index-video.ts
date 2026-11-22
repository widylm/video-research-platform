import { z } from "zod";
import { parseVideoLink } from "./public-video-url.ts";

// A keyless, read-only index search, not an Instagram/TikTok API.
// Only canonical original video links are returned. No metrics are fabricated.
export const webIndexQuerySchema = z.object({
  keywords: z.string().trim().min(2).max(120),
  platform: z.enum(["all", "tiktok", "instagram"]),
  limit: z.number().int().min(1).max(20),
}).strict();
export type WebIndexQuery = z.infer<typeof webIndexQuerySchema>;
export type WebIndexPlatform = "tiktok" | "instagram";
export interface IndexedVideo {
  platform: WebIndexPlatform;
  externalId: string;
  url: string;
  author: string | null;
  indexTitle: string | null;
  indexSnippet: string | null;
}
export interface WebIndexResult {
  videos: IndexedVideo[];
  failedPlatforms: WebIndexPlatform[];
  failures: WebIndexFailure[];
  source: "bing-rss";
}
type WebIndexErrorCode = "index_unavailable" | "index_rate_limited" | "index_invalid_feed" | "index_timeout";
export type WebIndexFailure = { platform: WebIndexPlatform; code: WebIndexErrorCode; httpStatus?: number };

export class WebIndexError extends Error {
  readonly code: WebIndexErrorCode;
  readonly httpStatus?: number;
  readonly failures: WebIndexFailure[];
  constructor(code: WebIndexErrorCode, httpStatus?: number, failures: WebIndexFailure[] = []) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
    this.failures = failures;
  }
}

const feeds: Record<WebIndexPlatform, string> = {
  tiktok: "site:tiktok.com \"/video/\"",
  instagram: "site:instagram.com/reel/",
};
const entryPattern = /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi;
const field = (xml: string, tag: string) => {
  const found = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(xml);
  if (!found) return null;
  const content = found[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
  return content.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (match, numeric: string | undefined, named: string | undefined) => {
    if (numeric) {
      const value = numeric.toLowerCase().startsWith("x") ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10);
      return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
        ? String.fromCodePoint(value) : "";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[(named ?? "").toLowerCase()] ?? match;
  }).trim();
};

export function buildIndexUrl(platform: WebIndexPlatform, keywords: string): string {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", `${feeds[platform]} ${keywords}`);
  url.searchParams.set("format", "rss");
  url.searchParams.set("count", "20");
  return url.toString();
}

export function parseIndexedVideos(rss: string, platform: WebIndexPlatform, limit: number): IndexedVideo[] {
  if (rss.length > 400_000 || !/<rss\b/i.test(rss) || !/<channel\b/i.test(rss)) {
    throw new WebIndexError("index_invalid_feed");
  }
  const deduped = new Map<string, IndexedVideo>();
  for (const match of rss.matchAll(entryPattern)) {
    const item = match[1];
    const url = field(item, "link");
    if (!url) continue;
    const link = parseVideoLink(url);
    if (link?.kind !== "video" || link.video.platform !== platform) continue;
    // A /p/ URL may be an image; only Instagram /reel/ URLs qualify.
    if (platform === "instagram" && !link.video.url.includes("/reel/")) continue;
    const { externalId, author } = link.video;
    const title = field(item, "title")?.replace(/<[^>]+>/g, "").slice(0, 120) ?? null;
    const snippet = field(item, "description")?.replace(/<[^>]+>/g, "").slice(0, 280) ?? null;
    deduped.set(externalId, {
      platform, externalId, url: link.video.url, author: author || null,
      indexTitle: title, indexSnippet: snippet,
    });
    if (deduped.size >= Math.max(1, Math.min(limit, 20))) break;
  }
  return [...deduped.values()];
}

async function searchOne(
  platform: WebIndexPlatform,
  keywords: string,
  limit: number,
  request: typeof fetch,
): Promise<IndexedVideo[]> {
  const signal = AbortSignal.timeout(8_000);
  let response: Response;
  try {
    response = await request(buildIndexUrl(platform, keywords), {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { Accept: "application/rss+xml, application/xml;q=0.9" },
      signal,
    });
  } catch {
    throw new WebIndexError(signal.aborted ? "index_timeout" : "index_unavailable");
  }
  if (response.status === 429) {
    void response.body?.cancel().catch(() => {});
    throw new WebIndexError("index_rate_limited", response.status);
  }
  if (!response.ok || Number(response.headers.get("content-length") ?? "0") > 400_000) {
    void response.body?.cancel().catch(() => {});
    throw new WebIndexError(response.ok ? "index_invalid_feed" : "index_unavailable", response.status);
  }
  try {
    return parseIndexedVideos(await response.text(), platform, limit);
  } catch (error) {
    throw new WebIndexError(error instanceof WebIndexError ? error.code
      : signal.aborted ? "index_timeout" : "index_unavailable", response.status);
  }
}

export async function searchWebIndex(
  input: unknown,
  request: typeof fetch = fetch,
): Promise<WebIndexResult> {
  const query = webIndexQuerySchema.parse(input);
  const platforms: WebIndexPlatform[] = query.platform === "all"
    ? ["tiktok", "instagram"] : [query.platform];
  const outcomes = await Promise.allSettled(platforms.map(platform =>
    searchOne(platform, query.keywords, query.limit, request)));
  const failures: WebIndexFailure[] = [];
  const videos = new Map<string, IndexedVideo>();
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      const error = outcome.reason instanceof WebIndexError ? outcome.reason : new WebIndexError("index_unavailable");
      failures.push({ platform: platforms[index], code: error.code, httpStatus: error.httpStatus });
      return;
    }
    for (const video of outcome.value) videos.set(`${video.platform}:${video.externalId}`, video);
  });
  if (failures.length === platforms.length) {
    const code = failures.find(failure => failure.code === "index_rate_limited")?.code ?? failures[0].code;
    throw new WebIndexError(code, undefined, failures);
  }
  return {
    videos: [...videos.values()].slice(0, query.limit),
    failedPlatforms: failures.map(failure => failure.platform),
    failures,
    source: "bing-rss",
  };
}
