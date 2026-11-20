import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudBrowserQuery } from "../../lib/cloud-browser-contract.ts";
import { storeObservations } from "../../workers/cloud-browser/catalog.ts";
import { CloudBrowserJobs, reserveBudget } from "../../workers/cloud-browser/index.ts";
import { browserErrorCode, neutralSource, neutralSourceUrl, withDeadline } from "../../workers/cloud-browser/source.ts";

const query = { keywords: "mosses", limit: 10, platform: "all" };
const url = "http://127.0.0.1:4100/catalog";
const fields = { challenge: false, title: "Catalogue of mosses", description: "Field notes" };

test("neutral jobs reject platform search, invalid sources and caller-provided network targets", async () => {
  assert.equal(neutralSourceUrl("local", url), url);
  const hosted = "https://kadr-test.pages.dev/catalog";
  assert.equal(neutralSourceUrl("hosted", hosted), hosted);
  assert.equal(neutralSourceUrl("hosted", "https://kadr-test.team.workers.dev/catalog"), "https://kadr-test.team.workers.dev/catalog");
  for (const invalid of ["http://localhost:4100/catalog", `${url}?next=evil`, `http://user@127.0.0.1:4100/catalog`, `${url}/other`]) {
    assert.equal(neutralSourceUrl("local", invalid), null);
  }
  for (const invalid of [url, `${hosted}?q=value`, "https://a.pages.dev.evil.test/catalog", "https://instagram.com/catalog"]) {
    assert.equal(neutralSourceUrl("hosted", invalid), null);
  }
  assert.equal(cloudBrowserQuery.safeParse({ ...query, platform: "instagram" }).success, false);
  assert.equal(cloudBrowserQuery.safeParse({ ...query, limit: 11 }).success, false);
  assert.equal(cloudBrowserQuery.safeParse({ ...query, url }).success, false);
  const executor = new CloudBrowserJobs({}, {});
  const request = new Request("https://kadr-executor.internal/jobs", { method: "POST", body: JSON.stringify(query),
    headers: { "x-kadr-profile": crypto.randomUUID() } });
  const response = await executor.fetch(request);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "source_unavailable" });
});

test("budget reserves no more than eight minutes and eight launches per UTC day", () => {
  const now = Date.parse("2026-11-20T23:59:00Z");
  let state;
  for (let step = 0; step < 8; step += 1) state = reserveBudget(state, now);
  assert.deepEqual(state, { day: "2026-11-20", requests: 8, reservedMs: 480_000 });
  assert.equal(reserveBudget(state, now), null);
  assert.deepEqual(reserveBudget(state, now + 60_000), { day: "2026-11-21", requests: 1, reservedMs: 60_000 });
});

test("timeout, 429, unavailable pages and challenges yield explicit errors and no records", async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 5), (error) => browserErrorCode(error) === "timed_out");
  assert.equal(browserErrorCode(new Error("code: 429")), "browser_quota");
  assert.equal(browserErrorCode(new Error("credential details")), "browser_error");
  const page = (content, status = true, actualUrl = url) => ({
    setJavaScriptEnabled: async () => {}, setRequestInterception: async () => {}, on: () => {},
    goto: async () => ({ ok: () => status }), url: () => actualUrl, evaluate: async () => content,
  });
  const captcha = neutralSource(page({ ...fields, challenge: true }, false), url, query);
  await assert.rejects(captcha.read(), (error) => browserErrorCode(error) === "manual_intervention_required");
  await assert.rejects(neutralSource(page(fields, false), url, query).read(), (error) => browserErrorCode(error) === "source_denied");
  await assert.rejects(neutralSource(page(fields, true, "http://127.0.0.1/other"), url, query).read(), /source_denied/);
  const empty = neutralSource(page(fields), url, { ...query, keywords: "ferns" });
  assert.deepEqual(empty.normalize(await empty.read()), []);
});

test("repeated observations are keyed by canonical URL and preserve a manual note", async () => {
  const record = { id: url, url, title: fields.title, description: fields.description, fetchedAt: "2026-11-20T10:00:00.000Z" };
  const store = new Map();
  const newer = { ...record, title: "Revised heading", fetchedAt: "2026-11-20T10:00:30.000Z" };
  assert.deepEqual(await storeObservations(storeWithPromises(), [record, record]), [record]);
  store.set(`catalog:${url}`, { observation: record, note: "Team note" });
  await storeObservations(storeWithPromises(), [newer]);
  await storeObservations(storeWithPromises(), [record]);
  assert.equal(store.size, 1);
  assert.deepEqual(store.get(`catalog:${url}`), { observation: newer, note: "Team note" });

  function storeWithPromises() {
    return { get: async (key) => store.get(key), put: async (key, value) => { store.set(key, value); } };
  }
});
