import { z } from "zod";

export const optionalPublicationDate = z.union([z.literal(""), z.iso.date().refine((value) => !value.startsWith("0000-"))]);

const metric = z.string().trim().max(16).regex(/^\d*$/)
  .transform((value) => value ? Number(value) : null)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable());

export function searchTerms(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("ru").split(/[\s,]+/).filter(Boolean);
}

export const tagTerms = (value: string) => searchTerms(value).map((word) => word.replace(/^#/, "")).filter(Boolean);

export const videoEntrySchema = z.object({
  url: z.string().trim().min(1).max(2048),
  description: z.string().trim().max(2200),
  publishedAt: optionalPublicationDate.transform((date) => date || null),
  hashtags: z.string().max(600)
    .transform((value) => Array.from(new Set(tagTerms(value))))
    .pipe(z.array(z.string().regex(/^[\p{L}\p{M}\p{N}_]{1,64}$/u)).max(30)),
  views: metric,
  likes: metric,
  collectionId: z.union([z.literal(""), z.uuid()]).transform((value) => value || null),
});
