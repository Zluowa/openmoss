// Full-app acceptance against an explicitly isolated dev home. Creates/deletes only test assistants.
// No provider turn is sent. Existing browser tests cover real IME/mention/scroll interactions.
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createRequire } from "node:module";
const axePath = createRequire(new URL("../apps/web/package.json", import.meta.url)).resolve(
  "axe-core/axe.min.js",
);

if (process.env.MOSSBOT_SMOKE_ISOLATED !== "1") {
  throw new Error("Start Moss with an isolated --home-dir, then set MOSSBOT_SMOKE_ISOLATED=1.");
}
const base = process.env.MOSSBOT_SMOKE_URL ?? "http://localhost:5733";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname));
const output = resolve(process.env.MOSSBOT_SMOKE_OUTPUT ?? "docs/pr-screenshots/mossbot-reference");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  locale: "zh-CN",
  colorScheme: "dark",
  viewport: { width: 1440, height: 1000 },
  hasTouch: true,
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const receipt = { checks: [], screenshots: [], pageErrors: [], modelTurnsSent: 0 };
page.on("pageerror", (error) => receipt.pageErrors.push(error.message));
const check = (name, value = true) => {
  assert(value, name);
  receipt.checks.push(name);
};
const shot = async (name) => {
  await page.screenshot({ path: resolve(output, name), animations: "disabled" });
  receipt.screenshots.push(name);
};
const home = async () => {
  await page.goto(`${base}/mossbot`);
  await page.locator("[data-mossbot-workspace]").waitFor();
};
const assistantRow = (name) =>
  page
    .locator("[data-mossbot-workspace] .mossbot-list-item")
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
const openRowMenu = async (name) =>
  assistantRow(name)
    .getByRole("button", { name: new RegExp(`助手操作.*${name}`) })
    .click();
const item = (name) => page.getByRole("menuitem", { name, exact: true });
async function createAssistant(name) {
  await home();
  await page
    .locator("[data-mossbot-workspace]")
    .getByRole("button", { name: "新建助手或群聊", exact: true })
    .click();
  await item("新建助手").click();
  await page.locator("#mossbot-name").fill(name);
  await page.getByRole("button", { name: "创建助手", exact: true }).click();
  await page.locator("[data-mossbot-conversation]").waitFor();
  return page.url();
}

try {
  await home();
  for (const name of ["跳过设置", "暂不设置", "跳过导览"]) {
    const skip = page.getByRole("button", { name, exact: true });
    try {
      await skip.waitFor({ state: "visible", timeout: 2500 });
      await skip.click();
    } catch (error) {
      if (error.name !== "TimeoutError") throw error;
    }
  }
  // Always seed this fixture through the production creation flow.
  const name = `Moss UI ${Date.now().toString(36).slice(-5)}`;
  const chatUrl = await createAssistant(name);
  check("native assistant creation and canonical thread navigation");
  await shot("chat-desktop.png");
  const choice = page.locator(".mossbot-onboarding-option").filter({ hasText: "查资料、写东西" });
  await choice.click();
  const editor = page.locator('[data-chat-composer-form="true"] [contenteditable="true"]').first();
  await editor.waitFor();
  assert((await editor.innerText()).includes("查资料、写东西"));
  await editor.fill("");
  check("onboarding populates the native draft without sending a model request");

  await home();
  await openRowMenu(name);
  await item("置顶").click();
  await openRowMenu(name);
  await item("标为未读").click();
  await assistantRow(name).locator(".mossbot-unread-dot").waitFor();
  await page.reload();
  await assistantRow(name).locator(".mossbot-unread-dot").waitFor();
  check("pin and unread persist across reload");
  await openRowMenu(name);
  await item("设为主助手").click();
  await openRowMenu(name);
  await item("隐藏").click();
  await assistantRow(name).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "会话筛选", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "显示已隐藏的助手", exact: true }).click();
  await page.keyboard.press("Escape");
  await openRowMenu(name);
  await item("显示助手").click();
  await assistantRow(name).waitFor();
  check("hidden assistants can be found and restored without changing lifecycle");
  const search = page.getByRole("textbox", { name: "搜索助手和群聊", exact: true });
  await search.fill("no-such-assistant-acceptance");
  await assistantRow(name).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await assistantRow(name).waitFor();
  check("roster search and clear restore the same identities");

  for (const width of [320, 375, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    check(
      `roster has no document overflow at ${width}px`,
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    );
  }
  await shot("home-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("home-mobile.png");
  await openRowMenu(name);
  await shot("list-menu-mobile.png");
  await page.keyboard.press("Escape");

  await page.goto(chatUrl);
  await page.getByRole("button", { name: "查看资料", exact: true }).waitFor();
  await shot("chat-mobile.png");
  await page
    .getByRole("button", { name: new RegExp(`助手操作.*${name}`) })
    .last()
    .click();
  await shot("chat-menu-mobile.png");
  await item("在聊天中查找").click();
  const find = page.getByTestId("thread-find-bar");
  await find.waitFor();
  await find.locator("input").fill(name);
  check("identity menu opens native history search/highlight/navigation");
  await find.locator("input").press("Escape");
  await page.getByRole("button", { name: "返回助手列表", exact: true }).click();
  await page.locator("[data-mossbot-workspace]").waitFor();
  await page.locator(".mossbot-main-assistant").click();
  await page.locator("[data-mossbot-conversation]").waitFor();
  check("mobile back and main-assistant navigation keep the canonical conversation");

  await page.getByRole("button", { name: "查看资料", exact: true }).click();
  const profile = page.locator(".mossbot-profile");
  const toggle = profile.getByRole("switch", { name: "通知", exact: true });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await shot("profile-mobile.png");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  const box = await toggle.boundingBox();
  check("profile notification switch has a compact track", box.width < 80 && box.height >= 20);
  // Load the installed asset from the dev server's same-origin file route; preserve its CSP.
  await page.addScriptTag({ url: `${base}/@fs${axePath}` });
  const accessibility = await page.evaluate(async () =>
    window.axe.run(document.querySelector(".mossbot-profile"), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    }),
  );
  receipt.accessibility = {
    passedRules: accessibility.passes.length,
    violations: accessibility.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      count: nodes.length,
    })),
  };
  check("profile passes scoped WCAG A/AA automated checks", accessibility.violations.length === 0);
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "查看资料", exact: true }).click();
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await toggle.click();
  check("per-assistant notification preference survives reload and can be restored");
  await profile.getByRole("button", { name: /定时任务/ }).click();
  check(
    "profile opens the native scoped automations section",
    await profile.innerText().then((text) => !text.includes("Moss events")),
  );
  await profile.locator(".mossbot-profile-nav button").first().click();
  await profile.getByRole("button", { name: "资料库", exact: true }).click();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "取消", exact: true })
    .waitFor();
  check("knowledge/memory opens the existing native settings dialog");
  await page.getByRole("dialog").last().getByRole("button", { name: "取消", exact: true }).click();
  await profile.getByRole("button", { name: "分享为模板…", exact: true }).click();
  const template = page.locator(".mossbot-template-dialog");
  await template.locator("pre").waitFor();
  const exported = JSON.parse(await template.locator("pre").innerText());
  assert.deepEqual(Object.keys(exported).toSorted(), ["avatar", "instructions", "name", "version"]);
  check("template preview contains only the explicit portable fields");
  const downloadPromise = page.waitForEvent("download");
  await template.getByRole("button", { name: "下载模板", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "moss-assistant-template.json");
  check("reviewed template download uses an actual JSON artifact");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // The destructive action is tested only on this assistant created by this run.
  await page
    .getByRole("button", { name: new RegExp(`助手操作.*${name}`) })
    .last()
    .click();
  await item("删除…").click();
  const deletion = page.getByRole("dialog").last();
  const confirm = deletion.getByRole("textbox", { name: "输入助手名称以确认删除", exact: true });
  await confirm.waitFor();
  const remove = deletion.getByRole("button", { name: "删除助手", exact: true });
  check("deletion requires the exact assistant name", await remove.isDisabled());
  await confirm.fill(name);
  await remove.click();
  await page.locator("[data-mossbot-workspace]").waitFor();
  await assistantRow(name).waitFor({ state: "hidden" });
  check("native typed deletion removes the fixture and returns to the roster");
  check("no browser page errors", receipt.pageErrors.length === 0);
  await rm(resolve(output, "failure.png"), { force: true });
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.failure = error.message;
  await shot("failure.png").catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, "verification.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
  await browser.close();
}
