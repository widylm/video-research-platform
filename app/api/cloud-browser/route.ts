import { cloudBrowserBinding } from "@/lib/cloud-browser-binding";
import { cloudBrowserQuery, type CloudBrowserErrorCode } from "@/lib/cloud-browser-contract";
import { workspace } from "@/lib/workspace";

const response = (error: CloudBrowserErrorCode, status: number) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

async function readSmallJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const data = new Uint8Array(2_048);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > data.byteLength) {
        await reader.cancel();
        return null;
      }
      data.set(value, length);
      length += value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, length)));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

async function run(request: Request) {
  const executor = cloudBrowserBinding();
  if (!executor) return response("unavailable", 404);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  // The browser's Fetch Metadata survives the OpenNext URL rewrite in local and proxied Workers.
  if ((fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
    || (origin && fetchSite !== "same-origin" && origin !== new URL(request.url).origin)) return response("forbidden", 403);

  try {
    const session = await workspace();
    if (session.mode !== "team") return response("forbidden", 401);
    if (session.profile.role === "viewer") return response("forbidden", 403);
    const headers = { "x-kadr-profile": session.profile.id, "Content-Type": "application/json" };
    const init: RequestInit = { method: request.method, headers };
    if (request.method === "POST") {
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return response("invalid_query", 415);
      const query = cloudBrowserQuery.safeParse(await readSmallJson(request));
      if (!query.success) return response("invalid_query", 400);
      init.body = JSON.stringify(query.data);
    }
    return await executor.fetch(new Request("https://kadr-executor.internal/jobs", init));
  } catch {
    return response("unavailable", 503);
  }
}

export { run as GET, run as POST };
