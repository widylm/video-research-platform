import type { CloudBrowserRecord } from "../../lib/cloud-browser-contract.ts";

interface CatalogStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

type CatalogRow = { observation: CloudBrowserRecord; note?: string };

export async function storeObservations(store: CatalogStore, observations: readonly CloudBrowserRecord[]) {
  const records = new Map(observations.map((record) => [record.url, record]));
  for (const [url, observation] of records) {
    const key = `catalog:${url}`;
    const previous = await store.get<CatalogRow>(key);
    if (!previous || previous.observation.fetchedAt <= observation.fetchedAt) {
      await store.put(key, { ...previous, observation });
    }
  }
  return [...records.values()];
}
