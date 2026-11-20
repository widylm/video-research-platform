import type { BulkPlatform, ProviderVideo } from "../bulk-search.ts";
import { parseVideoLink } from "../public-video-url.ts";

type RecordData = Record<string, unknown>;
const record = (value: unknown): RecordData | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordData : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function text(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  return value.replaceAll("\0", "").trim().slice(0, max).replace(/[\uD800-\uDBFF]$/u, "").trim() || null;
}

function count(...values: unknown[]): number | null {
  for (const value of values) {
    const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
    if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) return number === 0 ? 0 : number;
  }
  return null;
}

function publicationTime(...values: unknown[]) {
  for (const value of values) {
    const seconds = count(value);
    if (seconds !== null && seconds > 0 && seconds < 4_102_444_800) return new Date(seconds * 1_000).toISOString();
  }
  return null;
}

function videoId(value: unknown, pattern: RegExp) {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === "string" && pattern.test(id) ? id : null;
}

function username(value: unknown, max: number) {
  return typeof value === "string" && value.length <= max && /^[\w.]+$/.test(value) ? value : null;
}

function videoLink(value: unknown, platform: BulkPlatform) {
  const link = typeof value === "string" ? parseVideoLink(value) : null;
  if (link?.kind !== "video" || link.video.platform !== platform) return null;
  if (platform === "instagram" && !link.video.url.startsWith("https://www.instagram.com/reel/")) return null;
  return link.video;
}

function hashtags(description: string | null, sources: { value: unknown; field?: string }[]) {
  if (description === null && !sources.some(({ value }) => Array.isArray(value))) return null;
  const tags = new Set<string>();
  const addTag = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const tag = raw.trim().replace(/^#/, "").normalize("NFC").toLowerCase();
    if (tag.length <= 128 && /^[\p{L}\p{M}\p{N}_]+$/u.test(tag)) tags.add(tag);
  };
  for (const { value, field } of sources) {
    for (const entry of array(value).slice(0, 100)) {
      addTag(field ? record(entry)?.[field] : entry);
    }
  }
  for (const match of (description ?? "").matchAll(/#([\p{L}\p{M}\p{N}_]{1,128})(?![\p{L}\p{M}\p{N}_])/gu)) {
    addTag(match[1]);
  }
  return [...tags].slice(0, 100);
}

function tiktokMetadata(row: RecordData): ProviderVideo | null {
  if (row.imagePost || row.image_post_info) return null;
  const suppliedUrl = row.url ?? row.share_url;
  const link = videoLink(suppliedUrl, "tiktok");
  if (suppliedUrl != null && !link) return null;
  if (!link && !record(row.video) && !record(row.videoInfo)) return null;

  const rawId = row.id ?? row.aweme_id;
  const externalId = rawId == null ? link?.externalId : videoId(rawId, /^\d{8,25}$/);
  if (!externalId || (link && externalId !== link.externalId)) return null;

  const account = record(row.author);
  const author = link?.author ?? username(account?.uniqueId ?? account?.unique_id ?? row.author, 64);
  const description = text(row.desc ?? row.video_description, 5_000);
  const title = text(row.originalTitle ?? row.video_title, 300);
  // Fashion Radar also used `title` for the caption in its lossy exports.
  const separateTitle = description !== null && text(row.title, 5_000) !== description ? text(row.title, 300) : null;
  const stats = [record(row.statsV2), record(row.stats), record(row.statistics), row];
  return {
    externalId,
    url: link?.url ?? (author ? `https://www.tiktok.com/@${author}/video/${externalId}` : null),
    originalTitle: title ?? separateTitle,
    originalDescription: description,
    author,
    publishedAt: publicationTime(row.createTime, row.create_time),
    views: count(...stats.flatMap((value) => [value?.playCount, value?.play_count, value?.view_count])),
    likes: count(...stats.flatMap((value) => [value?.diggCount, value?.digg_count, value?.like_count])),
    comments: count(...stats.flatMap((value) => [value?.commentCount, value?.comment_count])),
    hashtags: hashtags(description, [
      { value: row.challenges, field: "title" }, { value: row.textExtra, field: "hashtagName" }, { value: row.hashtags },
    ]),
  };
}

function instagramMetadata(row: RecordData): ProviderVideo | null {
  if ((row.media_type != null && row.media_type !== 2) || row.is_video === false
    || row.__typename === "GraphImage" || row.__typename === "GraphSidecar") return null;
  const suppliedUrl = row.url ?? row.permalink;
  const link = videoLink(suppliedUrl, "instagram");
  if (suppliedUrl != null && !link) return null;
  const isVideo = row.media_type === 2 || row.is_video === true || row.__typename === "GraphVideo"
    || array(row.video_versions).length > 0;
  const isReel = row.product_type === "clips" || row.media_product_type === "REELS";
  if (!link && !isVideo && !isReel) return null;

  const shortcode = row.code ?? row.shortcode;
  const externalId = shortcode == null ? link?.externalId : typeof shortcode === "string"
    ? videoId(shortcode, /^[\w-]{1,64}$/) : null;
  if (!externalId || (link && externalId !== link.externalId)) return null;

  const captionEdge = record(array(record(row.edge_media_to_caption)?.edges)[0]);
  const description = text(record(row.caption)?.text ?? (typeof row.caption === "string" ? row.caption : null)
    ?? record(captionEdge?.node)?.text, 5_000);
  const title = text(row.originalTitle ?? row.video_title, 300);
  const hidden = row.like_and_view_counts_disabled === true;
  return {
    externalId,
    url: link?.url ?? (isReel ? `https://www.instagram.com/reel/${externalId}/` : null),
    originalTitle: title,
    originalDescription: description,
    author: username(record(row.owner)?.username ?? record(row.user)?.username ?? row.username, 30),
    publishedAt: publicationTime(row.taken_at, row.taken_at_timestamp),
    views: hidden ? null : count(row.video_view_count, record(row.view_count)?.count, row.view_count),
    likes: hidden ? null : count(row.like_count, record(row.edge_media_preview_like)?.count, record(row.edge_liked_by)?.count),
    comments: count(row.comment_count, row.comments_count, record(row.edge_media_to_comment)?.count,
      record(row.edge_media_to_parent_comment)?.count),
    hashtags: hashtags(description, [{ value: row.hashtags }]),
  };
}

/** Converts one saved metadata record to the PR #9 provider contract. */
export function normalizeFashionRadarVideo(platform: BulkPlatform, input: unknown): ProviderVideo | null {
  const row = record(input);
  if (!row) return null;
  return platform === "tiktok" ? tiktokMetadata(row) : instagramMetadata(row);
}
