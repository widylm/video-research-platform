"use client";

import { Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { searchInstagram } from "@/app/actions/instagram-discovery";
import { bulkVideoKey } from "@/lib/bulk-search";
import { PilotCard } from "./bulk-search-pilot";

export function InstagramDiscovery({ profileId }: { profileId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof searchInstagram>> | null>(null);
  const [pending, setPending] = useState(false);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setData(null);
    setPending(true);
    try {
      setData(await searchInstagram({
        hashtag: String(form.get("hashtag") ?? ""), days: Number(form.get("days")),
        minViews: Number(form.get("minViews")), minLikes: Number(form.get("minLikes")),
      }));
    } catch {
      setData({ error: "Поиск не завершился. Попробуй ещё раз." });
    } finally {
      setPending(false);
    }
  }

  const result = data?.result;
  return <>
    <form className="panel pilot-form" onSubmit={search}>
      <label>Хэштег<input name="hashtag" required maxLength={81} placeholder="#amazonfinds" /></label>
      <label>Период<select name="days" defaultValue="30">
        <option value="7">Последние 7 дней</option>
        <option value="30">Последние 30 дней</option>
        <option value="0">Вся доступная подборка</option>
      </select></label>
      <label>Минимум просмотров<input name="minViews" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} defaultValue={0} required /></label>
      <label>Минимум лайков<input name="minLikes" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} defaultValue={0} required /></label>
      <div className="pilot-actions">
        <button className="button primary" disabled={pending} type="submit"><Search size={16} /> Найти Reels</button>
      </div>
    </form>
    {pending && <p role="status">Ищу ролики выбранных аккаунтов…</p>}
    {data?.error && <p className="notice error" role="alert">{data.error}</p>}
    {result && <section className="results-section" aria-label="Найденные Reels">
      <p role="status">Найдено {result.videos.length} из {result.checked} полученных Reels.</p>
      {result.failedAccounts > 0 && <p className="notice error">
        {result.rateLimited ? "Instagram временно ограничил запросы." : "Часть аккаунтов недоступна."} Показаны полученные результаты.
      </p>}
      {!result.videos.length && <p className="panel empty-state">В полученной подборке нет роликов по этому хэштегу и фильтрам.</p>}
      {result.videos.map((video) => <PilotCard key={bulkVideoKey(video)} video={video} preview storageScope={`kadr.instagram.${profileId}`} />)}
    </section>}
  </>;
}
