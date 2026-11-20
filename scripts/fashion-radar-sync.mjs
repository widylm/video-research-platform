import { mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { bulkPlatforms } from "../lib/bulk-search.ts";
import { createFashionRadarSender } from "../lib/fashion-radar/sender.ts";

async function main() {
  const { values } = parseArgs({ options: {
    enable: { type: "boolean", default: false }, endpoint: { type: "string" },
    results: { type: "string" }, queue: { type: "string" }, platforms: { type: "string" },
  } });
  if (!values.enable) {
    console.log("Синхронизация отключена.");
    return;
  }
  const platforms = values.platforms?.split(",");
  if (!values.endpoint || !values.results || !values.queue || !platforms?.every((value) => bulkPlatforms.includes(value))) {
    console.error("Укажите --endpoint, --results, --queue и --platforms из списка tiktok,instagram.");
    process.exitCode = 1;
    return;
  }
  const deviceToken = process.env.KADR_RADAR_DEVICE_TOKEN;
  if (!deviceToken) {
    console.error("Код подключения устройства отсутствует. Введите его в защищённом терминале.");
    process.exitCode = 1;
    return;
  }
  delete process.env.KADR_RADAR_DEVICE_TOKEN;
  const queueFile = resolve(values.queue);
  const poll = createFashionRadarSender({
    enabled: true, endpoint: values.endpoint, queueFile, resultsFile: resolve(values.results), deviceToken, platforms,
  });
  const lock = `${queueFile}.lock`;
  await mkdir(dirname(queueFile), { recursive: true, mode: 0o700 });
  const lockFile = await open(lock, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") return null;
    throw error;
  });
  if (!lockFile) {
    console.error("Очередь уже открыта. Остановите другой процесс перед повторным запуском.");
    process.exitCode = 1;
    return;
  }
  const control = new AbortController();
  const stop = () => control.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let previous = "";
  try {
    console.log("Синхронизация ожидает завершённые результаты Fashion Radar.");
    while (!control.signal.aborted) {
      const status = await poll(control.signal);
      if (status.state === "paused") {
        console.error(`Синхронизация приостановлена (HTTP ${status.httpStatus}). Пакет остался в очереди.`);
        process.exitCode = 1;
        break;
      }
      if (status.state === "delivered") {
        console.log(`Передано ${status.sent} / отклонено ${status.rejected} / повторов ${status.duplicates}`);
      } else if (status.state !== previous && status.state === "waiting") {
        console.log("Передача отложена. Попробуем снова после паузы.");
      } else if (status.state !== previous && status.state === "queue_full") {
        console.log("Очередь заполнена. Дождитесь доставки перед следующим сбором.");
      }
      previous = status.state;
      await delay(2_000, undefined, { signal: control.signal }).catch((error) => {
        if (error.name !== "AbortError") throw error;
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await lockFile.close();
    await rm(lock, { force: true });
  }
}

try {
  await main();
} catch {
  console.error("Не удалось запустить синхронизацию. Проверьте адрес приёмника, разрешённые платформы, код устройства и файлы очереди.");
  process.exitCode = 1;
}
