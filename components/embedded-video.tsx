"use client";

import { ExternalLink, Play } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { checkSavedVideo } from "@/app/actions";
import { platformNames, type Video } from "@/lib/videos";

const messages = {
  missing: "Платформа не нашла публикацию. Возможно, автор удалил её или ограничил доступ.",
  player: "Встроенный плеер недоступен. Попробуйте открыть публикацию на платформе.",
  unknown: "Платформа не подтвердила доступность. Откройте публикацию на платформе, чтобы проверить ссылку.",
  available: "Платформа подтвердила встраивание. Если плеер не запускается, откройте публикацию на платформе.",
};

export function VideoPreviewButton({ id, expanded, onToggle }: {
  id: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return <button className="button secondary video-preview-button" type="button"
    onClick={onToggle} aria-expanded={expanded} aria-controls={id}>
    <Play size={16} aria-hidden="true" /> {expanded ? "Скрыть предпросмотр" : "Предпросмотр"}
  </button>;
}

export function EmbeddedVideo({ video, src }: { video: Video; src: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<keyof typeof messages>();
  const [checking, startTransition] = useTransition();

  useEffect(() => {
    if (video.platform !== "tiktok") return;
    function receive(event: MessageEvent) {
      if (event.origin !== "https://www.tiktok.com" || event.source !== frame.current?.contentWindow) return;
      const message = event.data;
      if (message?.["x-tiktok-player"] !== true || message.type !== "onPlayerError") return;
      if (message.value?.errorCode === 3002) return; // The user can start playback manually.
      setStatus(message.value?.errorCode === 1001 ? "missing" : "player");
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [video.platform]);

  const showFallback = status === "missing" || status === "player";

  return <>
    {!showFallback && <iframe ref={frame} className="official-embed" src={src} title={`Видео ${platformNames[video.platform]}`}
      allow="encrypted-media; fullscreen; picture-in-picture" allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin" onError={() => setStatus("player")} />}
    <div className="player-links">
      <a href={video.url ?? src} target="_blank" rel="noreferrer" className="external-link">
        Открыть в {platformNames[video.platform]} <ExternalLink size={15} />
      </a>
      <button type="button" className="button quiet" disabled={checking} onClick={() => startTransition(async () => {
        try {
          const result = await checkSavedVideo(video.id);
          setStatus(result === "unavailable" ? "missing" : result);
        } catch {
          setStatus("unknown");
        }
      })}>{checking ? "Проверяем…" : "Проверить доступность"}</button>
    </div>
    <p className="field-hint" role="status">
      {showFallback ? "Ролик можно открыть на платформе." : status ? messages[status] : "Если видео не воспроизводится, проверьте доступность или откройте оригинал."}
    </p>
  </>;
}
