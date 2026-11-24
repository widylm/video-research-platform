import { z } from "zod";
import { cloudBrowserQuery, fashionRadarQuery, safeVerificationUrl, type CloudBrowserJob } from "../../lib/cloud-browser-contract.ts";
import type { BulkQuery } from "../../lib/bulk-search.ts";
import { storeObservations } from "./catalog.ts";
import { BrowserJobError, browserErrorCode, neutralSourceUrl, runNeutralBrowser, type BrowserBinding } from "./source.ts";
import { runFashionRadar } from "./fashion-radar.ts";

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
  KADR_BROWSER_SOURCE_URL?: string;
  CLOUD_BROWSER_JOBS: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}
type StoredJob = CloudBrowserJob & { query: BulkQuery; reservationDay: string };
type Budget = { day: string; requests: number; reservedMs: number };
const slot = "active";
const lastStart = "last-start";
const budgetKey = "budget";
const reservationMs = 60_000;
const maxReservedMs = 8 * reservationMs;
const maxRuns = 8;
const cooldownMs = 20_000;
const jobKey = (id: string) => `job:${id}`;
const userKey = (user: string) => `user:${user}`;
const json = (body: object, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const publicJob = ({ id, state, keywords, records, videos, scanned, limited, error, diagnostics, verification }: StoredJob): CloudBrowserJob =>
  ({ id, state, keywords, records, videos, scanned, limited, error, diagnostics,
    verification: state === "awaiting_verification" && verification && Date.parse(verification.expiresAt) > Date.now()
      && safeVerificationUrl(verification.url) ? verification : undefined });
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export function reserveBudget(previous: Budget | undefined, now: number): Budget | null {
  const day = utcDay(now);
  const used = previous?.day === day ? previous : { day, requests: 0, reservedMs: 0 };
  if (used.requests >= maxRuns || used.reservedMs + reservationMs > maxReservedMs) return null;
  return { day, requests: used.requests + 1, reservedMs: used.reservedMs + reservationMs };
}

export function reserveVerificationBudget(previous: Budget | undefined, now: number): Budget | null {
  const day = utcDay(now);
  // A normal job already reserved one minute. A manual check needs two more.
  const used = previous?.day === day ? previous : { day, requests: 1, reservedMs: reservationMs };
  if (used.reservedMs + 2 * reservationMs > maxReservedMs) return null;
  return { ...used, reservedMs: used.reservedMs + 2 * reservationMs };
}

export class CloudBrowserJobs {
  private readonly state: State;
  private readonly env: Env;
  private readonly collect: typeof runFashionRadar;

  constructor(state: State, env: Env, collect: typeof runFashionRadar = runFashionRadar) {
    this.state = state; this.env = env; this.collect = collect;
  }

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
    const fashionRadar = this.env.KADR_BROWSER_SOURCE === "fashion-radar";
    if (!this.env.BROWSER || (!fashionRadar && !neutralSourceUrl(this.env.KADR_BROWSER_SOURCE, this.env.KADR_BROWSER_SOURCE_URL))) {
      return json({ error: "source_unavailable" }, 503);
    }
    const query = (fashionRadar ? fashionRadarQuery : cloudBrowserQuery).safeParse(await request.json().catch(() => null));
    if (!query.success) return json({ error: "invalid_query" }, 400);

    return storage.transaction(async (transaction) => {
      if (await transaction.get(slot)) return json({ error: "slot_busy" }, 409);
      const now = Date.now();
      const started = await transaction.get<number>(lastStart);
      if (started !== undefined && now - started < cooldownMs) return json({ error: "cooldown" }, 429);
      const budget = reserveBudget(await transaction.get<Budget>(budgetKey), now);
      if (!budget) return json({ error: "budget_exhausted" }, 429);
      const id = crypto.randomUUID();
      const job: StoredJob = {
        id, state: "pending", keywords: query.data.keywords, records: [], query: query.data, reservationDay: budget.day,
      };
      const ownerKey = userKey(user.data);
      const previous = await transaction.get<string>(ownerKey);
      if (previous) await transaction.delete(jobKey(previous));
      await transaction.put(jobKey(id), job);
      await transaction.put(ownerKey, id);
      await transaction.put(slot, id);
      await transaction.put(budgetKey, budget);
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
        if (job?.state === "running" || job?.state === "awaiting_verification") {
          await transaction.put(jobKey(id), { ...job, state: "failed", error: "interrupted", verification: undefined });
        }
        await transaction.delete(slot);
        return null;
      }
      const now = Date.now();
      if (job.reservationDay !== utcDay(now)) {
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
      if (this.env.BROWSER && this.env.KADR_BROWSER_SOURCE === "fashion-radar") {
        const update = (change: Partial<StoredJob>) => storage.transaction(async transaction => {
          if (await transaction.get<string>(slot) !== running.id) throw new BrowserJobError("interrupted");
          const current = await transaction.get<StoredJob>(jobKey(running.id));
          if (!current) throw new BrowserJobError("interrupted");
          await transaction.put(jobKey(running.id), { ...current, ...change });
        });
        const collection = await this.collect(this.env.BROWSER, fashionRadarQuery.parse(running.query),
          promise => this.state.waitUntil(promise), {
            reserve: () => storage.transaction(async transaction => {
              if (await transaction.get<string>(slot) !== running.id) throw new BrowserJobError("interrupted");
              const now = Date.now();
              const budget = reserveVerificationBudget(await transaction.get<Budget>(budgetKey), now);
              if (!budget) throw new BrowserJobError("budget_exhausted");
              await transaction.put(budgetKey, budget);
              await transaction.setAlarm(now + 3 * reservationMs);
            }),
            publish: async (verification, diagnostics) => {
              if (!safeVerificationUrl(verification.url)) throw new BrowserJobError("verification_unavailable");
              await update({ state: "awaiting_verification", verification, diagnostics, error: "manual_intervention_required" });
            },
            resumed: () => update({ state: "running", verification: undefined, diagnostics: undefined, error: undefined }),
          });
        result = { ...running, state: "completed", records: [], videos: collection.videos,
          scanned: collection.scanned, limited: collection.limited, error: collection.warning };
      }
      else if (!this.env.BROWSER || !url) result = { ...running, state: "failed", error: "source_unavailable" };
      else {
        const records = await runNeutralBrowser(this.env.BROWSER, url, running.query, (promise) => this.state.waitUntil(promise));
        result = { ...running, state: "completed", records: [...records] };
      }
    } catch (error) {
      result = { ...running, state: "failed", error: browserErrorCode(error),
        diagnostics: error instanceof BrowserJobError ? error.diagnostics : undefined };
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
    return env.CLOUD_BROWSER_JOBS.get(env.CLOUD_BROWSER_JOBS.idFromName("workspace")).fetch(request);
  },
};

export default worker;
