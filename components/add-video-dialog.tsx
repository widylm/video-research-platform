"use client";

import { Link2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { savePublicVideo } from "@/app/actions";
import type { Collection } from "@/lib/library";
import type { Video } from "@/lib/videos";

export function AddVideoDialog({ collections, collectionId, onClose, onSaved }: {
  collections: Collection[];
  collectionId?: string;
  onClose: () => void;
  onSaved: (video: Video, created: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await savePublicVideo(Object.fromEntries(new FormData(event.currentTarget)));
      if ("error" in result) setError(result.error);
      else onSaved(result.data.video, result.data.created);
    } catch {
      setError("Не удалось сохранить видео. Попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="video-dialog" aria-labelledby="add-video-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-body">
      <div className="dialog-header">
        <h2 id="add-video-title">Добавить видео</h2>
        <button type="button" className="icon-button" disabled={busy} aria-label="Закрыть" onClick={onClose}><X size={20} /></button>
      </div>
      <form className="add-video-form" onSubmit={save}>
        <label>Ссылка на видео
          <input name="url" inputMode="url" placeholder="https://…" required maxLength={2048}
            aria-describedby="add-video-link-hint" autoFocus />
        </label>
        <p className="field-hint" id="add-video-link-hint">Видео TikTok, Reels и публикации Instagram. Поддерживаются короткие ссылки.</p>
        <label>Название
          <input name="title" maxLength={120} placeholder="Как назвать это видео в каталоге" />
        </label>
        <label>Описание
          <textarea name="description" rows={3} maxLength={2200} placeholder="О чём это видео" />
        </label>
        <label>Хэштеги
          <input name="hashtags" maxLength={600} placeholder="#кофе, #лайфстайл" />
        </label>
        <div className="add-video-fields">
          <label>Дата публикации<input name="publishedAt" type="date" /></label>
          <label>Просмотры<input name="views" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} /></label>
          <label>Лайки<input name="likes" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} /></label>
        </div>
        <p className="field-hint">Оставьте неизвестную дату и метрики пустыми.</p>
        <label>Коллекция
          <select name="collectionId" defaultValue={collectionId ?? ""}>
            <option value="">Только в каталог</option>
            {collections.map((item) => <option key={item.id} value={item.id}>
              {item.name} · {item.shared ? "Общая" : "Личная"}
            </option>)}
          </select>
        </label>
        <p className="field-hint">Карточка видна команде. Состав личной коллекции виден только её владельцу.</p>
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="form-actions">
          <button className="button quiet" type="button" disabled={busy} onClick={onClose}>Отмена</button>
          <button className="button primary" type="submit" disabled={busy}>
            <Link2 size={17} /> {busy ? "Сохраняем…" : "Сохранить видео"}
          </button>
        </div>
      </form>
    </div>
  </dialog>;
}
