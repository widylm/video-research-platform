import pg from "pg";
import { z } from "zod";
import { bulkPlatforms, bulkResultLimit } from "../bulk-search.ts";
import type { FashionRadarStore } from "./receiver.ts";

const claimSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal(200), platforms: z.array(z.enum(bulkPlatforms)).min(1).max(2) }),
  z.object({ status: z.literal([401, 403, 429]) }),
]);
const counter = z.number().int().min(0).max(bulkResultLimit);
const saveSchema = z.object({ status: z.literal([200, 403]), sent: counter, duplicates: counter });

export function fashionRadarDbUrl(value?: string) {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "postgresql:" || !/^kadr_radar_ingest(?:\.[a-z0-9]+)?$/.test(url.username)
    || !url.hostname || !url.password || url.pathname !== "/postgres" || url.search || url.hash) return null;
  return url;
}

export function createFashionRadarPostgres(url: URL) {
  const db = new pg.Client({
    connectionString: url.href,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 4_000, query_timeout: 6_000,
  });
  // The bundle may still be arriving when a connection drops after authorization.
  db.on("error", () => {});
  let connected = false;
  async function query(sql: string, args: unknown[]) {
    if (!connected) {
      await db.connect();
      connected = true;
    }
    return (await db.query(sql, args)).rows[0];
  }
  const store: FashionRadarStore = {
    async claim(id, digest) {
      const row = await query("select status, platforms::text[] from private.claim_fashion_radar_request($1, $2)", [id, digest]);
      return claimSchema.parse(row);
    },
    async save(id, digest, { videos }) {
      const metadata = videos.map(({ externalId, originalTitle, originalDescription, publishedAt, fetchedAt, ...data }) => ({
        ...data, external_id: externalId, original_title: originalTitle, original_description: originalDescription,
        published_at: publishedAt, fetched_at: fetchedAt,
      }));
      const row = saveSchema.parse(await query(
        "select * from private.save_fashion_radar_batch($1, $2, $3::jsonb)", [id, digest, JSON.stringify(metadata)],
      ));
      if (row.status === 403) return null;
      if (row.sent + row.duplicates !== videos.length) throw new Error("Invalid Fashion Radar receipt.");
      return { sent: row.sent, duplicates: row.duplicates };
    },
  };
  return { store, close: () => db.end() };
}
