import type { Platform } from "./videos";

type PublicVideoUrl = { platform: Platform; externalId: string; url: string; author: string };
type VideoLink = { kind: "video"; video: PublicVideoUrl } | { kind: "short"; platform: Platform; url: string };

const tiktokHosts = ["www.tiktok.com", "tiktok.com", "m.tiktok.com"];
const instagramHosts = ["www.instagram.com", "instagram.com"];
const unsafeCharacters = /[\\\u0000-\u0020\u007f]/;

export function parseVideoLink(input: string): VideoLink | null {
  const raw = input.trim();
  const address = /^https:\/\/([^/?#]+)([^?#]*)/i.exec(raw);
  if (!address || raw.length > 2048 || unsafeCharacters.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname;
  const [, authority, rawPath] = address;
  if (authority.toLowerCase() !== host || url.pathname !== (rawPath || "/")) return null;

  if (tiktokHosts.includes(host)) {
    const match = /^\/@([\w.]{1,64})\/video\/(\d{8,25})\/?$/.exec(url.pathname);
    if (match) {
      const [, author, externalId] = match;
      return { kind: "video", video: {
        platform: "tiktok", externalId, author,
        url: `https://www.tiktok.com/@${author}/video/${externalId}`,
      } };
    }

    if (/^\/t\/[A-Za-z0-9_-]{4,64}\/?$/.test(url.pathname)) {
      return { kind: "short", platform: "tiktok", url: `https://${host}${url.pathname}` };
    }
  }

  if (["vm.tiktok.com", "vt.tiktok.com"].includes(host) && /^\/[A-Za-z0-9_-]{4,64}\/?$/.test(url.pathname)) {
    return { kind: "short", platform: "tiktok", url: `https://${host}${url.pathname}` };
  }

  if (instagramHosts.includes(host)) {
    const match = /^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
    if (match) {
      const [, path, externalId] = match;
      return { kind: "video", video: {
        platform: "instagram", externalId, author: "",
        url: `https://www.instagram.com/${path === "reels" ? "reel" : path}/${externalId}/`,
      } };
    }

    if (/^\/share\/(?:(?:p|reel|reels)\/)?[A-Za-z0-9_-]{4,64}\/?$/.test(url.pathname)) {
      return { kind: "short", platform: "instagram", url: `https://${host}${url.pathname}` };
    }
  }

  return null;
}

const invalidLink = "Вставьте HTTPS-ссылку на видео TikTok или публикацию Instagram.";
const shortLink = "Не удалось раскрыть короткую ссылку. Откройте её в приложении площадки и скопируйте полную ссылку.";
const unavailableLink = "Публикация по этой ссылке недоступна. Возможно, автор удалил её или ограничил доступ.";
const redirects = new Set([301, 302, 303, 307, 308]);

function redirectLink(location: string | null, from: string) {
  if (!location || unsafeCharacters.test(location)) return null;
  // Resolve relative Location paths without normalizing away an untrusted authority.
  if (location.startsWith("//")) return parseVideoLink(`https:${location}`);
  if (/^[a-z][a-z\d+.-]*:/i.test(location)) return parseVideoLink(location);
  return parseVideoLink(new URL(location, from).href);
}

export async function resolveVideoLink(input: string, request: typeof fetch = fetch): Promise<
  { video: PublicVideoUrl } | { error: string }
> {
  let link = parseVideoLink(input);
  if (!link) return { error: invalidLink };

  const signal = AbortSignal.timeout(5_000);
  const visited = new Set<string>();
  while (link.kind === "short") {
    if (visited.size >= 4 || visited.has(link.url)) return { error: shortLink };
    visited.add(link.url);

    try {
      const response = await request(link.url, {
        method: "HEAD", redirect: "manual", credentials: "omit", cache: "no-store", signal,
      });
      if (response.status === 404 || response.status === 410) return { error: unavailableLink };
      if (!redirects.has(response.status)) return { error: shortLink };

      const next = redirectLink(response.headers.get("location"), link.url);
      const platform = next?.kind === "video" ? next.video.platform : next?.platform;
      if (!next || platform !== link.platform) return { error: shortLink };
      link = next;
    } catch {
      return { error: shortLink };
    }
  }

  return { video: link.video };
}

export async function checkVideoEmbed(input: string, request: typeof fetch = fetch) {
  const link = parseVideoLink(input);
  if (link?.kind !== "video") return "unknown";

  const endpoint = new URL(link.video.platform === "tiktok"
    ? "https://www.tiktok.com/oembed" : "https://graph.facebook.com/v27.0/instagram_oembed");
  endpoint.searchParams.set("url", link.video.url);

  try {
    const response = await request(endpoint, {
      redirect: "manual", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(4_000),
    });
    await response.body?.cancel();
    if (response.ok && response.headers.get("content-type")?.includes("application/json")) return "available";
    if (response.status === 404 || response.status === 410) return "unavailable";
  } catch {
    // A network failure does not prove that the publication was removed.
  }
  return "unknown";
}

const tiktokImageHost = /^(?:[a-z0-9-]+\.)*tiktokcdn(?:-us)?\.com$/;

function tiktokThumbnail(value: unknown) {
  if (typeof value !== "string" || value.length > 3072) return undefined;
  try {
    const url = new URL(value);
    const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
    if (authority?.toLowerCase() === url.hostname && tiktokImageHost.test(url.hostname) && !url.hash) {
      return url.href;
    }
  } catch {
    // A missing or malformed thumbnail falls back to the text card.
  }
  return undefined;
}

// Only read structured oEmbed fields; never execute or extract content from HTML.
export function parseTikTokPreview(payload: unknown, externalId: string) {
  if (!payload || typeof payload !== "object") return null;
  const fields = payload as Record<string, unknown>;
  if (fields.provider_name !== "TikTok" || fields.type !== "video") return null;
  if (fields.embed_product_id != null && fields.embed_product_id !== externalId) return null;
  const title = typeof fields.title === "string" ? fields.title.trim().slice(0, 220) : "";
  const authorName = typeof fields.author_name === "string" ? fields.author_name.trim().slice(0, 120) : "";
  const thumbnailUrl = tiktokThumbnail(fields.thumbnail_url);
  return title || authorName || thumbnailUrl ? { title: title || undefined, authorName: authorName || undefined, thumbnailUrl } : null;
}

export async function readTikTokPreview(input: string, request: typeof fetch = fetch) {
  const link = parseVideoLink(input);
  if (link?.kind !== "video" || link.video.platform !== "tiktok") return null;
  const endpoint = new URL("https://www.tiktok.com/oembed");
  endpoint.searchParams.set("url", link.video.url);
  try {
    const response = await request(endpoint, {
      redirect: "manual", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      return null;
    }
    return parseTikTokPreview(await response.json(), link.video.externalId);
  } catch {
    return null;
  }
}
