import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bulkImportSchema } from "../../lib/bulk-import.ts";
import { bulkQuerySchema, searchBulk } from "../../lib/bulk-search.ts";
import { normalizeFashionRadarVideo } from "../../lib/providers/fashion-radar-metadata.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/fashion-radar-metadata.json", import.meta.url), "utf8"));
const publishedAt = "2026-11-01T12:00:00.000Z";
const tiktokUrl = "https://www.tiktok.com/@fixture.cafe/video/7000000000000000001";

test("TikTok maps captions, separate titles, safe IDs, counts and hashtags", () => {
  const row = normalizeFashionRadarVideo("tiktok", fixture.tiktokVideo);
  assert.deepEqual(row, {
    externalId: "7000000000000000001", url: tiktokUrl, author: "fixture.cafe",
    originalTitle: "Домашний эспрессо", originalDescription: "Готовим эспрессо #Кофе #кофе #CAFÉ",
    publishedAt, views: 250, likes: 0, comments: 8, hashtags: ["рецепт", "café", "кофе"],
  });
  const captionIsNotTitle = normalizeFashionRadarVideo("tiktok", { ...fixture.tiktokVideo, title: fixture.tiktokVideo.desc });
  assert.equal(captionIsNotTitle.originalTitle, null);
  assert.equal(normalizeFashionRadarVideo("tiktok", { url: tiktokUrl }).author, "fixture.cafe");
  assert.deepEqual(normalizeFashionRadarVideo("tiktok", fixture.tiktokMissing), {
    externalId: "7000000000000000002", url: null, author: null,
    originalTitle: null, originalDescription: null, publishedAt: null,
    likes: null, views: null, comments: null, hashtags: null,
  });
});

test("Instagram uses public shortcode, caption, username and view counts, excluding hidden data", () => {
  assert.deepEqual(normalizeFashionRadarVideo("instagram", fixture.instagramReel), {
    externalId: "Fixture_Reel-1", url: "https://www.instagram.com/reel/Fixture_Reel-1/", author: "fixture.reels",
    originalTitle: null, originalDescription: "Молочная пенка #Латте", publishedAt,
    views: 1200, likes: 30, comments: 0, hashtags: ["латте"],
  });
  assert.deepEqual(normalizeFashionRadarVideo("instagram", fixture.instagramHidden), {
    externalId: "Fixture_Reel-2", url: "https://www.instagram.com/reel/Fixture_Reel-2/", author: "fixture.private_metrics",
    originalTitle: null, originalDescription: "Без хэштегов", publishedAt: null,
    views: null, likes: null, comments: 2, hashtags: [],
  });
  const playsOnly = normalizeFashionRadarVideo("instagram", { ...fixture.instagramReel, view_count: undefined });
  assert.equal(playsOnly.views, null);
  const linkOnly = normalizeFashionRadarVideo("instagram", { url: fixture.instagramReel.permalink });
  assert.equal(linkOnly.author, null);
  assert.equal(linkOnly.hashtags, null);
  const unknownProduct = normalizeFashionRadarVideo("instagram", { ...fixture.instagramHidden, product_type: null });
  assert.equal(unknownProduct.url, null);
});

test("offline normalization rejects mismatches, untrusted URLs, rounded IDs and photos", () => {
  for (const url of [
    "https://vm.tiktok.com/abcd/", "https://www.tiktok.com.evil.test/@fixture.cafe/video/7000000000000000001",
    "https://fixture:password@www.tiktok.com/@fixture.cafe/video/7000000000000000001",
    "https://www.tiktok.com/@fixture.cafe/video/7000000000000000002",
    "https://www.instagram.com/reel/Fixture_Reel-1/",
  ]) {
    assert.equal(normalizeFashionRadarVideo("tiktok", { ...fixture.tiktokVideo, url }), null);
  }
  assert.equal(normalizeFashionRadarVideo("tiktok", { ...fixture.tiktokVideo, id: Number(fixture.tiktokVideo.id) }), null);
  assert.equal(normalizeFashionRadarVideo("tiktok", { ...fixture.tiktokVideo, imagePost: {} }), null);
  assert.equal(normalizeFashionRadarVideo("instagram", { ...fixture.instagramReel, media_type: 1 }), null);
  assert.equal(normalizeFashionRadarVideo("instagram", { ...fixture.instagramReel, code: "Other_Reel" }), null);
  assert.equal(normalizeFashionRadarVideo("instagram", { ...fixture.instagramReel, permalink: "https://instagram.com/p/Fixture_Reel-1/" }), null);
});

test("PR #9 filters normalized rows before the result cap and keeps one row per platform and ID", async () => {
  const good = normalizeFashionRadarVideo("tiktok", fixture.tiktokVideo);
  const sparse = normalizeFashionRadarVideo("tiktok", fixture.tiktokMissing);
  const tooOld = { ...good, externalId: "7000000000000000003", url: null, publishedAt: "2026-10-31T23:59:59Z" };
  const tooNew = { ...good, externalId: "7000000000000000004", url: null, publishedAt: "2026-11-01T12:00:01Z" };
  const lowViews = { ...good, externalId: "7000000000000000005", url: null, views: 249 };
  const unknownLikes = { ...good, externalId: "7000000000000000006", url: null, likes: null };
  const pages = [sparse, tooOld, tooNew, lowViews, unknownLikes, good, good];
  const provider = {
    id: "fixture:tiktok", platform: "tiktok", billing: "free", quotePageMicros: () => 0,
    async fetchPage({ cursor }) {
      const offset = Number(cursor ?? 0);
      return { items: [pages[offset]], nextCursor: offset + 1 === pages.length ? null : String(offset + 1), chargedMicros: 0 };
    },
  };
  const filters = { publishedFrom: "2026-11-01T15:00:00+03:00", publishedTo: publishedAt, minViews: 250, minLikes: 0 };
  const query = { keywords: "кофе", platform: "tiktok", limit: 2, filters };
  const result = await searchBulk(query, [provider], { budgetMicros: 0 });
  assert.equal(result.pagesScanned, 7);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.videos.map(({ externalId }) => externalId), [good.externalId]);
  assert.equal(result.videos[0].likes, 0);
  assert.equal((await searchBulk({ ...query, limit: 1 }, [provider], { budgetMicros: 0 })).pagesScanned, 6);
  assert.equal(bulkQuerySchema.safeParse({ ...query, filters: { minViews: -1 } }).success, false);
  assert.equal(bulkQuerySchema.safeParse({ ...query, filters: { ...filters, publishedTo: "2026-10-31T12:00:00Z" } }).success, false);
});

test("the future import boundary accepts unique metadata with nulls and strips incidental data", () => {
  const fromTikTok = { ...normalizeFashionRadarVideo("tiktok", fixture.tiktokVideo),
    platform: "tiktok", source: "fixture:tiktok", fetchedAt: "2026-11-20T12:00:00Z" };
  const fromInstagram = { ...normalizeFashionRadarVideo("instagram", fixture.instagramHidden),
    platform: "instagram", source: "fixture:instagram", fetchedAt: "2026-11-20T12:00:00Z" };
  const batch = { version: 1, videos: [fromTikTok, { ...fromInstagram,
    id: "database-managed", cookies: "test-only", video_versions: ["not-imported"], note: "team data stays separate",
  }] };
  const validated = bulkImportSchema.parse(batch);
  assert.deepEqual(validated.videos, [fromTikTok, fromInstagram].map((row) => ({ ...row, fetchedAt: "2026-11-20T12:00:00.000Z" })));
  assert.equal(validated.videos[0].likes, 0);
  assert.equal(validated.videos[1].likes, null);
  for (const invalid of [
    { ...batch, version: 2 }, { ...batch, collectionId: "no-side-effects" },
    { ...batch, videos: [] }, { ...batch, videos: [fromTikTok, fromTikTok] },
    { ...batch, videos: Array(1_001).fill(fromTikTok) },
    ...[{ url: null }, { url: "https://example.org/video" }, { source: "mock:tiktok" }, { originalDescription: "abc\0def" }]
      .map((patch) => ({ ...batch, videos: [{ ...fromTikTok, ...patch }] })),
  ]) assert.equal(bulkImportSchema.safeParse(invalid).success, false);
});
