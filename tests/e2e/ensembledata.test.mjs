import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudBrowserRequest } from "../../lib/cloud-browser-contract.ts";
import { EnsemblePilotError, fetchEnsembleKeyword, parseEnsembleKeywordResponse } from "../../workers/cloud-browser/ensembledata.ts";

const record = {
  aweme_info: {
    aweme_id: "7234567890123456789",
    desc: "Street style #fashion",
    create_time: 1716163200,
    author: { unique_id: "creator" },
    statistics: { play_count: 42, digg_count: 7, comment_count: 3 },
  },
};
const response = { data: { data: [record, record] } };
test("provider mode accepts only a single TikTok 10-record request", () => {
  assert.equal(cloudBrowserRequest.safeParse({ mode: "provider", keywords: "street style", platform: "tiktok", limit: 10 }).success, true);
  assert.equal(cloudBrowserRequest.safeParse({ mode: "provider", keywords: "street style", platform: "instagram", limit: 10 }).success, false);
  assert.equal(cloudBrowserRequest.safeParse({ mode: "provider", keywords: "fashion", platform: "tiktok", limit: 11 }).success, false);
  assert.equal(cloudBrowserRequest.safeParse({ mode: "provider", keywords: "fashion", platform: "tiktok", limit: 10, url: "https://evil.com" }).success, false);
});
test("normalization yields unique canonical TikTok links with genuine reported metrics", () => {
  const videos = parseEnsembleKeywordResponse(response);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].url, "https://www.tiktok.com/@creator/video/7234567890123456789");
  assert.equal(videos[0].views, 42);
  assert.equal(videos[0].likes, 7);
  assert.equal(videos[0].comments, 3);
  assert.equal(videos[0].author, "creator");
  assert.equal(videos[0].publishedAt, "2024-05-20T00:00:00.000Z");
  assert.equal(videos[0].source, "ensembledata_keyword");
  assert.equal(videos[0].hashtags, null);
});
test("missing identifiers or unverified author never become a fabricated URL", () => {
  const result = parseEnsembleKeywordResponse({ data: { data: [
    { aweme_info: { aweme_id: "7234567890123456790", author: {} } },
    { aweme_info: { aweme_id: "7234567890123456791", author: { unique_id: "no slash!" } } },
    { aweme_info: { aweme_id: "7234567890123456792", author: { unique_id: "validname" }, statistics: {} } },
  ] } });
  assert.equal(result.length, 1);
  assert.equal(result[0].views, null);
  assert.equal(result[0].likes, null);
  assert.equal(result[0].comments, null);
  assert.throws(() => parseEnsembleKeywordResponse({ data: { fake: [] } }), /provider_invalid_response/);
});
test("one fetch only, no cursor, token remains solely in query and handles HTTP errors", async () => {
  let calls = 0;
  const mock = async (url, options) => {
    calls++;
    const address = new URL(url);
    assert.equal(address.origin, "https://ensembledata.com");
    assert.equal(address.pathname, "/apis/tt/keyword/search");
    assert.equal(address.searchParams.get("name"), "street style");
    assert.equal(address.searchParams.get("token"), "private-test-token");
    assert.equal(address.searchParams.get("cursor"), null);
    assert.equal(options.method, "GET");
    return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  assert.equal((await fetchEnsembleKeyword("private-test-token", "street style", mock)).length, 1);
  assert.equal(calls, 1);
  await assert.rejects(fetchEnsembleKeyword("token", "a", async () => new Response("no", { status: 401 })), (error) => error instanceof EnsemblePilotError && error.code === "provider_http_error");
  await assert.rejects(fetchEnsembleKeyword("token", "a", async () => new Response("{}")), (error) => error instanceof EnsemblePilotError && error.code === "provider_invalid_response");
});
