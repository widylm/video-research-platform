import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { recordFashionRadarCompletion } from "../../lib/fashion-radar/completion.ts";
import { createFashionRadarSender } from "../../lib/fashion-radar/sender.ts";
import { startSupabaseStack } from "./supabase-stack.mjs";

const loginTitle = "Вход в рабочее пространство";
const videoTitle = "Медленное утро и кофе дома";
const sharedName = "Командное исследование";
const privateName = "Личное исследование";

let browser;
let stack;

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  stack = await startSupabaseStack();
}, { timeout: 240_000 });

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stack?.stop();
    assert.deepEqual(stack?.coverRequests ?? [], [], "The application must not request Storage or cover revisions.");
  }
}, { timeout: 30_000 });

function button(page, name) {
  return page.getByRole("button", { name, exact: typeof name === "string" });
}

function tikTokPlayer(route, errorCode) {
  const message = errorCode ? { type: "onPlayerError", value: { errorCode } } : { type: "onPlayerReady" };
  return route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Плеер TikTok</title><script>
      parent.postMessage(${JSON.stringify({ ...message, "x-tiktok-player": true })}, "*");
    </script>${errorCode ? "<p>Server error</p>" : ""}`,
  });
}

async function loginPage(t, appUrl = stack.appUrl) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.route("https://www.tiktok.com/player/v1/*", (route) => tikTokPlayer(route));
  await page.goto(appUrl);
  await page.waitForURL("**/login");
  await page.getByRole("heading", { name: loginTitle }).waitFor();
  return page;
}

async function submitLogin(page, role, password = stack.users[role].password) {
  await page.getByLabel("Электронная почта").fill(stack.users[role].email);
  await page.getByLabel("Пароль").fill(password);
  await button(page, "Войти").click();
}

async function signedInAs(t, role, appUrl) {
  const roles = { admin: "Администратор", member: "Участник", viewer: "Наблюдатель" };
  const page = await loginPage(t, appUrl);
  await submitLogin(page, role);
  await page.getByText(stack.users[role].name, { exact: true }).waitFor();
  await page.getByText(roles[role], { exact: true }).waitFor();
  return page;
}

test("the authenticated Кадр UI runs a server-side Wrangler Browser Run session and shows a neutral document", { timeout: 120_000 }, async (t) => {
  let hits = 0;
  const unexpected = [];
  let userAgent = "";
  const fixture = createServer((incoming, outgoing) => {
    if (incoming.url !== "/catalog") { unexpected.push(incoming.url); return outgoing.writeHead(404).end(); }
    hits += 1;
    userAgent = incoming.headers["user-agent"] ?? "";
    setTimeout(() => outgoing.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      '<!doctype html><title>Botanical collection</title><link rel="icon" href="data:,"><main><h1>Catalogue of mosses</h1><p>A neutral document about mosses.</p><img src="/unexpected.png"></main>',
    ), 1_300);
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  t.after(() => { fixture.close(); fixture.closeAllConnections(); });
  const source = `http://127.0.0.1:${fixture.address().port}/catalog`;
  const preview = await stack.startCloudBrowser(source);
  const api = preview.url + "/api/cloud-browser";
  const input = { platform: "all", keywords: "mosses", limit: 10 };
  assert.equal((await fetch(stack.appUrl + "/api/cloud-browser")).status, 404);
  assert.equal((await fetch(api)).status, 401);
  const viewer = await signedInAs(t, "viewer", preview.url);
  assert.equal((await viewer.request.post(api, { data: input })).status(), 403);
  const editor = await signedInAs(t, "member", preview.url);
  assert.equal((await editor.request.post(api, { data: input, headers: { origin: "https://other.example" } })).status(), 403);
  assert.equal((await editor.request.post(api, { data: { ...input, platform: "tiktok" } })).status(), 400);
  await button(editor, "Массовый поиск").click();
  await editor.getByLabel("Ключевые слова").fill("mosses");
  const accepted = editor.waitForResponse((response) => response.url() === api && response.request().method() === "POST");
  await button(editor, "Найти").click();
  const submitted = await accepted;
  const submission = await submitted.json();
  assert.equal(submitted.status(), 202, JSON.stringify(submission));
  assert.equal(submission.job.state, "pending");
  assert.equal((await editor.request.post(api, { data: input })).status(), 409);
  const results = editor.getByRole("region", { name: "Результаты облачной проверки" });
  await results.getByRole("heading", { name: "Catalogue of mosses" }).waitFor({ timeout: 55_000 }).catch(async (error) => {
    const response = await editor.request.get(api);
    throw new Error(`${error.message}\n${await response.text()}\n${preview.logs()}`);
  });
  await results.getByText("A neutral document about mosses.").waitFor();
  assert.equal(await results.getByRole("link").getAttribute("href"), source);
  assert.equal(hits, 1);
  assert.match(userAgent, /Chrome/);
  assert.deepEqual(unexpected, []);
  await editor.reload();
  await button(editor, "Массовый поиск").click();
  await results.getByRole("heading", { name: "Catalogue of mosses" }).waitFor();
  assert.equal(hits, 1);
  const admin = await signedInAs(t, "admin", preview.url);
  assert.deepEqual(await (await admin.request.get(api)).json(), { job: null });
});

test("password sign-in loads the profile and sign-out clears the session", { timeout: 40_000 }, async (t) => {
  const page = await loginPage(t);
  await submitLogin(page, "admin", "invalid-password-for-test");
  await page.getByRole("alert").filter({ hasText: "Не удалось войти" }).waitFor();

  await submitLogin(page, "admin");
  await page.waitForURL(stack.appUrl + "/");
  await page.getByText(stack.users.admin.name, { exact: true }).waitFor();
  await page.getByText("Администратор", { exact: true }).waitFor();
  assert.ok((await page.context().cookies()).some(cookie => cookie.name.includes("-auth-token") && cookie.httpOnly));

  await button(page, "Выйти").click();
  await page.waitForURL("**/login");
  assert.ok(!(await page.context().cookies()).some(cookie => cookie.name.includes("-auth-token")));
  await page.goto(stack.appUrl);
  await page.waitForURL("**/login");
});

test("an authenticated account without a workspace profile stays locked out", { timeout: 30_000 }, async (t) => {
  const page = await loginPage(t);
  await submitLogin(page, "outsider");
  await page.getByRole("alert").filter({ hasText: "Этот аккаунт не добавлен" }).waitFor();
  await page.goto(stack.appUrl);
  await page.waitForURL("**/login");
});

test("collections and favorites persist across sessions and respect team roles", { timeout: 75_000 }, async (t) => {
  const member = await signedInAs(t, "member");
  await button(member, "Коллекции").click();

  await member.getByLabel("Название").fill(sharedName);
  await button(member, "Создать").click();
  await button(member, /Командное исследование/).waitFor();

  await member.getByLabel("Название").fill(privateName);
  await member.getByLabel("Видна команде").uncheck();
  await button(member, "Создать").click();
  await button(member, /Личное исследование/).waitFor();

  await button(member, "Поиск видео").click();
  await button(member, `В избранное: ${videoTitle}`).click();
  await button(member, `Убрать из избранного: ${videoTitle}`).waitFor();
  await button(member, videoTitle).click();
  const details = member.getByRole("dialog");
  await button(details, sharedName).click();
  await details.getByRole("button", { name: sharedName, pressed: true }).waitFor();
  await button(details, "Закрыть").click();

  const secondDevice = await signedInAs(t, "member");
  await button(secondDevice, /Избранное/).click();
  await button(secondDevice, videoTitle).waitFor();

  const viewer = await signedInAs(t, "viewer");
  await button(viewer, "Коллекции").click();
  await button(viewer, /Командное исследование/).click();
  await button(viewer, videoTitle).waitFor();
  await button(viewer, "Удалить коллекцию").waitFor({ state: "hidden" });
  await button(viewer, "Все коллекции").click();
  await button(viewer, /Личное исследование/).waitFor({ state: "hidden" });
  await button(viewer, "Создать").waitFor({ state: "hidden" });
  await button(viewer, "Избранное").click();
  await viewer.getByText("Найдено: 0", { exact: true }).waitFor();

  const viewerWrite = await stack.restAs("viewer", "collections", {
    method: "POST",
    body: JSON.stringify({ name: "Недоступная операция" }),
  });
  assert.equal(viewerWrite.status, 403);
  assert.equal((await viewerWrite.json()).code, "42501");

  await button(member, "Коллекции").click();
  await button(member, /Командное исследование/).click();
  await button(member, videoTitle).click();
  await button(details, sharedName).click();
  await details.getByRole("button", { name: sharedName, pressed: false }).waitFor();
  await button(details, "Закрыть").click();
  await member.getByText("Найдено: 0", { exact: true }).waitFor();

  const admin = await signedInAs(t, "admin");
  await button(admin, "Коллекции").click();
  await button(admin, /Командное исследование/).click();
  admin.once("dialog", (dialog) => dialog.accept());
  await button(admin, "Удалить коллекцию").click();
  await admin.getByRole("heading", { name: "Все коллекции" }).waitFor();
  await button(admin, /Командное исследование/).waitFor({ state: "hidden" });

  await button(member, "Все коллекции").click();
  await button(member, "Обновить").click();
  await button(member, /Командное исследование/).waitFor({ state: "hidden" });
  await button(member, /Личное исследование/).waitFor();
});

test("saved public videos appear in the team catalog and can join personal and shared collections", { timeout: 75_000 }, async (t) => {
  const before = await stack.restAs("member", "videos?select=id,views,likes&is_mock=eq.true");
  assert.equal(before.status, 200);
  const demos = await before.json();
  assert.equal(demos.length, 8);
  assert.ok(demos.every(({ views, likes }) => views > 0 && likes > 0));
  await testPublicVideoAccess();

  const member = await signedInAs(t, "member");
  await member.setViewportSize({ width: 390, height: 844 });
  await member.route("https://www.tiktok.com/player/v1/*", async (route) => {
    await route.fulfill({ contentType: "text/html", body: `<script>
      parent.postMessage({'x-tiktok-player': true, type: 'onPlayerError', value: {errorCode: 1001}}, '*');
    </script>` });
  });

  await button(member, "Коллекции").click();
  await member.getByLabel("Название").fill("Личная медиатека");
  await member.getByLabel("Видна команде").uncheck();
  await button(member, "Создать").click();
  await button(member, /Личная медиатека/).click();
  await button(member, "Добавить видео").click();
  const entry = member.getByRole("dialog", { name: "Добавить видео" });
  assert.equal(await entry.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth), true);
  assert.match(await entry.getByLabel("Коллекция").locator("option:checked").textContent(), /Личная медиатека/);
  await entry.getByLabel("Ссылка на видео").fill("https://www.tiktok.com.example.org/@scout2015/video/6718335390845095173");
  await button(entry, "Сохранить видео").click();
  await entry.getByRole("alert").filter({ hasText: "Вставьте HTTPS-ссылку" }).waitFor();

  const videoName = "Свежий ролик про кофе";
  const canonical = "https://www.tiktok.com/@scout2015/video/6718335390845095173";
  await entry.getByLabel("Ссылка на видео").fill(canonical + "?tracking=1");
  await entry.getByLabel("Название").fill(videoName);
  await entry.getByLabel("Описание").fill("Ручное описание ролика.");
  await entry.getByLabel("Хэштеги").fill("#КОФЕ, #утро");
  await entry.getByLabel("Дата публикации").fill("2026-11-18");
  await entry.getByLabel("Лайки").fill("0");
  await button(entry, "Сохранить видео").click();

  const details = member.getByRole("dialog", { name: videoName });
  await details.getByText("Видео сохранено в каталоге.").waitFor();
  assert.equal(await details.locator("iframe").count(), 0);
  const playerRequested = member.waitForRequest("https://www.tiktok.com/player/v1/6718335390845095173");
  await button(details, "Предпросмотр").click();
  await playerRequested;
  await details.getByText("Ролик можно открыть на платформе.").waitFor();
  await details.getByText("Нет данных", { exact: true }).waitFor();
  await details.getByLabel("Лайки: 0").waitFor();
  assert.equal(await details.getByRole("link", { name: "Открыть в TikTok" }).getAttribute("href"), canonical);
  assert.equal(await details.locator("iframe").count(), 0);
  await details.getByRole("button", { name: "Личная медиатека", pressed: true }).waitFor();
  await button(details, "Закрыть").click();
  await button(member, videoName).waitFor();

  await button(member, "Все коллекции").click();
  await member.getByLabel("Название").fill("Общая медиатека");
  await member.getByLabel("Видна команде").check();
  await button(member, "Создать").click();
  await button(member, /Общая медиатека/).click();
  await button(member, "Добавить видео").click();
  await entry.getByLabel("Ссылка на видео").fill(canonical.replace("www.tiktok.com", "m.tiktok.com"));
  await entry.getByLabel("Описание").fill("Описание при повторном импорте");
  await entry.getByLabel("Просмотры").fill("50");
  await button(entry, "Сохранить видео").click();
  await details.getByText("Это видео уже в каталоге.", { exact: false }).waitFor();
  await details.getByRole("button", { name: "Общая медиатека", pressed: true }).waitFor();
  await button(details, "Закрыть").click();

  const catalogRow = await stack.restAs("member", "videos?select=url,title,views,likes&external_id=eq.6718335390845095173");
  assert.deepEqual(await catalogRow.json(), [{ url: canonical, title: videoName, views: null, likes: 0 }]);

  const viewer = await signedInAs(t, "viewer");
  await button(viewer, "Добавить видео").waitFor({ state: "hidden" });
  await button(viewer, "Коллекции").click();
  await button(viewer, /Личная медиатека/).waitFor({ state: "hidden" });
  await button(viewer, /Общая медиатека/).click();
  await button(viewer, videoName).waitFor();
  await button(viewer, "Поиск видео").click();
  await viewer.getByLabel("Ключевые слова").fill("СВЕЖИЙ");
  await viewer.getByLabel("Хэштеги").fill("#кофе");
  await viewer.getByLabel("Дата публикации с").fill("2026-11-18");
  await viewer.getByLabel("Дата публикации по").fill("2026-11-18");
  await button(viewer, "Найти видео").click();
  await viewer.getByText("Найдено: 1", { exact: true }).waitFor();
  await button(viewer, "Таблица").click();
  await viewer.getByRole("cell", { name: "Нет данных", exact: true }).waitFor();
  await viewer.getByRole("cell", { name: "0", exact: true }).waitFor();
  await viewer.getByLabel("Мин. просмотров").fill("0");
  await button(viewer, "Найти видео").click();
  await viewer.getByText("Найдено: 0", { exact: true }).waitFor();

  await viewer.route(/www\.instagram\.com\/(p|reel)\/DR_Kadr00\/embed\//, (route) => route.fulfill({ body: "Instagram embed" }));
  await button(viewer, "Сбросить").click();
  await button(viewer, "Публикация Instagram").click();
  const instagram = viewer.getByRole("dialog", { name: "Публикация Instagram" });
  assert.equal(await instagram.locator("iframe").count(), 0);
  await button(instagram, "Предпросмотр").click();
  assert.match(await instagram.locator("iframe").getAttribute("src"), /^https:\/\/www\.instagram\.com\/(p|reel)\/DR_Kadr00\/embed\/$/);
  await instagram.getByRole("link", { name: "Открыть в Instagram" }).waitFor();
  await instagram.getByText("Если видео не воспроизводится", { exact: false }).waitFor();
});

async function testPublicVideoAccess() {
  const row = {
    p_platform: "instagram", p_external_id: "DR_Kadr00", p_url: "https://www.instagram.com/reel/DR_Kadr00/",
    p_author: "", p_title: "Публикация Instagram", p_description: "", p_hashtags: [],
    p_published_at: null, p_views: null, p_likes: null, p_collection_id: null,
  };
  const save = (role, data) => stack.restAs(role, "rpc/save_public_video", { method: "POST", body: JSON.stringify(data) });
  for (const role of ["anon", "viewer", "outsider"]) {
    const denied = await save(role, row);
    assert.ok([401, 403].includes(denied.status), role);
    const response = await denied.json();
    assert.equal(response.code, "42501", role);
  }
  const invalid = await save("member", { ...row, p_url: "https://wrong.example/reel/DR_Kadr00/" });
  assert.equal((await invalid.json()).code, "23514");
  const invalidDate = await save("member", { ...row, p_published_at: "infinity" });
  assert.equal((await invalidDate.json()).code, "23514");

  const own = await stack.restAs("admin", "collections?select=id", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ name: "Закрытая проверка", shared: false }),
  });
  assert.equal(own.status, 201);
  const [{ id }] = await own.json();
  const deniedCollection = await save("member", { ...row, p_collection_id: id });
  assert.equal((await deniedCollection.json()).code, "42501");
  const rolledBack = await stack.restAs("member", "videos?select=id&external_id=eq.DR_Kadr00");
  assert.deepEqual(await rolledBack.json(), []);

  const results = await Promise.all([
    save("admin", row),
    save("member", { ...row, p_url: "https://www.instagram.com/p/DR_Kadr00/" }),
  ]);
  for (const response of results) assert.equal(response.status, 200);
  const [[first], [second]] = await Promise.all(results.map((response) => response.json()));
  assert.equal(first.video.id, second.video.id);
  assert.equal(Number(first.created) + Number(second.created), 1);

  const secondViewerAttempt = await save("viewer", row);
  assert.equal(secondViewerAttempt.status, 403);

  const outsider = await stack.restAs("outsider", "videos?select=id");
  assert.deepEqual(await outsider.json(), []);
}

test("mobile catalog renders saved text and only loads official players on request", { timeout: 55_000 }, async (t) => {
  const video = await addCatalogFixture("tiktok", "1234567890123456789", {
    p_title: "Кадр из студии",
    p_description: "Короткий съёмочный план",
    p_hashtags: ["съёмка"],
    p_views: 1250,
    p_likes: 0,
  });
  const instagram = await addCatalogFixture("instagram", "KadrPreview01", { p_hashtags: ["сценография"] });

  const page = await loginPage(t);
  const playerRequests = [];
  const backgroundRequests = [];
  page.on("request", (request) => {
    const { hostname, pathname } = new URL(request.url());
    if (/\/player\/v1\/|\/embed\//.test(pathname)) playerRequests.push(request.url());
    if (/^\/api\/videos\/|^\/covers\/|\/oembed/.test(pathname) || hostname.includes("tiktokcdn")) {
      backgroundRequests.push(request.url());
    }
  });
  await page.route("https://www.instagram.com/p/KadrPreview01/embed/", (route) => route.fulfill({ body: "Instagram iframe" }));

  await page.setViewportSize({ width: 390, height: 844 });
  await submitLogin(page, "viewer");
  await page.waitForURL(stack.appUrl + "/");
  await button(page, videoTitle).waitFor();
  assert.equal(await page.locator("article img, article iframe").count(), 0);

  await page.getByLabel("Дата публикации с").fill("2026-11-19");
  await button(page, "Найти видео").click();
  await page.getByText("Найдено: 2", { exact: true }).waitFor();
  const cards = page.locator("article");
  const tik = cards.filter({ has: button(page, "Кадр из студии") });
  const ig = cards.filter({ has: button(page, "Публикация Instagram") });

  await tik.getByText("@studio.notes", { exact: true }).waitFor();
  await tik.getByText("Короткий съёмочный план", { exact: true }).waitFor();
  await tik.getByText("#съёмка", { exact: true }).waitFor();
  await tik.getByLabel(/Просмотры:/).waitFor();
  await tik.getByLabel("Лайки: 0", { exact: true }).waitFor();
  await ig.getByText("#сценография", { exact: true }).waitFor();
  assert.equal(await ig.getByText(instagram.external_id).count(), 0);
  assert.equal(await ig.getByLabel(/Просмотры:|Лайки:/).count(), 0);
  await ig.hover();
  await button(tik, "Предпросмотр").focus();
  assert.equal(await cards.locator("img, iframe").count(), 0);
  assert.deepEqual(backgroundRequests, []);
  assert.deepEqual(playerRequests, []);

  await button(tik, "Предпросмотр").click();
  const tikPlayer = "https://www.tiktok.com/player/v1/" + video.external_id;
  assert.equal(await tik.locator("iframe").getAttribute("src"), tikPlayer);
  await button(ig, "Предпросмотр").click();
  await tik.locator("iframe").waitFor({ state: "detached" });
  const igPlayer = "https://www.instagram.com/p/KadrPreview01/embed/";
  assert.equal(await ig.locator("iframe").getAttribute("src"), igPlayer);
  assert.equal(await cards.locator("iframe").count(), 1);
  await button(ig, "Скрыть предпросмотр").click();
  await ig.locator("iframe").waitFor({ state: "detached" });

  await button(ig, "Публикация Instagram").click();
  const dialog = page.getByRole("dialog", { name: "Публикация Instagram" });
  await button(dialog, "Предпросмотр").waitFor();
  assert.equal(await dialog.locator("iframe").count(), 0);
  await button(dialog, "Предпросмотр").click();
  assert.equal(await dialog.locator("iframe").getAttribute("src"), igPlayer);
  await button(dialog, "Редактировать карточку").waitFor({ state: "hidden" });
  await button(dialog, "Закрыть").click();
  assert.equal(await page.locator("iframe").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.deepEqual(backgroundRequests, []);
  assert.ok(playerRequests.includes(tikPlayer) && playerRequests.includes(igPlayer));
});

test("retired cover and thumbnail endpoints are absent in the team workspace", async (t) => {
  const page = await signedInAs(t, "admin");
  const id = "69000000-0000-4000-8000-000000000001";
  for (const suffix of ["cover", "preview"]) {
    const url = `${stack.appUrl}/api/videos/${id}/${suffix}`;
    const anonymous = await fetch(url, { redirect: "manual" });
    assert.equal(anonymous.status, 404);
    await anonymous.body?.cancel();
    const authenticated = await page.request.get(url);
    assert.equal(authenticated.status(), 404);
  }
  await button(page, videoTitle).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Демонстрационная карточка").waitFor();
  assert.equal(await dialog.locator("input[type=file], img, iframe").count(), 0);
});

test("authorized editors can rename a saved video without changing its identity or collections", { timeout: 45_000 }, async (t) => {
  const video = await addCatalogFixture("instagram", "KadrEdit002");
  const change = (role, updates, id = video.id) => stack.restAs(role, `videos?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(updates),
  });
  for (const role of ["viewer", "outsider"]) {
    const denied = await change(role, { title: "Недопустимое изменение" });
    assert.deepEqual(await denied.json(), []);
  }
  const anon = await change("anon", { title: "Недопустимое изменение" });
  assert.equal((await anon.json()).code, "42501");
  for (const updates of [{ views: 10 }, { url: "https://example.org/" }, { cover: "https://example.org/" }]) {
    const denied = await change("member", updates);
    assert.equal((await denied.json()).code, "42501");
  }
  const demoEdit = await change("admin", { title: "Чужая демозапись" }, "69000000-0000-4000-8000-000000000001");
  assert.deepEqual(await demoEdit.json(), []);

  const editor = await signedInAs(t, "member");
  await editor.route("https://www.instagram.com/p/KadrEdit002/embed/", (route) => route.fulfill({ body: "Instagram iframe" }));
  await button(editor, "Коллекции").click();
  await editor.getByLabel("Название").fill("Общие идеи для съёмки");
  await button(editor, "Создать").click();
  await button(editor, /Общие идеи для съёмки/).waitFor();
  await button(editor, "Поиск видео").click();
  await editor.getByLabel("Ключевые слова").fill("KadrEdit002");
  await button(editor, "Найти видео").click();
  await editor.getByText("Найдено: 1", { exact: true }).waitFor();
  await button(editor, "Публикация Instagram").click();
  const details = editor.getByRole("dialog");
  assert.equal(await details.locator("input[type=file]").count(), 0);
  assert.equal(await details.getByRole("button", { name: /обложку/i }).count(), 0);
  await button(details, "Общие идеи для съёмки").click();
  await details.getByRole("button", { name: "Общие идеи для съёмки", pressed: true }).waitFor();
  await button(details, "Редактировать карточку").click();
  await details.getByLabel("Название").fill("Спокойное утро");
  await details.getByLabel("Описание").fill("Планы для следующей съёмки");
  await details.getByLabel("Автор Instagram").fill("@morning.notes");
  await button(details, "Сохранить изменения").click();
  await details.getByRole("heading", { name: "Спокойное утро" }).waitFor();
  await details.getByText("Карточка обновлена.").waitFor();
  await details.getByRole("button", { name: "Общие идеи для съёмки", pressed: true }).waitFor();
  assert.equal(await details.locator("iframe").count(), 0);
  await button(details, "Предпросмотр").click();
  assert.equal(await details.locator("iframe").getAttribute("src"), "https://www.instagram.com/p/KadrEdit002/embed/");

  const viewer = await signedInAs(t, "viewer");
  await button(viewer, "Коллекции").click();
  await button(viewer, /Общие идеи для съёмки/).click();
  await button(viewer, "Спокойное утро").waitFor();
  await viewer.getByText("Планы для следующей съёмки").waitFor();
  await viewer.getByText("@morning.notes").waitFor();
  const saved = await stack.restAs("viewer", `videos?select=id,url,views,likes,author&id=eq.${video.id}`);
  assert.deepEqual(await saved.json(), [{
    id: video.id, url: "https://www.instagram.com/p/KadrEdit002/", views: null, likes: null, author: "morning.notes",
  }]);
});

async function addCatalogFixture(platform, externalId, overrides = {}) {
  const tiktok = platform === "tiktok";
  const payload = {
    p_platform: platform,
    p_external_id: externalId,
    p_url: tiktok ? `https://www.tiktok.com/@studio.notes/video/${externalId}` : `https://www.instagram.com/p/${externalId}/`,
    p_author: tiktok ? "studio.notes" : "",
    p_title: `Видео ${tiktok ? "TikTok" : "Instagram"} · ${externalId}`,
    p_description: tiktok ? (externalId.endsWith("8") ? "Заметки о съёмке" : "Кадр из студии") : "",
    p_hashtags: [],
    p_published_at: "2026-11-19",
    p_views: null,
    p_likes: null,
    p_collection_id: null,
    ...overrides,
  };
  const response = await stack.restAs("admin", "rpc/save_public_video", {
    method: "POST", body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  const [{ video }] = await response.json();
  return video;
}

test("completed Fashion Radar runs reach the existing catalog via the protected receiver and dedicated Postgres role", { timeout: 100_000 }, async (t) => {
  const path = "/api/integrations/fashion-radar";
  assert.equal((await fetch(stack.appUrl + path, { method: "POST" })).status, 404);
  const { endpoint, enroll } = await stack.startRadarReceiver();
  const platforms = ["tiktok", "instagram"];
  const device = enroll("member", platforms);
  const viewer = enroll("viewer", platforms);
  const folder = await mkdtemp(join(tmpdir(), "kadr-radar-live-path-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const directory = join(folder, "completed");
  const externalId = "7000000000000000701";
  const reelId = "SyncReelFixture1";
  const tiktok = {
    id: externalId, url: `https://www.tiktok.com/@studio.notes/video/${externalId}`, source: "public-page-data",
    title: "Обжарка для пилота #фильтр", views: 0, likes: null, published_at: "2026-11-19T10:00:00.000Z",
  };
  const instagram = {
    id: `ig_${reelId}`, platform: "instagram", verified_video: true, url: `https://www.instagram.com/reel/${reelId}/`,
    title: "Рисунок молочной пены", likes: 0,
  };
  const completedAt = Date.now() - 60_000;
  const complete = (collectionId, row, offset) => recordFashionRadarCompletion({
    directory, platforms, collectionId, completedAt: new Date(completedAt + offset).toISOString(),
    state: { phase: "done", items: [row] },
  });
  const first = await complete("take-1", tiktok, 0);
  await complete("take-2", instagram, 1);
  assert.equal(await complete("take-1", tiktok, 0), first);
  assert.equal((await readdir(directory)).length, 2);

  const post = (token) => fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal((await post("invalid")).status, 401);
  assert.equal((await post(viewer.token)).status, 403);
  const config = { enabled: true, endpoint: `https://test-kadr.example${path}`, completionDir: directory, platforms,
    deviceToken: device.token, queueFile: join(folder, "queue.json") };
  let now = Date.now();
  let attempts = 0;
  const transport = async (_url, options) => {
    attempts += 1;
    const response = await fetch(endpoint, options); // Loopback transport, with real HTTP and Postgres TLS behind the receiver.
    assert.equal(response.status, 200);
    if (attempts === 1) {
      await response.body?.cancel();
      throw new Error("Lost response after the database committed");
    }
    return response;
  };
  assert.equal((await createFashionRadarSender(config, transport, () => now)()).state, "waiting");
  const restarted = createFashionRadarSender(config, transport, () => now);
  now += 5_000;
  assert.deepEqual(await restarted(), { state: "delivered", sent: 0, rejected: 0, duplicates: 1 });
  assert.deepEqual(await restarted(), { state: "delivered", sent: 1, rejected: 0, duplicates: 0 });
  assert.equal(attempts, 3);
  assert.deepEqual(await readdir(directory), []);

  const lookup = (id) => stack.restAs("viewer", `videos?select=id,title,description,views,likes,is_mock,fashion_radar_managed&external_id=eq.${id}`);
  const [video] = await (await lookup(externalId)).json();
  assert.equal(video.views, 0);
  assert.equal(video.likes, null);
  assert.equal(video.is_mock, false);
  assert.equal(video.fashion_radar_managed, true);
  const [reel] = await (await lookup(reelId)).json();
  assert.equal(reel.likes, 0);
  assert.equal(reel.views, null);
  const edited = await stack.restAs("member", `videos?id=eq.${video.id}`, {
    method: "PATCH", body: JSON.stringify({ title: "Ручной заголовок для пилота", description: "Редактура команды" }),
  });
  assert.equal(edited.status, 204);
  const favorite = await stack.restAs("member", "favorites", { method: "POST", body: JSON.stringify({ video_id: video.id }) });
  assert.equal(favorite.status, 201);
  await complete("take-3", { ...tiktok, title: "Обновлённая подпись платформы", views: 38 }, 2);
  assert.deepEqual(await restarted(), { state: "delivered", sent: 1, rejected: 0, duplicates: 0 });
  const [refreshed] = await (await lookup(externalId)).json();
  assert.deepEqual(refreshed, { ...video, title: "Ручной заголовок для пилота", description: "Редактура команды", views: 38 });
  const snapshots = await stack.restAs("viewer", `fashion_radar_snapshots?select=original_description,views&external_id=eq.${externalId}`);
  assert.deepEqual(await snapshots.json(), [{ original_description: "Обновлённая подпись платформы", views: 38 }]);
  const favorites = await stack.restAs("member", `favorites?select=video_id&video_id=eq.${video.id}`);
  assert.deepEqual(await favorites.json(), [{ video_id: video.id }]);

  const page = await signedInAs(t, "viewer");
  await page.getByLabel("Ключевые слова").fill("Редактура команды");
  await button(page, "Найти видео").click();
  await page.getByText("Найдено: 1", { exact: true }).waitFor();
  await button(page, "Ручной заголовок для пилота").waitFor();
  device.revoke();
  assert.equal((await post(device.token)).status, 401);
});

test("TikTok errors stay out of grid cards and the original link remains available", { timeout: 35_000 }, async (t) => {
  const externalId = "1299999999999999999";
  await addCatalogFixture("tiktok", externalId, {
    p_title: "Идея для монтажа",
    p_description: "Ритм и смена ракурсов",
    p_hashtags: ["монтаж"],
  });
  const page = await loginPage(t);
  let requests = 0;
  await page.route(`https://www.tiktok.com/player/v1/${externalId}*`, (route) => {
    requests += 1;
    return tikTokPlayer(route, 2001);
  });
  await submitLogin(page, "viewer");
  await page.waitForURL(stack.appUrl + "/");
  await page.getByLabel("Ключевые слова").fill("Идея для монтажа");
  await button(page, "Найти видео").click();
  await page.getByText("Найдено: 1", { exact: true }).waitFor();
  const card = page.locator("article").filter({ has: button(page, "Идея для монтажа") });
  await card.scrollIntoViewIfNeeded();
  assert.equal(await card.locator("iframe, img").count(), 0);
  assert.equal(requests, 0);
  await card.getByText("Ритм и смена ракурсов").waitFor();
  await card.getByText("#монтаж").waitFor();

  await button(card, "Предпросмотр").click();
  await card.getByText("Ролик можно открыть на платформе.").waitFor();
  assert.equal(requests, 1);
  assert.equal(await card.locator("iframe").count(), 0);
  await card.getByRole("link", { name: "Открыть в TikTok" }).waitFor();
});

test("bulk search paginates 1000 mock results and keeps notes separate in the browser", { timeout: 45_000 }, async (t) => {
  const page = await signedInAs(t, "member");
  const externalRequests = [];
  const pilotPosts = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== stack.appUrl) externalRequests.push(request.url());
    if (request.method() === "POST") pilotPosts.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await button(page, "Массовый поиск").click();
  await page.getByLabel("Ключевые слова").fill("кофе");
  await page.getByLabel("Макс. видео").fill("1000");
  await button(page, "Запустить тестовый поиск").click();
  await page.getByRole("status").filter({ hasText: /^Найдено: 1000$/ }).waitFor();
  await page.getByText("Страница 1 из 50").waitFor();
  await page.getByText(/Обработано страниц: 20/).waitFor();
  const results = page.getByRole("region", { name: "Результаты пилота" });
  const first = results.locator("article").first();
  await first.getByRole("heading", { name: "Демо №1" }).waitFor();
  assert.equal(await results.locator("article").count(), 20);
  assert.equal(await results.locator("iframe, img").count(), 0);
  assert.ok(await results.getByText("Нет данных", { exact: true }).count() > 0);

  await first.getByText("Источник и ссылка", { exact: true }).click();
  await first.getByText("mock:tiktok", { exact: true }).waitFor();
  await first.getByText("Заметка", { exact: true }).click();
  await first.getByLabel("Личная заметка").fill("Это отдельная тестовая заметка");
  await button(first, "Сохранить заметку").click();
  await first.getByText("Заметка сохранена.").waitFor();
  await button(results, "Далее").click();
  await page.getByText("Страница 2 из 50").waitFor();
  await first.getByRole("heading", { name: "Название недоступно" }).waitFor();
  await button(results, "Назад").click();
  await first.getByRole("heading", { name: "Демо №1" }).waitFor();
  await first.getByText("Заметка", { exact: true }).click();
  assert.equal(await first.getByLabel("Личная заметка").inputValue(), "Это отдельная тестовая заметка");

  const snapshot = await page.evaluate(() => {
    const resultKey = Object.keys(sessionStorage).find((key) => /^kadr\.bulk-pilot.*\.results$/.test(key));
    const noteKey = Object.keys(localStorage).find((key) => /^kadr\.bulk-pilot.*\.note\./.test(key));
    const result = JSON.parse(sessionStorage.getItem(resultKey)).result;
    return { note: localStorage.getItem(noteKey), containsNote: JSON.stringify(result).includes("отдельная тестовая заметка"),
      title: result.videos[0].originalTitle, chargedMicros: result.chargedMicros, budgetMicros: result.budgetMicros };
  });
  assert.deepEqual(snapshot, {
    note: "Это отдельная тестовая заметка", containsNote: false, title: "Демо №1", chargedMicros: 0, budgetMicros: 0,
  });
  await page.reload();
  await button(page, "Массовый поиск").click();
  await page.getByRole("status").filter({ hasText: /^Найдено: 1000$/ }).waitFor();
  await first.getByText("Заметка", { exact: true }).click();
  assert.equal(await first.getByLabel("Личная заметка").inputValue(), "Это отдельная тестовая заметка");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(pilotPosts, []);
});
