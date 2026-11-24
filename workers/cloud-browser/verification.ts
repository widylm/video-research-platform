import type { Page } from "@cloudflare/puppeteer";
import { safeVerificationUrl, type CloudBrowserDiagnostics, type CloudBrowserVerification } from "../../lib/cloud-browser-contract.ts";
import { BrowserJobError, withDeadline } from "./source.ts";

export const verificationTime = 120_000;
export interface VerificationHooks {
  reserve(): Promise<void>;
  publish(verification: CloudBrowserVerification, diagnostics: CloudBrowserDiagnostics): Promise<void>;
  resumed(): Promise<void>;
}

export async function verificationScreenshot(page: Page): Promise<string | undefined> {
  try {
    const image = await withDeadline(page.screenshot({ type: "jpeg", encoding: "base64", quality: 35,
      fullPage: false, captureBeyondViewport: false }), 2_000);
    if (image.length > 0 && image.length <= 80_000) return `data:image/jpeg;base64,${image}`;
  } catch { /* Evidence must not replace the original error. */ }
}

export async function requestHumanVerification(page: Page, diagnostics: CloudBrowserDiagnostics, hooks: VerificationHooks,
  timeoutMs = verificationTime) {
  // Reserve the additional browser time before minting a temporary access link.
  await hooks.reserve();
  let cdp: Awaited<ReturnType<Page["createCDPSession"]>> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let complete: (result: { success: boolean; reason?: string }) => void = () => {};
  const finished = new Promise<{ success: boolean; reason?: string }>(resolve => { complete = resolve; });
  const listener = (result: unknown) => {
    if (result && typeof result === "object" && "success" in result && typeof result.success === "boolean") {
      complete({ success: result.success, reason: "reason" in result && typeof result.reason === "string" ? result.reason : undefined });
    }
  };
  try {
    cdp = await page.createCDPSession();
    cdp.on("Cloudflare.handoffComplete", listener);
    // Keep the short idle timeout during a deliberate pause, without keeping a
    // disconnected/crashed browser alive for several minutes.
    const connection = cdp;
    heartbeat = setInterval(() => { void connection.send("Browser.getVersion").catch(() => {}); }, 15_000);
    const view = await cdp.send("Cloudflare.getLiveView", { mode: "tab", expiresInMs: verificationTime });
    const url = safeVerificationUrl(view.devtoolsFrontendUrl);
    if (!url) throw new BrowserJobError("verification_unavailable", diagnostics);
    await cdp.send("Cloudflare.handoff", {
      instructions: "Пройдите показанную соцсетью проверку на человека. Когда проверка завершится и появится страница, нажмите Done. Если продолжить нельзя, нажмите Failed. Не отправляйте пароль или коды в чат.",
      timeout: timeoutMs,
    });
    await hooks.publish({ url, expiresAt: new Date(Date.now() + verificationTime).toISOString() }, diagnostics);
    let result: { success: boolean; reason?: string };
    try { result = await withDeadline(finished, timeoutMs); }
    catch { throw new BrowserJobError("verification_expired", diagnostics); }
    if (!result.success) throw new BrowserJobError(/time.?out|expired/i.test(result.reason ?? "") ? "verification_expired" : "verification_failed", diagnostics);
    await hooks.resumed();
  } catch (error) {
    if (error instanceof BrowserJobError) throw error;
    throw new BrowserJobError("verification_unavailable", diagnostics);
  } finally {
    clearInterval(heartbeat);
    if (cdp) {
      cdp.off("Cloudflare.handoffComplete", listener);
      await cdp.detach().catch(() => {});
    }
  }
}
