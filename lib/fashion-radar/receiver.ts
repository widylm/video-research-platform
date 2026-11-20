import { createHash, timingSafeEqual } from "node:crypto";
import { bulkImportSchema, type BulkImportBatch } from "../bulk-import.ts";
import type { BulkPlatform } from "../bulk-search.ts";
import { fashionRadarBodyLimit, fashionRadarDeviceToken, fashionRadarSources } from "./batch.ts";

export type FashionRadarDevice = Readonly<{
  tokenDigest: string; expiresAt: number; revoked: boolean;
  active: boolean; role: "admin" | "member" | "viewer";
  platforms: readonly BulkPlatform[];
}>;

export type FashionRadarStore = {
  getDevice(id: string): Promise<FashionRadarDevice | null>;
  takeRateSlot(id: string): Promise<boolean>;
  save(id: string, batch: BulkImportBatch): Promise<{ sent: number; duplicates: number }>;
};

const reply = (status: number, data: object, headers?: HeadersInit) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });

export function hashFashionRadarSecret(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

async function readBody(request: Request) {
  if (Number(request.headers.get("content-length")) > fashionRadarBodyLimit) return { tooLarge: true } as const;
  const reader = request.body?.getReader();
  if (!reader) return { invalid: true } as const;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > fashionRadarBodyLimit) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true } as const;
      }
      chunks.push(value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
    return { input: JSON.parse(text) as unknown } as const;
  } catch {
    return { invalid: true } as const;
  } finally {
    reader.releaseLock();
  }
}

/** Isolated handler. The application does not mount a route or configure a backing store. */
export function createFashionRadarReceiver(options: { enabled?: boolean; store?: FashionRadarStore; now?: () => number } = {}) {
  const { enabled, store, now = Date.now } = options;
  return async (request: Request): Promise<Response> => {
    if (!enabled || !store) return reply(404, { error: "sync_disabled" });
    if (request.method !== "POST") return reply(405, { error: "method_not_allowed" }, { Allow: "POST" });
    const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/);
    const credentials = token && fashionRadarDeviceToken.exec(token[1]);
    if (!credentials) return reply(401, { error: "unauthorized" });
    const [, id, secret] = credentials;

    try {
      const device = await store.getDevice(id);
      if (!device || device.revoked || device.expiresAt <= now() || !/^[a-f\d]{64}$/.test(device.tokenDigest)
        || !timingSafeEqual(Buffer.from(device.tokenDigest, "hex"), Buffer.from(hashFashionRadarSecret(secret), "hex"))) {
        return reply(401, { error: "unauthorized" });
      }
      if (!device.active || !["admin", "member"].includes(device.role)) return reply(403, { error: "import_forbidden" });
      if (!await store.takeRateSlot(id)) return reply(429, { error: "rate_limited" }, { "Retry-After": "60" });
      if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
        || request.headers.has("content-encoding")) return reply(415, { error: "unsupported_media_type" });
      const body = await readBody(request);
      if (body.tooLarge) return reply(413, { error: "payload_too_large" });
      if (body.invalid) return reply(400, { error: "invalid_json" });
      const batch = bulkImportSchema.safeParse(body.input);
      if (!batch.success) return reply(422, { error: "invalid_batch" });

      const incoming = (body.input as { videos: object[] }).videos;
      for (const [index, video] of batch.data.videos.entries()) {
        if (Object.keys(incoming[index]).some((field) => !Object.hasOwn(video, field))
          || Date.parse(video.fetchedAt) > now() + 5 * 60_000) return reply(422, { error: "invalid_batch" });
        if (video.source !== fashionRadarSources[video.platform] || !device.platforms.includes(video.platform)) {
          return reply(403, { error: "source_forbidden" });
        }
      }
      const { sent, duplicates } = await store.save(id, batch.data);
      return reply(200, { sent, rejected: 0, duplicates });
    } catch {
      return reply(503, { error: "sync_unavailable" });
    }
  };
}
