import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { coverMaxBytes } from "../../lib/video-cover.ts";
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

async function loginPage(t) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.route("**/api/videos/*/preview", (route) => route.fulfill({ json: null }));
  await page.route("https://www.tiktok.com/player/v1/*", (route) => tikTokPlayer(route));
  await page.goto(stack.appUrl);
  await page.waitForURL("**/login");
  await page.getByRole("heading", { name: loginTitle }).waitFor();
  return page;
}

async function submitLogin(page, role, password = stack.users[role].password) {
  await page.getByLabel("Электронная почта").fill(stack.users[role].email);
  await page.getByLabel("Пароль").fill(password);
  await button(page, "Войти").click();
}

async function signedInAs(t, role) {
  const roles = { admin: "Администратор", member: "Участник", viewer: "Наблюдатель" };
  const page = await loginPage(t);
  await submitLogin(page, role);
  await page.getByText(stack.users[role].name, { exact: true }).waitFor();
  await page.getByText(roles[role], { exact: true }).waitFor();
  return page;
}

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
  await button(member, `Подробнее: ${videoTitle}`).click();
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
  await details.getByText("Платформа не нашла публикацию.", { exact: false }).waitFor();
  await details.getByText("Нет данных", { exact: true }).waitFor();
  await details.getByLabel("Лайки: 0").waitFor();
  assert.equal(await details.getByRole("link", { name: "Открыть в TikTok" }).getAttribute("href"), canonical);
  assert.equal(await details.locator("iframe").getAttribute("src"), "https://www.tiktok.com/player/v1/6718335390845095173");
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

test("catalog cards use a loaded official cover and only open player if requested", { timeout: 55_000 }, async (t) => {
  const video = await addCatalogFixture("tiktok", "1234567890123456789");
  const broken = await addCatalogFixture("tiktok", "1234567890123456788");
  const instagram = await addCatalogFixture("instagram", "KadrPreview01", { p_hashtags: ["сценография"] });
  const denied = await fetch(`${stack.appUrl}/api/videos/${video.id}/preview`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("cache-control"), /private, no-store/);

  const page = await loginPage(t);
  const cover = "https://p16-sign-sg.tiktokcdn.com/cover.webp?x-signature=signed";
  const missingCover = "https://p16-sign-sg.tiktokcdn.com/missing.webp";
  await page.route(`**/api/videos/${video.id}/preview`, (route) => route.fulfill({
    json: { title: "Название из TikTok", authorName: "Имя автора", thumbnailUrl: cover },
  }));
  await page.route(`**/api/videos/${broken.id}/preview`, (route) => route.fulfill({
    json: { thumbnailUrl: missingCover },
  }));
  await page.route(cover, (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="orange"/></svg>',
  }));
  const brokenRequest = page.waitForRequest((request) => request.url() === missingCover);
  await page.route(missingCover, (route) => route.abort());
  await page.route("https://www.instagram.com/p/KadrPreview01/embed/", (route) => route.fulfill({ body: "Instagram iframe" }));

  await page.setViewportSize({ width: 390, height: 844 });
  await submitLogin(page, "viewer");
  await page.waitForURL(stack.appUrl + "/");
  await page.getByLabel("Дата публикации с").fill("2026-11-19");
  await button(page, "Найти видео").click();
  await page.getByText("Найдено: 3", { exact: true }).waitFor();
  const cards = page.locator("article");
  const tik = cards.filter({ hasText: "Кадр из студии" });
  await tik.scrollIntoViewIfNeeded();
  await button(tik, "Название из TikTok").waitFor();
  await tik.getByText("Имя автора").waitFor();
  await tik.locator("img").evaluate((img) => img.decode());
  assert.equal(await tik.locator("img").getAttribute("src"), cover);
  assert.equal(await tik.getByText("Нет данных", { exact: true }).count(), 0);

  const fallback = cards.filter({ hasText: "Заметки о съёмке" });
  await fallback.scrollIntoViewIfNeeded();
  await fallback.getByText("@studio.notes").waitFor();
  await brokenRequest;
  await fallback.locator("img").waitFor({ state: "hidden" });
  assert.equal(await fallback.getByRole("heading").textContent(), "Заметки о съёмке");

  await fallback.hover();
  assert.equal(await fallback.locator(".video-cover").count(), 0);
  assert.equal(await page.locator("article iframe").count(), 0);

  await button(tik, "Предпросмотр").click();
  assert.match(await tik.locator("iframe").getAttribute("src"), /tiktok\.com\/player\/v1\//);
  const ig = cards.filter({ has: button(page, "Публикация Instagram") });
  await ig.getByText("Автор не указан").waitFor();
  await ig.getByText("Описание не добавлено").waitFor();
  await ig.getByText("#сценография").waitFor();
  assert.equal(await ig.getByText(instagram.external_id).count(), 0);
  assert.equal(await ig.locator("iframe").count(), 0);
  await button(ig, "Предпросмотр").click();
  await tik.locator("iframe").waitFor({ state: "detached" });
  assert.equal(await ig.locator("iframe").getAttribute("src"), "https://www.instagram.com/p/KadrPreview01/embed/");
  await button(ig, "Публикация Instagram").click();
  const dialog = page.getByRole("dialog", { name: "Публикация Instagram" });
  await dialog.locator("iframe").waitFor();
  await button(dialog, "Редактировать карточку").waitFor({ state: "hidden" });
  await button(dialog, "Закрыть").click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
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
  assert.equal(await card.locator("iframe, .video-cover").count(), 0);
  assert.equal(requests, 0);
  await card.getByText("Ритм и смена ракурсов").waitFor();
  await card.getByText("#монтаж").waitFor();

  await button(card, "Предпросмотр").click();
  await card.getByText("Ролик можно открыть на платформе.").waitFor();
  assert.equal(requests, 1);
  assert.equal(await card.locator("iframe").count(), 0);
  await card.getByRole("link", { name: "Открыть в TikTok" }).waitFor();
});

async function picture(page, type, color) {
  return Buffer.from(await page.evaluate(async ({ type, color }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 32;
    const paint = canvas.getContext("2d");
    paint.fillStyle = color;
    paint.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, { type, color }));
}

const coverPath = (video) => `/api/videos/${video.id}/cover`;

test("editors manage manual covers and viewers see them in the catalog and collections", { timeout: 85_000 }, async (t) => {
  const title = "Кадры с ручной обложкой";
  const tikTok = await addCatalogFixture("tiktok", "1999999999999999999", { p_title: `${title} TikTok` });
  const instagram = await addCatalogFixture("instagram", "KadrManualCover01", { p_title: `${title} Instagram` });

  const editor = await signedInAs(t, "member");
  await editor.setViewportSize({ width: 390, height: 844 });
  const original = "https://p16-sign-sg.tiktokcdn.com/official-cover.jpg";
  const officialBytes = await picture(editor, "image/jpeg", "green");
  await editor.route(`**/api/videos/${tikTok.id}/preview`, (route) => route.fulfill({ json: { thumbnailUrl: original } }));
  await editor.route(original, (route) => route.fulfill({ contentType: "image/jpeg", body: officialBytes }));
  await editor.route("https://www.instagram.com/p/KadrManualCover01/embed/", (route) => route.fulfill({ body: "Instagram iframe" }));
  await button(editor, "Коллекции").click();
  await editor.getByLabel("Название").fill("Видео с командными обложками");
  await button(editor, "Создать").click();
  await button(editor, /Видео с командными обложками/).waitFor();
  await button(editor, "Поиск видео").click();
  await editor.getByLabel("Ключевые слова").fill(title);
  await button(editor, "Найти видео").click();
  await editor.getByText("Найдено: 2", { exact: true }).waitFor();

  const card = (page, video) => page.locator("article").filter({ has: button(page, video.title) });
  const visibleCover = (page, video) => card(page, video).locator(".video-cover img");
  const manualCover = (page, video) => visibleCover(page, video).and(page.locator(`img[src*="${coverPath(video)}?v="]`));
  const tikCover = visibleCover(editor, tikTok).and(editor.locator(`img[src="${original}"]`));
  await card(editor, tikTok).scrollIntoViewIfNeeded();
  await tikCover.waitFor();
  assert.equal(await card(editor, instagram).locator(".video-cover, iframe").count(), 0);

  for (const video of [tikTok, instagram]) {
    await button(editor, video.title).click();
    const dialog = editor.getByRole("dialog");
    await button(dialog, "Видео с командными обложками").click();
    await dialog.getByRole("button", { name: "Видео с командными обложками", pressed: true }).waitFor();
    await button(dialog, "Добавить обложку").waitFor();
    const upload = dialog.getByLabel("Файл обложки");
    await upload.setInputFiles({ name: "wrong.png", mimeType: "image/png", buffer: Buffer.from("<svg/>") });
    await dialog.getByText("Выберите изображение JPEG, PNG или WebP.").waitFor();
    const saved = editor.waitForResponse((response) => response.url().endsWith(coverPath(video))
      && response.request().method() === "PUT");
    await upload.setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: await picture(editor, "image/png", "orange") });
    const response = await saved;
    assert.ok(response.ok(), await response.text());
    await dialog.getByText("Обложка сохранена.", { exact: true }).waitFor();
    await button(dialog, "Заменить обложку").waitFor();
    await button(dialog, "Закрыть").click();
    await card(editor, video).scrollIntoViewIfNeeded();
    await manualCover(editor, video).waitFor();
  }
  assert.equal(await editor.locator("article iframe").count(), 0);
  assert.equal(await editor.evaluate(() => document.documentElement.scrollWidth), 390);

  const viewer = await signedInAs(t, "viewer");
  await viewer.route("https://www.instagram.com/p/KadrManualCover01/embed/", (route) => route.fulfill({ body: "Instagram iframe" }));
  await button(viewer, "Коллекции").click();
  await button(viewer, /Видео с командными обложками/).click();
  for (const video of [tikTok, instagram]) {
    await manualCover(viewer, video).waitFor();
  }
  await button(viewer, instagram.title).click();
  await button(viewer.getByRole("dialog"), "Заменить обложку").waitFor({ state: "hidden" });

  const read = () => viewer.request.get(stack.appUrl + coverPath(tikTok));
  const previous = await read();
  assert.equal(previous.status(), 200);
  assert.equal(previous.headers()["content-type"], "image/jpeg");
  assert.equal(previous.headers()["cache-control"], "private, no-store");
  assert.equal(previous.headers()["x-content-type-options"], "nosniff");

  await button(editor, tikTok.title).click();
  const dialog = editor.getByRole("dialog");
  await button(dialog, "Заменить обложку").waitFor();
  await dialog.getByLabel("Файл обложки").setInputFiles({
    name: "replacement.webp", mimeType: "image/webp", buffer: await picture(editor, "image/webp", "blue"),
  });
  await dialog.getByText("Обложка сохранена.", { exact: true }).waitFor();
  assert.notDeepEqual(await (await read()).body(), await previous.body());

  await button(dialog, "Удалить обложку").click();
  await dialog.getByText("Ручная обложка удалена.").waitFor();
  await button(dialog, "Закрыть").click();
  await tikCover.waitFor();

  await button(editor, instagram.title).click();
  await button(dialog, "Удалить обложку").click();
  await dialog.getByText("Ручная обложка удалена.").waitFor();
  await button(dialog, "Закрыть").click();
  assert.equal(await card(editor, instagram).locator(".video-cover, iframe").count(), 0);
  await button(card(editor, instagram), "Предпросмотр").click();
  assert.equal(await card(editor, instagram).locator("iframe").getAttribute("src"), "https://www.instagram.com/p/KadrManualCover01/embed/");
});

test("cover upload enforces authorization, origin, canonical paths and image limits", { timeout: 70_000 }, async (t) => {
  const video = await addCatalogFixture("instagram", "KadrCoverRls");
  const editor = await signedInAs(t, "admin");
  const bytes = await picture(editor, "image/jpeg", "salmon");
  const url = stack.appUrl + coverPath(video);
  const headers = { Origin: stack.appUrl, "Content-Type": "image/jpeg" };
  const forged = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
  assert.equal((await editor.request.put(url, { headers: { ...headers, Origin: "https://example.com" }, data: bytes })).status(), 403);
  assert.equal((await editor.request.put(url, { headers: { ...headers, "Sec-Fetch-Site": "cross-site" }, data: bytes })).status(), 403);
  assert.equal((await editor.request.put(url, { headers, data: forged })).status(), 422);
  assert.equal((await editor.request.put(url, { headers, data: Buffer.alloc(coverMaxBytes + 1) })).status(), 413);
  const sizeMarker = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sizeMarker > 0);
  const oversizedDimensions = Buffer.from(bytes);
  oversizedDimensions.writeUInt16BE(1281, sizeMarker + 7);
  assert.equal((await editor.request.put(url, { headers, data: oversizedDimensions })).status(), 422);

  const demo = "69000000-0000-4000-8000-000000000001";
  assert.equal((await editor.request.put(`${stack.appUrl}/api/videos/${demo}/cover`, { headers, data: bytes })).status(), 404);
  const store = (role, path, data = bytes, type = "image/jpeg") => stack.storageAs(role, `object/video-covers/${path}`, {
    method: "POST", headers: { "Content-Type": type, "x-upsert": "true" }, body: data,
  });
  for (const path of [`${demo}.jpg`, `${video.id}.png`, `folder/${video.id}.jpg`, "00000000-0000-4000-8000-000000000000.jpg"]) {
    assert.equal((await store("member", path)).ok, false);
  }
  const path = `${video.id}.jpg`;
  assert.equal((await store("member", path, forged, "image/svg+xml")).ok, false);
  assert.equal((await store("member", path, Buffer.alloc(coverMaxBytes + 1))).ok, false);
  assert.equal((await editor.request.put(url, { headers, data: bytes })).status(), 200);
  assert.equal((await fetch(url)).status, 401);
  for (const role of ["viewer", "outsider", "anon"]) {
    assert.equal((await store(role, path)).ok, false);
    const read = await stack.storageAs(role, `object/authenticated/video-covers/${path}`);
    assert.equal(read.ok, role === "viewer");
  }
  const readVersions = (role) => stack.restAs(role, "rpc/saved_video_cover_versions", {
    method: "POST", body: JSON.stringify({ video_ids: [video.id] }),
  });
  assert.equal((await (await readVersions("viewer")).json())[0].id, video.id);
  assert.deepEqual(await (await readVersions("outsider")).json(), []);
  assert.equal((await readVersions("anon")).ok, false);
  const viewer = await signedInAs(t, "viewer");
  assert.equal((await viewer.request.put(url, { headers, data: bytes })).status(), 403);
  assert.equal((await viewer.request.delete(url, { headers })).status(), 403);
  assert.equal((await viewer.request.get(url)).status(), 200);

  // A raw Storage client can declare a JPEG MIME type on other bytes.
  assert.equal((await store("member", path, forged)).ok, true);
  assert.equal((await viewer.request.get(url)).status(), 404);
  assert.equal((await editor.request.delete(url, { headers })).status(), 204);
  assert.deepEqual(await (await readVersions("viewer")).json(), []);
});
