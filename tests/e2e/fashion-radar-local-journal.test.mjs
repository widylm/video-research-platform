import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

let files;
let installer;
let fixture;
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

before(async () => {
  files = await mkdtemp(join(tmpdir(), "kadr-radar-kit-"));
  installer = join(files, "kit with spaces");
  fixture = "\uFEFF" + (await readFile(new URL("fixtures/legacy-fashion-radar-server.mjs", import.meta.url), "utf8")).replace(/\n/g, "\r\n");
  execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/package-fashion-radar-local-journal.mjs", import.meta.url)), installer]);
});
after(() => rm(files, { recursive: true, force: true }));

async function setup(name, source = fixture) {
  const root = join(files, `Fashion Radar ${name}`);
  const server = join(root, "collector", "server.mjs");
  const journal = join(root, ".kadr-journal");
  await mkdir(join(root, "collector"), { recursive: true });
  await writeFile(server, source);
  await writeFile(join(root, "Start-Collector.cmd"), "@node collector\\server.mjs\r\n");
  return {
    root, server, journal, completed: join(journal, "completed"), pending: join(journal, "pending"),
    results: join(root, ".tmp", "results.json"),
    apply: (...flags) => execFileSync(process.execPath, [join(installer, "install.mjs"), root, ...flags], { encoding: "utf8", stdio: "pipe" }),
  };
}

async function until(get, matches, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await get().catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (matches(value)) return value;
    await delay(10);
  }
  throw new Error("Local collector condition was not reached.");
}

async function start(t, server) {
  const child = spawn(process.execPath, [server], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let warnings = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { warnings += chunk; });
  const stop = async (signal = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill(signal);
    await exited;
  };
  t.after(() => stop());
  const match = await until(async () => {
    if (child.exitCode !== null) throw new Error(warnings);
    return /PORT=(\d+)/.exec(output);
  }, Boolean);
  const request = (path, method = "GET") => fetch(`http://127.0.0.1:${match[1]}${path}`, { method });
  return { request, stop, warnings: () => warnings, status: async () => (await request("/api/status")).json() };
}

async function run(app) {
  const response = await app.request("/api/collect", "POST");
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true });
}

test("the standalone installer edits the issue's CRLF blocks, is reversible and refuses mismatched files", async () => {
  const installation = await setup("Журнал");
  const { server, apply, root } = installation;
  const original = await readFile(server);
  assert.match(apply("--check"), /Оба фрагмента/);
  assert.deepEqual(await readFile(server), original);
  assert.match(apply(), /Патч установлен/);
  const patched = await readFile(server, "utf8");
  assert.match(patched, /^\uFEFFimport [^\r\n]+\r\n/);
  assert.match(patched, /kadrLocalJournal\.track\(collector,run\)/);
  assert.match(patched, /const run=collector\.collect\(\)/);
  assert.equal(await readFile(join(root, "Start-Collector.cmd"), "utf8"), "@node collector\\server.mjs\r\n");
  assert.deepEqual(await readFile(`${server}.kadr-original`), original);
  assert.match(apply("--enable"), /журнал включён/);
  assert.equal(await readFile(server, "utf8"), patched);
  assert.match(apply("--restore"), /восстановлен/);
  assert.deepEqual(await readFile(server), original);
  const changed = fixture.replace("run.then(saveResults).catch", "run.then(() => saveResults()).catch");
  const different = await setup("Другой формат", changed);
  assert.throws(() => different.apply("--enable"), /фрагмент .*collect/);
  assert.equal(await readFile(different.server, "utf8"), changed);
  await assert.rejects(readFile(`${different.server}.kadr-original`), { code: "ENOENT" });
});

test("disabled mode keeps the native results and HTTP status flow without creating journal files", async (t) => {
  const local = await setup("Выключено");
  local.apply("--enable");
  local.apply("--disable");
  const app = await start(t, local.server);
  await run(app);
  const result = await until(() => readJson(local.results), (state) => state?.phase === "done");
  assert.deepEqual(await app.status(), result);
  assert.match(result.message, /Завершён сбор 1/);
  await assert.rejects(readdir(local.journal), { code: "ENOENT" });
});

test("captures consecutive and empty runs, skips cancelled runs, and continues with a full sender queue", async (t) => {
  const local = await setup("Очередь");
  local.apply("--enable");
  await mkdir(local.journal);
  const queueFile = join(local.journal, "queue.json");
  const fullQueue = JSON.stringify({ jobs: Array.from({ length: 16 }, () => ({ pending: true })) });
  await writeFile(queueFile, fullQueue);
  const app = await start(t, local.server);

  await run(app);
  await until(app.status, (state) => state.phase === "done");
  await run(app);
  await until(() => readdir(local.completed), (names) => names?.length === 2);

  await app.request("/fixture/next-hold");
  await run(app);
  assert.equal((await app.request("/api/stop", "POST")).status, 200);
  await until(() => readJson(local.results), (state) => state?.message === "Завершён сбор 3");
  assert.equal((await readdir(local.completed)).length, 2);

  await app.request("/fixture/next-empty");
  await run(app);
  const names = await until(() => readdir(local.completed), (files) => files?.length === 3);
  const records = await Promise.all(names.map((name) => readJson(join(local.completed, name))));
  const videos = records.flatMap(({ batch }) => batch?.videos ?? []);
  assert.deepEqual(new Set(videos.map(({ originalDescription }) => originalDescription)),
    new Set(["Синтетический сбор 1 #тест", "Синтетический сбор 2 #тест"]));
  assert.equal(records.filter(({ batch }) => batch === null).length, 1);
  assert.ok(videos.every(({ views, likes }) => views === 0 && likes === null));
  assert.equal(await readFile(queueFile, "utf8"), fullQueue);
});

test("preserves original results on publish failure, and replays staged runs once after process loss", async (t) => {
  const local = await setup("Восстановление");
  local.apply("--enable");
  await mkdir(local.journal);
  await writeFile(local.completed, "blocked");
  const app = await start(t, local.server);
  for (const index of [1, 2]) {
    await run(app);
    await until(() => readJson(local.results), (state) => state?.message === `Завершён сбор ${index}`);
  }
  const staged = await readdir(local.pending);
  assert.equal(staged.length, 2);
  assert.match((await app.status()).message, /журнал недоступен/);
  assert.match(app.warnings(), /журнал недоступен/);
  await app.stop("SIGKILL");

  await rm(local.completed);
  await mkdir(local.completed);
  // Reproduce an interruption after publication but before the source entry was unlinked.
  await link(join(local.pending, staged[0]), join(local.completed, staged[0]));
  const restarted = await start(t, local.server);
  await until(() => readdir(local.pending), (names) => names?.length === 0);
  assert.deepEqual((await readdir(local.completed)).sort(), staged.sort());
  assert.equal((await readJson(local.results)).message, "Завершён сбор 2");
  assert.equal((await restarted.status()).phase, "waiting");
});

test("a separate original state for every run survives when both staging directories are blocked", async (t) => {
  const local = await setup("Резерв");
  local.apply("--enable");
  const temp = join(local.root, ".tmp");
  const backup = join(temp, "kadr-journal-recovery");
  await mkdir(local.journal);
  await mkdir(temp);
  await writeFile(local.pending, "blocked");
  await writeFile(backup, "blocked");
  const app = await start(t, local.server);
  for (const index of [1, 2]) {
    await run(app);
    await until(() => readJson(local.results), (state) => state?.message === `Завершён сбор ${index}`);
  }
  const rescues = (await readdir(temp)).filter((name) => name.startsWith(".kadr-rescue-"));
  assert.equal(rescues.length, 2);
  const snapshots = await Promise.all(rescues.map((name) => readJson(join(temp, name))));
  assert.equal(new Set(snapshots.map(({ collectionId }) => collectionId)).size, 2);
  await app.stop("SIGKILL");

  await rm(local.pending);
  await rm(backup);
  await start(t, local.server);
  const names = await until(() => readdir(local.completed), (entries) => entries?.length === 2);
  const converted = await Promise.all(names.map((name) => readJson(join(local.completed, name))));
  assert.deepEqual(new Set(converted.map(({ batch }) => batch.videos[0].fetchedAt)),
    new Set(snapshots.map(({ completedAt }) => completedAt)));
  assert.equal((await readdir(temp)).some((name) => name.startsWith(".kadr-rescue-")), false);
  assert.deepEqual(await readJson(local.results), snapshots.find(({ state }) => state.message === "Завершён сбор 2").state);
});
