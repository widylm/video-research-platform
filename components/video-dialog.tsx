"use client";

import { BookmarkPlus, Check, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Collection } from "@/lib/library";
import { officialEmbed, videoLabel, type Video } from "@/lib/videos";
import { EditVideoForm } from "./edit-video-form";
import { EmbeddedVideo, VideoPreviewButton } from "./embedded-video";
import { PlatformBadge, VideoMetrics } from "./video-results";

export function VideoDialog({ video, collections, canEdit, canEditDetails, busy, error, notice, onClose, onToggle, onUpdated }: {
  video: Video;
  collections: Collection[];
  canEdit: boolean;
  canEditDetails: boolean;
  busy: boolean;
  error: string;
  notice: string;
  onClose: () => void;
  onUpdated: (video: Video) => void;
  onToggle: (collection: Collection, saved: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const embedSrc = officialEmbed(video);
  const { title, author, editableTitle } = videoLabel(video);

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
        onCancel={() => setEditing(false)} onSaved={(entry) => { setEditing(false); onUpdated(entry); }} />
        : <>
          {author && <p className="video-author">{author}</p>}
          {notice && <p className="video-demo" role="status">{notice}</p>}
          {embedSrc && <>
            <VideoPreviewButton id="details-preview" expanded={previewOpen} onToggle={() => setPreviewOpen((open) => !open)} />
            <div id="details-preview" className="dialog-player" hidden={!previewOpen}>
              {previewOpen && <EmbeddedVideo video={video} src={embedSrc} />}
            </div>
          </>}
          {video.isMock && <p className="video-demo">Демонстрационная карточка</p>}
          <VideoMetrics video={video} full />
          {video.description && <p className="video-description">{video.description}</p>}
          {canEditDetails && <button className="button secondary edit-video-button" type="button" disabled={busy || updating}
            onClick={() => { setPreviewOpen(false); setEditing(true); }}><Pencil size={16} /> Редактировать карточку</button>}
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
