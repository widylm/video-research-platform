import { webIndexQuerySchema, searchWebIndex, WebIndexError } from "@/lib/web-index-video";
import { workspace } from "@/lib/workspace";

const send = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { "Cache-Control": "no-store" },
});

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if ((fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
    || (origin && fetchSite !== "same-origin" && origin !== new URL(request.url).origin)) return send({ error: "forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return send({ error: "invalid_query" }, 415);
  }
  const text = await request.text().catch(() => "");
  if (text.length > 2_048) return send({ error: "invalid_query" }, 400);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return send({ error: "invalid_query" }, 400); }
  const query = webIndexQuerySchema.safeParse(parsed);
  if (!query.success) return send({ error: "invalid_query" }, 400);
  try {
    const session = await workspace();
    if (session.mode !== "team") return send({ error: "forbidden" }, 401);
    // Search only; no catalog writes. All signed-in members, including viewers, may query.
    const result = await searchWebIndex(query.data);
    return send(result);
  } catch (error) {
    if (error instanceof WebIndexError) return send({ error: error.code, failures: error.failures }, 503);
    return send({ error: "index_unavailable" }, 503);
  }
}
