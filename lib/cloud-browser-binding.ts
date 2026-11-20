import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export function cloudBrowserBinding() {
  try {
    const { env } = getCloudflareContext();
    return (env as { KADR_BROWSER_EXECUTOR?: { fetch(request: Request): Promise<Response> } }).KADR_BROWSER_EXECUTOR;
  } catch {
    // Normal Next.js and the default Worker can run without the optional binding.
    return undefined;
  }
}
