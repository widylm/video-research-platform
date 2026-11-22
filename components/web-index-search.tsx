"use client";
import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { savePublicVideo } from "@/app/actions";
import type { IndexedVideo, WebIndexPlatform } from "@/lib/web-index-video";

type Platform = "all" | WebIndexPlatform;
type SearchResult = { videos: IndexedVideo[]; failedPlatforms: WebIndexPlatform[]; source: "bing-rss" };
const errors: Record<string, string> = {
  forbidden: "Войдите в аккаунт команды для поиска.",
  invalid_query: "Введите запрос длиной от 2 до 120 символов.",
  index_unavailable: "Веб-индекс сейчас недоступен из облака. Попробуйте позже.",
  index_rate_limited: "Веб-индекс ограничил запросы. Попробуйте позже.",
};
export function WebIndexSearch({ canSave }: { canSave: boolean }) {
  const [keywords, setKeywords] = useState("");
  const [platform, setPlatform] = useState<Platform>("all");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/web-index-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords, platform, limit: 20 }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(errors[body.error] ?? errors.index_unavailable);
      setResult(body as SearchResult);
    } catch (error) {
      setError(error instanceof Error ? error.message : errors.index_unavailable);
    } finally { setLoading(false); }
  }
  async function saveVideo(video: IndexedVideo) {
    const key = `${video.platform}:${video.externalId}`;
    if (saving) return;
    setSaving(key);
    setError("");
    try {
      const result = await savePublicVideo({
        url: video.url, title: "", description: "", publishedAt: "", hashtags: "",
        views: "", likes: "", collectionId: "",
      });
      if ("error" in result) setError(result.error);
      else setSaved(previous => [...previous, key]);
    } catch {
      setError("Не удалось сохранить ссылку. Повторите попытку.");
    } finally { setSaving(null); }
  }
  return <section className="results-section" aria-label="Поиск новых видео в интернете">
    <form className="panel pilot-form" onSubmit={submit}>
      <h2>Найти новые видео в интернете</h2>
      <p>Поиск публично проиндексированных ссылок TikTok и Instagram Reels. Результатов может быть мало или не быть совсем.</p>
      <label>Поисковый запрос
        <input name="keywords" required minLength={2} maxLength={120} value={keywords}
          onChange={event => setKeywords(event.target.value)} disabled={loading}
          placeholder="Например, кофе" />
      </label>
      <label>Площадка
        <select value={platform} onChange={event => setPlatform(event.target.value as Platform)} disabled={loading}>
          <option value="all">TikTok и Instagram</option>
          <option value="tiktok">TikTok</option>
          <option value="instagram">Instagram Reels</option>
        </select>
      </label>
      <div className="pilot-actions"><span>Без API-ключей · максимум 20 индексированных ссылок</span>
        <button className="button primary" type="submit" disabled={loading}>
          <Search size={16} /> {loading ? "Ищем…" : "Найти"}
        </button>
      </div>
    </form>
    {error && <p className="notice error" role="alert">{error}</p>}
    {result && <div>
      <p role="status">Найдено ссылок: {result.videos.length}. Наличие ролика и актуальность данных проверяйте на сайте площадки.</p>
      {result.failedPlatforms.length > 0 && <p className="notice error">Не ответил веб-индекс для: {result.failedPlatforms.join(", ")}</p>}
      {result.videos.length === 0 && <p className="panel empty-state">Веб-индекс не нашёл подходящих ссылок. Это не означает, что видео на площадке нет.</p>}
      {result.videos.map(video => <article className="panel pilot-card" key={video.platform + video.externalId}>
        <h3>{video.indexTitle || (video.platform === "tiktok" ? "Видео TikTok" : "Instagram Reel")}</h3>
        <p>{video.platform === "tiktok" ? "TikTok" : "Instagram"}{video.author ? " · @" + video.author : ""}</p>
        {video.indexSnippet && <p>{video.indexSnippet}</p>}
        <a href={video.url} target="_blank" rel="noopener noreferrer">Открыть оригинальную ссылку</a>
        {canSave && <button className="button quiet" type="button" disabled={!!saving || saved.includes(`${video.platform}:${video.externalId}`)} onClick={() => void saveVideo(video)}>
          {saved.includes(`${video.platform}:${video.externalId}`) ? "В общем каталоге" : saving === `${video.platform}:${video.externalId}` ? "Сохраняем…" : "Сохранить в общий каталог"}
        </button>}
      </article>)}
    </div>}
  </section>;
}
