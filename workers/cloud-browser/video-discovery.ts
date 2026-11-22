import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { bulkVideoSchema, type BulkPlatform, type BulkQuery, type BulkVideo } from "../../lib/bulk-search.ts";
import { cloudSocialLimit, type CloudBrowserErrorCode } from "../../lib/cloud-browser-contract.ts";
import { parseVideoLink } from "../../lib/public-video-url.ts";
import { BrowserJobError, withDeadline, type BrowserBinding } from "./source.ts";

// A new, opt-in public-page collector. It uses visible page links only:
// no private endpoints, cookies, logins, captcha solving, or invented metrics.
const source = "public_dom_browser";
const maxLinks = 2_000;
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

export function normalizePublicLinks(links: readonly string[], platform: Platform, limit = cloudSocialLimit): BulkVideo[] {
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
    if (output.size >= Math.min(cloudSocialLimit, Math.max(1, limit))) break;
  }
  return Array.from(output.values());
}

export function socialHttpError(status: number): CloudBrowserErrorCode {
  if (status === 401) return "source_http_401";
  if (status === 403) return "source_http_403";
  if (status === 429) return "source_http_429";
  if (status === 451) return "source_http_451";
  return "source_denied";
}

async function scan(page: Page, url: string, platform: Platform, limit: number): Promise<BulkVideo[]> {
  const origin = new URL(url).origin;
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    // Keep the pilot on the configured public origin and avoid sending forms or downloading media.
    const target = new URL(request.url());
    const allowed = target.origin === origin && request.method() === "GET"
      && !["image", "media", "font"].includes(request.resourceType());
    void (allowed ? request.continue() : request.abort()).catch(() => {});
  });
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12_000 });
  if (!response) throw new BrowserJobError("source_denied");
  if (!response.ok()) throw new BrowserJobError(socialHttpError(response.status()));
  const landed = new URL(page.url());
  if (landed.origin !== origin) throw new BrowserJobError("source_denied");
  const state = await page.evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText ?? "").slice(0, 700),
    links: Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).slice(0, 2_000)
      .filter((node) => node.getClientRects().length > 0).map((node) => node.href),
  }));
  const notice = `${state.title} ${state.text}`;
  if (/captcha|verify you are human|security check/i.test(notice)) {
    throw new BrowserJobError("manual_intervention_required");
  }
  if (/\/(?:login|sign-in)\/?$/i.test(landed.pathname) || /login required|log in to continue|sign in to continue/i.test(notice)) {
    throw new BrowserJobError("source_login_required");
  }
  return normalizePublicLinks(state.links, platform, limit);
}

export async function runSocialDiscovery(
  binding: BrowserBinding, platform: Platform, query: BulkQuery,
  cleanup: (promise: Promise<unknown>) => void,
): Promise<BulkVideo[]> {
  const url = discoveryUrl(platform, query.keywords);
  if (!url) throw new BrowserJobError("invalid_query");
  let browser: Browser | undefined;
  let expired = false;
  const launch = puppeteer.launch(binding, { keep_alive: 30_000 });
  const close = (session: Browser) => withDeadline(session.close(), 2_000).catch(() => {});
  try {
    return await withDeadline((async () => {
      const session = await launch;
      if (expired) throw new BrowserJobError("timed_out");
      browser = session;
      return scan(await session.newPage(), url, platform, query.limit);
    })(), 20_000);
  } finally {
    expired = true;
    if (browser) await close(browser);
    else cleanup(launch.then(close, () => {}));
  }
}
