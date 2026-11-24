import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { z } from "zod";
import type { BrowserSource, CloudBrowserDiagnostics, CloudBrowserErrorCode, CloudBrowserRecord } from "../../lib/cloud-browser-contract.ts";
import type { BulkQuery } from "../../lib/bulk-search.ts";

export type BrowserBinding = Parameters<typeof puppeteer.launch>[0];
const fetchTimeout = 12_000;
const localFetchTimeout = 45_000; // Wrangler may install Chromium on the first use of its local binding.

export class BrowserJobError extends Error {
  readonly code: CloudBrowserErrorCode;
  readonly diagnostics?: CloudBrowserDiagnostics;
  constructor(code: CloudBrowserErrorCode, diagnostics?: CloudBrowserDiagnostics) {
    super(code); this.code = code; this.diagnostics = diagnostics;
  }
}

export function neutralSourceUrl(mode?: string, configuredUrl?: string): string | null {
  if (!configuredUrl || !URL.canParse(configuredUrl)) return null;
  if (mode === "local" && /^http:\/\/127\.0\.0\.1:\d{1,5}\/catalog$/.test(configuredUrl)) return configuredUrl;
  // The account operator may opt in to a static page they control on Cloudflare.
  if (mode === "hosted" && /^https:\/\/(?:[a-z0-9-]+\.)+(?:workers|pages)\.dev\/catalog$/.test(configuredUrl)) return configuredUrl;
  return null;
}

export async function withDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrowserJobError("timed_out")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

const pageFields = z.object({ challenge: z.boolean(), title: z.string().trim().max(300), description: z.string().trim().max(2_000) });
type PageFields = z.infer<typeof pageFields>;

export function neutralSource(page: Page, url: string, query: BulkQuery): BrowserSource<PageFields, CloudBrowserRecord> {
  return {
    async read() {
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        // Only the fixed document is allowed. No redirects, third-party assets or user-selected hosts.
        const allowed = request.isNavigationRequest() && request.method() === "GET" && request.url() === url;
        void (allowed ? request.continue() : request.abort()).catch(() => {});
      });
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 8_000 });
      if (!response || page.url() !== url) throw new BrowserJobError("source_denied");
      const content = pageFields.parse(await page.evaluate(() => ({
        challenge: !!document.querySelector('[data-challenge="captcha"], iframe[src*="captcha"], #challenge-running')
          || /captcha|verify you are human/i.test(document.title),
        title: (document.querySelector("h1")?.textContent ?? document.title).trim().slice(0, 300),
        description: [...document.querySelectorAll("main p, body > p, body > div > p")].slice(0, 3)
          .map((node) => node.textContent?.trim() ?? "").join(" ").slice(0, 2_000),
      })));
      if (content.challenge) throw new BrowserJobError("manual_intervention_required");
      if (!response.ok()) throw new BrowserJobError("source_denied");
      return content;
    },
    normalize({ title, description }) {
      const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
      const text = normalize(`${title} ${description}`);
      if (!title || !normalize(query.keywords).split(/\s+/).every((term) => text.includes(term))) return [];
      return [{ id: url, url, title, description, fetchedAt: new Date().toISOString() }];
    },
  };
}

export function browserErrorCode(error: unknown): CloudBrowserErrorCode {
  if (error instanceof BrowserJobError) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "timed_out";
  if (error instanceof Error && /\b429\b/.test(error.message)) return "browser_quota";
  return "browser_error";
}

export async function runNeutralBrowser(binding: BrowserBinding, url: string, query: BulkQuery,
  cleanup: (operation: Promise<unknown>) => void): Promise<readonly CloudBrowserRecord[]> {
  let browser: Browser | undefined;
  let expired = false;
  const launch = puppeteer.launch(binding, { keep_alive: 30_000 });
  const close = (session: Browser) => withDeadline(session.close(), 2_000).catch(() => {});
  try {
    return await withDeadline((async () => {
      const session = await launch;
      if (expired) return [];
      browser = session;
      const source = neutralSource(await session.newPage(), url, query);
      const raw = await source.read();
      return source.normalize(raw);
    })(), url.startsWith("http://127.0.0.1:") ? localFetchTimeout : fetchTimeout);
  } finally {
    expired = true;
    if (browser) await close(browser);
    else cleanup(launch.then(close, () => {}));
  }
}
