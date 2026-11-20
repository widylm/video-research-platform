import { existsSync } from "node:fs";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { completionFileName, recordFashionRadarCompletion, syncDirectory } from "../../lib/fashion-radar/completion.ts";

const finished = (state) => state.phase === "done" || state.phase === "empty";
const platforms = ["tiktok", "instagram"];
const journalWarning = "Локальный журнал недоступен или ожидает восстановления. Проверьте лог Fashion Radar.";
const resultsWarning = "Не удалось записать results.json. Проверьте доступ к папке Fashion Radar.";
const rescueName = /^\.kadr-rescue-([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\.json$/;

function entries(directory) {
  return readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function preserveOriginal(directory, file, job) {
  const temporary = join(directory, `${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(job), { flag: "wx", flush: true, mode: 0o600 });
    await link(temporary, file).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function publishPending(directory, completed) {
  const names = await entries(directory);
  for (const name of names.filter((value) => completionFileName.test(value)).sort()) {
    await mkdir(completed, { recursive: true, mode: 0o700 });
    const source = join(directory, name);
    await link(source, join(completed, name)).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await syncDirectory(completed);
    await rm(source, { force: true });
  }
}

export function createLocalCollectorJournal(root, saveResults, warn = console.warn) {
  const enabled = existsSync(join(root, "collector", "kadr-journal", "enabled"));
  if (!enabled) return { track: (_collector, run) => run.then(() => saveResults()).catch(() => {}) };

  const completed = join(root, ".kadr-journal", "completed");
  const legacyFolder = join(root, ".tmp");
  const pending = [join(root, ".kadr-journal", "pending"), join(legacyFolder, "kadr-journal-recovery")];
  const lastRun = new WeakMap();
  const unsaved = new Map();

  async function recover() {
    let successful = true;
    for (const directory of pending) {
      try { await publishPending(directory, completed); } catch { successful = false; }
    }
    return successful;
  }

  async function stage() {
    for (const [id, job] of unsaved) {
      const rescue = join(legacyFolder, `.kadr-rescue-${id}.json`);
      for (const directory of pending) {
        try {
          await recordFashionRadarCompletion({ ...job, directory, platforms });
          unsaved.delete(id);
          await rm(rescue, { force: true }).catch(() => {}); // A stale rescue entry can be replayed safely.
          break;
        } catch { /* Try the recovery folder while keeping the same run ID and timestamp. */ }
      }
      if (unsaved.has(id)) await preserveOriginal(legacyFolder, rescue, job).catch(() => {});
    }
    const recovered = await recover();
    return recovered && unsaved.size === 0;
  }

  async function restore() {
    let intact = true;
    for (const name of await entries(legacyFolder)) {
      const id = rescueName.exec(name)?.[1];
      if (!id) continue;
      try {
        const saved = JSON.parse(await readFile(join(legacyFolder, name), "utf8"));
        if (saved.collectionId !== id || typeof saved.completedAt !== "string" || !finished(saved.state)) throw new Error();
        unsaved.set(id, saved);
      } catch { intact = false; }
    }
    if (!await stage() || !intact) warn(`[Кадр] ${journalWarning}`);
  }

  let saves = restore().catch(() => warn(`[Кадр] ${journalWarning}`));

  return {
    track(collector, run) {
      const collectionId = randomUUID();
      lastRun.set(collector, collectionId);
      return run.then(() => {
        const liveState = collector.state;
        if (!finished(liveState)) return;

        const state = JSON.parse(JSON.stringify(liveState));
        const completedAt = new Date().toISOString();
        // Both browser collectors set cancelled on stop. TikTok can also return a terminal phase after cancellation.
        const cancelled = collector.cancelled === true || state.cancelled === true
          || (typeof state.message === "string" && state.message.startsWith("Остановлено."));
        const report = (message) => {
          warn(`[Кадр] ${message}`);
          if (lastRun.get(collector) === collectionId && collector.state === liveState && finished(liveState)) {
            liveState.message = `${liveState.message ?? ""} ${message}`.trim();
          }
        };
        const save = saves.then(async () => {
          if (!cancelled) unsaved.set(collectionId, { collectionId, completedAt, state });
          if (!await stage()) report(journalWarning);
          // The old results file is written even when the journal could not be staged or published.
          try { await saveResults(state); } catch { report(resultsWarning); }
        });
        saves = save.catch(() => report(journalWarning));
        return saves;
      }).catch(() => warn(`[Кадр] Сбор или сохранение завершились ошибкой.`));
    },
  };
}
