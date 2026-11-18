import { z } from "zod";
import type { Video } from "@/lib/videos";

export interface Collection {
  id: string;
  ownerId: string;
  name: string;
  shared: boolean;
  videoIds: string[];
}

export interface Library {
  favorites: string[];
  collections: Collection[];
  videos: Record<string, Video>;
}

export const emptyLibrary: Library = { favorites: [], collections: [], videos: {} };

const collectionId = z.uuid();
const videoId = z.uuid();

export const libraryCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("favorite"), videoId, saved: z.boolean() }),
  z.object({ kind: z.literal("create"), name: z.string().trim().min(1).max(80), shared: z.boolean() }),
  z.object({ kind: z.literal("delete"), collectionId }),
  z.object({ kind: z.literal("item"), collectionId, videoId, saved: z.boolean() }),
]);

export type LibraryCommand = z.infer<typeof libraryCommand>;
