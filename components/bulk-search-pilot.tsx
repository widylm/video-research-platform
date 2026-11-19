"use client";

import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import {
  bulkQuerySchema, bulkResultLimit, bulkStoredResultSchema, bulkVideoKey,
  type BulkQuery, type BulkSearchResult, type BulkVideo,
} from "@/lib/bulk-search";
import { runBulkPilot } from "@/lib/providers/bulk-pilot";
import { PlatformBadge } from "./video-results";

const defaultQuery: BulkQuery = { keywords: "", platform: "all", limit: 100 };
const displayPageSize = 20;
const fields = { views: "Просмотры", likes: "Лайки", comments: "Комментарии" } as const;
const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone: "UTC" });
const timestamp = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
const number = new Intl.NumberFormat("ru-RU");
const stopMessages = {
  exhausted: "Фиктивная выдача закончилась.",
  "result-limit": "Достигнут лимит результатов.",
  "page-limit": "Достигнут лимит страниц обработки.",
  "budget-limit": "Достигнут лимит расходов.",
};
const noData = "Нет данных";

function PilotNote({ storageKey }: { storageKey: string }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    try {
      setText((localStorage.getItem(storageKey) ?? "").slice(0, 1_000));
    } catch {
      setStatus("Хранилище браузера недоступно.");
    }
  }, [storageKey]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (text.trim()) localStorage.setItem(storageKey, text.trim());
      else localStorage.removeItem(storageKey);
      setStatus(text.trim() ? "Заметка сохранена." : "Заметка удалена.");
    } catch {
      setStatus("Не удалось сохранить заметку в браузере.");
    }
  }

  return <details className="pilot-note">
    <summary>Заметка</summary>
    <form onSubmit={save}>
      <label>Личная заметка<textarea value={text} maxLength={1_000} rows={3}
        onChange={(event) => { setText(event.target.value); setStatus(""); }} /></label>
      <button className="button secondary" type="submit">Сохранить заметку</button>
      {status && <span className="field-hint" role="status">{status}</span>}
    </form>
  </details>;
}

function PilotCard({ video, storageScope }: { video: BulkVideo; storageScope: string }) {
  return <article className="panel pilot-card">
    <PlatformBadge platform={video.platform} />
    <h3>{video.originalTitle ?? "Название недоступно"}</h3>
    <span className="video-author">{video.author ?? "Автор не указан"}</span>
    <p>{video.originalDescription ?? noData}</p>
    {video.hashtags && <div className="tags">
      {video.hashtags.map((tag, index) => <span key={`${index}-${tag}`}>#{tag.replace(/^#/, "")}</span>)}
    </div>}
    <dl className="pilot-metadata">
      <div><dt>Опубликовано</dt><dd>{video.publishedAt ? date.format(new Date(video.publishedAt)) : noData}</dd></div>
      {Object.entries(fields).map(([key, label]) => {
        const count = video[key as keyof typeof fields];
        return <div key={key}><dt>{label}</dt><dd>{count === null ? noData : number.format(count)}</dd></div>;
      })}
    </dl>
    <details>
      <summary>Источник и ссылка</summary>
      <dl className="pilot-metadata">
        <div><dt>ID</dt><dd>{video.externalId}</dd></div>
        <div><dt>Источник</dt><dd>{video.source}</dd></div>
        <div><dt>Получено, UTC</dt><dd>{timestamp.format(new Date(video.fetchedAt))}</dd></div>
        <div><dt>Ссылка</dt><dd>{video.url ? <a href={video.url} target="_blank" rel="noreferrer">Открыть оригинал</a> : noData}</dd></div>
      </dl>
    </details>
    <PilotNote storageKey={`${storageScope}.note.${bulkVideoKey(video)}`} />
  </article>;
}

export function BulkSearchPilot({ profileId }: { profileId?: string }) {
  const storageScope = `kadr.bulk-pilot.v1.${profileId ?? "demo"}`;
  const snapshotKey = `${storageScope}.results`;
  const [query, setQuery] = useState(defaultQuery);
  const [result, setResult] = useState<BulkSearchResult>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [storageNotice, setStorageNotice] = useState("");
  const [busy, startTransition] = useTransition();

  useEffect(() => {
    try {
      const stored = bulkStoredResultSchema.safeParse(JSON.parse(sessionStorage.getItem(snapshotKey) ?? "null"));
      if (stored.success) {
        setQuery(stored.data.query);
        setResult(stored.data.result);
      }
    } catch {
      // The current search stays usable when browser storage is unavailable.
    }
  }, [snapshotKey]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = bulkQuerySchema.safeParse({
      keywords: form.get("keywords"), platform: form.get("platform"), limit: Number(form.get("limit")),
    });
    if (!input.success) {
      setError(`Введите ключевые слова и лимит от 1 до ${bulkResultLimit}.`);
      return;
    }
    setQuery(input.data);
    setError("");
    setStorageNotice("");
    startTransition(async () => {
      try {
        const data = await runBulkPilot(input.data);
        setResult(data);
        setPage(1);
        try {
          sessionStorage.setItem(snapshotKey, JSON.stringify({ query: input.data, result: data }));
        } catch {
          setStorageNotice("Результаты доступны до закрытия этого раздела.");
        }
      } catch {
        setError("Не удалось выполнить тестовый поиск. Попробуйте ещё раз.");
      }
    });
  }

  const total = result?.videos.length ?? 0;
  const pageCount = Math.ceil(total / displayPageSize);
  return <>
    <form className="panel pilot-form" onSubmit={submit}>
      <div className="pilot-fields">
        <label>Ключевые слова<input name="keywords" required maxLength={120}
          value={query.keywords} onChange={(event) => setQuery({ ...query, keywords: event.target.value })}
          placeholder="Например, кофе, город или спорт" disabled={busy} /></label>
        <label>Платформа<select name="platform" value={query.platform} disabled={busy}
          onChange={(event) => setQuery({ ...query, platform: event.target.value as BulkQuery["platform"] })}>
          <option value="all">Обе платформы</option><option value="tiktok">TikTok</option><option value="instagram">Instagram Reels</option>
        </select></label>
        <label>Макс. видео<input key={query.limit} name="limit" type="number" min={1} max={bulkResultLimit} step={1}
          defaultValue={query.limit} required disabled={busy} /></label>
      </div>
      <div className="pilot-actions">
        <span>Фиктивные данные · бюджет $0 · заметки в этом браузере</span>
        <button className="button primary" disabled={busy} type="submit"><Search size={16} />{busy ? "Ищем…" : "Запустить тестовый поиск"}</button>
      </div>
    </form>
    {error && <p className="notice error" role="alert">{error}</p>}
    {storageNotice && <p className="field-hint" role="status">{storageNotice}</p>}
    {result && <section className="results-section" aria-label="Результаты пилота">
      <div className="pilot-result-summary">
        <span role="status">Найдено: {total}</span>
        <span>Обработано страниц: {result.pagesScanned}. {stopMessages[result.stop]}</span>
      </div>
      {pageCount > 1 && <nav className="pilot-pagination" aria-label="Страницы результатов">
        <button className="button secondary" type="button" disabled={page === 1}
          onClick={() => setPage((old) => old - 1)}><ChevronLeft size={16} /> Назад</button>
        <span>Страница {page} из {pageCount}</span>
        <button className="button secondary" type="button" disabled={page === pageCount}
          onClick={() => setPage((old) => old + 1)}>Далее <ChevronRight size={16} /></button>
      </nav>}
      {total ? <div className="video-grid">
        {result.videos.slice((page - 1) * displayPageSize, page * displayPageSize).map((video) =>
          <PilotCard key={bulkVideoKey(video)} video={video} storageScope={storageScope} />)}
      </div> : <div className="panel empty-state">Попробуйте «кофе», «город» или «спорт».</div>}
    </section>}
  </>;
}
