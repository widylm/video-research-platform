import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudBrowserRequest, socialPilotPlatform } from "../../lib/cloud-browser-contract.ts";
import { CloudBrowserJobs } from "../../workers/cloud-browser/index.ts";
import { discoveryUrl, normalizePublicLinks, socialHttpError } from "../../workers/cloud-browser/video-discovery.ts";

test("social discovery validates platform, budget and forbids unrequested network targets", () => {
  const input = { mode: "social", keywords: "street style", platform: "tiktok", limit: 10 };
  assert.equal(cloudBrowserRequest.safeParse(input).success, true);
  assert.equal(cloudBrowserRequest.safeParse({ ...input, limit: 11 }).success, false);
  assert.equal(cloudBrowserRequest.safeParse({ ...input, platform: "all" }).success, false);
  assert.equal(cloudBrowserRequest.safeParse({ ...input, filters: { minLikes: 20 } }).success, false);
  assert.equal(cloudBrowserRequest.safeParse({ ...input, url: "https://example.com" }).success, false);
  assert.equal(cloudBrowserRequest.safeParse({ ...input, platform: "invalid" }).success, false);
  assert.equal(cloudBrowserRequest.safeParse({ keywords: "mosses", platform: "all", limit: 10 }).success, true);
});

test("the executor only admits one social run for the explicitly enabled platform", async () => {
  const entries = new Map();
  const state = { storage: { transaction: async (op) => op({
    get: async (key) => entries.get(key), put: async (key, value) => entries.set(key, value),
    setAlarm: async () => {},
  }) } };
  const request = (platform, keywords) => new Request("https://kadr-executor.internal/jobs", {
    method: "POST", headers: { "x-kadr-profile": crypto.randomUUID() },
    body: JSON.stringify({ mode: "social", platform, keywords, limit: 10 }),
  });
  const env = { BROWSER: {}, KADR_ENABLE_SOCIAL_DISCOVERY: "1", KADR_SOCIAL_DISCOVERY_PLATFORM: "instagram" };
  assert.equal(socialPilotPlatform({ KADR_ENABLE_SOCIAL_DISCOVERY: "1" }), undefined);
  const disabled = new CloudBrowserJobs(state, { BROWSER: {} });
  assert.equal((await (await disabled.fetch(request("instagram", "style"))).json()).error, "social_disabled");
  const executor = new CloudBrowserJobs(state, env);
  assert.equal((await executor.fetch(request("tiktok", "style"))).status, 503);
  assert.equal((await executor.fetch(request("instagram", "street style"))).status, 400);
  assert.equal(entries.size, 0);
  assert.equal((await executor.fetch(request("instagram", "style"))).status, 202);
  assert.equal((await executor.fetch(request("instagram", "style"))).status, 409);
  entries.delete("active");
  const restarted = new CloudBrowserJobs(state, env);
  const again = await restarted.fetch(request("instagram", "style"));
  assert.equal(again.status, 429);
  assert.equal((await again.json()).error, "social_already_run");
});

test("access failures distinguish authorization, forbidden and rate-limited responses", () => {
  assert.equal(socialHttpError(401), "source_http_401");
  assert.equal(socialHttpError(403), "source_http_403");
  assert.equal(socialHttpError(429), "source_http_429");
  assert.equal(socialHttpError(451), "source_http_451");
});

test("platform search targets are fixed and instagram accepts only exact tags", () => {
  assert.equal(discoveryUrl("tiktok", "street style"), "https://www.tiktok.com/search/video?q=street%20style");
  assert.equal(discoveryUrl("instagram", "#street_style"), "https://www.instagram.com/explore/tags/street_style/");
  assert.equal(discoveryUrl("instagram", "street style"), null);
  assert.equal(discoveryUrl("tiktok", ""), null);
  assert.equal(discoveryUrl("instagram", "../../../admin"), null);
});

test("discovery accepts only canonical real-looking public video URLs, without fake statistics", () => {
  const links = [
    "https://www.tiktok.com/@creator/video/7234567890123456789?lang=en",
    "https://www.tiktok.com/@creator/video/7234567890123456789",
    "https://www.instagram.com/reel/DQexample_1/",
    "https://www.instagram.com/p/DQexample_2/",
    "https://example.com/watch/123",
    "https://www.tiktok.com/@other/video/7234567890123456790",
  ];
  const tik = normalizePublicLinks(links, "tiktok", 20);
  assert.equal(tik.length, 2);
  assert.deepEqual(tik.map(v => v.externalId), ["7234567890123456789", "7234567890123456790"]);
  assert.equal(tik[0].author, "creator");
  assert.equal(tik[0].views, null);
  assert.equal(tik[0].likes, null);
  assert.equal(tik[0].comments, null);
  assert.equal(tik[0].publishedAt, null);
  assert.equal(tik[0].source, "public_dom_browser");
  const ig = normalizePublicLinks(links, "instagram", 20);
  assert.equal(ig.length, 1);
  assert.equal(ig[0].url, "https://www.instagram.com/reel/DQexample_1/");
  assert.equal(ig[0].author, null);
});

test("discovery respects per-job max items and ignores unrelated links", () => {
  const links = Array.from({ length: 40 }, (_, i) => `https://www.tiktok.com/@creator/video/${7234567890123456700n + BigInt(i)}`);
  assert.equal(normalizePublicLinks(links, "tiktok", 7).length, 7);
  assert.equal(normalizePublicLinks(links, "tiktok", 100).length, 10);
  assert.deepEqual(normalizePublicLinks(["https://example.com/a"], "instagram"), []);
});
