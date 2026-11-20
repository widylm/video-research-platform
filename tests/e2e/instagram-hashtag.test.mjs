import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkImportSchema } from "../../lib/bulk-import.ts";
import { runInstagramHashtagPilot } from "../../lib/providers/instagram-hashtag.ts";

const userId = "40000000000000001";
const hashtagId = "40000000000000002";
const token = "synthetic-token";
const config = { userId, accessToken: token };
const query = { hashtag: "#кофе" };
const endpoint = `/v27.0/${hashtagId}/recent_media`;
const lookup = { data: [{ id: hashtagId }] };
const media = (items, next) => ({ data: items, ...(next && { paging: { next } }) });
const nextPage = `https://graph.facebook.com${endpoint}?after=same_cursor&access_token=must_not_be_forwarded&limit=50&fields=media_url`;
const reel = (n, fields = {}) => ({ id: `7000000000000000${n}`, media_type: "VIDEO", permalink: `https://instagram.com/reels/KadrTest-${n}/?ref=test`, ...fields });
const api = (...responses) => {
  const requests = [];
  return { requests, async fetch(url, init) {
    requests.push({ url: new URL(url), init });
    assert.ok(responses.length, "Unexpected request to Graph API");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response instanceof Response ? response : Response.json(response);
  } };
};

test("fails closed without authorization, for keyword search and for an oversized pilot", async () => {
  const graph = api();
  await assert.rejects(runInstagramHashtagPilot(query, { userId }, graph.fetch), /не подключён/);
  await assert.rejects(runInstagramHashtagPilot(query, { ...config, userId: "../recent_media" }, graph.fetch), /не подключён/);
  await assert.rejects(runInstagramHashtagPilot({ hashtag: "кофе латте" }, config, graph.fetch), /один точный хэштег/);
  await assert.rejects(runInstagramHashtagPilot({ ...query, limit: 11 }, config, graph.fetch), /лимит от 1 до 10/);
  assert.equal(graph.requests.length, 0);
});

test("fetches only official metadata, deduplicates Reels by permalink, and preserves null and zero", async () => {
  const one = reel(1, { caption: "Пример #Кофе", timestamp: "2026-11-19T20:31:57+0000", like_count: 0, comments_count: 0 });
  const two = reel(2, { view_count: 500, username: "ignore_undocumented_field", media_url: "https://cdn.example/private.mp4" });
  const graph = api(lookup, media([
    { ...reel(5), media_type: "IMAGE" },
    { ...reel(6), permalink: "https://www.instagram.com/p/KadrTest-6/" },
    { ...reel(7), permalink: "https://instagram.com.example.org/reel/KadrTest-7/" },
    one,
  ], nextPage), media([{ ...one, id: reel(8).id }, two]));
  const result = await runInstagramHashtagPilot(query, config, graph.fetch);
  assert.deepEqual(result.videos.map(({ externalId }) => externalId), ["KadrTest-1", "KadrTest-2"]);
  assert.deepEqual(result.videos[0], {
    platform: "instagram", source: "instagram:hashtag-search", fetchedAt: result.videos[0].fetchedAt,
    externalId: "KadrTest-1", url: "https://www.instagram.com/reel/KadrTest-1/",
    originalTitle: null, originalDescription: "Пример #Кофе", author: null, publishedAt: "2026-11-19T20:31:57.000Z",
    views: null, likes: 0, comments: 0, hashtags: ["кофе"],
  });
  assert.equal(result.videos[1].views, null);
  assert.equal(result.videos[1].author, null);
  assert.equal(result.videos[1].likes, null);
  assert.equal(result.videos[1].comments, null);
  assert.equal(result.videos[1].hashtags, null);
  assert.deepEqual(result.report, {
    apiRequests: 3, apiMediaRows: 6, mediaPages: 2, reelsWithPermalink: 3, matchedVideos: 2, duplicates: 1, filteredOut: 0,
    repeatedPage: false, stop: "exhausted", apiFeeUsd: 0,
    missing: { originalTitle: 2, originalDescription: 1, author: 2, publishedAt: 1, views: 2, likes: 1, comments: 1, hashtags: 1 },
  });
  const [lookupCall, first, second] = graph.requests;
  assert.equal(lookupCall.url.pathname, "/v27.0/ig_hashtag_search");
  assert.equal(lookupCall.url.searchParams.get("q"), "кофе");
  assert.equal(first.url.pathname, endpoint);
  assert.equal(first.url.searchParams.get("limit"), "10");
  assert.equal(second.url.searchParams.get("limit"), "9");
  assert.equal(second.url.searchParams.get("after"), "same_cursor");
  assert.equal(second.url.searchParams.get("fields"), "id,media_type,permalink,caption,timestamp,like_count,comments_count");
  for (const { url, init } of graph.requests) {
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.equal(url.searchParams.get("user_id"), userId);
    assert.equal(url.searchParams.has("access_token"), false);
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
  }
  assert.equal(bulkImportSchema.safeParse({ version: 1, videos: result.videos }).success, true);
  assert.equal(bulkImportSchema.safeParse({ version: 1, videos: [{ ...result.videos[0], source: "mock:instagram" }] }).success, false);
});

test("filters dates and likes before the result cap and caps media pages even with Meta's repeated after", async () => {
  const recent = { timestamp: "2026-11-19T12:00:00Z", like_count: 0 };
  const graph = api(lookup,
    media([reel(1, { timestamp: "2026-11-18T12:00:00Z", like_count: 50 })], nextPage),
    media([reel(2, { ...recent, like_count: undefined })], nextPage),
    media([reel(3, recent)], nextPage));
  const result = await runInstagramHashtagPilot({ ...query, filters: { publishedFrom: recent.timestamp, minLikes: 0 } }, config, graph.fetch);
  assert.deepEqual(result.videos.map(({ externalId }) => externalId), ["KadrTest-3"]);
  assert.equal(result.report.apiRequests, 4);
  assert.equal(result.report.filteredOut, 2);
  assert.equal(result.report.stop, "page-limit");

  const small = api({ id: hashtagId }, media([reel(4)], nextPage));
  const limited = await runInstagramHashtagPilot({ ...query, limit: 1 }, config, small.fetch);
  assert.equal(limited.report.stop, "result-limit");
  assert.equal(small.requests.length, 2);
  const oversized = api(lookup, media([reel(1), reel(2)]));
  await assert.rejects(runInstagramHashtagPilot({ ...query, limit: 1 }, config, oversized.fetch), /сверх лимита/);
});

test("stops repeated pages and does not follow untrusted pagination links", async () => {
  const repeating = api(lookup, media([reel(1)], nextPage), media([reel(1)], nextPage));
  const result = await runInstagramHashtagPilot(query, config, repeating.fetch);
  assert.equal(result.report.repeatedPage, true);
  assert.equal(result.report.apiRequests, 3);
  assert.equal(result.report.matchedVideos, 1);
  const badLink = api(lookup, media([], nextPage.replace("graph.facebook.com", "example.org")));
  await assert.rejects(runInstagramHashtagPilot(query, config, badLink.fetch), /некорректный адрес/);
  assert.equal(badLink.requests.length, 2);
});

test("reports rate limits, denied permissions and API errors without retry, credentials or demo fallback", async () => {
  for (const [response, message] of [
    [Response.json({ error: { message: token } }, { status: 429 }), /ограничила запросы/],
    [Response.json({ error: { code: 4, message: token } }, { status: 400 }), /ограничила запросы/],
    [Response.json({ error: { code: 190, message: token } }, { status: 400 }), /отклонила токен/],
    [Response.json({ error: { code: 10, message: token } }, { status: 400 }), /нет доступа/],
    [new Response(token, { status: 503 }), /HTTP 503/],
    [new Error(token), /официальный Instagram Graph API недоступен/i],
    [Response.json({ images: [] }), /некорректный ответ/],
  ]) {
    const graph = api(response);
    await assert.rejects(runInstagramHashtagPilot(query, config, graph.fetch), (error) => {
      assert.match(error.message, message);
      assert.equal(error.message.includes(token), false);
      return true;
    });
    assert.equal(graph.requests.length, 1);
  }
  const empty = api({ data: [] });
  const result = await runInstagramHashtagPilot(query, config, empty.fetch);
  assert.deepEqual(result.videos, []);
  assert.equal(result.report.apiRequests, 1);
  assert.equal(result.report.mediaPages, 0);
});
