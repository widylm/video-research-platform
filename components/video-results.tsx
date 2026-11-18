"use client";

import Image from "next/image";
import {
  CalendarDays, Eye, Film, Heart, LayoutGrid, List, Play, SearchX,
} from "lucide-react";
import { platformNames, sortOptions, type Sort, type Video } from "@/lib/videos";

export const formatNumber = new Intl.NumberFormat("ru-RU");
const compact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone: "UTC" });

export function PlatformBadge({ platform }: { platform: Video["platform"] }) {
  return <span className={`platform-badge ${platform}`}><span aria-hidden="true" />{platformNames[platform]}</span>;
}

export function VideoMetrics({ video, full = false }: { video: Video; full?: boolean }) {
  const number = full ? formatNumber : compact;
  return <div className="video-metrics">
    <span title="Просмотры" aria-label={`Просмотры: ${formatNumber.format(video.views)}`}>
      <Eye size={16} aria-hidden="true" /> {number.format(video.views)}
    </span>
    <span title="Лайки" aria-label={`Лайки: ${formatNumber.format(video.likes)}`}>
      <Heart size={15} aria-hidden="true" /> {number.format(video.likes)}
    </span>
    {full && <span><CalendarDays size={16} />{dateFormat.format(new Date(video.publishedAt))}</span>}
  </div>;
}

interface Props {
  videos: Video[];
  favorites: string[];
  view: "grid" | "table";
  sort: Sort;
  busy: boolean;
  emptyHint: string;
  onView: (view: Props["view"]) => void;
  onSort: (sort: Sort) => void;
  onOpen: (video: Video) => void;
  onFavorite: (video: Video) => void;
}

function FavoriteButton({ video, saved, busy, onFavorite }: {
  video: Video;
  saved: boolean;
  busy: boolean;
  onFavorite: Props["onFavorite"];
}) {
  return <button className={`icon-button favorite-button${saved ? " saved" : ""}`}
    aria-label={saved ? `Убрать из избранного: ${video.title}` : `В избранное: ${video.title}`}
    aria-pressed={saved} disabled={busy} onClick={() => onFavorite(video)}>
    <Heart size={17} fill={saved ? "currentColor" : "none"} />
  </button>;
}

export function VideoResults(props: Props) {
  const { videos, favorites, view, sort, busy, emptyHint, onView, onSort, onOpen, onFavorite } = props;

  return <>
    <div className="results-toolbar">
      <span className="result-counter" role="status"><Film size={16} /> Найдено: {videos.length}</span>
      <div className="display-options">
        <label className="sort-label"><span className="sr-only">Сортировка</span>
          <select value={sort} disabled={busy} onChange={(event) => onSort(event.target.value as Sort)}>
            {Object.entries(sortOptions).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
          </select>
        </label>
        <div className="view-toggle" role="group" aria-label="Вид результатов">
          <button className="icon-button" type="button" title="Плитка" aria-label="Плитка"
            aria-pressed={view === "grid"} onClick={() => onView("grid")}><LayoutGrid size={17} /></button>
          <button className="icon-button" type="button" title="Таблица" aria-label="Таблица"
            aria-pressed={view === "table"} onClick={() => onView("table")}><List size={17} /></button>
        </div>
      </div>
    </div>
    {videos.length === 0 ? <div className="panel empty-state">
      <SearchX size={25} /><strong>Здесь пока нет видео</strong><p>{emptyHint}</p>
    </div> : view === "grid" ? <div className="video-grid">
      {videos.map((video) => <article className="panel video-card" key={video.id}>
        <div className="video-cover">
          <button className="cover-trigger" onClick={() => onOpen(video)} aria-label={`Подробнее: ${video.title}`}>
            <Image src={video.cover} alt="" fill sizes="(max-width: 660px) 100vw, (max-width: 1260px) 45vw, 26vw" />
            <span className="play-mark" aria-hidden="true"><Play size={19} fill="currentColor" /></span>
          </button>
          <PlatformBadge platform={video.platform} />
          <FavoriteButton video={video} saved={favorites.includes(video.id)} busy={busy} onFavorite={onFavorite} />
        </div>
        <div className="video-body">
          <h3><button onClick={() => onOpen(video)}>{video.title}</button></h3>
          <p className="video-author">@{video.author}</p>
          <VideoMetrics video={video} />
        </div>
      </article>)}
    </div> : <div className="panel table-scroll" tabIndex={0} role="region" aria-label="Таблица видео">
      <table>
        <thead><tr><th scope="col">Видео</th><th scope="col">Платформа</th><th scope="col">Дата</th>
          <th scope="col">Просмотры</th><th scope="col">Лайки</th><th scope="col"><span className="sr-only">Избранное</span></th>
        </tr></thead>
        <tbody>{videos.map((video) => <tr key={video.id}>
          <td><button className="table-video" onClick={() => onOpen(video)}>{video.title}</button>
            <small>@{video.author}</small></td>
          <td><PlatformBadge platform={video.platform} /></td>
          <td>{dateFormat.format(new Date(video.publishedAt))}</td>
          <td>{formatNumber.format(video.views)}</td><td>{formatNumber.format(video.likes)}</td>
          <td><FavoriteButton video={video} saved={favorites.includes(video.id)} busy={busy} onFavorite={onFavorite} /></td>
        </tr>)}</tbody>
      </table>
    </div>}
  </>;
}
