import { z } from "zod";
import { bulkResultLimit, bulkVideoKey, bulkVideoSchema } from "./bulk-search.ts";

const importVideoSchema = bulkVideoSchema.superRefine((video, ctx) => {
  if (video.url === null) {
    ctx.addIssue({ code: "custom", path: ["url"], message: "A matching canonical video URL is required." });
  }
  if (video.source === "mock" || video.source.startsWith("mock:")) {
    ctx.addIssue({ code: "custom", path: ["source"], message: "Pilot data cannot be imported." });
  }
  const storedText = [video.originalTitle, video.originalDescription, video.author, ...(video.hashtags ?? [])];
  if (storedText.some((value) => value?.includes("\0"))) {
    ctx.addIssue({ code: "custom", message: "Text fields must not contain NUL characters." });
  }
});

/** Versioned metadata-only batch for validation before any future database integration. */
export const bulkImportSchema = z.strictObject({
  version: z.literal(1),
  videos: z.array(importVideoSchema).min(1).max(bulkResultLimit),
}).superRefine(({ videos }, ctx) => {
  const seen = new Set<string>();
  for (const [index, video] of videos.entries()) {
    const key = bulkVideoKey(video);
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", path: ["videos", index, "externalId"], message: "Duplicate platform video." });
    }
    seen.add(key);
  }
});

export type BulkImportBatch = z.output<typeof bulkImportSchema>;
