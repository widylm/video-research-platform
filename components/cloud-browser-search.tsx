"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { browserJobActive, cloudBrowserErrors, cloudBrowserUrl, type CloudBrowserErrorCode, type CloudBrowserJob } from "@/lib/cloud-browser-contract";
import type { BulkQuery } from "@/lib/bulk-search";

const status = { pending: "В очереди", running: "Браузер выполняет поиск", awaiting_verification: "Ожидает ручной проверки", completed: "Проверка завершена", failed: "Проверка не завершилась" };
const describe = (code?: CloudBrowserErrorCode) => (code && cloudBrowserErrors[code]) || cloudBrowserErrors.unavailable;

export function CloudBrowserSearch() {
  const [job, setJob] = useState<CloudBrowserJob | null>(null);
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const active = browserJobActive(job?.state);
  const busy = !ready || starting || active;

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function refresh() {
      try {
        const response = await fetch(cloudBrowserUrl, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(describe(data.error));
        if (!controller.signal.aborted) {
          setJob(data.job);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : describe());
      } finally {
        if (!controller.signal.aborted) {
          setReady(true);
          if (active) timer = window.setTimeout(refresh, 1_500);
        }
      }
    }
    if (!ready) void refresh();
    else if (active) timer = window.setTimeout(refresh, 1_500);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [active, ready]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const query: BulkQuery = { keywords: String(fields.get("keywords") ?? ""), platform: "all", limit: 10 };
    setStarting(true);
    setError("");
    try {
      const response = await fetch(cloudBrowserUrl, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query),
      });
      const data = await response.json();
      if (response.ok) setJob(data.job);
      else setError(describe(data.error));
    } catch { setError(describe()); }
    finally { setStarting(false); }
  }

  return <>
    <form className="panel pilot-form" onSubmit={submit}>
      <label>Ключевые слова<input name="keywords" required maxLength={120} disabled={busy} /></label>
      <div className="pilot-actions">
        <span>Разрешённая тестовая страница · отдельный каталог документов</span>
        <button className="button primary" disabled={busy} type="submit"><Search size={16} /> Найти</button>
      </div>
    </form>
    {error && <p className="notice error" role="alert">{error}</p>}
    {job && <section className="results-section" aria-label="Результаты облачной проверки">
      <p role="status">{status[job.state]}{job.state === "completed" ? ` · Найдено: ${job.records.length}` : ""}</p>
      {job.error && <p className="notice error" role="alert">{describe(job.error)}</p>}
      {job.state === "completed" && job.records.length === 0 && <p className="panel empty-state">По запросу ничего не найдено.</p>}
      {job.records.map((record) => <article className="panel pilot-card" key={record.id}>
        <h3>{record.title}</h3>
        {record.description && <p>{record.description}</p>}
        <a href={record.url} target="_blank" rel="noreferrer">Открыть тестовый источник</a>
      </article>)}
    </section>}
  </>;
}
