// Real local UI/RPC acceptance. No reply fixture is injected; live model checks are a separate phase.
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

assert.equal(process.env.MOSSBOT_SMOKE_ISOLATED, "1", "Use an isolated Moss --home-dir.");
const base = process.env.MOSSBOT_SMOKE_URL ?? "http://localhost:5733";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname));
const output = resolve(process.env.MOSSBOT_GROUP_OUTPUT ?? "docs/pr-screenshots/mossbot-groups");
const profile = resolve(process.env.MOSSBOT_GROUP_PROFILE ?? "/tmp/mossbot-group-browser");
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: ["--no-sandbox"],
  locale: "zh-CN",
  colorScheme: "dark",
  hasTouch: true,
  viewport: { width: 390, height: 844 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(25000);
const receipt = {
  checks: [],
  screenshots: [],
  pageErrors: [],
  liveModelRequests: "not-run",
  fixture: {},
};
page.on("pageerror", (e) => receipt.pageErrors.push(e.message));
const check = (name, value = true) => {
  assert(value, name);
  receipt.checks.push(name);
  console.log(`PASS ${name}`);
};
const shot = async (name) => {
  await page.screenshot({ path: resolve(output, name), animations: "disabled" });
  receipt.screenshots.push(name);
};
const workspace = page.locator("[data-mossbot-workspace]");
const waitHome = async () => {
  await workspace.waitFor();
  await workspace.locator('[data-mossbot-roster][aria-busy="false"]').waitFor();
};
const home = async () => {
  await page.goto(`${base}/mossbot`);
  await waitHome();
};
const row = (name) =>
  workspace
    .locator(".mossbot-list-item")
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
const menuItem = (name) => page.getByRole("menuitem", { name, exact: true });
const rowMenu = async (name) =>
  row(name)
    .getByRole("button", { name: /助手操作|群聊操作/ })
    .click();
const openNew = async (name) => {
  await workspace.getByRole("button", { name: "新建助手或群聊", exact: true }).click();
  await menuItem(name).click();
};
const newFolder = async (name) => {
  await openNew("新建分组");
  await page.getByRole("textbox", { name: "新建分组", exact: true }).fill(name);
  await page.getByRole("button", { name: "创建分组", exact: true }).click();
};
const assign = async (name, folder) => {
  await rowMenu(name);
  await menuItem("移至分组").click();
  await page.getByRole("menuitemradio", { name: folder, exact: true }).click();
  await page.getByRole("menu").first().waitFor({ state: "hidden" });
};

try {
  await home();
  for (const name of ["跳过设置", "暂不设置", "跳过导览"]) {
    const button = page.getByRole("button", { name, exact: true });
    try {
      await button.waitFor({ state: "visible", timeout: 2500 });
      await button.click();
    } catch (e) {
      if (e.name !== "TimeoutError") throw e;
    }
  }
  // Hide prior acceptance assistants only in this isolated browser's presentation preferences.
  for (const name of await workspace
    .locator('.mossbot-list-item[data-conversation-kind="assistant"] .text-ui-lg')
    .allTextContents()) {
    if (!name.startsWith("Moss UI")) continue;
    await rowMenu(name);
    await menuItem("隐藏").click();
  }
  const roles = [
    ["Moss", "你是用户的个人助理，帮助安排任务并协作。", 0],
    [
      "灵感",
      "你是创意伙伴灵感，提出具体且有趣的想法。群聊中只回答用户点名的问题，结合前面成员的回复，最多100字，不要重复正常回复或自行继续。",
      8,
    ],
    [
      "明镜",
      "你是审阅伙伴明镜，指出方案的风险和遗漏。群聊中结合之前成员的回复，最多100字，不要重复正常回复或自行继续。",
      9,
    ],
    [
      "落地",
      "你是执行伙伴落地，将想法和审阅意见整理成可行安排。群聊中结合前面成员的回复，最多100字，不要重复正常回复或自行继续。",
      10,
    ],
  ];
  for (const [name, instructions, avatar] of roles) {
    if (await row(name).count()) continue;
    await openNew("新建助手");
    await page.locator("#mossbot-name").fill(name);
    await page.locator("#mossbot-personality").fill(instructions);
    await page
      .locator('[role="group"]')
      .filter({ has: page.locator("[data-mossbot-avatar]") })
      .last()
      .getByRole("button")
      .nth(avatar)
      .click();
    await page.getByRole("button", { name: "创建助手", exact: true }).click();
    await page.locator("[data-mossbot-conversation]").waitFor();
    receipt.fixture[name] = page.url();
    await home();
  }
  check("three distinct role assistants created through the native UI");
  const groupName = "机器人协作演示";
  if (!(await row(groupName).count())) {
    // Starting from a bot's menu preselects that actual bot, not just its display name.
    await rowMenu("灵感");
    await menuItem("新建群聊").click();
    const dialog = page.getByRole("dialog").last();
    await dialog.getByRole("textbox", { name: "群聊名称", exact: true }).fill(groupName);
    const selected = dialog.getByRole("checkbox", { name: "灵感", exact: true });
    check(
      "bot menu preselects the real assistant in room creation",
      (await selected.getAttribute("aria-checked")) === "true",
    );
    await dialog
      .getByRole("textbox", { name: "群聊背景", exact: true })
      .fill("六位朋友的周末聚会。创意、审阅和执行三个角色协作，输出可落地的安排。验收环境。 ");
    for (const name of ["明镜", "落地"])
      await dialog.getByRole("checkbox", { name, exact: true }).click();
    await dialog.getByRole("button", { name: "创建群聊", exact: true }).click();
    await page.locator("[data-mossbot-room]").waitFor();
    receipt.fixture.roomUrl = page.url();
  } else {
    await row(groupName).locator(".mossbot-assistant-row").click();
    await page.locator("[data-mossbot-room]").waitFor();
    receipt.fixture.roomUrl = page.url();
  }
  check("native three-bot group creation and room route");
  const room = page.locator("[data-mossbot-room]");
  await room.locator("[data-room-name]").click();
  const members = page.getByRole("dialog").last();
  await members.getByRole("combobox").selectOption("everyone");
  await shot("members-mobile.png");
  await members.getByRole("button", { name: "保存更改", exact: true }).click();
  await page.reload();
  await room.waitFor();
  await room.locator("[data-room-name]").click();
  assert.equal(
    await page.getByRole("dialog").last().getByRole("combobox").inputValue(),
    "everyone",
  );
  await page.getByRole("dialog").last().getByRole("button", { name: "取消", exact: true }).click();
  check("member roster and everyone responder saved through native service and survive reload");
  await room.locator("[data-room-name]").click();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("checkbox", { name: "Moss", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "保存更改", exact: true })
    .click();
  await page.reload();
  await room.waitFor();
  await room.locator("[data-room-name]").click();
  const expandedMembers = page.getByRole("dialog").last();
  assert.equal(
    await expandedMembers
      .getByRole("checkbox", { name: "Moss", exact: true })
      .getAttribute("aria-checked"),
    "true",
  );
  await expandedMembers.getByRole("checkbox", { name: "Moss", exact: true }).click();
  for (const name of ["灵感", "明镜", "落地"])
    await expandedMembers.getByRole("checkbox", { name, exact: true }).click();
  check(
    "member management rejects an empty group",
    await expandedMembers.getByRole("button", { name: "保存更改", exact: true }).isDisabled(),
  );
  for (const name of ["灵感", "明镜", "落地"])
    await expandedMembers.getByRole("checkbox", { name, exact: true }).click();
  await expandedMembers.getByRole("button", { name: "保存更改", exact: true }).click();
  check("adding and removing an actual member preserves the original group and responder");
  const composer = room.getByRole("combobox");
  await composer.click();
  await composer.fill("@明");
  await composer.press("End");
  await page.getByRole("option", { name: /明镜/ }).click();
  check(
    "mention picker inserts the selected member",
    (await composer.inputValue()).includes("@明镜"),
  );
  await composer.click();
  await composer.fill("待发送草稿，重新打开群聊后继续");
  await page.reload();
  await room.waitFor();
  assert.equal(await composer.inputValue(), "待发送草稿，重新打开群聊后继续");
  await composer.click();
  await composer.fill("");
  check("room draft persists without sending a model request");
  await shot("group-mobile.png");
  await room.getByRole("button", { name: /群聊操作/ }).click();
  await shot("group-menu-mobile.png");
  await page.keyboard.press("Escape");
  await room.getByRole("button", { name: "返回助手列表", exact: true }).click();
  await workspace.waitFor();
  check("mobile room back navigation returns to the shared conversation roster");
  if (!(await workspace.locator('[data-section="领导"]').count())) await newFolder("领导");
  await assign("Moss", "领导");
  if (!(await workspace.locator('[data-section="协作"]').count())) await newFolder("协作");
  for (const name of [groupName, "灵感", "明镜", "落地"]) await assign(name, "协作");
  check("bots and room can share a named conversation group");
  await page.reload();
  await waitHome();
  const section = workspace
    .locator("[data-mossbot-folder]")
    .filter({ has: page.locator('[data-section="协作"]') });
  await section.locator(".mossbot-list-item").nth(3).waitFor();
  assert.equal(await section.locator(".mossbot-list-item").count(), 4);
  await section.getByRole("button", { name: "协作", exact: true }).click();
  await row(groupName).waitFor({ state: "hidden" });
  await page.reload();
  await waitHome();
  await row(groupName).waitFor({ state: "hidden" });
  check("conversation assignment and collapse survive reload");
  const search = workspace.getByRole("textbox", { name: "搜索助手和群聊", exact: true });
  await search.fill(groupName);
  await row(groupName).waitFor();
  check("search reveals matching chats inside collapsed groups without losing collapse preference");
  await search.fill("");
  await row(groupName).waitFor({ state: "hidden" });
  await section.getByRole("button", { name: "协作", exact: true }).click();
  await section.getByRole("button", { name: "分组操作 · 协作", exact: true }).click();
  await menuItem("重命名分组").click();
  await page.getByRole("textbox", { name: "重命名分组", exact: true }).fill("伙伴");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  check(
    "renaming keeps all bot and room memberships",
    (await workspace.locator('[data-section="伙伴"]').count()) === 1,
  );
  await assign(groupName, "未分组");
  await shot("grouped-mobile.png");
  await workspace.getByRole("button", { name: "分组操作 · 伙伴", exact: true }).click();
  await menuItem("移除分组（保留会话）").click();
  for (const name of [groupName, "灵感", "明镜", "落地"]) await row(name).waitFor();
  check("removing a conversation group preserves all assistants and room history");
  await shot("roster-mobile.png");
  for (const width of [320, 375, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    check(
      `mixed roster has no horizontal overflow at ${width}px`,
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    );
  }
  await shot("roster-desktop.png");
  await row(groupName).locator(".mossbot-assistant-row").click();
  await room.waitFor();
  await shot("group-desktop.png");
  check("no uncaught page errors", receipt.pageErrors.length === 0);
  await rm(resolve(output, "failure.png"), { force: true });
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.failure = error.message;
  process.exitCode = 1;
  await shot("failure.png").catch(() => {});
} finally {
  await writeFile(resolve(output, "ui-verification.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
  await context.close();
}
