"use client";

import Image from "next/image";
import { BookmarkPlus, Check, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Collection } from "@/lib/library";
import { officialEmbed, videoLabel, type Video, type VideoPreview } from "@/lib/videos";
import { EditVideoForm } from "./edit-video-form";
import { EmbeddedVideo } from "./embedded-video";
import { VideoCoverForm } from "./video-cover-form";
import { PlatformBadge, VideoMetrics } from "./video-results";

export function VideoDialog({ video, preview, collections, canEdit, canEditDetails, busy, error, notice, onClose, onToggle, onUpdated }: {
  video: Video;
  preview?: VideoPreview;
  collections: Collection[];
  canEdit: boolean;
  canEditDetails: boolean;
  busy: boolean;
  error: string;
  notice: string;
  onClose: () => void;
  onUpdated: (video: Video, change: "details" | "cover") => void;
  onToggle: (collection: Collection, saved: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState(false);
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const embedSrc = officialEmbed(video);
  const { title, author, editableTitle } = videoLabel(video, preview);

  return <dialog ref={dialog} className="video-dialog" aria-labelledby="video-title"
    onCancel={(event) => {
      event.preventDefault();
      if (!updating) onClose();
    }} onClick={(event) => { if (!updating && event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-body">
      <div className="dialog-header">
        <PlatformBadge platform={video.platform} />
        <button className="icon-button" aria-label="Закрыть" disabled={updating} onClick={onClose}><X size={20} /></button>
      </div>
      <h2 id="video-title">{editing ? "Редактирование карточки" : title}</h2>
      {editing ? <EditVideoForm video={video} title={editableTitle} busy={updating} onBusy={setUpdating}
        onCancel={() => setEditing(false)} onSaved={(entry) => { setEditing(false); onUpdated(entry, "details"); }} />
        : <>
          {author && <p className="video-author">{author}</p>}
          {notice && <p className="video-demo" role="status">{notice}</p>}
          {embedSrc ? <EmbeddedVideo video={video} src={embedSrc} />
            : video.cover ? <div className="dialog-cover"><Image src={video.cover} alt="" fill sizes="(max-width: 640px) 100vw, 600px" /></div>
              : <p className="notice error" role="status">Ссылка на встроенный плеер недоступна.</p>}
          {video.isMock && <p className="video-demo">Демонстрационная карточка · иллюстрация из фотостока</p>}
          <VideoMetrics video={video} full />
          {video.description && <p className="video-description">{video.description}</p>}
          {canEditDetails && <button className="button secondary edit-video-button" type="button" disabled={busy || updating}
            onClick={() => setEditing(true)}><Pencil size={16} /> Редактировать карточку</button>}
          {canEditDetails && <VideoCoverForm video={video} busy={busy || updating} onBusy={setUpdating}
            onUpdated={(entry) => onUpdated(entry, "cover")} />}
          <div className="tags">{video.hashtags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
          {canEdit && <div className="dialog-collections">
            <h3><BookmarkPlus size={18} /> Коллекции</h3>
            {collections.length ? <div className="collection-options">{collections.map((collection) => {
              const saved = collection.videoIds.includes(video.id);
              return <button key={collection.id} className="button secondary" aria-pressed={saved}
                disabled={busy || updating} onClick={() => onToggle(collection, !saved)}>
                {saved ? <Check size={16} /> : <BookmarkPlus size={16} />} {collection.name}
              </button>;
            })}</div> : <p>Создайте коллекцию в разделе «Коллекции», чтобы добавить видео.</p>}
          </div>}
          {error && <p className="notice error" role="alert">{error}</p>}
        </>}
    </div>
  </dialog>;
}
