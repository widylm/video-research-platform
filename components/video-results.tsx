"use client";

import { useState } from "react";
import {
  CalendarDays, Eye, Film, Heart, LayoutGrid, List, SearchX,
} from "lucide-react";
import { officialEmbed, platformNames, sortOptions, videoLabel, type Sort, type Video } from "@/lib/videos";
import { EmbeddedVideo, VideoPreviewButton } from "./embedded-video";

export const formatNumber = new Intl.NumberFormat("ru-RU");
const compact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone: "UTC" });

export function PlatformBadge({ platform }: { platform: Video["platform"] }) {
  return <span className="platform-badge"><span aria-hidden="true" />{platformNames[platform]}</span>;
}

function PublicationDate({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{dateFormat.format(new Date(value))}</time>
    : <span className="unknown-value">Нет данных</span>;
}

function count(value: number | null, formatter = formatNumber) {
  return value === null ? "Нет данных" : formatter.format(value);
}

export function VideoMetrics({ video, full = false }: { video: Video; full?: boolean }) {
  const number = full ? formatNumber : compact;
  if (!full && video.views === null && video.likes === null) return null;
  return <div className="video-metrics">
    {(full || video.views !== null) && <span title="Просмотры" aria-label={`Просмотры: ${count(video.views)}`}>
      <Eye size={16} aria-hidden="true" /> {count(video.views, number)}
    </span>}
    {(full || video.likes !== null) && <span title="Лайки" aria-label={`Лайки: ${count(video.likes)}`}>
      <Heart size={15} aria-hidden="true" /> {count(video.likes, number)}
    </span>}
    {full && <span><CalendarDays size={16} aria-hidden="true" /><PublicationDate value={video.publishedAt} /></span>}
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

function FavoriteButton({ video, title, saved, busy, onFavorite }: {
  video: Video;
  title: string;
  saved: boolean;
  busy: boolean;
  onFavorite: Props["onFavorite"];
}) {
  return <button className={`icon-button favorite-button${saved ? " saved" : ""}`}
    aria-label={saved ? `Убрать из избранного: ${title}` : `В избранное: ${title}`}
    aria-pressed={saved} disabled={busy} onClick={() => onFavorite(video)}>
    <Heart size={17} fill={saved ? "currentColor" : "none"} />
  </button>;
}

type EntryProps = Pick<Props, "busy" | "onOpen" | "onFavorite"> & { video: Video; saved: boolean };

function VideoCard({ video, saved, busy, inline, onTogglePreview, onOpen, onFavorite }: EntryProps & {
  inline: boolean;
  onTogglePreview: () => void;
}) {
  const { title, author } = videoLabel(video);
  const embed = officialEmbed(video);

  return <article className="panel video-card">
    <div className="video-card-header">
      <PlatformBadge platform={video.platform} />
      <FavoriteButton video={video} title={title} saved={saved} busy={busy} onFavorite={onFavorite} />
    </div>

    <div className="video-body">
      <h3><button onClick={() => onOpen(video)}>{title}</button></h3>
      <p className="video-byline">
        <span className="video-author">{author || "Автор не указан"}</span>
        {video.publishedAt && <PublicationDate value={video.publishedAt} />}
      </p>
      {video.description && <p className="video-card-description">{video.description}</p>}
      {video.hashtags.length > 0 && <div className="tags catalog-tags">
        {video.hashtags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}
      </div>}
      <VideoMetrics video={video} />
      {embed && <VideoPreviewButton id={`preview-${video.id}`} expanded={inline} onToggle={onTogglePreview} />}
    </div>
    {embed && <div id={`preview-${video.id}`} className={inline ? "catalog-player" : undefined} hidden={!inline}>
      {inline && <EmbeddedVideo video={video} src={embed} />}
    </div>}
  </article>;
}

function VideoTableRow({ video, saved, busy, onOpen, onFavorite }: EntryProps) {
  const { title, author } = videoLabel(video);
  return <tr>
    <td><button className="table-video" onClick={() => onOpen(video)}>{title}</button>
      {author && <small>{author}</small>}</td>
    <td><PlatformBadge platform={video.platform} /></td>
    <td><PublicationDate value={video.publishedAt} /></td>
    <td>{count(video.views)}</td><td>{count(video.likes)}</td>
    <td><FavoriteButton video={video} title={title} saved={saved} busy={busy} onFavorite={onFavorite} /></td>
  </tr>;
}

export function VideoResults(props: Props) {
  const { videos, favorites, view, sort, busy, emptyHint, onView, onSort, onOpen, onFavorite } = props;
  const [inlineId, setInlineId] = useState<string>();

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
            aria-pressed={view === "table"} onClick={() => { setInlineId(undefined); onView("table"); }}><List size={17} /></button>
        </div>
      </div>
    </div>
    {videos.length === 0 ? <div className="panel empty-state">
      <SearchX size={25} /><strong>Здесь пока нет видео</strong><p>{emptyHint}</p>
    </div> : view === "grid" ? <div className="video-grid">
      {videos.map((video) => <VideoCard key={video.id}
        video={video} saved={favorites.includes(video.id)} busy={busy} inline={inlineId === video.id}
        onTogglePreview={() => setInlineId((id) => id === video.id ? undefined : video.id)}
        onOpen={(entry) => { setInlineId(undefined); onOpen(entry); }} onFavorite={onFavorite}
      />)}
    </div> : <div className="panel table-scroll" tabIndex={0} role="region" aria-label="Таблица видео">
      <table>
        <thead><tr><th scope="col">Видео</th><th scope="col">Платформа</th><th scope="col">Дата</th>
          <th scope="col">Просмотры</th><th scope="col">Лайки</th><th scope="col"><span className="sr-only">Избранное</span></th>
        </tr></thead>
        <tbody>{videos.map((video) => <VideoTableRow key={video.id} video={video}
          saved={favorites.includes(video.id)} busy={busy} onOpen={onOpen} onFavorite={onFavorite} />)}</tbody>
      </table>
    </div>}
  </>;
}
