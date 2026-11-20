import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { bulkImportSchema } from "../bulk-import.ts";
import type { BulkPlatform } from "../bulk-search.ts";
import { fashionRadarBodyLimit, prepareFashionRadarBatch } from "./batch.ts";

export const completionFileName = /^\d{13}-[a-f0-9]{64}\.json$/;
export const completionReport = {
  rejected: z.number().int().min(0).max(50), duplicates: z.number().int().min(0).max(50),
};
export const completionSchema = z.strictObject({ batch: bulkImportSchema.nullable(), ...completionReport });

export async function syncDirectory(directory: string) {
  if (process.platform === "win32") return; // Node cannot open directories for fsync on Windows.
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Await this before acknowledging a completed collection or overwriting the last results file. */
export async function recordFashionRadarCompletion(input: {
  directory: string; collectionId: string; completedAt: string; state: unknown; platforms: readonly BulkPlatform[];
}) {
  const { directory, collectionId, completedAt, state, platforms } = input;
  const timestamp = Date.parse(completedAt);
  const prepared = prepareFashionRadarBatch(state, completedAt, platforms);
  if (!prepared || !/^[A-Za-z0-9_-]{1,128}$/.test(collectionId) || timestamp < 0 || timestamp > 9_999_999_999_999) {
    throw new Error("Invalid Fashion Radar completion.");
  }
  if (prepared.batch && Buffer.byteLength(JSON.stringify(prepared.batch)) > fashionRadarBodyLimit) {
    throw new Error("Fashion Radar completion exceeds the transfer limit.");
  }
  const body = JSON.stringify(prepared);
  const fingerprint = createHash("sha256").update(collectionId).update("\0").update(body).digest("hex");
  const name = `${String(timestamp).padStart(13, "0")}-${fingerprint}.json`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, body, { flag: "wx", flush: true, mode: 0o600 });
    await link(temporary, join(directory, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await syncDirectory(directory);
    return name;
  } finally {
    await rm(temporary, { force: true });
  }
}
