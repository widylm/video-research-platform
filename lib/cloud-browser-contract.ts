import { z } from "zod";
import { bulkQuerySchema, type BulkVideo } from "./bulk-search.ts";

export const cloudBrowserUrl = "/api/cloud-browser";
export const cloudBrowserQuery = bulkQuerySchema.strict().refine(({ platform, filters, limit }) =>
  platform === "all" && filters === undefined && limit <= 10);

export const cloudSocialQuery = bulkQuerySchema.extend({ mode: z.literal("social") }).strict().refine(({ limit, filters }) => limit <= 20 && filters === undefined);
export const cloudBrowserRequest = cloudBrowserQuery.or(cloudSocialQuery);


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
} as const;
export type CloudBrowserErrorCode = keyof typeof cloudBrowserErrors;

export interface CloudBrowserJob {
  id: string;
  state: "pending" | "running" | "completed" | "failed";
  keywords: string;
  records: CloudBrowserRecord[];
  videos?: BulkVideo[];
  unavailablePlatforms?: ("tiktok" | "instagram")[];
  mode?: "neutral" | "social";
  error?: CloudBrowserErrorCode;
}
