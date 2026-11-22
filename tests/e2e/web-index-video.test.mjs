import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndexUrl, parseIndexedVideos, searchWebIndex, webIndexQuerySchema, WebIndexError } from "../../lib/web-index-video.ts";

const tiktok = "https://www.tiktok.com/@coffeecreator/video/7234567890123456789";
const instagram = "https://www.instagram.com/reel/DA0Coffee/";
function rss(items) { return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Search</title>${items.map(
  item => `<item><title><![CDATA[${item.title ?? "Coffee"}]]></title><link>${item.url.replace(/&/g, "&amp;")}</link><description>Short clip</description></item>`
).join("")}</channel></rss>`; }

test("only bounded query parameters are accepted", () => {
  assert.equal(webIndexQuerySchema.safeParse({ keywords: "кофе", platform: "all", limit: 20 }).success, true);
  assert.equal(webIndexQuerySchema.safeParse({ keywords: "", platform: "all", limit: 20 }).success, false);
  assert.equal(webIndexQuerySchema.safeParse({ keywords: "coffee", platform: "all", limit: 21 }).success, false);
  assert.equal(webIndexQuerySchema.safeParse({ keywords: "coffee", platform: "all", limit: 10, url: "https://example.com" }).success, false);
  const url = new URL(buildIndexUrl("tiktok", "кофе"));
  assert.equal(url.hostname, "www.bing.com");
  assert.equal(url.searchParams.get("format"), "rss");
  assert.match(url.searchParams.get("q"), /кофе/);
});
test("normalizes canonical original video links and excludes non-video URLs", () => {
  const result = parseIndexedVideos(rss([
    { url: tiktok }, { url: tiktok + "?lang=ru" },
    { url: "https://www.tiktok.com/@someone" }, { url: instagram },
    { url: "https://malicious.example/video/123" },
  ]), "tiktok", 20);
  assert.equal(result.length, 1);
  assert.equal(result[0].url, tiktok);
  assert.equal(result[0].author, "coffeecreator");
  assert.equal(result[0].indexTitle, "Coffee");
  assert.deepEqual(parseIndexedVideos(rss([{ url: instagram }, { url: "https://www.instagram.com/p/DA0Coffee/" }]), "instagram", 20).map(v => v.url), [instagram]);
});
test("search never invents records when index has no relevant links", async () => {
  const mock = async () => new Response(rss([{ url: "https://example.com/not-a-video" }]), { status: 200 });
  const result = await searchWebIndex({ keywords: "кофе", platform: "all", limit: 10 }, mock);
  assert.equal(result.videos.length, 0);
  assert.deepEqual(result.failedPlatforms, []);
});
test("partial index failure is reported; total failures reject", async () => {
  const mock = async url => new URL(url).searchParams.get("q").includes("instagram")
    ? new Response("no", { status: 429 })
    : new Response(rss([{ url: tiktok }]), { status: 200 });
  const partial = await searchWebIndex({ keywords: "coffee", platform: "all", limit: 10 }, mock);
  assert.deepEqual(partial.failedPlatforms, ["instagram"]);
  assert.equal(partial.videos.length, 1);
  await assert.rejects(searchWebIndex({ keywords: "coffee", platform: "instagram", limit: 10 }, mock),
    error => error instanceof WebIndexError && error.code === "index_rate_limited");
  await assert.rejects(searchWebIndex({ keywords: "coffee", platform: "tiktok", limit: 10 }, async () => new Response("<html></html>")),
    error => error instanceof WebIndexError && error.code === "index_unavailable");
});
