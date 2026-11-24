import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { bulkVideoSchema, type BulkVideo } from "../../lib/bulk-search.ts";
import type { CloudBrowserApiResponse, CloudBrowserDiagnostics, CloudBrowserErrorCode, FashionRadarQuery } from "../../lib/cloud-browser-contract.ts";
import { parseVideoLink } from "../../lib/public-video-url.ts";
import { BrowserJobError, withDeadline, type BrowserBinding } from "./source.ts";
import { discoveryUrl, explicitlyEmpty, extractMetadata, filterCollected, mergeMetadata, pageProblem } from "./fashion-radar/metadata.mjs";
import { readFashionRadarPage } from "./page-state.ts";
import { requestHumanVerification, verificationScreenshot, type VerificationHooks } from "./verification.ts";

const totalTime = 45_000;
const maxPayload = 2_000_000;
const maxResponses = 24;
const resourceHosts = ["tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "ttwstatic.com",
  "byteoversea.com", "ibytedtos.com", "tiktokv.com", "instagram.com", "cdninstagram.com", "fbcdn.net", "facebook.com"];
// Exact service hosts observed in the failed live run; do not allow arbitrary
// .eu hosts or navigate to a verification endpoint. Site scripts may load their
// normal dependencies; any displayed verification still stops collection.
const tiktokServiceHosts = new Set([
  "mssdk16-normal-useastred.tiktokw.eu",
  "verification16-normal-useastred.tiktokw.eu",
  "starling16-normal-useastred.tiktokv.eu",
]);

export function allowedBrowserResource(raw: string, navigation: boolean, origin: string, method: string, type: string) {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !["GET", "POST"].includes(method)) return false;
  if (navigation) return method === "GET" && url.origin === origin;
  return !["media", "font"].includes(type)
    && (resourceHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
      || origin === "https://www.tiktok.com" && tiktokServiceHosts.has(url.hostname));
}

export function responseIsMetadata(raw: string, platform: FashionRadarQuery["platform"]) {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return url.origin === (platform === "tiktok" ? "https://www.tiktok.com" : "https://www.instagram.com")
    && (platform === "tiktok" ? /^\/api\/(challenge\/item_list|search\/general\/full|search\/item\/full)/.test(url.pathname)
      : /^\/(graphql|api\/v1\/)/.test(url.pathname));
}

export async function collectFashionRadar(page: Page, query: FashionRadarQuery,
  options: { pause?: (ms: number) => Promise<void>; now?: () => number;
    onVerification?: (page: Page, diagnostics: CloudBrowserDiagnostics) => Promise<void> } = {}) {
  const url = discoveryUrl(query.platform, query.keywords, query.searchMode);
  if (!url) throw new BrowserJobError("invalid_query");
  const now = options.now ?? Date.now;
  const pause = options.pause ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const startedAt = now();
  let deadline = startedAt + 35_000;
  const origin = new URL(url).origin;
  const rows = new Map<string, BulkVideo>();
  const visible = new Map<string, string>();
  const pending = new Set<Promise<void>>();
  let responses = 0;
  let rateLimited = false;
  let empty = false;
  let pageTitle = "";
  let navigationStatus: number | undefined = undefined;
  let failedRequests = 0;
  const blockedHosts = new Set<string>();
  const apiResponses: CloudBrowserApiResponse[] = [];
  let challengeVisible = false;
  let assisted = false;
  const diagnostics = (): CloudBrowserDiagnostics => ({ navigationStatus, pageTitle,
    elapsedMs: Math.max(0, now() - startedAt), visibleLinks: visible.size,
    metadataResponses: responses, metadataItems: rows.size, failedRequests, blockedHosts: [...blockedHosts],
    apiResponses: apiResponses.map(response => ({ ...response })), challengeVisible });
  const fail = (code: CloudBrowserErrorCode): never => { throw new BrowserJobError(code, diagnostics()); };
  const add = (data: unknown) => {
    let count = 0;
    for (const row of extractMetadata(query.platform, data)) {
      const parsed = bulkVideoSchema.safeParse(row);
      if (parsed.success) {
        rows.set(row.externalId, mergeMetadata(rows.get(row.externalId), parsed.data));
        count += 1;
      }
    }
    return count;
  };

  await page.setRequestInterception(true);
  page.on("request", request => {
    const allowed = allowedBrowserResource(request.url(), request.isNavigationRequest(), origin,
      request.method(), request.resourceType());
    if (!allowed && ["script", "document", "fetch", "xhr", "stylesheet"].includes(request.resourceType())
      && blockedHosts.size < 12 && URL.canParse(request.url())) {
      // Only hostnames, never request URLs, query strings, headers or cookies.
      blockedHosts.add(new URL(request.url()).hostname.slice(0, 120));
    }
    void (allowed ? request.continue() : request.abort()).catch(() => {});
  });
  page.on("requestfailed", request => {
    if (allowedBrowserResource(request.url(), request.isNavigationRequest(), origin,
      request.method(), request.resourceType())) failedRequests += 1;
  });
  page.on("response", response => {
    if (!responseIsMetadata(response.url(), query.platform) || responses >= maxResponses) return;
    responses += 1;
    const info: CloudBrowserApiResponse = { httpStatus: response.status(), format: "skipped", items: 0 };
    if (apiResponses.length === 4) apiResponses.shift();
    apiResponses.push(info);
    if (response.status() === 429) { rateLimited = true; return; }
    if (!response.ok() || Number(response.headers()["content-length"] ?? 0) > maxPayload) return;
    const task = (async () => {
      const body = await response.text();
      if (body.length > maxPayload) return;
      if (!body.trim()) { info.format = "empty"; return; }
      let data: unknown;
      try { data = JSON.parse(body.replace(/^for \(;;\);/, "")); }
      catch { info.format = "invalid_json"; return; }
      info.format = "json";
      if (data && typeof data === "object") {
        const envelope = data as Record<string, unknown>;
        const code = envelope.statusCode ?? envelope.status_code;
        if (typeof code === "number" && Number.isSafeInteger(code) && Math.abs(code) <= 1_000_000_000
          || typeof code === "string" && /^-?\d{1,9}$/.test(code)) info.apiCode = Number(code);
      }
      info.items = add(data);
    })().catch(() => { info.format = "unreadable"; }).finally(() => pending.delete(task));
    pending.add(task);
  });

  const navigation = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12_000 });
  if (!navigation) return fail("source_not_ready");
  navigationStatus = navigation.status();
  if (navigationStatus === 429) fail("source_rate_limited");
  if (navigationStatus === 401) fail("source_login_required");
  if (!navigation.ok()) fail("source_denied");
  const landed = new URL(page.url());
  if (landed.origin !== origin) fail("source_denied");

  let unchanged = 0;
  for (let step = 0; step < 8 && now() < deadline && !rateLimited; step += 1) {
    // Give JavaScript and normal cross-origin API requests time to populate the page.
    await pause(2_000);
    const state = await page.evaluate(readFashionRadarPage);
    pageTitle = state.title.slice(0, 160);
    challengeVisible = state.challenge;
    const problem = pageProblem(query.platform, state);
    if (problem === "manual_intervention_required" && options.onVerification && !assisted) {
      assisted = true;
      const pausedAt = now();
      await options.onVerification(page, diagnostics());
      deadline += now() - pausedAt;
      // A human may finish on the home/login page. Resume the requested search,
      // rather than treating an unrelated feed as matching the user's query.
      if (page.url() !== url) {
        const resumed = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12_000 });
        if (!resumed) fail("source_not_ready");
        if (resumed?.status() === 429) fail("source_rate_limited");
        if (resumed?.status() === 401) fail("source_login_required");
        if (!resumed?.ok()) fail("source_denied");
      }
      unchanged = 0;
      continue;
    }
    if (problem) fail(problem);
    empty = explicitlyEmpty(state.text);
    const before = visible.size;
    for (const href of state.links) {
      const link = parseVideoLink(href);
      if (link?.kind !== "video" || link.video.platform !== query.platform) continue;
      const inspectionUrl = link.video.url;
      if (visible.size < 100) visible.set(link.video.externalId, inspectionUrl);
    }
    for (const raw of state.hydration) { try { add(JSON.parse(raw)); } catch { /* Incomplete hydration is not a zero count. */ } }
    const found = filterCollected([...rows.values()].filter(row => visible.has(row.externalId)), query);
    if (found.length >= query.limit || empty) break;
    unchanged = visible.size === before ? unchanged + 1 : 0;
    // An empty initial render is not the end of the result list. TikTok may
    // load scripts/data after several seconds on a fresh cloud browser.
    if (visible.size > 0 && step >= 3 && unchanged >= 3) break;
    await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/video/"],a[href*="/reel/"],a[href*="/p/"]');
      const last = links.item(links.length - 1);
      last?.scrollIntoView({ block: "end" });
      let parent = last?.parentElement;
      while (parent && parent !== document.body) {
        if (parent.scrollHeight > parent.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
          parent.scrollBy(0, Math.max(600, parent.clientHeight)); return;
        }
        parent = parent.parentElement;
      }
      window.scrollBy(0, Math.max(600, innerHeight));
    });
  }

  // Instagram often omits timestamps/counters in its listing. Read a few original
  // pages, as the local collector did; never synthesize numbers from search snippets.
  let inspected = 0;
  for (const [id, detailUrl] of visible) {
    if (now() >= deadline || rateLimited || inspected >= 5) break;
    const row = rows.get(id);
    if (row?.publishedAt && row.views !== null && row.likes !== null) continue;
    inspected += 1;
    try {
      const detail = await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 4_000 });
      if (detail?.status() === 429) { rateLimited = true; break; }
      if (!detail?.ok()) continue;
      await pause(400);
      const data = await page.evaluate(() => ({
        url: location.href, text: (document.body?.innerText ?? "").slice(0, 2_000), links: [] as string[],
        hydration: [...document.querySelectorAll('script[type="application/json"],script#__UNIVERSAL_DATA_FOR_REHYDRATION__,script#SIGI_STATE')]
          .slice(0, 12).map(node => node.textContent ?? "").filter(text => text.length < 1_000_000),
      }));
      if (pageProblem(query.platform, data) === "manual_intervention_required") break;
      for (const raw of data.hydration) { try { add(JSON.parse(raw)); } catch {} }
    } catch { /* Keep a partial collection if one detail page fails. */ }
  }
  await withDeadline(Promise.allSettled([...pending]), 2_000);

  if (!visible.size && !empty) fail(rateLimited ? "source_rate_limited" : "source_not_ready");
  // Links alone still represent real videos, with missing fields kept explicitly unknown.
  for (const [id, href] of visible) {
    if (rows.has(id)) continue;
    const link = parseVideoLink(href);
    if (link?.kind !== "video" || query.platform === "instagram" && !href.includes("/reel/")) continue;
    rows.set(id, { platform: query.platform, externalId: id, url: href, source: "fashion-radar-browser",
      fetchedAt: new Date().toISOString(), author: link.video.author || null, originalTitle: null,
      originalDescription: null, publishedAt: null, views: null, likes: null, comments: null, hashtags: null });
  }
  const candidates = [...rows.values()].filter(row => visible.has(row.externalId));
  return { videos: filterCollected(candidates, query), scanned: visible.size,
    limited: !empty, warning: rateLimited ? "source_rate_limited" as const : undefined };
}

export async function runFashionRadar(binding: BrowserBinding, query: FashionRadarQuery,
  cleanup: (operation: Promise<unknown>) => void, verification?: VerificationHooks) {
  let browser: Browser | undefined;
  let expired = false;
  const launch = puppeteer.launch(binding, { keep_alive: 30_000,
    guardrails: verification ? { allowedDomains: resourceHosts.flatMap(host => [host, `*.${host}`]).concat([...tiktokServiceHosts]) } : undefined });
  const close = (session: Browser) => withDeadline(session.close(), 2_000).catch(() => {});
  try {
    return await withDeadline((async () => {
      browser = await launch;
      if (expired) throw new BrowserJobError("timed_out");
      const page = await browser.newPage();
      let humanAttempted = false;
      let screenshot: string | undefined;
      try {
        return await collectFashionRadar(page, query, { onVerification: verification ? async (page, diagnostics) => {
          // Only capture the initial, fresh guest page, before the user can type.
          screenshot = await verificationScreenshot(page);
          humanAttempted = true;
          await requestHumanVerification(page, { ...diagnostics, screenshot }, verification);
        } : undefined });
      } catch (error) {
        if (error instanceof BrowserJobError && error.diagnostics) {
          if (!humanAttempted && ["manual_intervention_required", "source_not_ready"].includes(error.code)) {
            screenshot = await verificationScreenshot(page);
          }
          if (screenshot && !error.diagnostics.screenshot) {
            throw new BrowserJobError(error.code, { ...error.diagnostics, screenshot });
          }
        }
        throw error;
      }
    })(), verification ? 170_000 : totalTime);
  } finally {
    expired = true;
    if (browser) await close(browser);
    else cleanup(launch.then(close, () => {}));
  }
}
