import { z } from "zod";
import { cloudBrowserRequest, socialPilotPlatform, type CloudBrowserJob } from "../../lib/cloud-browser-contract.ts";
import type { BulkQuery } from "../../lib/bulk-search.ts";
import { searchIndexedTiktok } from "./tiktok-search.ts";
import { discoveryUrl, runSocialDiscovery } from "./video-discovery.ts";
import { storeObservations } from "./catalog.ts";
import { browserErrorCode, neutralSourceUrl, runNeutralBrowser, type BrowserBinding } from "./source.ts";

interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
interface State {
  storage: Transaction & { transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> };
  waitUntil(operation: Promise<unknown>): void;
}
interface Env {
  BROWSER?: BrowserBinding;
  KADR_BROWSER_SOURCE?: string;
  KADR_ENABLE_SOCIAL_DISCOVERY?: string;
  KADR_SOCIAL_DISCOVERY_PLATFORM?: string;
  KADR_ENABLE_TIKTOK_SEARCH?: string;
  TAVILY_API_KEY?: string;
  KADR_BROWSER_SOURCE_URL?: string;
  CLOUD_BROWSER_JOBS: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}
type StoredJob = CloudBrowserJob & { query: BulkQuery; reservationDay: string };
type Budget = { day: string; requests: number; reservedMs: number };
const slot = "active";
const lastStart = "last-start";
const budgetKey = "budget";
const socialAttempt = "social-attempt-used";
const providerAttempt = "tiktok-search-attempt-used";
const reservationMs = 60_000;
const maxReservedMs = 8 * reservationMs;
const maxRuns = 8;
const cooldownMs = 20_000;
const jobKey = (id: string) => `job:${id}`;
const userKey = (user: string) => `user:${user}`;
const json = (body: object, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const publicJob = ({ id, state, keywords, records, videos, mode, error }: StoredJob): CloudBrowserJob => ({ id, state, keywords, records, videos, mode, error });
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export function reserveBudget(previous: Budget | undefined, now: number): Budget | null {
  const day = utcDay(now);
  const used = previous?.day === day ? previous : { day, requests: 0, reservedMs: 0 };
  if (used.requests >= maxRuns || used.reservedMs + reservationMs > maxReservedMs) return null;
  return { day, requests: used.requests + 1, reservedMs: used.reservedMs + reservationMs };
}

export class CloudBrowserJobs {
  private readonly state: State;
  private readonly env: Env;

  constructor(state: State, env: Env) { this.state = state; this.env = env; }

  async fetch(request: Request) {
    const user = z.uuid().safeParse(request.headers.get("x-kadr-profile"));
    if (!user.success) return json({ error: "forbidden" }, 403);
    const storage = this.state.storage;
    if (request.method === "GET") {
      const id = await storage.get<string>(userKey(user.data));
      const job = id ? await storage.get<StoredJob>(jobKey(id)) : null;
      return json({ job: job ? publicJob(job) : null });
    }
    if (request.method !== "POST") return json({ error: "invalid_query" }, 405);
    const query = cloudBrowserRequest.safeParse(await request.json().catch(() => null));
    if (!query.success) return json({ error: "invalid_query" }, 400);
    const provider = "mode" in query.data && query.data.mode === "provider";
    if (provider && (this.env.KADR_ENABLE_TIKTOK_SEARCH !== "1" || !this.env.TAVILY_API_KEY?.trim())) return json({ error: "provider_disabled" }, 503);
    if (!provider && this.env.KADR_ENABLE_TIKTOK_SEARCH === "1") return json({ error: "invalid_query" }, 400);
    if (!provider && !this.env.BROWSER) return json({ error: "source_unavailable" }, 503);
    const social = "mode" in query.data && query.data.mode === "social";
    const allowedPlatform = socialPilotPlatform(this.env);
    if (social) {
      if (allowedPlatform !== query.data.platform) return json({ error: "social_disabled" }, 503);
      if (!discoveryUrl(allowedPlatform, query.data.keywords)) return json({ error: "invalid_query" }, 400);
    } else if (provider) {
      // Independent provider mode; no browser launch required.
    } else if (allowedPlatform) {
      return json({ error: "invalid_query" }, 400);
    } else if (!neutralSourceUrl(this.env.KADR_BROWSER_SOURCE, this.env.KADR_BROWSER_SOURCE_URL)) {
      return json({ error: "source_unavailable" }, 503);
    }

    return storage.transaction(async (transaction) => {
      if (await transaction.get(slot)) return json({ error: "slot_busy" }, 409);
      if (social && await transaction.get(socialAttempt)) return json({ error: "social_already_run" }, 429);
      if (provider && await transaction.get(providerAttempt)) return json({ error: "provider_already_run" }, 429);
      const now = Date.now();
      const started = await transaction.get<number>(lastStart);
      if (started !== undefined && now - started < cooldownMs) return json({ error: "cooldown" }, 429);
      const budget = provider ? (await transaction.get<Budget>(budgetKey) ?? { day: utcDay(now), requests: 0, reservedMs: 0 })
        : reserveBudget(await transaction.get<Budget>(budgetKey), now);
      if (!budget) return json({ error: "budget_exhausted" }, 429);
      const id = crypto.randomUUID();
      const job: StoredJob = {
        id, state: "pending", keywords: query.data.keywords, records: [],
        mode: provider ? "provider" : social ? "social" : "neutral",
        query: { keywords: query.data.keywords, platform: query.data.platform, limit: query.data.limit, filters: query.data.filters },
        reservationDay: budget.day,
      };
      const ownerKey = userKey(user.data);
      const previous = await transaction.get<string>(ownerKey);
      if (previous) await transaction.delete(jobKey(previous));
      await transaction.put(jobKey(id), job);
      await transaction.put(ownerKey, id);
      await transaction.put(slot, id);
      if (!provider) await transaction.put(budgetKey, budget);
      if (social) await transaction.put(socialAttempt, id);
      if (provider) await transaction.put(providerAttempt, id);
      await transaction.setAlarm(now);
      return json({ job: publicJob(job) }, 202);
    });
  }

  async alarm() {
    const storage = this.state.storage;
    const running = await storage.transaction(async (transaction) => {
      const id = await transaction.get<string>(slot);
      if (!id) return null;
      const job = await transaction.get<StoredJob>(jobKey(id));
      if (!job || job.state !== "pending") {
        // A watchdog or platform retry after a restart must not launch a second browser.
        if (job?.state === "running") await transaction.put(jobKey(id), { ...job, state: "failed", error: "interrupted" });
        await transaction.delete(slot);
        return null;
      }
      const now = Date.now();
      if (job.mode !== "provider" && job.reservationDay !== utcDay(now)) {
        const budget = reserveBudget(await transaction.get<Budget>(budgetKey), now);
        if (!budget) {
          await transaction.put(jobKey(id), { ...job, state: "failed", error: "budget_exhausted" });
          await transaction.delete(slot);
          return null;
        }
        await transaction.put(budgetKey, budget);
      }
      const started = { ...job, state: "running" } as const;
      await transaction.put(jobKey(id), started);
      await transaction.put(lastStart, now);
      await transaction.setAlarm(now + reservationMs);
      return started;
    });
    if (!running) return;

    const url = neutralSourceUrl(this.env.KADR_BROWSER_SOURCE, this.env.KADR_BROWSER_SOURCE_URL);
    let result: StoredJob;
    try {
      if (running.mode === "provider") {
        if (this.env.KADR_ENABLE_TIKTOK_SEARCH !== "1" || !this.env.TAVILY_API_KEY?.trim()) result = { ...running, state: "failed", error: "provider_disabled" };
        else {
          const videos = await searchIndexedTiktok(this.env.TAVILY_API_KEY, running.query.keywords, running.query.limit);
          result = { ...running, state: "completed", records: [], videos };
        }
      } else if (!this.env.BROWSER) result = { ...running, state: "failed", error: "source_unavailable" };
      else if (running.mode === "social") {
        const platform = socialPilotPlatform(this.env);
        if (!platform || platform !== running.query.platform) result = { ...running, state: "failed", error: "social_disabled" };
        else {
          const videos = await runSocialDiscovery(this.env.BROWSER, platform, running.query, (promise) => this.state.waitUntil(promise));
          result = { ...running, state: "completed", records: [], videos };
        }
      } else if (!url) result = { ...running, state: "failed", error: "source_unavailable" };
      else {
        const records = await runNeutralBrowser(this.env.BROWSER, url, running.query, (promise) => this.state.waitUntil(promise));
        result = { ...running, state: "completed", records: [...records] };
      }
    } catch (error) {
      result = { ...running, state: "failed", error: browserErrorCode(error) };
    }
    await storage.transaction(async (transaction) => {
      if (await transaction.get<string>(slot) !== running.id) return;
      result.records = await storeObservations(transaction, result.records);
      await transaction.put(jobKey(running.id), result);
      await transaction.delete(slot);
      await transaction.deleteAlarm();
    });
  }
}

const worker = {
  fetch(request: Request, env: Env) {
    const name = env.KADR_ENABLE_TIKTOK_SEARCH === "1" ? "tiktok-web-search"
      : socialPilotPlatform(env) ? "social-pilot" : "workspace";
    return env.CLOUD_BROWSER_JOBS.get(env.CLOUD_BROWSER_JOBS.idFromName(name)).fetch(request);
  },
};

export default worker;
