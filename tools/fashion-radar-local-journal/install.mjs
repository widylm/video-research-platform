import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { patchCollector } from "./patch.mjs";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);

async function readOptional(path) {
  return readFile(path).then((bytes) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function replaceFile(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", flush: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) throw new Error("Требуется Node.js 22.12 или новее.");
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { enable: { type: "boolean" }, disable: { type: "boolean" }, restore: { type: "boolean" }, check: { type: "boolean" } },
  });
  if (positionals.length > 1 || Object.values(values).filter(Boolean).length > 1) {
    throw new Error("Укажите одну папку Fashion Radar и не более одного режима.");
  }
  let location = positionals[0];
  if (!location) {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try { location = (await reader.question("Путь к папке Fashion Radar (где находится Start-Collector.cmd): ")).trim(); }
    finally { reader.close(); }
  }
  location = location?.replace(/^"([^"]+)"$/, "$1");
  if (!location) throw new Error("Укажите папку Fashion Radar.");

  const collectorDir = resolve(location, "collector");
  const server = join(collectorDir, "server.mjs");
  const backupFile = `${server}.kadr-original`;
  const adapter = join(collectorDir, "kadr-journal");
  const flag = join(adapter, "enabled");
  const current = await readOptional(server);
  if (current === null) throw new Error("В указанной папке не найден collector/server.mjs.");
  const backup = await readOptional(backupFile);
  const original = backup ?? current;
  const patched = patchCollector(original);
  if (current !== original && current !== patched) {
    throw new Error("После создания резервной копии server.mjs изменился. Установщик оставил его без изменений.");
  }

  if (values.check) {
    console.log(current === patched ? "Патч уже установлен." : "Оба фрагмента из Issue №15 совпадают. Можно установить журнал.");
    return;
  }
  if (values.restore || values.disable) {
    await rm(flag, { force: true });
    if (values.restore && current === patched) await replaceFile(server, original);
    console.log(values.restore ? "Исходный server.mjs восстановлен. Журнал и резервная копия сохранены." : "Журнал выключен. Перезапустите Fashion Radar.");
    return;
  }

  const runtime = await readFile(new URL("./collector.mjs", import.meta.url), "utf8");
  if (backup === null) await writeFile(backupFile, original, { flag: "wx", flush: true });
  await mkdir(adapter, { recursive: true });
  await replaceFile(join(adapter, "collector.mjs"), runtime);
  if (current !== patched) {
    await rm(flag, { force: true });
    await replaceFile(server, patched);
  }
  if (values.enable) await replaceFile(flag, "local-only\n");
  const enabled = await readOptional(flag) !== null;
  console.log(enabled ? "Локальный журнал включён. Запустите обычный Start-Collector.cmd."
    : "Патч установлен. Для включения локального журнала запустите установщик с --enable.");
}

try {
  await main();
} catch (error) {
  console.error(`Установка остановлена. ${error.message}`);
  process.exitCode = 1;
}
