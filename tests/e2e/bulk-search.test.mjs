import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkQuerySchema, bulkStoredResultSchema, searchBulk } from "../../lib/bulk-search.ts";
import { runBulkPilot } from "../../lib/providers/bulk-pilot.ts";

const query = { keywords: "кофе", platform: "all", limit: 5 };
const a = "2000000000000000001";
const b = "2000000000000000002";
const c = "2000000000000000003";
const page = (items, nextCursor = null, chargedMicros = 0) => ({ items, nextCursor, chargedMicros });
const provider = (id, platform, pages, { quoted = 0, billing = "free" } = {}) => {
  const requests = [];
  return {
    id, platform, billing, requests,
    quotePageMicros: () => quoted,
    async fetchPage(input) {
      requests.push(input);
      return pages[input.cursor ?? "first"];
    },
  };
};

test("bulk search deduplicates per platform across pages and preserves nulls and zero", async () => {
  const tik = provider("test:tiktok", "tiktok", {
    first: page([{ externalId: a, views: 0, originalTitle: " ", url: `https://m.tiktok.com/@studio/video/${a}?tracking=yes` }], "next"),
    next: page([{ externalId: a, views: 50 }, { externalId: b, comments: 0, url: `https://wrong.example/${b}` }, { externalId: c, likes: -1 }]),
  });
  const ig = provider("test:instagram", "instagram", {
    first: page([{ externalId: a, url: `https://instagram.com/reels/${a}/`, originalDescription: " Подпись " }]),
  });
  const result = await searchBulk(query, [tik, ig], { budgetMicros: 0 });
  assert.deepEqual(result.videos.map(({ platform, externalId }) => [platform, externalId]), [
    ["tiktok", a], ["instagram", a], ["tiktok", b],
  ]);
  assert.deepEqual(result.videos[0], {
    platform: "tiktok", externalId: a, url: `https://www.tiktok.com/@studio/video/${a}`,
    originalTitle: null, originalDescription: null, author: null, publishedAt: null,
    views: 0, likes: null, comments: null, hashtags: null, source: "test:tiktok",
    fetchedAt: result.videos[0].fetchedAt,
  });
  assert.match(result.videos[0].fetchedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(result.videos[1].originalDescription, "Подпись");
  assert.equal(result.videos[1].url, `https://www.instagram.com/reel/${a}/`);
  assert.equal(result.videos[2].comments, 0);
  assert.equal(result.videos[2].url, null);
  assert.equal(result.duplicates, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.stop, "exhausted");
  assert.deepEqual(tik.requests.map(({ cursor, limit }) => [cursor, limit]), [[null, 3], ["next", 3]]);
  assert.deepEqual(bulkStoredResultSchema.parse(JSON.parse(JSON.stringify({ query, result }))).result, result);
});

test("the pipeline enforces result and page limits before asking a provider", async () => {
  const source = provider("test:tiktok", "tiktok", {
    first: page([{ externalId: a }], "next"),
    next: page([{ externalId: a }], "third"),
    third: page([{ externalId: b }]),
  });

  const limited = await searchBulk({ ...query, limit: 1 }, [source], { budgetMicros: 0 });
  assert.equal(limited.videos.length, 1);
  assert.equal(limited.stop, "result-limit");
  assert.equal(source.requests.length, 1);
  assert.equal(source.requests[0].limit, 1);

  const scanned = await searchBulk(query, [source], { budgetMicros: 0, maxPages: 2 });
  assert.equal(scanned.pagesScanned, 2);
  assert.equal(scanned.duplicates, 1);
  assert.equal(scanned.stop, "page-limit");
  assert.equal(source.requests.length, 3);
  assert.equal(bulkQuerySchema.safeParse({ ...query, limit: 1_001 }).success, false);
  assert.equal(bulkQuerySchema.safeParse({ ...query, keywords: "  " }).success, false);
});

test("the cap is checked before each billed read, including a metered provider quoting zero", async () => {
  const metered = provider("test:metered", "tiktok", {
    first: page([{ externalId: a }], "next", 300),
    next: page([{ externalId: b }], null, 300),
  }, { quoted: 500, billing: "metered" });
  const zeroQuote = provider("test:zeroquote", "tiktok", { first: page([]) }, { billing: "metered" });
  const free = provider("test:mock", "instagram", { first: page([{ externalId: "reel-test" }]) });
  const zero = await searchBulk(query, [metered, zeroQuote, free], { budgetMicros: 0 });
  assert.equal(metered.requests.length, 0);
  assert.equal(zeroQuote.requests.length, 0);
  assert.equal(zero.videos.length, 1);
  assert.equal(zero.chargedMicros, 0);
  assert.equal(zero.stop, "budget-limit");

  const limited = await searchBulk(query, [metered], { budgetMicros: 700 });
  assert.equal(metered.requests.length, 1);
  assert.equal(metered.requests[0].maxChargeMicros, 500);
  assert.equal(limited.chargedMicros, 300);
  assert.equal(limited.stop, "budget-limit");

  const broken = provider("test:overrun", "instagram", { first: page([], null, 501) }, { quoted: 500, billing: "metered" });
  await assert.rejects(searchBulk(query, [broken], { budgetMicros: 700 }), /page contract/);
});

test("a provider repeating a cursor or returning too many records is rejected", async () => {
  const repeats = provider("test:cursor", "tiktok", { first: page([], "next"), next: page([], "next") });
  await assert.rejects(searchBulk(query, [repeats], { budgetMicros: 0 }), /repeated a cursor/);
  const oversized = provider("test:overflow", "tiktok", { first: page([{ externalId: a }, { externalId: b }]) });
  await assert.rejects(searchBulk({ ...query, limit: 1 }, [oversized], { budgetMicros: 0 }), /page contract/);
});

test("the pilot supplies 1000 unique synthetic videos across both platforms at zero cost", async () => {
  const result = await runBulkPilot({ ...query, keywords: " КОФЕ ", limit: 1_000 });
  assert.equal(result.videos.length, 1_000);
  assert.equal(result.pagesScanned, 20);
  assert.equal(new Set(result.videos.map(({ platform, externalId }) => `${platform}:${externalId}`)).size, 1_000);
  assert.equal(result.videos.filter(({ platform }) => platform === "tiktok").length, 500);
  assert.ok(result.videos.every(({ source, url }) => source.startsWith("mock:") && url === null));
  assert.equal(result.chargedMicros, 0);
  assert.equal(result.budgetMicros, 0);
  const small = await runBulkPilot({ ...query, limit: 2 });
  assert.deepEqual(small.videos.map(({ platform }) => platform), ["tiktok", "instagram"]);
  assert.equal((await runBulkPilot({ ...query, platform: "instagram", limit: 1_000 })).videos.length, 600);
  assert.equal((await runBulkPilot({ ...query, keywords: "нет такого" })).videos.length, 0);
});
