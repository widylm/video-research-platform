import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { socialPilotPlatform } from "./cloud-browser-contract";

export function cloudBrowserBinding() {
  try {
    const { env } = getCloudflareContext();
    return (env as { KADR_BROWSER_EXECUTOR?: { fetch(request: Request): Promise<Response> } }).KADR_BROWSER_EXECUTOR;
  } catch {
    // Normal Next.js and the default Worker can run without the optional binding.
    return undefined;
  }
}

export function cloudBrowserSocialPlatform() {
  try {
    return socialPilotPlatform(getCloudflareContext().env as Parameters<typeof socialPilotPlatform>[0]);
  } catch {
    return undefined;
  }
}

export function cloudEnsembleEnabled(): boolean {
  try {
    return (getCloudflareContext().env as { KADR_ENABLE_ENSEMBLEDATA?: string }).KADR_ENABLE_ENSEMBLEDATA === "1";
  } catch { return false; }
}
