// This function is serialized into the remote page by Puppeteer. Keep every
// helper inside it so that it does not reference Worker-side imports.
export function readFashionRadarPage() {
  // Method syntax keeps esbuild's keepNames transform from injecting a
  // Worker-side __name helper into this browser-serialized function.
  const visibility = { rendered(node: Element, inViewport = false) {
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    for (let current: Element | null = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    return !inViewport || rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  } };
  const challenge = [...document.querySelectorAll('iframe[src*="captcha"], [data-challenge="captcha"], #challenge-running')]
    .some(node => visibility.rendered(node, true) && (node.tagName !== "IFRAME"
      || node.getBoundingClientRect().width >= 200 && node.getBoundingClientRect().height >= 100));
  return {
    url: location.href, title: document.title,
    text: (document.body?.innerText ?? "").slice(0, 4_000), challenge,
    links: [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"],a[href*="/reel/"],a[href*="/reels/"],a[href*="/p/"]')]
      .filter(node => visibility.rendered(node)).slice(0, 200).map(node => node.href),
    hydration: [...document.querySelectorAll('script[type="application/json"],script#__UNIVERSAL_DATA_FOR_REHYDRATION__,script#SIGI_STATE')]
      .slice(0, 12).map(node => node.textContent ?? "").filter(text => text.length < 1_000_000),
  };
}
