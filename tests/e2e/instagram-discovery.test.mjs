import assert from "node:assert/strict";
import test from "node:test";
import { discoverInstagram, instagramDiscoveryConfig, normalizeHashtag } from "../../lib/instagram-discovery.ts";

const config = (accounts, token = "test-token") => instagramDiscoveryConfig({
  KADR_INSTAGRAM_ACCOUNT_ID: "123456789012345", KADR_INSTAGRAM_TOKEN: token, KADR_INSTAGRAM_ACCOUNTS: accounts,
});

test("checks the configured accounts and accepts only a single exact hashtag", () => {
  assert.deepEqual(config(" @Zara, zara, mango ").accounts, ["zara", "mango"]);
  assert.equal(config("zara){}"), null);
  assert.equal(config("a,b,c,d,e,f"), null);
  assert.deepEqual(config("fashion").accounts, ["fashion"]);
  assert.equal(normalizeHashtag(" #Moda "), "moda");
  assert.equal(normalizeHashtag("#moda #other"), null);
});

test("reads only configured accounts, filters exact tags and preserves unknown metrics", async (t) => {
  const now = new Date().toISOString();
  const reel = (id, caption, view_count, like_count, extra = {}) => ({
    permalink: `https://www.instagram.com/reel/${id}/`,
    media_type: "VIDEO", caption, timestamp: now, view_count, like_count, comments_count: 12, ...extra,
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(url.searchParams.has("access_token"), false);
    const fields = url.searchParams.get("fields");
    assert.match(fields, /^business_discovery\.username\((zara|mango)\)/);
    return Response.json({ business_discovery: { media: { data: [
      reel("good", "#Moda", 5000, 300),
      reel("other", "#modafashion", 99999, 999),
      reel("unknown", "#moda", undefined, 50),
      reel("old", "#moda", 12000, 100, { timestamp: "2024-01-01T00:00:00Z" }),
      reel("photo", "#moda", 5000, 100, { media_type: "IMAGE" }),
      reel("unsafe", "#moda", 5000, 100, { permalink: "https://instagram.example/reel/unsafe/" }),
    ] } } });
  });
  const source = config("zara,mango");
  const result = await discoverInstagram(source, "moda", 30, 100, 100);
  assert.equal(result.checked, 4);
  assert.deepEqual(result.videos.map((video) => [video.externalId, video.views, video.comments]), [["good", 5000, 12]]);
  const withoutThresholds = await discoverInstagram(source, "moda", 30, 0, 0);
  assert.deepEqual(withoutThresholds.videos.map((video) => [video.externalId, video.views]), [["good", 5000], ["unknown", null]]);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("a rate limit stops further requests and reports incomplete account coverage", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { code: 4 } }, { status: 400 }));
  const result = await discoverInstagram(config("a,b", "another-token"), "moda", 30, 0, 0);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(result.rateLimited, true);
  assert.equal(result.failedAccounts, 2);
  assert.deepEqual(result.videos, []);
});
