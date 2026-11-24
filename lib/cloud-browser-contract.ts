import { z } from "zod";
import { bulkQuerySchema, type BulkVideo } from "./bulk-search.ts";

export const cloudBrowserUrl = "/api/cloud-browser";
export const cloudBrowserQuery = bulkQuerySchema.strict().refine(({ platform, filters, limit }) =>
  platform === "all" && filters === undefined && limit <= 10);
export const fashionRadarQuery = bulkQuerySchema.extend({
  platform: z.enum(["tiktok", "instagram"]),
  limit: z.number().int().min(1).max(50),
  searchMode: z.enum(["hashtag", "keyword"]).default("hashtag"),
}).strict().refine(({ keywords, searchMode }) => searchMode === "keyword"
  || /^[\p{L}\p{N}_]{1,80}$/u.test(keywords.replace(/^#/, "")), {
  message: "Введите один хэштег без пробелов.",
});
export type FashionRadarQuery = z.infer<typeof fashionRadarQuery>;
export const browserRequestQuery = z.union([cloudBrowserQuery, fashionRadarQuery]);

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
  invalid_query: "Проверьте запрос, способ поиска и количество роликов.",
  source_unavailable: "Источник сборщика не настроен.",
  slot_busy: "Другой поиск уже выполняется. Дождитесь его завершения.",
  cooldown: "Подождите 20 секунд между запусками браузера.",
  budget_exhausted: "Дневной лимит запусков сборщика исчерпан.",
  browser_quota: "Cloudflare ограничил запуск браузера. Проверьте квоту Browser Run.",
  browser_error: "Не удалось запустить браузер или получить данные.",
  source_denied: "Источник отказал облачному браузеру в доступе.",
  manual_intervention_required: "Соцсеть требует ручной проверки.",
  verification_unavailable: "Не удалось открыть облачное окно проверки. Подробности и снимок страницы доступны ниже.",
  verification_expired: "Время ручной проверки истекло. Запустите новый сбор, когда будете готовы открыть окно проверки.",
  verification_failed: "Ручная проверка не завершена. Сбор остановлен.",
  timed_out: "Облачный браузер не успел завершить поиск.",
  interrupted: "Выполнение было прервано. Запустите поиск снова.",
  source_login_required: "Соцсеть требует вход. Облачный браузер не использует вход из Chrome на вашем компьютере.",
  source_not_ready: "Соцсеть не загрузила выдачу. Это не означает, что подходящих роликов нет.",
  source_rate_limited: "Соцсеть ограничила запросы. Повторите поиск позже.",
} as const;
export type CloudBrowserErrorCode = keyof typeof cloudBrowserErrors;

export interface CloudBrowserApiResponse {
  httpStatus: number;
  apiCode?: number;
  format: "json" | "empty" | "invalid_json" | "unreadable" | "skipped";
  items: number;
}

export interface CloudBrowserDiagnostics {
  navigationStatus?: number;
  pageTitle: string;
  elapsedMs: number;
  visibleLinks: number;
  metadataResponses: number;
  metadataItems: number;
  failedRequests: number;
  blockedHosts: string[];
  apiResponses?: CloudBrowserApiResponse[];
  challengeVisible?: boolean;
  screenshot?: string;
}

export interface CloudBrowserVerification {
  url: string;
  expiresAt: string;
}

export function safeVerificationUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 16_000 || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  const socket = url.searchParams.get("wss") ?? "";
  const socketUrl = socket.startsWith("wss://") ? socket : `wss://${socket}`;
  if (!URL.canParse(socketUrl)) return null;
  const target = new URL(socketUrl);
  return url.protocol === "https:" && url.hostname === "live.browser.run" && !url.port && !url.username && !url.password && !url.hash
    && ["/ui/view", "/ui/inspector"].includes(url.pathname) && target.protocol === "wss:"
    && target.hostname === "live.browser.run" && !target.port && !target.username && !target.password
    && target.pathname.startsWith("/api/devtools/browser/") ? raw : null;
}

export function browserJobActive(state?: CloudBrowserJob["state"]) {
  return state === "pending" || state === "running" || state === "awaiting_verification";
}

export interface CloudBrowserJob {
  id: string;
  state: "pending" | "running" | "awaiting_verification" | "completed" | "failed";
  keywords: string;
  records: CloudBrowserRecord[];
  videos?: BulkVideo[];
  scanned?: number;
  limited?: boolean;
  error?: CloudBrowserErrorCode;
  diagnostics?: CloudBrowserDiagnostics;
  verification?: CloudBrowserVerification;
}
