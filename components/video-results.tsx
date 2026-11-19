"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  CalendarDays, Eye, Film, Heart, LayoutGrid, List, Play, SearchX,
} from "lucide-react";
import { manualCoverUrl } from "@/lib/video-cover";
import { officialEmbed, platformNames, sortOptions, videoLabel, type Sort, type Video, type VideoPreview } from "@/lib/videos";
import { EmbeddedVideo } from "./embedded-video";

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
  onOpen: (video: Video, preview?: VideoPreview) => void;
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

function useVideoPreview<T extends HTMLElement>(video: Video) {
  const { id, isMock, platform } = video;
  const ref = useRef<T>(null);
  const [preview, setPreview] = useState<VideoPreview | null>();

  useEffect(() => {
    const element = ref.current;
    if (!element || isMock || platform !== "tiktok" || typeof IntersectionObserver === "undefined") return;
    const controller = new AbortController();
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void fetch(`/api/videos/${id}/preview`, { signal: controller.signal }).then(async (response) => {
        const result = response.ok ? await response.json() : null;
        if (!controller.signal.aborted) setPreview(result);
      }).catch(() => {
        if (!controller.signal.aborted) setPreview(null);
      });
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [id, isMock, platform]);

  return { ref, preview: preview ?? undefined };
}

type EntryProps = Pick<Props, "busy" | "onOpen" | "onFavorite"> & { video: Video; saved: boolean };

function VideoCard({ video, saved, busy, inline, onTogglePreview, onOpen, onFavorite }: EntryProps & {
  inline: boolean;
  onTogglePreview: () => void;
}) {
  const { ref, preview } = useVideoPreview<HTMLElement>(video);
  const [loadedCover, setLoadedCover] = useState("");
  const [failedCovers, setFailedCovers] = useState<readonly string[]>([]);
  const { title, author } = videoLabel(video, preview);
  const manual = video.coverRevision && manualCoverUrl(video.id, video.coverRevision);
  const official = video.isMock ? video.cover : preview?.thumbnailUrl;
  const cover = [manual, official].find((url) => url && !failedCovers.includes(url));
  const showCover = Boolean(cover && (video.isMock || loadedCover === cover) && !inline);
  const embed = officialEmbed(video);
  const open = () => onOpen(video, preview);
  const badge = <PlatformBadge platform={video.platform} />;
  const favorite = <FavoriteButton video={video} title={title} saved={saved} busy={busy} onFavorite={onFavorite} />;

  return <article className="panel video-card" ref={ref}>
    {cover && <div className={showCover ? "video-cover" : "video-cover-pending"} aria-hidden={!showCover}>
      <Image key={cover} src={cover} alt="" fill sizes="(max-width: 660px) 100vw, (max-width: 1260px) 45vw, 26vw"
        unoptimized referrerPolicy="no-referrer" onLoad={() => setLoadedCover(cover)}
        onError={() => setFailedCovers((current) => [...current, cover])} />
      {showCover && <>
        <button className="cover-trigger" onClick={open} aria-label={`Подробнее: ${title}`}>
          <span className="play-mark" aria-hidden="true"><Play size={19} fill="currentColor" /></span>
        </button>
        {badge}{favorite}
      </>}
    </div>}
    {!showCover && <div className="video-card-header">{badge}{favorite}</div>}

    <div className="video-body">
      <h3><button onClick={open}>{title}</button></h3>
      <p className="video-byline">
        <span className="video-author">{author || "Автор не указан"}</span>
        {video.publishedAt && <PublicationDate value={video.publishedAt} />}
      </p>
      {!video.isMock && <p className="video-card-description">{video.description || "Описание не добавлено"}</p>}
      {!video.isMock && video.hashtags.length > 0 && <div className="tags catalog-tags">
        {video.hashtags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}
      </div>}
      <VideoMetrics video={video} />
      {embed && <button className="button secondary catalog-preview-button" type="button"
        onClick={onTogglePreview} aria-expanded={inline} aria-controls={`preview-${video.id}`}>
        <Play size={16} aria-hidden="true" /> {inline ? "Скрыть предпросмотр" : "Предпросмотр"}
      </button>}
    </div>
    {embed && <div id={`preview-${video.id}`} className={inline ? "catalog-player" : undefined} hidden={!inline}>
      {inline && <EmbeddedVideo video={video} src={embed} hideFailedFrame />}
    </div>}
  </article>;
}

function VideoTableRow({ video, saved, busy, onOpen, onFavorite }: EntryProps) {
  const { ref, preview } = useVideoPreview<HTMLTableRowElement>(video);
  const { title, author } = videoLabel(video, preview);
  return <tr ref={ref}>
    <td><button className="table-video" onClick={() => onOpen(video, preview)}>{title}</button>
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
        onOpen={(entry, preview) => { setInlineId(undefined); onOpen(entry, preview); }} onFavorite={onFavorite}
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
