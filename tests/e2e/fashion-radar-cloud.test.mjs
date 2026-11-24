import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedBrowserResource, collectFashionRadar, responseIsMetadata } from '../../workers/cloud-browser/fashion-radar.ts';
import { discoveryUrl, extractMetadata, filterCollected, pageProblem } from '../../workers/cloud-browser/fashion-radar/metadata.mjs';
import { fashionRadarQuery, browserRequestQuery } from '../../lib/cloud-browser-contract.ts';
import { CloudBrowserJobs } from '../../workers/cloud-browser/index.ts';

const id = '7412345678901234567';
const url = `https://www.tiktok.com/@reviewer/video/${id}`;
const tiktok = { id, author: { uniqueId: 'reviewer' }, video: {}, createTime: 1732000000,
  desc: 'A useful product #amazonfinds', stats: { playCount: 0, diggCount: 12, commentCount: 3 } };
const instagram = { code: 'Sample_123', media_type: 2, taken_at: 1732000000,
  caption: { text: '#Находки ' + 'x'.repeat(1500) }, play_count: 200, like_count: 0,
  comment_count: 7, user: { username: 'reviewer' } };
const query = { platform: 'tiktok', searchMode: 'hashtag', keywords: 'amazonfinds', limit: 20 };

test('the supplied collector extracts exact counters, captions and missing values without packages or a browser profile', () => {
  const [tt] = extractMetadata('tiktok', { data: [{ item: tiktok }] });
  assert.equal(tt.url, url); assert.equal(tt.views, 0); assert.equal(tt.comments, 3);
  assert.equal(tt.source, 'fashion-radar-browser'); assert.equal(tt.originalTitle, null);
  assert.equal(tt.author, 'reviewer');
  const [ig] = extractMetadata('instagram', { items: [instagram] });
  assert.equal(ig.externalId, 'Sample_123'); assert.equal(ig.comments, 7); assert.equal(ig.likes, 0);
  assert.equal(ig.author, 'reviewer'); assert.ok(ig.originalDescription.length > 1000);
  assert.equal(extractMetadata('instagram', { ...instagram, media_type: 1 }).length, 0);
  const [hidden] = extractMetadata('instagram', { ...instagram, like_and_view_counts_disabled: true });
  assert.equal(hidden.likes, null); assert.equal(hidden.views, null);
  const [missing] = extractMetadata('tiktok', { ...tiktok, createTime: undefined, stats: {} });
  assert.equal(missing.views, null); assert.equal(missing.comments, null); assert.equal(missing.publishedAt, null);
});

test('keywords and hashtags are different searches; user input never selects a host', () => {
  assert.equal(discoveryUrl('tiktok', '#Находки'), 'https://www.tiktok.com/tag/%D0%9D%D0%B0%D1%85%D0%BE%D0%B4%D0%BA%D0%B8');
  assert.equal(discoveryUrl('instagram', 'two words'), null);
  assert.equal(new URL(discoveryUrl('instagram', 'two words', 'keyword')).searchParams.get('q'), 'two words');
  assert.equal(discoveryUrl('other', 'test'), null);
  assert.equal(fashionRadarQuery.safeParse({ ...query, keywords: 'two words' }).success, false);
  assert.equal(fashionRadarQuery.safeParse({ ...query, keywords: 'two words', searchMode: 'keyword' }).success, true);
  assert.equal(browserRequestQuery.safeParse({ ...query, url: 'https://evil.example/' }).success, false);
  assert.equal(fashionRadarQuery.safeParse({ ...query, limit: 51 }).success, false);
});

test('page scripts and GraphQL POST requests can load while private targets and media downloads are excluded', () => {
  const allowed = (href, method = 'GET', type = 'script', navigation = false) =>
    allowedBrowserResource(href, navigation, 'https://www.instagram.com', method, type);
  assert.equal(allowed('https://static.cdninstagram.com/scripts/app.js'), true);
  assert.equal(allowed('https://www.instagram.com/graphql/query', 'POST', 'fetch'), true);
  for (const href of ['https://127.0.0.1/private', 'https://instagram.com.evil.example/script', 'http://www.instagram.com/script',
    'https://user:password@www.instagram.com/script', 'https://www.instagram.com:444/script']) assert.equal(allowed(href), false);
  assert.equal(allowed('https://cdninstagram.com/file.mp4', 'GET', 'media'), false);
  assert.equal(allowed('https://static.cdninstagram.com/verification.png', 'GET', 'image'), true);
  assert.equal(allowed('https://unknown.example/verification.png', 'GET', 'image'), false);
  assert.equal(allowed('https://www.tiktok.com/tag/test', 'GET', 'document', true), false);
  assert.equal(responseIsMetadata('https://www.tiktok.com/api/challenge/item_list/', 'tiktok'), true);
  assert.equal(responseIsMetadata('https://www.tiktok.com/api/search/item/full/', 'instagram'), false);
  for (const host of ['mssdk16-normal-useastred.tiktokw.eu', 'verification16-normal-useastred.tiktokw.eu',
    'starling16-normal-useastred.tiktokv.eu']) {
    const resource = `https://${host}/service?token=not-recorded`;
    assert.equal(allowedBrowserResource(resource, false, 'https://www.tiktok.com', 'POST', 'fetch'), true);
    assert.equal(allowedBrowserResource(resource, true, 'https://www.tiktok.com', 'GET', 'document'), false);
    assert.equal(allowedBrowserResource(resource, false, 'https://www.tiktok.com', 'GET', 'media'), false);
    assert.equal(allowedBrowserResource(`https://${host}.evil.example/script`, false, 'https://www.tiktok.com', 'GET', 'script'), false);
  }
  assert.equal(allowedBrowserResource('https://unverified.tiktokw.eu/script', false, 'https://www.tiktok.com', 'GET', 'script'), false);
});

test('date filters exclude unknown dates and preserve the boundary instead of returning undated videos as fresh', () => {
  const [row] = extractMetadata('tiktok', tiktok);
  const rows = [row, { ...row, externalId: '7412345678901234568', publishedAt: null }];
  assert.equal(filterCollected(rows, { ...query, filters: { publishedFrom: row.publishedAt } }).length, 1);
  assert.equal(filterCollected(rows, { ...query, filters: { minViews: 1 } }).length, 0);
});

function fakePage(state, network, body = JSON.stringify({ itemList: [tiktok] })) {
  let currentUrl = discoveryUrl(query.platform, query.keywords), reads = 0;
  const handlers = {};
  return {
    setRequestInterception: async () => {}, on: (event, fn) => { handlers[event] = fn; },
    goto: async href => {
      currentUrl = href;
      if (network) handlers.response({ url: () => 'https://www.tiktok.com/api/challenge/item_list/', status: () => 200,
        ok: () => true, headers: () => ({}), text: async () => body });
      return { ok: () => true, status: () => 200 };
    },
    url: () => currentUrl,
    evaluate: async fn => fn.toString().includes('hydration:') || fn.toString().includes('hydration: ')
      ? { url: currentUrl, title: '', text: '', challenge: false, links: [], hydration: [], ...state(++reads) } : undefined,
  };
}

test('a browser collection waits for delayed page content, reads observed responses, and returns original links with metrics', async () => {
  const page = fakePage(read => ({ links: read >= 2 ? [url] : [] }), true);
  const result = await collectFashionRadar(page, { ...query, limit: 1 }, { pause: async () => {} });
  assert.equal(result.videos.length, 1); assert.equal(result.videos[0].url, url);
  assert.equal(result.videos[0].comments, 3); assert.equal(result.scanned, 1);
});

test('a fresh cloud page gets time to render instead of being declared empty after four seconds', async () => {
  let clock = 0;
  const page = fakePage(() => ({ links: clock >= 12_000 ? [url] : [] }), true);
  const result = await collectFashionRadar(page, { ...query, limit: 1 }, {
    now: () => clock, pause: async ms => { clock += ms; },
  });
  assert.equal(result.videos.length, 1);
  assert.ok(clock >= 12_000);
});

test('native TikTok status objects retain login and slider-verification reasons on the normal search URL', async () => {
  const fixtures = [
    ['Log in to see more videos', 'source_login_required'],
    ['Войдите, чтобы увидеть результаты поиска', 'source_login_required'],
    ['Drag the slider to complete the puzzle', 'manual_intervention_required'],
    ['Something went wrong', 'source_not_ready'],
  ];
  for (const [text, code] of fixtures) {
    await assert.rejects(collectFashionRadar(fakePage(() => ({ text }), false), query, { pause: async () => {} }),
      error => error.code === code && error.diagnostics.navigationStatus === 200);
  }
});

test('a failed load includes bounded diagnostics without recording request URLs, tokens or page body', async () => {
  let clock = 0;
  const page = fakePage(() => ({ title: 'TikTok', text: 'public page text' }), false);
  const originalOn = page.on;
  page.on = (event, handler) => {
    originalOn(event, handler);
    if (event === 'request') handler({ url: () => 'https://unknown.example/script.js?token=secret',
      isNavigationRequest: () => false, method: () => 'GET', resourceType: () => 'script', abort: async () => {} });
  };
  await assert.rejects(collectFashionRadar(page, query, { now: () => clock, pause: async ms => { clock += ms; } }), error => {
    assert.equal(error.code, 'source_not_ready');
    assert.deepEqual(error.diagnostics, { navigationStatus: 200, pageTitle: 'TikTok', elapsedMs: 16_000,
      visibleLinks: 0, metadataResponses: 0, metadataItems: 0, failedRequests: 0, blockedHosts: ['unknown.example'], apiResponses: [], challengeVisible: false });
    assert.ok(!JSON.stringify(error.diagnostics).includes('secret'));
    assert.ok(!JSON.stringify(error.diagnostics).includes('public page text'));
    return true;
  });
});

test('an HTTP 200 response without videos reports its format and API code without leaking the payload or claiming success', async () => {
  const fixtures = [
    ['', { httpStatus: 200, format: 'empty', items: 0 }],
    ['<html>secret-payload</html>', { httpStatus: 200, format: 'invalid_json', items: 0 }],
    [JSON.stringify({ statusCode: 10204, statusMsg: 'secret-payload', itemList: [] }),
      { httpStatus: 200, format: 'json', items: 0, apiCode: 10204 }],
    [JSON.stringify({ status_code: '0', token: 'secret-payload', itemList: [] }),
      { httpStatus: 200, format: 'json', items: 0, apiCode: 0 }],
  ];
  for (const [body, expected] of fixtures) {
    const page = fakePage(() => ({}), true, body);
    await assert.rejects(collectFashionRadar(page, query, { pause: async () => {} }), error => {
      assert.equal(error.code, 'source_not_ready');
      assert.equal(error.diagnostics.metadataResponses, 1);
      assert.deepEqual(error.diagnostics.apiResponses, [expected]);
      assert.ok(!JSON.stringify(error.diagnostics).includes('secret-payload'));
      return true;
    });
  }
});

test('login, human verification and an unloaded page are errors rather than a fake or successful empty result', async () => {
  const fixtures = [
    [{ url: 'https://www.tiktok.com/login', links: [] }, 'source_login_required'],
    [{ text: 'Verify you are human', challenge: true }, 'manual_intervention_required'],
    [{ text: '', links: [] }, 'source_not_ready'],
  ];
  for (const [state, code] of fixtures) {
    await assert.rejects(collectFashionRadar(fakePage(() => state), query, { pause: async () => {} }), error => error.code === code);
  }
  assert.equal(pageProblem('instagram', { url: 'https://www.instagram.com/accounts/login/', text: '', links: [] }), 'source_login_required');
});

test('a manual check resumes the same requested search without consuming its collection deadline', async () => {
  let clock = 0, verified = false, handoffs = 0;
  const page = fakePage(() => ({ challenge: !verified, links: verified ? [url] : [] }), true);
  const result = await collectFashionRadar(page, { ...query, limit: 1 }, {
    now: () => clock, pause: async ms => { clock += ms; },
    onVerification: async (activePage, diagnostics) => {
      assert.equal(diagnostics.challengeVisible, true);
      handoffs += 1; clock += 90_000; verified = true;
      await activePage.goto('https://www.tiktok.com/');
    },
  });
  assert.equal(handoffs, 1); assert.equal(result.videos[0].url, url);
  assert.equal(page.url(), discoveryUrl(query.platform, query.keywords));
  assert.ok(clock >= 90_000);
});

test('Done never bypasses a still-visible verification or creates an endless handoff loop', async () => {
  let handoffs = 0;
  await assert.rejects(collectFashionRadar(fakePage(() => ({ challenge: true }), false), query, {
    pause: async () => {}, onVerification: async () => { handoffs += 1; },
  }), error => error.code === 'manual_intervention_required');
  assert.equal(handoffs, 1);
  assert.equal(pageProblem('tiktok', { url, title: 'TikTok', text: 'A video about captcha design', links: [url], challenge: false }), null);
});

test('the real executor accepts collection queries without a provider key and queues them outside the user browser', async () => {
  const values = new Map();
  const storage = { get: async key => values.get(key), put: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key), setAlarm: async () => {} };
  storage.transaction = async fn => fn(storage);
  const executor = new CloudBrowserJobs({ storage }, { BROWSER: {}, KADR_BROWSER_SOURCE: 'fashion-radar' });
  const request = new Request('https://executor.internal/jobs', { method: 'POST', body: JSON.stringify(query),
    headers: { 'x-kadr-profile': crypto.randomUUID() } });
  const response = await executor.fetch(request);
  assert.equal(response.status, 202);
  const queued = (await response.json()).job;
  assert.equal(queued.state, 'pending');
  assert.equal(values.get('budget').requests, 1);
  const diagnostics = { navigationStatus: 200, pageTitle: 'TikTok', elapsedMs: 16_000, visibleLinks: 0,
    metadataResponses: 0, metadataItems: 0, failedRequests: 0, blockedHosts: [],
    apiResponses: [{ httpStatus: 200, format: 'json', apiCode: 10204, items: 0 }] };
  const key = `job:${queued.id}`;
  values.set(key, { ...values.get(key), state: 'failed', error: 'source_not_ready', diagnostics });
  const status = await executor.fetch(new Request('https://executor.internal/jobs', {
    headers: { 'x-kadr-profile': request.headers.get('x-kadr-profile') },
  }));
  const publicJob = (await status.json()).job;
  assert.deepEqual(publicJob.diagnostics, diagnostics);
  assert.equal(publicJob.query, undefined);
});
