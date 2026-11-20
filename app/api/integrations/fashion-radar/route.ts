import { createFashionRadarPostgres, fashionRadarDbUrl } from "@/lib/fashion-radar/postgres";
import { createFashionRadarReceiver } from "@/lib/fashion-radar/receiver";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const url = process.env.KADR_FASHION_RADAR_ENABLED === "1" ? fashionRadarDbUrl(process.env.KADR_FASHION_RADAR_DB_URL) : null;
  if (!url) return createFashionRadarReceiver()(request);
  const adapter = createFashionRadarPostgres(url);
  try {
    return await createFashionRadarReceiver({ enabled: true, store: adapter.store })(request);
  } finally {
    await adapter.close().catch(() => {});
  }
}
