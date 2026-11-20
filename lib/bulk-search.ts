import { z } from "zod";
import { parseVideoLink } from "./public-video-url.ts";

export const bulkPlatforms = ["tiktok", "instagram"] as const;
export type BulkPlatform = (typeof bulkPlatforms)[number];
export const bulkResultLimit = 1_000;
export const bulkPageSize = 50;
export const bulkPageLimit = 40;
export const bulkPilotBudgetMicros = 0;

const utcDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bulkFiltersSchema = z.object({
  publishedFrom: utcDate.optional(),
  publishedTo: utcDate.optional(),
  minViews: nonnegativeInteger.optional(),
  minLikes: nonnegativeInteger.optional(),
}).refine(({ publishedFrom, publishedTo }) => !publishedFrom || !publishedTo || publishedFrom <= publishedTo, {
  path: ["publishedTo"],
  message: "The end of the publication window must be on or after its start.",
});

export const bulkQuerySchema = z.object({
  keywords: z.string().trim().min(1).max(120),
  platform: z.enum(["all", ...bulkPlatforms]),
  limit: z.number().int().min(1).max(bulkResultLimit),
  filters: bulkFiltersSchema.optional(),
});
export type BulkQuery = z.infer<typeof bulkQuerySchema>;

const optional = <T extends z.ZodType>(schema: T) => schema.nullish().transform((value) => value ?? null);
const optionalText = (max: number) => optional(z.string().trim().max(max).transform((value) => value || null));
const count = optional(nonnegativeInteger);
const sourceId = z.string().min(1).max(64).regex(/^[a-z0-9:_-]+$/);
const videoFields = z.object({
  externalId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  url: optional(z.string().max(2_048)),
  originalTitle: optionalText(300),
  originalDescription: optionalText(5_000),
  author: optionalText(128),
  publishedAt: optional(utcDate),
  views: count,
  likes: count,
  comments: count,
  hashtags: optional(z.array(z.string().trim().min(1).max(128)).max(100)),
});

export type ProviderVideo = z.input<typeof videoFields>;
const resultSchema = videoFields.extend({
  platform: z.enum(bulkPlatforms),
  source: sourceId,
  fetchedAt: utcDate,
});
export type BulkVideo = Readonly<z.output<typeof resultSchema>>;

function normalizeVideo(row: z.output<typeof resultSchema>): BulkVideo | null {
  if (row.platform === "tiktok" && !/^\d{8,25}$/.test(row.externalId)) return null;

  const link = row.url ? parseVideoLink(row.url) : null;
  const url = link?.kind === "video" && link.video.platform === row.platform && link.video.externalId === row.externalId
    && (row.platform === "tiktok" || link.video.url.startsWith("https://www.instagram.com/reel/"))
    ? link.video.url : null;
  return { ...row, url };
}

export const bulkVideoSchema = resultSchema.transform(normalizeVideo).pipe(z.custom<BulkVideo>((value) => value !== null));

export function bulkVideoKey(video: Pick<BulkVideo, "platform" | "externalId">) {
  return `${video.platform}:${video.externalId}`;
}

function matchesFilters(video: BulkVideo, filters: BulkQuery["filters"]) {
  if (!filters) return true;
  const { publishedFrom, publishedTo, minViews, minLikes } = filters;
  return (publishedFrom === undefined || (video.publishedAt !== null && video.publishedAt >= publishedFrom))
    && (publishedTo === undefined || (video.publishedAt !== null && video.publishedAt <= publishedTo))
    && (minViews === undefined || (video.views !== null && video.views >= minViews))
    && (minLikes === undefined || (video.likes !== null && video.likes >= minLikes));
}

export interface BulkSearchProvider {
  readonly id: string;
  readonly platform: BulkPlatform;
  readonly billing: "free" | "metered";
  // The quote includes any fixed and per-item charges. Units are integer millionths of USD.
  quotePageMicros(limit: number): number;
  // A provider must enforce this cap at the source before making a billable request.
  fetchPage(input: Readonly<{ keywords: string; cursor: string | null; limit: number; maxChargeMicros: number }>): Promise<
    { items: readonly ProviderVideo[]; nextCursor: string | null; chargedMicros: number }
  >;
}

const micros = nonnegativeInteger;
const pageSchema = z.object({
  items: z.array(z.unknown()).max(bulkPageSize),
  nextCursor: z.string().min(1).max(1_024).nullable(),
  chargedMicros: micros,
});
const stopReasons = ["exhausted", "result-limit", "page-limit", "budget-limit"] as const;
const jobMetadata = z.object({
  pagesScanned: z.number().int().min(0).max(bulkPageLimit),
  chargedMicros: micros,
  budgetMicros: micros,
  duplicates: z.number().int().min(0),
  rejected: z.number().int().min(0),
  stop: z.enum(stopReasons),
});
export type BulkSearchResult = z.infer<typeof jobMetadata> & { videos: BulkVideo[] };

export async function searchBulk(
  input: BulkQuery,
  providers: readonly BulkSearchProvider[],
  options: { budgetMicros: number; maxPages?: number },
): Promise<BulkSearchResult> {
  const query = bulkQuerySchema.parse(input);
  const budgetMicros = micros.parse(options.budgetMicros);
  const maxPages = z.number().int().min(1).max(bulkPageLimit).parse(options.maxPages ?? bulkPageLimit);
  const queue = providers.filter((provider) => query.platform === "all" || provider.platform === query.platform)
    .map((provider) => ({ provider, source: sourceId.parse(provider.id), cursor: null as string | null, seen: new Set<string>() }));
  const videos = new Map<string, BulkVideo>();
  let pagesScanned = 0;
  let chargedMicros = 0;
  let duplicates = 0;
  let rejected = 0;
  let budgetLimited = false;

  while (queue.length && videos.size < query.limit && pagesScanned < maxPages) {
    const job = queue.shift()!;
    const remaining = query.limit - videos.size;
    // Split the initial allowance so a small multi-platform search can sample each selected provider.
    const pendingStarts = queue.filter((entry) => entry.cursor === null).length;
    const limit = Math.min(bulkPageSize, job.cursor === null ? Math.ceil(remaining / (pendingStarts + 1)) : remaining);
    const quoted = micros.parse(job.provider.quotePageMicros(limit));
    if ((job.provider.billing === "metered" && budgetMicros === chargedMicros) || quoted > budgetMicros - chargedMicros) {
      budgetLimited = true;
      continue;
    }

    const page = pageSchema.parse(await job.provider.fetchPage({
      keywords: query.keywords, cursor: job.cursor, limit, maxChargeMicros: quoted,
    }));
    if (page.chargedMicros > quoted || page.items.length > limit) {
      throw new Error("Bulk search provider exceeded its page contract.");
    }
    pagesScanned += 1;
    chargedMicros += page.chargedMicros;
    const fetchedAt = new Date().toISOString();
    for (const row of page.items) {
      const parsed = videoFields.safeParse(row);
      const video = parsed.success ? normalizeVideo({
        ...parsed.data, platform: job.provider.platform, source: job.source, fetchedAt,
      }) : null;
      if (!video) {
        rejected += 1;
        continue;
      }
      if (!matchesFilters(video, query.filters)) continue;

      const key = bulkVideoKey(video);
      if (videos.has(key)) duplicates += 1;
      else videos.set(key, video);
    }

    if (page.nextCursor !== null) {
      if (job.seen.has(page.nextCursor)) throw new Error("Bulk search provider repeated a cursor.");
      job.seen.add(page.nextCursor);
      job.cursor = page.nextCursor;
      queue.push(job);
    }
  }

  const stop = videos.size === query.limit ? "result-limit"
    : queue.length && pagesScanned === maxPages ? "page-limit"
      : budgetLimited ? "budget-limit" : "exhausted";
  return { videos: Array.from(videos.values()), pagesScanned, chargedMicros, budgetMicros, duplicates, rejected, stop };
}

export const bulkStoredResultSchema = z.object({
  query: bulkQuerySchema,
  result: jobMetadata.extend({
    videos: z.array(bulkVideoSchema).max(bulkResultLimit),
  }),
});
