"use client";

import Image from "next/image";
import { BookmarkPlus, Check, ExternalLink, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Collection } from "@/lib/library";
import { officialEmbed, platformNames, type Video } from "@/lib/videos";
import { PlatformBadge, VideoMetrics } from "./video-results";

export function VideoDialog({ video, collections, canEdit, busy, error, onClose, onToggle }: {
  video: Video;
  collections: Collection[];
  canEdit: boolean;
  busy: boolean;
  error: string;
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
      <p className="video-author">@{video.author}</p>
      {embedSrc ? <iframe className="official-embed" src={embedSrc} title={`Видео ${platformNames[video.platform]}`}
        allow="encrypted-media; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
        : <div className="dialog-cover"><Image src={video.cover} alt="" fill sizes="(max-width: 640px) 100vw, 600px" /></div>}
      {embedSrc && <a href={video.url ?? embedSrc} target="_blank" rel="noreferrer"
        className="external-link">Открыть в {platformNames[video.platform]} <ExternalLink size={15} /></a>}
      {video.isMock && <p className="video-demo">Демонстрационная карточка · иллюстрация из фотостока</p>}
      <VideoMetrics video={video} full />
      <p className="video-description">{video.description}</p>
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
