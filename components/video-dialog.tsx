"use client";

import Image from "next/image";
import { BookmarkPlus, Check, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Collection } from "@/lib/library";
import { officialEmbed, type Video } from "@/lib/videos";
import { EmbeddedVideo } from "./embedded-video";
import { PlatformBadge, VideoMetrics } from "./video-results";

export function VideoDialog({ video, collections, canEdit, busy, error, notice, onClose, onToggle }: {
  video: Video;
  collections: Collection[];
  canEdit: boolean;
  busy: boolean;
  error: string;
  notice: string;
  onClose: () => void;
  onToggle: (collection: Collection, saved: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const embedSrc = officialEmbed(video);

  return <dialog ref={dialog} className="video-dialog" aria-labelledby="video-title"
    onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-body">
      <div className="dialog-header">
        <PlatformBadge platform={video.platform} />
        <button className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={20} /></button>
      </div>
      <h2 id="video-title">{video.title}</h2>
      {video.author && <p className="video-author">@{video.author}</p>}
      {notice && <p className="video-demo" role="status">{notice}</p>}
      {embedSrc ? <EmbeddedVideo video={video} src={embedSrc} />
        : video.cover ? <div className="dialog-cover"><Image src={video.cover} alt="" fill sizes="(max-width: 640px) 100vw, 600px" /></div>
          : <p className="notice error" role="status">Ссылка на встроенный плеер недоступна.</p>}
      {video.isMock && <p className="video-demo">Демонстрационная карточка · иллюстрация из фотостока</p>}
      <VideoMetrics video={video} full />
      {video.description && <p className="video-description">{video.description}</p>}
      <div className="tags">{video.hashtags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
      {canEdit && <div className="dialog-collections">
        <h3><BookmarkPlus size={18} /> Коллекции</h3>
        {collections.length ? <div className="collection-options">{collections.map((collection) => {
          const saved = collection.videoIds.includes(video.id);
          return <button key={collection.id} className="button secondary" aria-pressed={saved}
            disabled={busy} onClick={() => onToggle(collection, !saved)}>
            {saved ? <Check size={16} /> : <BookmarkPlus size={16} />} {collection.name}
          </button>;
        })}</div> : <p>Создайте коллекцию в разделе «Коллекции», чтобы добавить видео.</p>}
      </div>}
      {error && <p className="notice error" role="alert">{error}</p>}
    </div>
  </dialog>;
}
