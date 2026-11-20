import { z } from "zod";
import { bulkImportSchema, type BulkImportBatch } from "../bulk-import.ts";
import { bulkResultLimit, bulkVideoKey, bulkVideoSchema, type BulkPlatform, type BulkVideo } from "../bulk-search.ts";
import { normalizeFashionRadarVideo } from "../providers/fashion-radar-metadata.ts";
import { parseVideoLink } from "../public-video-url.ts";

export const fashionRadarSources = {
  tiktok: "fashion-radar:tiktok",
  instagram: "fashion-radar:instagram",
} as const;
export const fashionRadarPath = "/api/integrations/fashion-radar";
export const fashionRadarBodyLimit = 512 * 1024;
export const fashionRadarDeviceToken = /^([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\.([A-Za-z\d_-]{43})$/;

export const fashionRadarReceiptSchema = z.strictObject({
  sent: z.number().int().min(0).max(bulkResultLimit),
  rejected: z.literal(0),
  duplicates: z.number().int().min(0).max(bulkResultLimit),
});

const timestamp = z.iso.datetime({ offset: true });
const localRow = z.object({
  id: z.string(), url: z.string(), platform: z.unknown().optional(), source: z.unknown().optional(),
  title: z.unknown().optional(), hashtags: z.unknown().optional(), published_at: timestamp.nullish().catch(null),
  views: z.unknown().optional(), likes: z.unknown().optional(), verified_video: z.unknown().optional(),
  inspection_url: z.unknown().optional(),
});
const localState = z.object({
  phase: z.enum(["done", "empty"]), items: z.array(z.unknown()).max(50),
  message: z.unknown().optional(), cancelled: z.unknown().optional(),
});
const localFile = z.union([localState, z.object({ state: localState }).transform(({ state }) => state)]);

function normalize(value: unknown, fetchedAt: string, platforms: readonly BulkPlatform[]): BulkVideo | null {
  const parsed = localRow.safeParse(value);
  if (!parsed.success) return null;
  const row = parsed.data;
  const link = parseVideoLink(row.url);
  if (link?.kind !== "video") return null;
  const { platform, externalId } = link.video;
  if (!platforms.includes(platform) || (row.platform != null && row.platform !== platform)) return null;
  const caption = typeof row.title === "string" ? row.title : null;
  let metadata;
  if (platform === "tiktok") {
    if (row.id !== externalId || (row.source !== "public-page-data" && row.source !== "visible-link")) return null;
    metadata = normalizeFashionRadarVideo(platform, row.source === "public-page-data" ? {
      url: row.url, desc: caption, hashtags: row.hashtags, play_count: row.views, digg_count: row.likes,
    } : { url: row.url });
  } else {
    // The old collector could infer /reel/ from a /p/ URL while inspecting a publication.
    if (row.id !== `ig_${externalId}` || row.verified_video !== true || row.inspection_url != null || row.source != null) return null;
    metadata = normalizeFashionRadarVideo(platform, { permalink: row.url, caption, like_count: row.likes });
  }
  if (!metadata?.url) return null;
  const result = bulkVideoSchema.safeParse({
    ...metadata, platform, source: fashionRadarSources[platform], fetchedAt,
    publishedAt: row.source === "visible-link" ? null : row.published_at,
  });
  return result.success ? result.data : null;
}

export function prepareFashionRadarBatch(input: unknown, fetchedAt: string, platforms: readonly BulkPlatform[]): {
  batch: BulkImportBatch | null; rejected: number; duplicates: number;
} | null {
  const parsed = localFile.safeParse(input);
  if (!parsed.success || (parsed.data.phase === "empty" && parsed.data.items.length > 0)
    || parsed.data.cancelled === true || (typeof parsed.data.message === "string" && parsed.data.message.startsWith("Остановлено."))
    || !timestamp.safeParse(fetchedAt).success) return null;

  const videos = new Map<string, BulkVideo>();
  let rejected = 0;
  let duplicates = 0;
  for (const row of parsed.data.items) {
    const video = normalize(row, fetchedAt, platforms);
    if (!video) rejected += 1;
    else if (videos.has(bulkVideoKey(video))) duplicates += 1;
    else videos.set(bulkVideoKey(video), video);
  }
  return { batch: videos.size ? bulkImportSchema.parse({ version: 1, videos: [...videos.values()] }) : null, rejected, duplicates };
}
