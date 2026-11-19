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
