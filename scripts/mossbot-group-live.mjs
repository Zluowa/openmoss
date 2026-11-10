// Live acceptance only. Requires an isolated running home and an already configured native provider.
// No key values, reply fixtures, or mock provider are accepted by this script.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

assert.equal(process.env.MOSSBOT_SMOKE_ISOLATED, "1", "Use an isolated Moss --home-dir.");
assert.equal(
  process.env.MOSSBOT_LIVE_GROUP_AUTHORIZED,
  "1",
  "Live provider requests require explicit authorization.",
);
const output = resolve(process.env.MOSSBOT_GROUP_OUTPUT ?? "docs/pr-screenshots/mossbot-groups");
await mkdir(output, { recursive: true });
const ui = JSON.parse(await readFile(resolve(output, "ui-verification.json"), "utf8"));
assert(ui.passed && ui.fixture.roomUrl, "Complete the UI acceptance first.");
const url = new URL(ui.fixture.roomUrl);
assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
const roomId = url.searchParams.get("room");
const profile = resolve(process.env.MOSSBOT_GROUP_PROFILE ?? "/tmp/mossbot-group-browser");
const context = await chromium.launchPersistentContext(profile, {
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: ["--no-sandbox"],
  locale: "zh-CN",
  colorScheme: "dark",
  hasTouch: true,
  viewport: { width: 1440, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(30000);
const receipt = {
  startedAt: new Date().toISOString(),
  stage: "starting",
  checks: [],
  screenshots: [],
  turns: [],
  pageErrors: [],
  roomId,
};
page.on("pageerror", (e) => receipt.pageErrors.push(e.message));
const save = () =>
  writeFile(resolve(output, "live-verification.json"), JSON.stringify(receipt, null, 2) + "\n");
const check = async (name, value = true) => {
  assert(value, name);
  receipt.checks.push(name);
  console.log(`PASS ${name}`);
  await save();
};
const stage = async (name) => {
  receipt.stage = name;
  console.log(`STAGE ${name}`);
  await save();
};
const shot = async (name) => {
  await page.screenshot({ path: resolve(output, name), animations: "disabled" });
  receipt.screenshots.push(name);
};
const get = () =>
  page.evaluate(async (id) => {
    const { readNativeApi } = await import("/src/nativeApi.ts");
    return readNativeApi().mossbotRooms.get({ roomId: id });
  }, roomId);
const room = page.locator("[data-mossbot-room]");
const input = room.getByRole("combobox");
async function send(text) {
  await input.click();
  await input.fill(text);
  await input.press("Escape");
  await input.press("Enter");
}
const keys = (data) => new Set(data.room.deliveries.map((d) => `${d.requestId}:${d.memberId}`));
async function completedSince(before, expected) {
  const prior = keys(before),
    end = Date.now() + 240000;
  while (Date.now() < end) {
    const data = await get();
    const jobs = data.room.deliveries.filter((d) => !prior.has(`${d.requestId}:${d.memberId}`));
    const failed = jobs.find((d) => d.state === "failed");
    if (failed) throw new Error(`Native group delivery failed: ${failed.error}`);
    if (jobs.length >= expected && jobs.every((d) => d.state === "completed")) {
      const ids = new Set(before.replies.map((r) => r.message.id));
      return { data, jobs, replies: data.replies.filter((r) => !ids.has(r.message.id)) };
    }
    await page.waitForTimeout(750);
  }
  throw new Error("Native room did not finish within the bounded live acceptance timeout.");
}

try {
  await page.goto(url.href);
  await room.waitFor();
  let initial = await get();
  if (process.env.MOSSBOT_LIVE_MODEL) {
    const model = process.env.MOSSBOT_LIVE_MODEL;
    await page.evaluate(
      async ({ ids, model }) => {
        const { readNativeApi } = await import("/src/nativeApi.ts");
        const api = readNativeApi();
        for (const projectId of ids) {
          const { config } = await api.projectAgent.getOverview({ projectId });
          await api.projectAgent.configure({
            projectId,
            requestId: crypto.randomUUID(),
            agentKind: "mossbot",
            coordinatorModelSelection: { ...config.coordinatorModelSelection, model },
            expectedRevision: config.revision,
            limits: config.limits,
            captureEnabled: config.captureEnabled,
          });
        }
      },
      { ids: initial.room.members.filter((m) => !m.hidden).map((m) => m.id), model },
    );
    receipt.requestedModel = model;
  }
  const active = initial.room.members.filter((m) => !m.hidden);
  await check(
    "three distinct native member identities and threads",
    active.length === 3 && new Set(active.map((m) => m.threadId)).size === 3,
  );
  receipt.members = active.map(({ id, name, threadId, modelSelection }) => ({
    id,
    name,
    threadId,
    modelSelection,
  }));
  await stage("everyone-live-replies");
  await send(
    "@everyone 六位朋友周末在家聚会两小时。请灵感先给两个不依赖手机的活动，明镜结合灵感的建议指出一个风险，落地结合前两位的回复排出时间表。每位最多100字，直接回答，不调用工具，也不要自行追加新话题。",
  );
  const everyone = await completedSince(initial, 3);
  receipt.members = everyone.data.room.members
    .filter((m) => !m.hidden)
    .map(({ id, name, threadId, modelSelection }) => ({ id, name, threadId, modelSelection }));
  assert.equal(everyone.jobs.length, 3);
  assert.deepEqual(new Set(everyone.jobs.map((d) => d.memberId)), new Set(active.map((m) => m.id)));
  assert(
    active.every((m) => everyone.replies.some((r) => r.memberId === m.id && r.message.text.trim())),
  );
  receipt.turns.push({
    kind: "everyone",
    deliveries: everyone.jobs,
    replies: everyone.replies.map(({ memberId, threadId, message }) => ({
      memberId,
      threadId,
      messageId: message.id,
      text: message.text,
    })),
  });
  await check("everyone receives one real completed reply from each selected bot");
  await shot("live-group-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("live-group-mobile.png");
  const ids = everyone.replies.map((r) => r.message.id);
  await page.reload();
  await room.waitFor();
  const restored = await get();
  await check(
    "real group replies and member thread identities survive reload",
    ids.every((id) => restored.replies.some((r) => r.message.id === id)) &&
      active.every((m) =>
        restored.room.members.some((r) => r.id === m.id && r.threadId === m.threadId),
      ),
  );
  await stage("targeted-live-mention");
  const beforeMention = await get();
  await send(
    "@明镜 仅请你再指出一项这个聚会安排里需要照顾的参与者差异。50字以内，不调用工具；其他成员不用回复。",
  );
  const mentioned = await completedSince(beforeMention, 1);
  assert.equal(mentioned.jobs.length, 1);
  assert.equal(mentioned.jobs[0].memberId, active.find((m) => m.name === "明镜").id);
  receipt.turns.push({
    kind: "mention",
    deliveries: mentioned.jobs,
    replies: mentioned.replies.map(({ memberId, message }) => ({
      memberId,
      messageId: message.id,
      text: message.text,
    })),
  });
  await check("a specific live mention wakes only the selected bot");
  await stage("native-queue-and-stop");
  const beforeStop = await get(),
    priorStop = keys(beforeStop);
  await send("@灵感 请暂时拟定五个活动名称，每个不超过六个字。");
  await input.waitFor({ state: "visible" });
  await send("@落地 这是排队取消验收消息，无需实际执行后续安排。");
  await room.getByRole("button", { name: "停止群聊", exact: true }).click();
  let stopped;
  for (let i = 0; i < 80; i++) {
    const data = await get(),
      jobs = data.room.deliveries.filter((d) => !priorStop.has(`${d.requestId}:${d.memberId}`));
    if (
      jobs.length === 2 &&
      jobs.every((d) => d.state === "cancelled" || d.state === "completed")
    ) {
      stopped = jobs;
      break;
    }
    await page.waitForTimeout(500);
  }
  await check(
    "native stop clears queued work and terminates active group delivery",
    stopped?.length === 2 && stopped.some((d) => d.state === "cancelled"),
  );
  receipt.turns.push({ kind: "queue-stop", deliveries: stopped });
  if (process.env.MOSSBOT_LIVE_VISUAL === "1") {
    await stage("native-interactive-visual");
    const beforeVisual = await get();
    await send(
      "@落地 请用本会话提供的内嵌可视化工具，将刚才三位伙伴的聚会安排做成一个可交互的两小时时间轴：可切换轻松版和活跃版，点击活动显示详情。用中文，深色界面。请实际创建并返回可打开的可视化，不要只贴HTML代码块，也不要调用外部服务。",
    );
    const visual = await completedSince(beforeVisual, 1);
    await page
      .locator('[data-inline-visualization-state="ready"]')
      .first()
      .waitFor({ timeout: 60000 });
    await shot("live-visual-mobile.png");
    receipt.turns.push({
      kind: "visual",
      deliveries: visual.jobs,
      replies: visual.replies.map(({ memberId, message }) => ({
        memberId,
        messageId: message.id,
        text: message.text,
      })),
    });
    await check("a real group bot creates an inline visual through native tools");
  }
  await room.getByRole("button", { name: "返回助手列表", exact: true }).click();
  await page.locator('[data-mossbot-workspace] [data-mossbot-roster][aria-busy="false"]').waitFor();
  await shot("live-roster-mobile.png");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot("live-roster-desktop.png");
  await check("no uncaught browser errors during live acceptance", receipt.pageErrors.length === 0);
  receipt.passed = true;
  await stage("completed");
} catch (error) {
  receipt.passed = false;
  receipt.failure = error.message;
  process.exitCode = 1;
  await shot("live-failure.png").catch(() => {});
  await save();
  console.error(error.message);
} finally {
  await save();
  await context.close();
}
