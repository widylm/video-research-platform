"use client";

import { ImagePlus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { coverMaxBytes, coverMaxSide, coverType, coverUploadMaxBytes } from "@/lib/video-cover";
import type { Video } from "@/lib/videos";

async function prepareCover(file: File) {
  if (file.size > coverUploadMaxBytes) throw new Error("Выберите изображение размером до 5 МиБ.");
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const webp = String.fromCharCode(...header.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...header.subarray(8, 12)) === "WEBP";
  if (!png && !jpeg && !webp) throw new Error("Выберите изображение JPEG, PNG или WebP.");

  const image = await createImageBitmap(file).catch(() => null);
  if (!image) throw new Error("Не удалось прочитать изображение. Выберите другой файл.");

  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, coverMaxSide / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Не удалось подготовить обложку в этом браузере.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.7, 0.5, 0.3]) {
      const result = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, coverType, quality));
      if (result?.type === coverType && result.size <= coverMaxBytes) return result;
    }
    throw new Error("Не удалось сжать обложку до 512 КиБ. Попробуйте изображение меньшего размера.");
  } finally {
    image.close();
  }
}

export function VideoCoverForm({ video, busy, onBusy, onUpdated }: {
  video: Video;
  busy: boolean;
  onBusy: (value: boolean) => void;
  onUpdated: (video: Video) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function changeCover(file?: File) {
    if (busy) return;
    setError("");
    setNotice("");
    onBusy(true);
    try {
      const response = await fetch(`/api/videos/${video.id}/cover`, file
        ? { method: "PUT", headers: { "Content-Type": coverType }, body: await prepareCover(file) }
        : { method: "DELETE" });
      const result = response.status === 204 ? {} : await response.json();
      if (!response.ok) throw new Error(result.error || "Не удалось обновить обложку.");
      onUpdated({ ...video, coverRevision: result.revision });
      setNotice(file ? "Обложка сохранена." : "Ручная обложка удалена.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось обновить обложку.");
    } finally {
      onBusy(false);
    }
  }

  return <div className="video-cover-form" role="group" aria-label="Обложка карточки">
    <div className="video-cover-actions">
      <input ref={input} type="file" aria-label="Файл обложки" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
        hidden disabled={busy} onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void changeCover(file);
        }} />
      <button type="button" className="button secondary" disabled={busy} onClick={() => input.current?.click()}>
        <ImagePlus size={16} aria-hidden="true" /> {video.coverRevision ? "Заменить обложку" : "Добавить обложку"}
      </button>
      {video.coverRevision && <button type="button" className="button secondary" disabled={busy}
        onClick={() => void changeCover()}>
        <Trash2 size={16} aria-hidden="true" /> Удалить обложку
      </button>}
    </div>
    <p className="video-demo">JPEG, PNG или WebP до 5 МиБ.</p>
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}
