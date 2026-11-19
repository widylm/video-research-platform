"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function useCatalogFrameLimit() {
  const [state, setState] = useState({ limit: 0, reducedData: false });

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 740px)");
    const reduced = window.matchMedia("(prefers-reduced-data: reduce)");
    const connection = (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } }).connection;
    function update() {
      const reducedData = reduced.matches || Boolean(connection?.saveData);
      setState({
        limit: document.hidden || reducedData ? 0 : compact.matches ? 1 : 2,
        reducedData,
      });
    }
    update();
    compact.addEventListener("change", update);
    reduced.addEventListener("change", update);
    connection?.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      compact.removeEventListener("change", update);
      reduced.removeEventListener("change", update);
      connection?.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return state;
}

export function CatalogVideoFrame({ src, title, onUnavailable }: {
  src: string;
  title: string;
  onUnavailable: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const timer = window.setTimeout(onUnavailable, 8_000);
    function receive(event: MessageEvent) {
      if (event.origin !== "https://www.tiktok.com" || event.source !== frame.current?.contentWindow) return;
      const message = event.data;
      if (message?.["x-tiktok-player"] !== true) return;
      if (message.type === "onPlayerReady") {
        window.clearTimeout(timer);
        setReady(true);
      } else if (message.type === "onPlayerError" && message.value?.errorCode !== 3002) {
        onUnavailable();
      }
    }
    window.addEventListener("message", receive);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
  }, [src, onUnavailable]);

  return <iframe ref={frame} className="catalog-frame" data-ready={ready} src={src} title={title}
    aria-hidden="true" tabIndex={-1} allow="autoplay 'none'"
    referrerPolicy="strict-origin-when-cross-origin" onError={onUnavailable} />;
}
