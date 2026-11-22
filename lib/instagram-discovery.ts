import type { BulkVideo } from "./bulk-search.ts";
import { parseVideoLink } from "./public-video-url.ts";

type Environment = Record<string, string | undefined>;
type DiscoveryConfig = { accountId: string; token: string; accounts: string[] };
const usernamePattern = /^[a-z0-9_.]{1,30}$/;
const pageSize = 25;
const cacheMs = 5 * 60_000;

export function instagramDiscoveryConfig(env: Environment): DiscoveryConfig | null {
  const accountId = env.KADR_INSTAGRAM_ACCOUNT_ID?.trim() ?? "";
  const token = env.KADR_INSTAGRAM_TOKEN?.trim() ?? "";
  const accounts = Array.from(new Set((env.KADR_INSTAGRAM_ACCOUNTS ?? "").split(",")
    .map((account) => account.trim().replace(/^@/, "").toLowerCase()).filter(Boolean)));
  if (!/^\d{10,25}$/.test(accountId) || !token || accounts.length < 1 ||
      accounts.length > 5 || !accounts.every((account) => usernamePattern.test(account))) return null;
  return { accountId, token, accounts };
}

export function normalizeHashtag(value: string): string | null {
  const hashtag = value.trim().normalize("NFC").replace(/^#/, "").toLowerCase();
  return /^[\p{L}\p{M}\p{N}_]{1,80}$/u.test(hashtag) ? hashtag : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeVideo(value: unknown, account: string, fetchedAt: string): BulkVideo | null {
  const row = record(value);
  if (row?.media_type !== "VIDEO" || typeof row.permalink !== "string") return null;
  const link = parseVideoLink(row.permalink);
  if (link?.kind !== "video" || link.video.platform !== "instagram" ||
      !link.video.url.startsWith("https://www.instagram.com/reel/")) return null;
  const description = typeof row.caption === "string" ? row.caption.trim().slice(0, 5000) : "";
  const date = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  const hashtags = Array.from(new Set([...description.matchAll(/#([\p{L}\p{M}\p{N}_]+)/gu)]
    .map((match) => normalizeHashtag(match[1])).filter((tag): tag is string => tag !== null))).slice(0, 100);
  return {
    platform: "instagram", source: "instagram_business_discovery", externalId: link.video.externalId,
    url: link.video.url, author: account, originalTitle: description.split("\n")[0].slice(0, 150) || null,
    originalDescription: description || null, publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
    views: count(row.view_count), likes: count(row.like_count), comments: count(row.comments_count),
    hashtags: hashtags.length ? hashtags : null, fetchedAt,
  };
}

type Sample = { videos: BulkVideo[]; failedAccounts: number; rateLimited: boolean };
type AccountResult = { videos: BulkVideo[]; failed: boolean; rateLimited: boolean };
let cached: { key: string; until: number; sample: Promise<Sample> } | undefined;

async function readAccount(config: DiscoveryConfig, account: string, fetchedAt: string): Promise<AccountResult> {
  const url = new URL(`https://graph.facebook.com/v27.0/${config.accountId}`);
  url.searchParams.set("fields", `business_discovery.username(${account}){media.limit(${pageSize}){permalink,media_type,caption,timestamp,view_count,like_count,comments_count}}`);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(7_000),
    });
    const data = record(await response.json().catch(() => null));
    const error = record(data?.error);
    const rateLimited = response.status === 429 || [4, 17, 32, 613, 80000].includes(Number(error?.code));
    const media = record(record(data?.business_discovery)?.media)?.data;
    if (!response.ok || !Array.isArray(media)) return { videos: [], failed: true, rateLimited };
    const videos = media.slice(0, pageSize).map((row) => normalizeVideo(row, account, fetchedAt));
    return { videos: videos.filter((video): video is BulkVideo => video !== null), failed: false, rateLimited: false };
  } catch {
    return { videos: [], failed: true, rateLimited: false };
  }
}

async function readSample(config: DiscoveryConfig): Promise<Sample> {
  const fetchedAt = new Date().toISOString();
  const videos = new Map<string, BulkVideo>();
  let failedAccounts = 0;
  for (const [index, account] of config.accounts.entries()) {
    const result = await readAccount(config, account, fetchedAt);
    if (result.rateLimited) return { videos: [...videos.values()], failedAccounts: config.accounts.length - index + failedAccounts, rateLimited: true };
    if (result.failed) failedAccounts += 1;
    for (const video of result.videos) videos.set(video.externalId, video);
  }
  return { videos: [...videos.values()], failedAccounts, rateLimited: false };
}

export async function discoverInstagram(config: DiscoveryConfig, hashtag: string, days: number, minViews: number, minLikes: number) {
  const key = JSON.stringify(config);
  const now = Date.now();
  if (!cached || cached.key !== key || cached.until <= now) {
    cached = { key, until: now + cacheMs, sample: readSample(config) };
  }
  const sample = await cached.sample;
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  const videos = sample.videos.filter((video) => video.hashtags?.includes(hashtag) &&
    (!days || (video.publishedAt !== null && video.publishedAt >= cutoff && video.publishedAt <= new Date(now).toISOString())) &&
    (!minViews || (video.views !== null && video.views >= minViews)) &&
    (!minLikes || (video.likes !== null && video.likes >= minLikes)));
  videos.sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || (b.likes ?? -1) - (a.likes ?? -1) ||
    (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return { videos, checked: sample.videos.length, accountCount: config.accounts.length,
    failedAccounts: sample.failedAccounts, rateLimited: sample.rateLimited };
}
