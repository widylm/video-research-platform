import { z } from "zod";
import { type BulkVideo } from "../../lib/bulk-search.ts";
import { cloudSocialLimit, type CloudBrowserErrorCode } from "../../lib/cloud-browser-contract.ts";
import { parseVideoLink } from "../../lib/public-video-url.ts";
import { BrowserJobError } from "./source.ts";

const endpoint = "https://api.tavily.com/search";
const resultLimit = 20;
const maxResponseBytes = 128 * 1024;
const searchResponse = z.object({ results: z.array(z.object({ url: z.string() })).max(resultLimit) });

function providerStatus(status: number): CloudBrowserErrorCode {
  switch (status) {
    case 401: return "provider_http_401";
    case 403: return "provider_http_403";
    case 429: return "provider_http_429";
    case 432: return "provider_http_432";
    default: return "provider_http_error";
  }
}

async function readResults(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new BrowserJobError("provider_invalid_response");
  const bytes = new Uint8Array(maxResponseBytes);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.length) {
        void reader.cancel().catch(() => {});
        throw new BrowserJobError("provider_invalid_response");
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    return searchResponse.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)))).results;
  } finally {
    reader.releaseLock();
  }
}

export async function searchIndexedTiktok(
  apiKey: string, keywords: string, limit: number, request: typeof fetch = fetch,
): Promise<BulkVideo[]> {
  const signal = AbortSignal.timeout(12_000);
  let response: Response;
  try {
    response = await request(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
      redirect: "error",
      signal,
      body: JSON.stringify({
        query: `${keywords} TikTok videos`,
        search_depth: "basic",
        max_results: resultLimit,
        include_domains: ["tiktok.com"],
        include_domains_mode: "restrict",
        auto_parameters: false,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    });
  } catch {
    throw new BrowserJobError(signal.aborted ? "provider_timeout" : "provider_unreachable");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new BrowserJobError(providerStatus(response.status));
  }

  let results;
  try {
    results = await readResults(response);
  } catch {
    throw new BrowserJobError(signal.aborted ? "provider_timeout" : "provider_invalid_response");
  }

  // A search snippet is not authoritative video metadata. Keep just the canonical link and its identifiers.
  const videos = new Map<string, BulkVideo>();
  const fetchedAt = new Date().toISOString();
  for (const { url } of results) {
    const link = parseVideoLink(url);
    if (link?.kind !== "video" || link.video.platform !== "tiktok") continue;
    const { author, externalId, url: canonicalUrl } = link.video;
    if (videos.has(externalId)) continue;
    videos.set(externalId, {
      platform: "tiktok", source: "tavily_search_index", externalId, url: canonicalUrl, author, fetchedAt,
      originalTitle: null, originalDescription: null, publishedAt: null,
      hashtags: null, views: null, likes: null, comments: null,
    });
    if (videos.size >= Math.min(limit, cloudSocialLimit)) break;
  }
  return [...videos.values()];
}
