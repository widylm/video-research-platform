import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudBrowserRequest } from "../../lib/cloud-browser-contract.ts";
import { CloudBrowserJobs } from "../../workers/cloud-browser/index.ts";
import { searchIndexedTiktok } from "../../workers/cloud-browser/tiktok-search.ts";

const canonicalUrl = "https://www.tiktok.com/@example/video/7234567890123456789";
const query = { mode: "provider", platform: "tiktok", keywords: "кофе", limit: 10 };

test("TikTok search makes one Basic request to the fixed search API and only preserves canonical video data", async () => {
  let requests = 0;
  const videos = await searchIndexedTiktok("test-key", "кофе", 2, async (url, options) => {
    requests += 1;
    assert.equal(url, "https://api.tavily.com/search");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(options.body), {
      query: "кофе TikTok videos", search_depth: "basic", max_results: 20,
      include_domains: ["tiktok.com"], include_domains_mode: "restrict", auto_parameters: false,
      include_answer: false, include_raw_content: false, include_images: false,
    });
    return Response.json({ results: [
      { url: "https://tiktok.com/@example", title: "A profile" },
      { url: "https://www.tiktok.com.other.test/@example/video/7234567890123456789" },
      { url: "https://vm.tiktok.com/example/" },
      { url: canonicalUrl + "?source=test", title: "Search snippet", views: 345 },
      { url: canonicalUrl },
      { url: "https://m.tiktok.com/@second/video/7234567890123456790" },
      { url: "https://www.tiktok.com/@third/video/7234567890123456791" },
    ] });
  });
  assert.equal(requests, 1);
  assert.equal(videos.length, 2);
  assert.equal(videos[0].url, canonicalUrl);
  assert.equal(videos[0].author, "example");
  assert.equal(videos[0].source, "tavily_search_index");
  for (const field of ["originalTitle", "originalDescription", "publishedAt", "hashtags", "views", "likes", "comments"]) {
    assert.equal(videos[0][field], null, field);
  }
});

test("TikTok search distinguishes no matches, malformed output and access errors without leaking the response body", async () => {
  assert.deepEqual(await searchIndexedTiktok("test-key", "coffee", 10, async () =>
    Response.json({ results: [] })), []);
  await assert.rejects(searchIndexedTiktok("test-key", "coffee", 10, async () =>
    Response.json({ result: [] })), { message: "provider_invalid_response" });
  await assert.rejects(searchIndexedTiktok("test-key", "coffee", 10, async () =>
    Response.json({ results: [], padding: "x".repeat(129 * 1024) })), { message: "provider_invalid_response" });
  for (const code of [401, 403, 429, 432]) {
    await assert.rejects(searchIndexedTiktok("test-key", "coffee", 10, async () =>
      new Response("private provider details", { status: code })), { message: `provider_http_${code}` });
  }
});

test("the staging executor fails closed without a key and atomically allows one indexed search", async () => {
  assert.equal(cloudBrowserRequest.safeParse({ ...query, limit: 11 }).success, false);
  const entries = new Map();
  const state = { storage: { transaction: async (op) => op({
    get: async (key) => entries.get(key), put: async (key, value) => entries.set(key, value),
    setAlarm: async () => {},
  }) } };
  const request = (body = query) => new Request("https://kadr-executor.internal/jobs", {
    method: "POST", headers: { "x-kadr-profile": crypto.randomUUID() }, body: JSON.stringify(body),
  });
  const env = { KADR_ENABLE_TIKTOK_SEARCH: "1" };
  assert.equal((await (await new CloudBrowserJobs(state, env).fetch(request())).json()).error, "provider_disabled");
  assert.equal(entries.size, 0);
  const enabled = { ...env, TAVILY_API_KEY: "test-key" };
  const executor = new CloudBrowserJobs(state, enabled);
  assert.equal((await executor.fetch(request({ ...query, mode: "social" }))).status, 400);
  assert.equal((await executor.fetch(request())).status, 202);
  assert.equal((await executor.fetch(request())).status, 409);
  entries.delete("active");
  assert.equal((await (await new CloudBrowserJobs(state, enabled).fetch(request())).json()).error, "provider_already_run");
});
