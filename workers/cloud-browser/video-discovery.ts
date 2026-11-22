import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { bulkVideoSchema, type BulkPlatform, type BulkQuery, type BulkVideo } from "../../lib/bulk-search.ts";
import { parseVideoLink } from "../../lib/public-video-url.ts";
import { BrowserJobError, browserErrorCode, withDeadline, type BrowserBinding } from "./source.ts";

// A new, opt-in public-page collector. It uses visible page links only:
// no private endpoints, cookies, logins, captcha solving, or invented metrics.
const source = "public_dom_browser";
const maxLinks = 2_000;
const maxVideos = 20;
type Platform = BulkPlatform;

export function discoveryUrl(platform: Platform, keywords: string): string | null {
  const term = keywords.trim().replace(/^#/, "");
  if (!term || term.length > 120) return null;
  if (platform === "tiktok") {
    return `https://www.tiktok.com/search/video?q=${encodeURIComponent(term)}`;
  }
  // Instagram's public tag page is not a general keyword search.
  if (!/^[\p{L}\p{N}_]{1,80}$/u.test(term)) return null;
  return `https://www.instagram.com/explore/tags/${encodeURIComponent(term)}/`;
}

export function normalizePublicLinks(links: readonly string[], platform: Platform, limit = maxVideos): BulkVideo[] {
  const output = new Map<string, BulkVideo>();
  const fetchedAt = new Date().toISOString();
  for (const href of links.slice(0, maxLinks)) {
    const parsed = parseVideoLink(href);
    if (parsed?.kind !== "video" || parsed.video.platform !== platform) continue;
    // An Instagram /p/ link can be a photo; only accept explicit Reel URLs.
    if (platform === "instagram" && !parsed.video.url.includes("/reel/")) continue;
    const { externalId, author, url } = parsed.video;
    const row = bulkVideoSchema.safeParse({
      platform, source, externalId, url, fetchedAt,
      author: author || null,
      originalTitle: null, originalDescription: null, publishedAt: null,
      views: null, likes: null, comments: null, hashtags: null,
    });
    if (row.success) output.set(externalId, row.data);
    if (output.size >= Math.min(maxVideos, Math.max(1, limit))) break;
  }
  return Array.from(output.values());
}

async function scan(page: Page, url: string, platform: Platform, limit: number): Promise<BulkVideo[]> {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    // Media are unnecessary for discovery and consume browser time.
    const skip = ["image", "media", "font"].includes(request.resourceType());
    void (skip ? request.abort() : request.continue()).catch(() => {});
  });
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12_000 });
  if (!response || !response.ok()) throw new BrowserJobError("source_denied");
  const origin = new URL(url).origin;
  if (new URL(page.url()).origin !== origin) throw new BrowserJobError("source_denied");

  let seen: BulkVideo[] = [];
  for (let step = 0; step < 3; step += 1) {
    const state = await page.evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText ?? "").slice(0, 700),
      links: Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 2_000).map((node) => (node as HTMLAnchorElement).href),
    }));
    if (/captcha|verify you are human|security check/i.test(state.title + " " + state.text)) {
      throw new BrowserJobError("manual_intervention_required");
    }
    if (/login required|log in to continue|sign in to continue/i.test(state.title)) {
      throw new BrowserJobError("source_denied");
    }
    seen = normalizePublicLinks(state.links, platform, limit);
    if (seen.length >= limit) break;
    await page.evaluate(() => window.scrollTo(0, document.body?.scrollHeight ?? 0));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  }
  return seen;
}

export interface DiscoveryResult {
  videos: BulkVideo[];
  unavailablePlatforms: Platform[];
}

export async function runSocialDiscovery(
  binding: BrowserBinding, query: BulkQuery,
  cleanup: (promise: Promise<unknown>) => void,
): Promise<DiscoveryResult> {
  let browser: Browser | undefined;
  let expired = false;
  const launch = puppeteer.launch(binding, { keep_alive: 30_000 });
  const close = (session: Browser) => withDeadline(session.close(), 2_000).catch(() => {});
  try {
    return await withDeadline((async () => {
      const session = await launch;
      if (expired) throw new BrowserJobError("timed_out");
      browser = session;
      const platforms: Platform[] = query.platform === "all" ? ["tiktok", "instagram"] : [query.platform];
      const videos = new Map<string, BulkVideo>();
      const unavailablePlatforms: Platform[] = [];
      let firstError: unknown;
      for (const platform of platforms) {
        const url = discoveryUrl(platform, query.keywords);
        if (!url) {
          unavailablePlatforms.push(platform);
          continue;
        }
        const page = await session.newPage();
        try {
          const items = await scan(page, url, platform, query.limit);
          for (const video of items) {
            videos.set(`${video.platform}:${video.externalId}`, video);
            if (videos.size >= query.limit) break;
          }
        } catch (error) {
          unavailablePlatforms.push(platform);
          firstError ??= error;
        } finally {
          await page.close().catch(() => {});
        }
        if (videos.size >= query.limit) break;
      }
      if (videos.size === 0 && firstError) {
        throw firstError instanceof BrowserJobError ? firstError : new BrowserJobError(browserErrorCode(firstError));
      }
      return { videos: [...videos.values()], unavailablePlatforms };
    })(), 45_000);
  } finally {
    expired = true;
    if (browser) await close(browser);
    else cleanup(launch.then(close, () => {}));
  }
}
