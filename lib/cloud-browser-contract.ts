import { z } from "zod";
import { bulkPlatforms, bulkQuerySchema, type BulkPlatform, type BulkVideo } from "./bulk-search.ts";

export const cloudBrowserUrl = "/api/cloud-browser";
export const cloudBrowserQuery = bulkQuerySchema.strict().refine(({ platform, filters, limit }) =>
  platform === "all" && filters === undefined && limit <= 10);

export const cloudSocialLimit = 10;
export const cloudSocialQuery = bulkQuerySchema.extend({ mode: z.literal("social"), platform: z.enum(bulkPlatforms) })
  .strict().refine(({ limit, filters }) => limit <= cloudSocialLimit && filters === undefined);
export const cloudBrowserRequest = cloudBrowserQuery.or(cloudSocialQuery);

export function socialPilotPlatform(env: { KADR_ENABLE_SOCIAL_DISCOVERY?: string; KADR_SOCIAL_DISCOVERY_PLATFORM?: string }): BulkPlatform | undefined {
  const platform = env.KADR_SOCIAL_DISCOVERY_PLATFORM;
  return env.KADR_ENABLE_SOCIAL_DISCOVERY === "1" && (platform === "tiktok" || platform === "instagram") ? platform : undefined;
}

export interface CloudBrowserRecord {
  id: string;
  url: string;
  title: string;
  description: string;
  fetchedAt: string;
}

// Future adapters can normalize into BulkVideo. The executor only registers the neutral adapter.
export interface BrowserSource<Raw, Result extends CloudBrowserRecord | BulkVideo> {
  read(): Promise<Raw>;
  normalize(raw: Raw): readonly Result[];
}

export const cloudBrowserErrors = {
  unavailable: "Облачный исполнитель недоступен.",
  forbidden: "Запуск доступен только активным редакторам.",
  invalid_query: "Введите ключевые слова для тестового поиска.",
  source_unavailable: "Разрешённый тестовый источник не настроен.",
  slot_busy: "Другой поиск уже выполняется. Дождитесь его завершения.",
  cooldown: "Подождите 20 секунд между запусками браузера.",
  budget_exhausted: "Дневной лимит облачного теста исчерпан.",
  browser_quota: "Cloudflare ограничил запуск браузера. Проверьте квоту Browser Run.",
  browser_error: "Не удалось запустить браузер или получить данные.",
  source_denied: "Тестовый источник отказал в доступе.",
  manual_intervention_required: "Источник требует ручной проверки. Поиск остановлен.",
  timed_out: "Облачный браузер не успел завершить поиск.",
  interrupted: "Выполнение было прервано. Запустите поиск снова.",
  social_disabled: "Поиск публичных видео пока не включён в этом окружении.",
  social_already_run: "Разрешённый пробный запуск уже использован.",
  source_http_401: "Площадка вернула HTTP 401. Требуется авторизация.",
  source_http_403: "Площадка вернула HTTP 403. Доступ запрещён.",
  source_http_429: "Площадка вернула HTTP 429. Достигнут лимит запросов.",
  source_http_451: "Площадка вернула HTTP 451. Доступ ограничен по правовым причинам.",
  source_login_required: "Площадка перенаправила на вход или потребовала войти.",
} as const;
export type CloudBrowserErrorCode = keyof typeof cloudBrowserErrors;

export interface CloudBrowserJob {
  id: string;
  state: "pending" | "running" | "completed" | "failed";
  keywords: string;
  records: CloudBrowserRecord[];
  videos?: BulkVideo[];
  mode?: "neutral" | "social";
  error?: CloudBrowserErrorCode;
}
