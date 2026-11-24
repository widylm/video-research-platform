import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { transformSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { readFashionRadarPage } from '../../workers/cloud-browser/page-state.ts';

test('hidden, transparent, off-screen and tiny CAPTCHA frames do not stop collection; a visible challenge does', async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true, args: ['--no-sandbox'] });
  try {
    const scope = {};
    const bundled = transformSync('var reader = ' + readFashionRadarPage.toString(), { keepNames: true, target: 'es2022' }).code;
    runInNewContext(bundled, scope);
    const inspect = '(' + scope.reader.toString() + ')()';
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent('<div id="wrapper" style="display:none"><iframe src="about:blank#captcha" width="350" height="250"></iframe></div>');
    assert.equal((await page.evaluate(inspect)).challenge, false);
    await page.locator('#wrapper').evaluate(node => { node.style.display = 'block'; node.style.opacity = '0'; });
    assert.equal((await page.evaluate(inspect)).challenge, false);
    await page.locator('#wrapper').evaluate(node => { node.style.opacity = '1'; node.style.position = 'fixed'; node.style.top = '-1000px'; });
    assert.equal((await page.evaluate(inspect)).challenge, false);
    await page.locator('#wrapper').evaluate(node => { node.style.top = '0'; });
    assert.equal((await page.evaluate(inspect)).challenge, true);
    await page.locator('iframe').evaluate(node => { node.width = '70'; node.height = '60'; });
    assert.equal((await page.evaluate(inspect)).challenge, false);
  } finally { await browser.close(); }
});
