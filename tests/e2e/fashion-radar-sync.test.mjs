import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bulkVideoKey } from "../../lib/bulk-search.ts";
import { fashionRadarBodyLimit, fashionRadarPath, prepareFashionRadarBatch } from "../../lib/fashion-radar/batch.ts";
import { recordFashionRadarCompletion } from "../../lib/fashion-radar/completion.ts";
import { fashionRadarDbUrl } from "../../lib/fashion-radar/postgres.ts";
import { createFashionRadarReceiver, hashFashionRadarSecret } from "../../lib/fashion-radar/receiver.ts";
import { createFashionRadarSender } from "../../lib/fashion-radar/sender.ts";

const id = "b2f57e8a-2ac1-4d5c-8169-6d9e8459485b";
const secret = "x".repeat(43);
const token = `${id}.${secret}`;
const endpoint = `https://staging.kadr.example${fashionRadarPath}`;
const platforms = ["tiktok", "instagram"];
const savedTime = "2026-11-20T10:00:00.000Z";
const clock = Date.parse(savedTime) + 60_000;
const tik = {
  id: "7000000000000000001", url: "https://m.tiktok.com/@demo.test/video/7000000000000000001?track=ignored",
  title: "Домашний кофе #Кофе", views: 0, likes: null, published_at: "2026-11-19T09:00:00.000Z", source: "public-page-data",
};
const ig = {
  id: "ig_Demo_Reel_1", url: "https://www.instagram.com/reel/Demo_Reel_1/", platform: "instagram", verified_video: true,
  title: "Рецепт #Латте", views: 400, likes: 0, published_at: null,
};
const complete = (items) => ({ state: { phase: "done", items } });
const batch = prepareFashionRadarBatch(complete([tik, ig]), savedTime, platforms).batch;

function testStore(deviceChanges = {}, rate = 10) {
  const byKey = new Map();
  const device = { tokenDigest: hashFashionRadarSecret(secret), expiresAt: clock + 1_000_000, revoked: false,
    active: true, role: "member", platforms, ...deviceChanges };
  let requests = 0;
  return {
    byKey, device, async claim(deviceId, digest) {
      if (deviceId !== id || digest !== device.tokenDigest || device.revoked || device.expiresAt <= clock) return { status: 401 };
      if (!device.active || device.role === "viewer") return { status: 403 };
      return ++requests <= rate ? { status: 200, platforms: device.platforms } : { status: 429 };
    },
    async save(_id, _digest, value) {
      let sent = 0;
      for (const video of value.videos) {
        const key = `${bulkVideoKey(video)}:${video.source}`;
        const prior = byKey.get(key);
        if (!prior || Date.parse(video.fetchedAt) > Date.parse(prior.fetchedAt)) {
          byKey.set(key, video);
          sent += 1;
        }
      }
      return { sent, duplicates: value.videos.length - sent };
    },
  };
}

function post(value, credential = token) {
  return new Request(endpoint, {
    method: "POST", body: JSON.stringify(value), headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
  });
}

test("uses only supported completed legacy records, canonical links and available metrics", () => {
  const result = prepareFashionRadarBatch(complete([tik, ig, ig, { ...tik, source: "mock:tiktok" },
    { ...ig, inspection_url: "https://www.instagram.com/p/Demo_Reel_1/" }, { ...tik, url: "https://not-tiktok.test/video/123" },
    { ...tik, id: "7000000000000000002" }, { ...ig, verified_video: false },
  ]), savedTime, platforms);
  assert.equal(result.rejected, 5);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.batch.videos, batch.videos);
  assert.equal(batch.videos[0].url, "https://www.tiktok.com/@demo.test/video/7000000000000000001");
  assert.equal(batch.videos[0].originalTitle, null);
  assert.equal(batch.videos[0].originalDescription, tik.title);
  assert.equal(batch.videos[0].views, 0);
  assert.equal(batch.videos[0].likes, null);
  assert.equal(batch.videos[1].publishedAt, null);
  assert.equal(batch.videos[1].likes, 0);
  assert.equal(batch.videos[1].views, null);
  assert.deepEqual(batch.videos[1].hashtags, ["латте"]);
  assert.equal(prepareFashionRadarBatch({ phase: "collecting", items: [tik] }, savedTime, platforms), null);
  assert.equal(prepareFashionRadarBatch({ phase: "done", message: "Остановлено. Найдено видео", items: [tik] }, savedTime, platforms), null);
  assert.equal(prepareFashionRadarBatch({ phase: "done", items: Array(51).fill(tik) }, savedTime, platforms), null);
  assert.equal(prepareFashionRadarBatch({ phase: "done", items: [ig] }, savedTime, ["tiktok"]).rejected, 1);
});

test("disabled and unauthorized requests fail closed before writes and rate limits are enforced", async () => {
  const store = testStore({}, 1);
  assert.equal((await createFashionRadarReceiver({ enabled: true })(post(batch))).status, 404);
  assert.equal((await createFashionRadarReceiver({ store })(post(batch))).status, 404);
  const handler = createFashionRadarReceiver({ enabled: true, store, now: () => clock });
  assert.equal((await handler(new Request(endpoint, { method: "POST" }))).status, 401);
  assert.equal((await handler(post(batch, `${id}.${"y".repeat(43)}`))).status, 401);
  store.device.expiresAt = clock;
  assert.equal((await handler(post(batch))).status, 401);
  store.device.expiresAt += 1_000;
  store.device.revoked = true;
  assert.equal((await handler(post(batch))).status, 401);
  store.device.revoked = false;
  store.device.role = "viewer";
  assert.equal((await handler(post(batch))).status, 403);
  store.device.role = "admin";
  store.device.active = false;
  assert.equal((await handler(post(batch))).status, 403);
  assert.equal(store.byKey.size, 0);
  store.device.active = true;
  assert.equal((await handler(post(batch))).status, 200);
  const limited = await handler(post(batch));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
});

test("validates byte limit, 1000 records, unknown fields, source scope and links", async () => {
  const store = testStore({ platforms: ["instagram"] });
  const handler = createFashionRadarReceiver({ enabled: true, store, now: () => clock });
  const makeBatch = (count) => ({ version: 1, videos: Array.from({ length: count }, (_, index) => ({
    platform: "instagram", source: "fashion-radar:instagram", externalId: `Test-${index}`, fetchedAt: savedTime,
    url: `https://www.instagram.com/reel/Test-${index}/`,
  })) });
  assert.equal((await handler(post(batch))).status, 403);
  for (const [patch, status] of [
    [{ source: "mock:instagram" }, 422], [{ source: "other:instagram" }, 403],
    [{ cookie: "do not accept" }, 422], [{ url: "https://example.test/reel/Test-0/" }, 422],
    [{ fetchedAt: "2026-11-21T10:00:00Z" }, 422],
  ]) {
    const input = makeBatch(1);
    Object.assign(input.videos[0], patch);
    assert.equal((await handler(post(input))).status, status);
  }
  assert.equal((await handler(post(makeBatch(1_001)))).status, 422);
  const tooLarge = new Request(endpoint, {
    method: "POST", body: " ".repeat(fashionRadarBodyLimit + 1),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  assert.equal((await handler(tooLarge)).status, 413);
  const input = makeBatch(1_000);
  assert.deepEqual(await (await handler(post(input))).json(), { sent: 1_000, rejected: 0, duplicates: 0 });
  assert.deepEqual(await (await handler(post(input))).json(), { sent: 0, rejected: 0, duplicates: 1_000 });
  assert.equal(store.byKey.size, 1_000);
});

test("queue persists across restart and retries lost receipts, without overwriting newer snapshots", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "kadr-radar-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const resultsFile = join(folder, "results.json");
  const queueFile = join(folder, "queue.json");
  const config = { enabled: true, endpoint, deviceToken: token, resultsFile, queueFile, platforms };
  let now = clock;
  let calls = 0;
  const store = testStore();
  const handler = createFashionRadarReceiver({ enabled: true, store, now: () => now });
  const transport = async (url, options) => {
    calls += 1;
    assert.equal(String(url), endpoint);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "manual");
    const result = await handler(new Request(url, options));
    if (calls === 1) throw new Error("Lost response after commit");
    return result;
  };
  assert.equal((await createFashionRadarSender({ ...config, enabled: false }, transport)()).state, "disabled");
  const original = createFashionRadarSender(config, transport, () => now);
  assert.equal((await original()).state, "idle");
  await writeFile(resultsFile, JSON.stringify(complete([tik, ig, ig, { ...ig, id: "bad" }])));
  await utimes(resultsFile, new Date(savedTime), new Date(savedTime));
  assert.equal((await original()).state, "waiting");
  const queued = await readFile(queueFile, "utf8");
  assert.equal(queued.includes(secret), false);
  assert.equal(queued.includes("verified_video"), false);
  assert.equal(store.byKey.size, 2);
  const restarted = createFashionRadarSender(config, transport, () => now);
  assert.equal((await restarted()).state, "waiting");
  assert.equal(calls, 1);
  now += 5_000;
  assert.deepEqual(await restarted(), { state: "delivered", sent: 0, rejected: 1, duplicates: 3 });
  assert.equal((await restarted()).state, "idle");
  assert.equal(calls, 2);

  await writeFile(resultsFile, JSON.stringify(complete([{ ...tik, views: 7 }])));
  await utimes(resultsFile, new Date(now), new Date(now));
  assert.deepEqual(await restarted(), { state: "delivered", sent: 1, rejected: 0, duplicates: 0 });
  assert.deepEqual(await (await handler(post(batch))).json(), { sent: 0, rejected: 0, duplicates: 2 });
  assert.equal(store.byKey.get("tiktok:7000000000000000001:fashion-radar:tiktok").views, 7);
});

test("sender pauses on permanent rejection, refuses redirects and never rereads a historical batch on enable", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "kadr-radar-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const resultsFile = join(folder, "results.json");
  const queueFile = join(folder, "queue.json");
  const config = { enabled: true, endpoint, deviceToken: token, resultsFile, queueFile, platforms };
  let calls = 0;
  const transport = async () => (calls += 1, Response.redirect("https://other.example", 307));
  await writeFile(resultsFile, JSON.stringify(complete([tik])));
  const sender = createFashionRadarSender(config, transport);
  assert.equal((await sender()).state, "idle");
  assert.equal(calls, 0);
  assert.throws(() => createFashionRadarSender({ ...config, endpoint: endpoint.replace("https:", "http:") }, transport));
  await writeFile(resultsFile, JSON.stringify(complete([ig])));
  assert.deepEqual(await sender(), { state: "paused", httpStatus: 307 });
  assert.equal(JSON.parse(await readFile(queueFile, "utf8")).jobs.length, 1);
  assert.equal(calls, 1);
});

test("the durable completion directory holds every run while the retry queue is full", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "kadr-radar-completion-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const directory = join(folder, "completed");
  const runCount = 19;
  for (let index = 0; index < runCount; index += 1) {
    const externalId = `71000000000000000${String(index).padStart(2, "0")}`;
    await recordFashionRadarCompletion({
      directory, collectionId: `run-${index}`, completedAt: new Date(clock + index).toISOString(), platforms,
      state: complete([{ ...tik, id: externalId, url: `https://www.tiktok.com/@demo.test/video/${externalId}` }]),
    });
  }
  const queueFile = join(folder, "queue.json");
  const config = { enabled: true, endpoint, deviceToken: token, completionDir: directory, queueFile, platforms };
  let now = clock;
  const pending = createFashionRadarSender(config, async () => new Response(null, { status: 503 }), () => now);
  for (let index = 0; index < runCount; index += 1) assert.equal((await pending()).state, "waiting");
  assert.equal((await readdir(directory)).length, 3);
  assert.equal(JSON.parse(await readFile(queueFile, "utf8")).jobs.length, 16);

  const observed = [];
  const drain = createFashionRadarSender(config, async (_url, options) => {
    observed.push(JSON.parse(options.body).videos[0].externalId);
    return Response.json({ sent: 1, rejected: 0, duplicates: 0 });
  }, () => now);
  now += 5_000;
  for (let index = 0; index < runCount; index += 1) assert.equal((await drain()).state, "delivered");
  assert.equal(new Set(observed).size, runCount);
  assert.deepEqual(await readdir(directory), []);
});

test("the receiver configuration rejects privileged logins and URL options which could disable TLS", () => {
  const url = "postgresql://kadr_radar_ingest.projectref:example@pooler.example:6543/postgres";
  assert.ok(fashionRadarDbUrl(url));
  assert.equal(fashionRadarDbUrl(url.replace("kadr_radar_ingest.projectref", "postgres.projectref")), null);
  assert.equal(fashionRadarDbUrl(`${url}?sslmode=disable`), null);
  assert.equal(fashionRadarDbUrl(url.replace(":example@", "@")), null);
});
