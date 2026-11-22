import { bulkVideoSchema, type BulkVideo } from "../../lib/bulk-search.ts";
import { parseVideoLink } from "../../lib/public-video-url.ts";

// Third-party provider, not an official TikTok API.
// This pilot makes at most one billable 1-unit request; no pagination or author-stat add-ons.
const endpoint = "https://ensembledata.com/apis/tt/keyword/search";
export const ensemblePilotLimit = 10;

type Obj = Record<string, unknown>;
const record = (input: unknown): Obj | null => input !== null && typeof input === "object" && !Array.isArray(input) ? input as Obj : null;
const str = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const oneOf = (...values: unknown[]) => values.find(value => value !== undefined && value !== null);
const title = (value: unknown) => str(value)?.slice(0, 300) ?? null;
const description = (value: unknown) => str(value)?.slice(0, 5_000) ?? null;
function published(value: unknown): string | null {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1_000_000_000 || seconds > 4_102_444_800) return null;
  return new Date(seconds * 1000).toISOString();
}

export function parseEnsembleKeywordResponse(payload: unknown, limit = ensemblePilotLimit): BulkVideo[] {
  const outer = record(payload);
  const body = record(outer?.data);
  // Official guides show response.data.data; do not accept arbitrary generated records.
  const posts = body?.data;
  if (!Array.isArray(posts)) throw new Error("provider_invalid_response");
  const output = new Map<string, BulkVideo>();
  const fetchedAt = new Date().toISOString();
  for (const entry of posts.slice(0, 20)) {
    const post = record(record(entry)?.aweme_info ?? entry);
    if (!post) continue;
    const id = str(oneOf(post.aweme_id, post.id));
    if (!id || !/^\d{8,25}$/.test(id)) continue;
    const author = record(post.author);
    const name = str(oneOf(author?.unique_id, author?.uniqueId, author?.username));
    const explicit = str(oneOf(post.share_url, post.url));
    const link = explicit ? parseVideoLink(explicit) : null;
    const validated = link?.kind === "video" && link.video.platform === "tiktok" && link.video.externalId === id
      ? link.video.url : null;
    const safeName = name && /^[\w.]{1,64}$/.test(name) ? name : null;
    const url = validated ?? (safeName ? `https://www.tiktok.com/@${safeName}/video/${id}` : null);
    if (!url) continue;
    const stats = record(post.statistics) ?? {};
    const desc = description(post.desc);
    const video = bulkVideoSchema.safeParse({
      platform: "tiktok", source: "ensembledata_keyword", externalId: id, url, fetchedAt,
      author: safeName ?? (link?.kind === "video" ? link.video.author : null),
      originalTitle: title(desc), originalDescription: desc,
      publishedAt: published(oneOf(post.create_time, post.createTime)),
      views: count(oneOf(stats.play_count, stats.view_count)),
      likes: count(oneOf(stats.digg_count, stats.like_count)),
      comments: count(stats.comment_count),
      hashtags: null,
    });
    if (!video.success || !video.data.url) continue;
    output.set(id, video.data);
    if (output.size >= Math.max(1, Math.min(limit, ensemblePilotLimit))) break;
  }
  return [...output.values()];
}

export class EnsemblePilotError extends Error {
  constructor(readonly code: "provider_http_error" | "provider_invalid_response" | "provider_timeout") { super(code); }
}

export async function fetchEnsembleKeyword(
  token: string, keywords: string,
  request: typeof fetch = fetch,
): Promise<BulkVideo[]> {
  if (!token.trim() || !keywords.trim() || keywords.length > 120) throw new EnsemblePilotError("provider_invalid_response");
  const url = new URL(endpoint);
  url.searchParams.set("name", keywords.trim());
  url.searchParams.set("period", "180");
  url.searchParams.set("get_author_stats", "false");
  url.searchParams.set("token", token);
  let response: Response;
  try {
    response = await request(url.toString(), { method: "GET", headers: { Accept: "application/json" },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch { throw new EnsemblePilotError("provider_timeout"); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new EnsemblePilotError("provider_http_error");
  }
  if (Number(response.headers.get("content-length") ?? 0) > 1_000_000) {
    await response.body?.cancel();
    throw new EnsemblePilotError("provider_invalid_response");
  }
  let json: unknown;
  try {
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error("oversized");
    json = JSON.parse(text);
  } catch { throw new EnsemblePilotError("provider_invalid_response"); }
  try { return parseEnsembleKeywordResponse(json); }
  catch { throw new EnsemblePilotError("provider_invalid_response"); }
}
