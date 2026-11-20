import { createHmac } from "node:crypto";
import { z } from "zod";
import { bulkQuerySchema, searchBulk, type BulkQuery, type BulkSearchProvider } from "../bulk-search.ts";
import { normalizeFashionRadarVideo } from "./fashion-radar-metadata.ts";

const graphOrigin = "https://graph.facebook.com";
const graphVersion = "/v27.0";
const fields = "id,media_type,permalink,caption,timestamp,like_count,comments_count";
const maxVideos = 10;
const maxPages = 3;
const graphId = z.string().regex(/^[1-9]\d{0,29}$/);
const timestamp = z.iso.datetime({ offset: true });
const hashtagNode = z.object({ id: graphId });
const lookupResponse = z.union([
  z.object({ data: z.array(hashtagNode).max(1) }).transform(({ data }) => data[0]?.id),
  hashtagNode.transform(({ id }) => id),
]);
const mediaResponse = z.object({
  data: z.array(z.unknown()).max(maxVideos),
  paging: z.object({ next: z.string().max(8_192).optional() }).optional(),
});
const mediaFields = z.object({
  id: graphId,
  media_type: z.string(),
  permalink: z.unknown().optional(),
  caption: z.unknown().optional(),
  timestamp: z.unknown().optional(),
  like_count: z.unknown().optional(),
  comments_count: z.unknown().optional(),
});
const graphError = z.object({ error: z.object({ code: z.number().optional() }) });

type InstagramConfig = Readonly<{ userId?: string; accessToken?: string; appSecret?: string }>;

export class InstagramPilotError extends Error {}

function issue(message: string): never {
  throw new InstagramPilotError(message);
}

function apiError(status: number, code?: number): never {
  if (status === 429 || [4, 17, 32, 613].includes(code ?? 0) || (code && code >= 80_000 && code <= 80_099)) {
    issue("Meta ограничила запросы Instagram. Пилот остановлен. Проверьте квоту в Meta App Dashboard.");
  }
  if (status === 401 || code === 190 || code === 102) {
    issue("Meta отклонила токен Instagram. Проверьте срок действия Facebook User Access Token и приложение, которое его выдало.");
  }
  if (status === 403 || code === 10 || (code && code >= 200 && code < 300)) {
    issue("Для Instagram Hashtag Search нет доступа. Проверьте App Review, Instagram Public Content Access, instagram_basic и роль на Facebook Page.");
  }
  issue(`Instagram Graph API прервал поиск (HTTP ${status}${code === undefined ? "" : `, код ${code}`}). Проверьте состояние API и настройки приложения.`);
}

function extractAfter(next: string | undefined, path: string) {
  if (next === undefined) return null;
  if (!URL.canParse(next)) issue("Instagram Graph API вернул некорректный адрес следующей страницы.");
  const url = new URL(next);
  const [after, extra] = url.searchParams.getAll("after");
  if (url.origin !== graphOrigin || url.username || url.password
    || (url.pathname !== `${graphVersion}${path}` && url.pathname !== path)
    || !after || after.length > 2_048 || extra !== undefined) {
    issue("Instagram Graph API вернул некорректный адрес следующей страницы.");
  }
  // Rebuild the request locally. Meta's next URL can carry its own access_token or other credentials.
  return after;
}

function normalizeTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = timestamp.safeParse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return parsed.success ? new Date(parsed.data).toISOString() : null;
}

function createInstagramHashtagProvider(config: InstagramConfig, request: typeof fetch) {
  const parsedId = graphId.safeParse(config.userId?.trim());
  const token = config.accessToken?.trim();
  if (!parsedId.success || !token || !/^[!-~]+$/.test(token)) {
    issue("Источник Instagram не подключён. Задайте KADR_INSTAGRAM_USER_ID и KADR_INSTAGRAM_ACCESS_TOKEN в окружении терминала.");
  }
  const userId = parsedId.data;
  const appSecret = config.appSecret?.trim();
  const proof = appSecret ? createHmac("sha256", appSecret).update(token).digest("hex") : null;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const stats = { apiRequests: 0, apiMediaRows: 0, reelsWithPermalink: 0, repeatedPage: false };

  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${graphVersion}${path}`, graphOrigin);
    url.search = new URLSearchParams({ user_id: userId, ...params }).toString();
    if (proof) url.searchParams.set("appsecret_proof", proof);
    stats.apiRequests += 1;
    const response = await request(url, {
      method: "GET", headers, redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(5_000),
    }).catch(() => issue("Официальный Instagram Graph API недоступен. Запрос остановлен."));
    if ([401, 403, 429].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      apiError(response.status);
    }
    const body: unknown = await response.json().catch(() => response.ok
      ? issue("Instagram Graph API вернул нечитаемый ответ.") : apiError(response.status));
    const error = graphError.safeParse(body);
    if (!response.ok || error.success) apiError(response.status, error.data?.error.code);
    return body;
  }

  let hashtagId: string | undefined;
  let after: string | null = null;
  let pages = 0;
  const seenMedia = new Set<string>();
  const provider: BulkSearchProvider = {
    id: "instagram:hashtag-search", platform: "instagram", billing: "free",
    quotePageMicros: () => 0,
    async fetchPage({ keywords, cursor, limit, maxChargeMicros }) {
      if (limit < 1 || limit > maxVideos || pages >= maxPages || maxChargeMicros !== 0
        || cursor !== (pages === 0 ? null : String(pages)) || (pages > 0 && after === null)) {
        issue("Достигнут предел пилота Instagram.");
      }
      if (hashtagId === undefined) {
        const found = lookupResponse.safeParse(await get("/ig_hashtag_search", { q: keywords.slice(1) }));
        if (!found.success) issue("Instagram Graph API вернул некорректный ответ для хэштега.");
        hashtagId = found.data;
        if (hashtagId === undefined) return { items: [], nextCursor: null, chargedMicros: 0 };
      }
      const path = `/${hashtagId}/recent_media`;
      const page = mediaResponse.safeParse(await get(path, { fields, limit: String(limit), ...(after ? { after } : {}) }));
      if (!page.success || page.data.data.length > limit) issue("Instagram Graph API вернул страницу сверх лимита или в неизвестном формате.");

      const rows = page.data.data.flatMap((value) => {
        const row = mediaFields.safeParse(value);
        return row.success ? [row.data] : [];
      });
      const items = rows.flatMap((row) => {
        if (row.media_type !== "VIDEO" || typeof row.permalink !== "string") return [];
        const video = normalizeFashionRadarVideo("instagram", {
          permalink: row.permalink, caption: typeof row.caption === "string" ? row.caption : null,
          like_count: row.like_count, comments_count: row.comments_count,
        });
        return video?.url ? [{ ...video, publishedAt: normalizeTimestamp(row.timestamp) }] : [];
      });

      after = extractAfter(page.data.paging?.next, path);
      // The official recent_media endpoint can repeat its opaque after value across different pages.
      if (after !== null && rows.length > 0 && rows.every(({ id }) => seenMedia.has(id))) {
        stats.repeatedPage = true;
        after = null;
      }
      for (const { id } of rows) seenMedia.add(id);
      stats.apiMediaRows += page.data.data.length;
      stats.reelsWithPermalink += items.length;
      pages += 1;
      return { items, nextCursor: after === null ? null : String(pages), chargedMicros: 0 };
    },
  };
  return { provider, stats };
}

export async function runInstagramHashtagPilot(
  input: Readonly<{ hashtag: string; limit?: number; filters?: BulkQuery["filters"] }>,
  config: InstagramConfig,
  request: typeof fetch = fetch,
) {
  const hashtag = input.hashtag.trim().normalize("NFC").toLowerCase();
  if (!/^#[\p{L}\p{M}\p{N}_]{1,100}$/u.test(hashtag)) {
    issue("Instagram Hashtag Search принимает один точный хэштег, например #кофе. Поиск по произвольным словам недоступен.");
  }
  const limit = input.limit ?? maxVideos;
  const query = bulkQuerySchema.safeParse({ keywords: hashtag, platform: "instagram", limit, filters: input.filters });
  if (!query.success || limit > maxVideos) issue("Введите лимит от 1 до 10 и корректные фильтры пилота.");

  const { provider, stats } = createInstagramHashtagProvider(config, request);
  const result = await searchBulk(query.data, [provider], { budgetMicros: 0, maxPages });
  const missingFields = ["originalTitle", "originalDescription", "author", "publishedAt", "views", "likes", "comments", "hashtags"] as const;
  return {
    hashtag,
    videos: result.videos,
    report: {
      ...stats,
      mediaPages: stats.apiRequests - 1,
      matchedVideos: result.videos.length,
      duplicates: result.duplicates,
      filteredOut: stats.reelsWithPermalink - result.videos.length - result.duplicates,
      missing: Object.fromEntries(missingFields.map((field) => [field, result.videos.filter((video) => video[field] === null).length])),
      stop: result.stop,
      apiFeeUsd: result.chargedMicros / 1_000_000,
    },
  };
}
