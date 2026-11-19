"use client";

import { useState, type FormEvent } from "react";
import { updateVideoDetails } from "@/app/actions";
import type { Video } from "@/lib/videos";

export function EditVideoForm({ video, title, busy, onBusy, onCancel, onSaved }: {
  video: Video;
  title: string;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onCancel: () => void;
  onSaved: (video: Video) => void;
}) {
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    setError("");
    onBusy(true);
    try {
      const result = await updateVideoDetails({ ...fields, id: video.id });
      if ("error" in result) setError(result.error);
      else onSaved(result.data);
    } catch {
      setError("Не удалось обновить карточку. Попробуйте ещё раз.");
    } finally {
      onBusy(false);
    }
  }

  return <form className="add-video-form" onSubmit={submit}>
    <label>Название<input name="title" required maxLength={120} defaultValue={title} /></label>
    <label>Описание<textarea name="description" rows={4} maxLength={2200} defaultValue={video.description} /></label>
    {video.platform === "instagram" && <label>Автор Instagram
      <input name="author" maxLength={31} placeholder="@имя_пользователя" defaultValue={video.author} />
    </label>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="form-actions">
      <button className="button quiet" type="button" disabled={busy} onClick={onCancel}>Отмена</button>
      <button className="button primary" type="submit" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить изменения"}</button>
    </div>
  </form>;
}
