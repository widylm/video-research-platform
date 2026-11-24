import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { browserJobActive, safeVerificationUrl } from '../../lib/cloud-browser-contract.ts';
import { CloudBrowserJobs, reserveBudget, reserveVerificationBudget } from '../../workers/cloud-browser/index.ts';
import { requestHumanVerification, verificationScreenshot } from '../../workers/cloud-browser/verification.ts';
import { BrowserJobError } from '../../workers/cloud-browser/source.ts';

const view = 'https://live.browser.run/ui/view?mode=tab&wss=' + encodeURIComponent('live.browser.run/api/devtools/browser/session/page/target?jwt=fixture');
const diagnostics = { pageTitle: 'TikTok', elapsedMs: 4000, visibleLinks: 0, metadataResponses: 0,
  metadataItems: 0, failedRequests: 0, blockedHosts: [], challengeVisible: true };

function connection() {
  const cdp = new EventEmitter();
  cdp.calls = [];
  cdp.send = async (method, options) => {
    cdp.calls.push([method, options]);
    if (method === 'Cloudflare.getLiveView') return { devtoolsFrontendUrl: view };
    assert.ok(cdp.listenerCount('Cloudflare.handoffComplete') > 0);
    return { handoffId: 'fixture' };
  };
  cdp.detach = async () => { cdp.detached = true; };
  return cdp;
}

test('temporary access links accept only Cloudflare UI and its own browser socket', () => {
  assert.equal(safeVerificationUrl(view), view);
  for (const value of [undefined, 'javascript:alert(1)', view.replace('https:', 'http:'),
    view.replace('live.browser.run/ui', 'live.browser.run.evil.test/ui'),
    view.replace('https://live.browser.run', 'https://user@live.browser.run'),
    'https://live.browser.run/ui/view?wss=' + encodeURIComponent('evil.test/api/devtools/browser/session'),
    'https://live.browser.run/ui/view?wss=' + encodeURIComponent('live.browser.run:444/api/devtools/browser/session')]) {
    assert.equal(safeVerificationUrl(value), null);
  }
  assert.equal(browserJobActive('awaiting_verification'), true);
  assert.equal(browserJobActive('failed'), false);
});

test('handoff reserves time, subscribes before requesting input, publishes only the verified URL and resumes on Done', async () => {
  const cdp = connection(), steps = [];
  await requestHumanVerification({ createCDPSession: async () => cdp }, diagnostics, {
    reserve: async () => { steps.push('reserve'); },
    publish: async (verification, evidence) => {
      assert.equal(verification.url, view); assert.deepEqual(evidence, diagnostics);
      assert.ok(Date.parse(verification.expiresAt) > Date.now());
      steps.push('publish'); cdp.emit('Cloudflare.handoffComplete', { success: true });
    },
    resumed: async () => { steps.push('resume'); },
  });
  assert.deepEqual(steps, ['reserve', 'publish', 'resume']);
  assert.equal(cdp.calls[0][0], 'Cloudflare.getLiveView');
  assert.equal(cdp.calls[1][0], 'Cloudflare.handoff');
  assert.equal(cdp.detached, true); assert.equal(cdp.listenerCount('Cloudflare.handoffComplete'), 0);
});

test('Failed, expiry and unsupported Cloudflare commands release the CDP listener without resuming automation', async () => {
  for (const outcome of ['failed', 'timeout', 'unsupported']) {
    const cdp = connection();
    if (outcome === 'unsupported') cdp.send = async () => { throw new Error('not supported'); };
    await assert.rejects(requestHumanVerification({ createCDPSession: async () => cdp }, diagnostics, {
      reserve: async () => {}, publish: async () => {
        if (outcome === 'failed') cdp.emit('Cloudflare.handoffComplete', { success: false });
      }, resumed: async () => { assert.fail('must not resume'); },
    }, 5), error => error.code === ({ failed: 'verification_failed', timeout: 'verification_expired', unsupported: 'verification_unavailable' })[outcome]);
    assert.equal(cdp.detached, true); assert.equal(cdp.listenerCount('Cloudflare.handoffComplete'), 0);
  }
  await assert.rejects(requestHumanVerification({ createCDPSession: async () => { assert.fail('quota must be checked first'); } }, diagnostics, {
    reserve: async () => { throw new BrowserJobError('budget_exhausted'); }, publish: async () => {}, resumed: async () => {},
  }), error => error.code === 'budget_exhausted');
});

test('only a small pre-input screenshot can be attached to diagnostics', async () => {
  assert.equal(await verificationScreenshot({ screenshot: async () => 'YWJj' }), 'data:image/jpeg;base64,YWJj');
  assert.equal(await verificationScreenshot({ screenshot: async () => 'a'.repeat(80_001) }), undefined);
  assert.equal(await verificationScreenshot({ screenshot: async () => { throw new Error('failed'); } }), undefined);
});

test('manual intervention reserves three minutes in total, retains the eight-minute ceiling, and handles a UTC day change', () => {
  const now = Date.parse('2026-11-23T23:59:59Z');
  const normal = reserveBudget(undefined, now);
  const assisted = reserveVerificationBudget(normal, now);
  assert.deepEqual(assisted, { day: '2026-11-23', requests: 1, reservedMs: 180_000 });
  assert.equal(reserveVerificationBudget({ ...assisted, reservedMs: 420_000 }, now), null);
  assert.deepEqual(reserveVerificationBudget(assisted, now + 1000), { day: '2026-11-24', requests: 1, reservedMs: 180_000 });
});

function store() {
  const values = new Map();
  const storage = { get: async key => values.get(key), put: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key), setAlarm: async when => values.set('alarm', when), deleteAlarm: async () => values.delete('alarm') };
  storage.transaction = async callback => callback(storage);
  return { values, state: { storage, waitUntil: () => {} } };
}
const query = { platform: 'tiktok', searchMode: 'hashtag', keywords: 'skincare', limit: 5 };
const req = (user, method = 'GET') => new Request('https://executor.internal/jobs', { method,
  headers: { 'x-kadr-profile': user }, body: method === 'POST' ? JSON.stringify(query) : undefined });

test('a waiting job retains its slot, isolates its temporary link to its owner, and clears access on completion', async () => {
  const { values, state } = store();
  let release, published;
  const resume = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { published = resolve; });
  const executor = new CloudBrowserJobs(state, { BROWSER: {}, KADR_BROWSER_SOURCE: 'fashion-radar' }, async (_binding, _query, _cleanup, hooks) => {
    await hooks.reserve();
    await hooks.publish({ url: view, expiresAt: new Date(Date.now() + 120_000).toISOString() }, diagnostics);
    published(); await resume; await hooks.resumed();
    return { videos: [], scanned: 0, limited: true };
  });
  const owner = crypto.randomUUID(), colleague = crypto.randomUUID();
  assert.equal((await executor.fetch(req(owner, 'POST'))).status, 202);
  const running = executor.alarm(); await ready;
  const waiting = (await (await executor.fetch(req(owner))).json()).job;
  assert.equal(waiting.state, 'awaiting_verification'); assert.equal(waiting.verification.url, view);
  assert.equal((await (await executor.fetch(req(colleague))).json()).job, null);
  assert.equal((await executor.fetch(req(colleague, 'POST'))).status, 409);
  assert.equal(values.get('budget').reservedMs, 180_000);
  const key = `job:${waiting.id}`, original = values.get(key);
  values.set(key, { ...original, verification: { ...original.verification, expiresAt: new Date(0).toISOString() } });
  assert.equal((await (await executor.fetch(req(owner))).json()).job.verification, undefined);
  values.set(key, original);
  release(); await running;
  const done = (await (await executor.fetch(req(owner))).json()).job;
  assert.equal(done.state, 'completed'); assert.equal(done.verification, undefined);
  assert.equal(values.has('active'), false); assert.equal(values.has('alarm'), false);
});

test('a watchdog removes a stale waiting link without launching another browser', async () => {
  const { values, state } = store(), owner = crypto.randomUUID(), id = crypto.randomUUID();
  values.set('active', id); values.set(`user:${owner}`, id);
  values.set(`job:${id}`, { id, keywords: 'test', records: [], state: 'awaiting_verification',
    verification: { url: view, expiresAt: new Date(Date.now() + 120_000).toISOString() } });
  const executor = new CloudBrowserJobs(state, {}, async () => { assert.fail('must not launch'); });
  await executor.alarm();
  const job = (await (await executor.fetch(req(owner))).json()).job;
  assert.equal(job.state, 'failed'); assert.equal(job.error, 'interrupted'); assert.equal(job.verification, undefined);
  assert.equal(values.has('active'), false);
});
