import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { bulkImportSchema } from "../bulk-import.ts";
import type { BulkPlatform } from "../bulk-search.ts";
import {
  fashionRadarBodyLimit, fashionRadarDeviceToken, fashionRadarPath, fashionRadarReceiptSchema, fashionRadarSources, prepareFashionRadarBatch,
} from "./batch.ts";
import { completionFileName, completionReport, completionSchema, syncDirectory } from "./completion.ts";

const queueLimit = 16;
const jobSchema = z.object({
  batch: bulkImportSchema,
  ...completionReport, completionFile: z.string().regex(completionFileName).optional(),
  attempt: z.number().int().min(0).max(10), retryAt: z.number().int().min(0),
});
const queueSchema = z.object({
  version: z.literal(1), binding: z.string(), revision: z.string().nullable(), jobs: z.array(jobSchema).max(queueLimit),
});
type Queue = z.output<typeof queueSchema>;
type SenderConfig = {
  enabled: boolean; endpoint: string; deviceToken: string;
  queueFile: string; platforms: readonly BulkPlatform[];
} & ({ resultsFile: string; completionDir?: never } | { completionDir: string; resultsFile?: never });
type Status = { state: "disabled" | "idle" | "queue_full" | "waiting" | "delivered" | "paused";
  sent?: number; rejected?: number; duplicates?: number; httpStatus?: number };

async function readBounded(path: string, limit: number, mutable = false) {
  const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Local sync file exceeds its format limit.");
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size || stat.mtimeMs !== (await file.stat()).mtimeMs) {
      if (mutable) return null;
      throw new Error("Durable sync file changed during read.");
    }
    return { buffer: buffer.subarray(0, bytesRead), modifiedAt: stat.mtime };
  } finally {
    await file.close();
  }
}

async function writeQueue(path: string, queue: Queue) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(queue), { flag: "wx", mode: 0o600, flush: true });
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

function nextAttempt(job: Queue["jobs"][number], now: number, retryAfter: string | null) {
  job.attempt = Math.min(job.attempt + 1, 10);
  const backoff = Math.min(5_000 * 2 ** (job.attempt - 1), 15 * 60_000);
  const serverWait = retryAfter === null ? 0 : /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1_000 : Date.parse(retryAfter) - now;
  job.retryAt = now + Math.max(backoff, Number.isFinite(serverWait) ? Math.min(serverWait, 24 * 60 * 60_000) : 0);
}

export function createFashionRadarSender(config: SenderConfig, request: typeof fetch = fetch, now = Date.now) {
  if (!config.enabled) return async (): Promise<Status> => ({ state: "disabled" });
  const endpoint = new URL(config.endpoint);
  const token = fashionRadarDeviceToken.exec(config.deviceToken);
  const pathName = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (!token || endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port
    || endpoint.search || endpoint.hash || endpoint.pathname !== fashionRadarPath || !config.platforms.length
    || (config.resultsFile && pathName(config.resultsFile) === pathName(config.queueFile))) {
    throw new Error("Invalid Fashion Radar sync settings.");
  }
  const binding = `${endpoint.origin}/${token[1]}`;
  let working = false;

  return async (signal?: AbortSignal): Promise<Status> => {
    if (working || signal?.aborted) return { state: "idle" };
    working = true;
    try {
      const saved = await readBounded(config.queueFile, (fashionRadarBodyLimit + 512) * queueLimit + 1024);
      const local = config.resultsFile ? await readBounded(config.resultsFile, fashionRadarBodyLimit, true) : null;
      const revision = local ? `${local.modifiedAt.toISOString()}:${createHash("sha256").update(local.buffer).digest("hex")}` : null;
      const queue: Queue = saved ? queueSchema.parse(JSON.parse(saved.buffer.toString("utf8")))
        : { version: 1, binding, revision, jobs: [] };
      if (!saved && config.resultsFile) {
        // Establish a baseline on first enable. Previous collections are not queued implicitly.
        await writeQueue(config.queueFile, queue);
        return { state: "idle" };
      }
      const allowed = (batch: Queue["jobs"][number]["batch"]) => batch.videos.every((video) =>
        config.platforms.includes(video.platform) && video.source === fashionRadarSources[video.platform]);
      if (queue.binding !== binding || queue.jobs.some(({ batch }) => !allowed(batch))) {
        throw new Error("Local sync queue belongs to a different connection or source.");
      }

      let status: Status = { state: "idle" };
      if (config.completionDir) {
        const names = (await readdir(config.completionDir).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        })).filter((name) => completionFileName.test(name)).sort();
        for (const name of names) {
          const path = join(config.completionDir, name);
          if (queue.jobs.some(({ completionFile }) => completionFile === name)) {
            await rm(path, { force: true }); // Copy was committed before a previous process stopped.
            continue;
          }
          if (queue.jobs.length >= queueLimit) break; // Leave the pending collection in the journal.
          const captured = await readBounded(path, fashionRadarBodyLimit + 512);
          if (!captured) continue;
          const { batch, rejected, duplicates } = completionSchema.parse(JSON.parse(captured.buffer.toString("utf8")));
          if (batch) {
            if (!allowed(batch)) throw new Error("Completion belongs to a source that is not allowed.");
            queue.jobs.push({ batch, rejected, duplicates, completionFile: name, attempt: 0, retryAt: 0 });
            await writeQueue(config.queueFile, queue);
          } else {
            status = { state: "delivered", sent: 0, rejected, duplicates };
          }
          await rm(path, { force: true });
          break;
        }
      }
      if (local && revision !== queue.revision) {
        if (queue.jobs.length >= queueLimit) {
          status = { state: "queue_full" };
        } else {
          let state: unknown;
          try { state = JSON.parse(local.buffer.toString("utf8")); } catch { /* Wait for the collector's next complete write. */ }
          const prepared = prepareFashionRadarBatch(state, local.modifiedAt.toISOString(), config.platforms);
          if (prepared) {
            if (prepared.batch) queue.jobs.push({ ...prepared, batch: prepared.batch, attempt: 0, retryAt: 0 });
            else status = { state: "delivered", sent: 0, rejected: prepared.rejected, duplicates: prepared.duplicates };
            queue.revision = revision;
            await writeQueue(config.queueFile, queue);
          }
        }
      }
      const job = queue.jobs[0];
      if (!job || signal?.aborted) return status;
      if (job.retryAt > now()) return status.state === "idle" ? { state: "waiting" } : status;

      const body = JSON.stringify(job.batch);
      if (Buffer.byteLength(body) > fashionRadarBodyLimit) return { state: "paused", httpStatus: 413 };
      const timeout = AbortSignal.timeout(10_000);
      const response = await request(endpoint, {
        method: "POST", body, headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.deviceToken}` },
        redirect: "manual", credentials: "omit", cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }).catch(() => null);
      if (signal?.aborted) return { state: "idle" };
      if (response?.ok) {
        const receipt = fashionRadarReceiptSchema.safeParse(await response.json().catch(() => null));
        if (receipt.success && receipt.data.sent + receipt.data.duplicates === job.batch.videos.length) {
          queue.jobs.shift();
          await writeQueue(config.queueFile, queue);
          return { state: "delivered", sent: receipt.data.sent, rejected: job.rejected, duplicates: job.duplicates + receipt.data.duplicates };
        }
      } else if (response && ![408, 429].includes(response.status) && response.status < 500) {
        await response.body?.cancel().catch(() => {});
        return { state: "paused", httpStatus: response.status };
      } else {
        await response?.body?.cancel().catch(() => {});
      }

      nextAttempt(job, now(), response?.headers.get("Retry-After") ?? null);
      await writeQueue(config.queueFile, queue);
      return { state: "waiting" };
    } finally {
      working = false;
    }
  };
}
