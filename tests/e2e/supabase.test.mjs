import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
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

async function loginPage(t) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
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
  await entry.getByLabel("Описание").fill(videoName);
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
