// Synthetic HTTP harness with the two exact legacy blocks from Issue #15.
import { createServer } from "node:http";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const collector = {
  state: { phase: "waiting", platform: "tiktok", items: [] },
  busy: false,
  cancelled: false,
  sequence: 0,
  empty: false,
  hold: false,
  async collect() {
    this.busy = true;
    this.cancelled = false;
    const index = ++this.sequence;
    const id = String(7100000000000000 + index);
    this.state = { phase: "collecting", platform: "tiktok", items: [] };
    if (this.hold) await new Promise((resolve) => { this.release = resolve; });
    else await delay(this.empty ? 0 : 65);
    this.state.items = this.empty ? [] : [{ id, url: `https://www.tiktok.com/@journal.test/video/${id}`,
      title: `Синтетический сбор ${index} #тест`, source: "public-page-data", views: 0, likes: null }];
    // Instagram can return a terminal phase even when its collector was stopped.
    this.state.phase = this.empty ? "empty" : "done";
    this.state.message = `Завершён сбор ${index}`;
    this.busy = false;
    this.empty = false;
    this.hold = false;
    return { collected: true };
  },
};

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const resultFile=path.join(root,'.tmp','results.json');
async function saveResults(){
  if(!['done','empty'].includes(collector.state.phase))return;
  await mkdir(path.dirname(resultFile),{recursive:true});
  await writeFile(resultFile+'.next',JSON.stringify(collector.state),'utf8');
  await rename(resultFile+'.next',resultFile);
}

function send(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if(url.pathname==='/api/collect'){
      if(collector.busy||!['waiting','done','empty'].includes(collector.state.phase))throw Error('Сначала открой поиск и дождись страницы.');
      const run=collector.collect();
      run.then(saveResults).catch(()=>{});
      send(res,202,{ok:true});return;
    }
    if (url.pathname === "/api/status") return send(res, 200, collector.state);
    if (url.pathname === "/api/stop") {
      collector.cancelled = true;
      collector.release?.();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/fixture/next-empty") {
      collector.empty = true;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/fixture/next-hold") {
      collector.hold = true;
      return send(res, 200, { ok: true });
    }
    send(res, 404, {});
  } catch (error) {
    send(res, 400, { message: error.message });
  }
});
server.listen(0, "127.0.0.1", () => console.log(`PORT=${server.address().port}`));
