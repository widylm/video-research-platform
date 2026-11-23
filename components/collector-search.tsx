"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Search, RefreshCw } from "lucide-react";
import { saveCollectedVideo } from "@/app/actions";
import { cloudBrowserErrors, cloudBrowserUrl, type CloudBrowserJob, type FashionRadarQuery } from "@/lib/cloud-browser-contract";
import type { BulkVideo } from "@/lib/bulk-search";
import { PlatformBadge } from "./video-results";

const status = { pending: "Поиск в очереди", running: "Собираем ролики со страницы соцсети", completed: "Сбор завершён", failed: "Сбор остановлен" };
const number = new Intl.NumberFormat("ru-RU");
const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone: "UTC" });
const describe = (code?: string) => code && code in cloudBrowserErrors
  ? cloudBrowserErrors[code as keyof typeof cloudBrowserErrors] : "Не удалось связаться со сборщиком. Обновите состояние.";
const metric = (value: number | null) => value === null ? "Нет данных" : number.format(value);

export function CollectorSearch({ enabled, canCollect }: { enabled: boolean; canCollect: boolean }) {
  const [job, setJob] = useState<CloudBrowserJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(enabled && canCollect);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const active = job?.state === "pending" || job?.state === "running";

  useEffect(() => {
    if (!enabled || !canCollect) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    async function poll() {
      try {
        const response = await fetch(cloudBrowserUrl, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(describe(data.error));
        if (controller.signal.aborted) return;
        failures = 0;
        setError("");
        setJob(data.job);
        if (data.job?.state === "pending" || data.job?.state === "running") timer = setTimeout(poll, 1500);
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : describe());
        // A temporary connection failure must not leave an active job polling forever.
        if (++failures < 3) timer = setTimeout(poll, 3000);
      } finally { if (!controller.signal.aborted) setRestoring(false); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [enabled, canCollect, revision]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || !canCollect || active || loading || restoring) return;
    const fields = new FormData(event.currentTarget);
    const days = Number(fields.get("days"));
    const query: FashionRadarQuery = {
      platform: fields.get("platform") === "instagram" ? "instagram" : "tiktok",
      keywords: String(fields.get("keywords") ?? "").trim(),
      searchMode: fields.get("searchMode") === "keyword" ? "keyword" : "hashtag",
      limit: Number(fields.get("limit")),
      filters: days ? { publishedFrom: new Date(Date.now() - days * 86400_000).toISOString(),
        publishedTo: new Date().toISOString() } : undefined,
    };
    setLoading(true); setError("");
    try {
      const response = await fetch(cloudBrowserUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query) });
      const data = await response.json();
      if (!response.ok) throw new Error(describe(data.error));
      setJob(data.job); setSaved({}); setRevision(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : describe()); }
    finally { setLoading(false); }
  }

  async function save(video: BulkVideo) {
    if (saving) return;
    const key = `${video.platform}:${video.externalId}`;
    setSaving(key); setError("");
    try {
      const result = await saveCollectedVideo(video);
      if ("error" in result) setError(result.error);
      else setSaved(current => ({ ...current, [key]: result.data.created ? "В каталоге команды" : "Уже в каталоге; ручные данные сохранены" }));
    } catch { setError("Не удалось сохранить ролик в каталог."); }
    finally { setSaving(null); }
  }

  const videos = job?.videos ?? [];
  return <>
    {!enabled && <div className="panel empty-state" role="status">
      <strong>Облачный сборщик ещё не подключён</strong>
      <p>Этот раздел получает реальные ролики. Для запуска нужно развернуть исполнитель Fashion Radar и связать его с сайтом.</p>
      <p>Платный сервис и ключи Apify для этого варианта не требуются.</p>
    </div>}
    {!canCollect && <p className="notice">Запускать сбор могут участники и администраторы команды.</p>}
    <form className="panel pilot-form" onSubmit={submit}>
      <div className="text-fields">
        <label>Площадка<select name="platform" disabled={!enabled || !canCollect || active || loading}>
          <option value="tiktok">TikTok</option><option value="instagram">Instagram Reels</option>
        </select></label>
        <label>Способ поиска<select name="searchMode" disabled={!enabled || !canCollect || active || loading}>
          <option value="hashtag">По хэштегу</option><option value="keyword">По ключевым словам</option>
        </select></label>
      </div>
      <label>Хэштег или ключевые слова<input name="keywords" required maxLength={120} placeholder="Например, amazonfinds"
        disabled={!enabled || !canCollect || active || loading} /></label>
      <div className="text-fields">
        <label>Дата публикации<select name="days" defaultValue="7" disabled={!enabled || !canCollect || active || loading}>
          <option value="1">Последние 24 часа</option><option value="7">Последние 7 дней</option>
          <option value="30">Последние 30 дней</option><option value="0">Все доступные даты</option>
        </select></label>
        <label>Максимум роликов<input name="limit" type="number" min={1} max={50} defaultValue={20}
          disabled={!enabled || !canCollect || active || loading} /></label>
      </div>
      <p className="field-hint">Даты проверяются у найденных роликов. Это выборка доступной выдачи; полный охват соцсети не гарантируется.</p>
      <div className="pilot-actions"><span>Реальные данные · до 50 роликов · ограничение времени и запусков</span>
        <button className="button primary" type="submit" disabled={!enabled || !canCollect || restoring || active || loading}>
          <Search size={16} />{loading ? "Запускаем…" : active ? "Собираем…" : "Собрать ролики"}
        </button>
      </div>
    </form>
    {error && <p className="notice error" role="alert">{error}</p>}
    {enabled && canCollect && <button className="button quiet" type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>
      <RefreshCw size={16} /> Обновить состояние
    </button>}
    {job && <section className="results-section" aria-label="Собранные ролики">
      <p role="status">{status[job.state]} · {job.keywords}{job.state === "completed" ? ` · Найдено: ${videos.length} · Проверено ссылок: ${job.scanned ?? 0}` : ""}</p>
      {job.error && <p className="notice error" role="alert">{describe(job.error)}</p>}
      {job.state === "completed" && job.videos === undefined && <p className="notice error">Подключён тестовый исполнитель. Для сбора роликов требуется исполнитель Fashion Radar.</p>}
      {job.state === "completed" && job.videos !== undefined && !videos.length && <p className="panel empty-state">
        В проверенной выдаче нет роликов, подходящих по выбранным датам. Попробуйте другой запрос или период «Все доступные даты».
      </p>}
      {job.limited && <p className="field-hint">Получена ограниченная выборка. Вход на вашем компьютере не переносится в облачный браузер.</p>}
      <div className="video-grid">{videos.map(video => {
        const key = `${video.platform}:${video.externalId}`;
        return <article className="panel pilot-card" key={key}>
          <PlatformBadge platform={video.platform} />
          <h3>{video.originalTitle || video.originalDescription?.split("\n")[0]?.slice(0, 140) || "Название не получено"}</h3>
          <p className="video-author">{video.author ? `@${video.author}` : "Автор не указан"}</p>
          {video.originalDescription && <p>{video.originalDescription}</p>}
          <dl className="pilot-metadata">
            <div><dt>Опубликовано</dt><dd>{video.publishedAt ? date.format(new Date(video.publishedAt)) : "Нет данных"}</dd></div>
            <div><dt>Просмотры</dt><dd>{metric(video.views)}</dd></div>
            <div><dt>Лайки</dt><dd>{metric(video.likes)}</dd></div>
            <div><dt>Комментарии</dt><dd>{metric(video.comments)}</dd></div>
          </dl>
          <p className="field-hint">Получено: {new Date(video.fetchedAt).toLocaleString("ru-RU")}</p>
          {video.url && <a href={video.url} target="_blank" rel="noreferrer">Открыть оригинал</a>}
          <button className="button secondary" type="button" disabled={!!saving || !!saved[key]} onClick={() => void save(video)}>
            {saved[key] ?? (saving === key ? "Сохраняем…" : "Сохранить в каталог команды")}
          </button>
        </article>;
      })}</div>
    </section>}
  </>;
}
