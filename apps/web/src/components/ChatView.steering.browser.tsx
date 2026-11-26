// FILE: ChatView.steering.browser.tsx
// Purpose: Real Chromium browser verification, zh-CN light/dark visual screenshots,
//          and rapid-steer UI stress tests for mid-run steering parity.
// Layer: Full-app ChatView browser tests

import { EventId, MessageId, type OrchestrationReadModel, TurnId } from "@moss/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_VIEWPORT,
  NOW_ISO,
  PROJECT_ID,
  THREAD_ID,
  createAssistantMessage,
  createSnapshotForTargetUser,
  createUserMessage,
  installChatViewFixture,
  isoAt,
  mountChatView,
  readDispatchedCommand,
  setImageLimitFixtureTheme,
  waitForElement,
  waitForLayout,
  wsRequests,
} from "../test/chatViewBrowserHarness";

vi.mock("~/lib/desktopTitleBar", async (importOriginal) => {
  const { desktopTitleBar } = await import("../test/chatViewBrowserMocks");
  const actual = await importOriginal<typeof import("~/lib/desktopTitleBar")>();
  return {
    desktopTitleBarControlsShown: () => desktopTitleBar.on || actual.desktopTitleBarControlsShown(),
    desktopTitleBarBandShown: () => desktopTitleBar.on || actual.desktopTitleBarBandShown(),
  };
});

const STEER_PARITY_SHOT_DIR = "../../../../.tmp/steer-parity";

function createSteerRestartComparisonSnapshot(): OrchestrationReadModel {
  const turn0 = TurnId.makeUnsafe("turn-steer-prev-0");
  const turn1 = TurnId.makeUnsafe("turn-steer-cut-1");
  const turn2 = TurnId.makeUnsafe("turn-steer-next-2");
  const base = createSnapshotForTargetUser({
    targetMessageId: MessageId.makeUnsafe("msg-steer-base-u1"),
    targetText: "帮我检查画布区域批注为什么会画出框外",
    messagePairCount: 1,
    sessionStatus: "ready",
  });
  const thread = base.threads[0]!;
  return {
    ...base,
    threads: [
      {
        ...thread,
        title: "画布批注与引导对齐验证",
        modelSelection: {
          provider: "antigravity",
          model: "gemini-3-pro",
        },
        session: {
          ...thread.session!,
          providerName: "antigravity",
          status: "ready",
          activeTurnId: null,
          lastError: null,
        },
        messages: [
          {
            ...createAssistantMessage({
              id: MessageId.makeUnsafe("msg-a0-intro"),
              text: "如果要修，最稳的做法是两头一起补：\n1. 提示词明确约束区域框选边界。\n2. 前端自动适配兜底，等比缩放并居中移回框内。\n\n需要我直接按这个方案帮你把这两处改掉吗？",
              offsetSeconds: 0,
            }),
            turnId: turn0,
          },
          {
            ...createUserMessage({
              id: MessageId.makeUnsafe("msg-u1"),
              text: "你可以使用 rea 逆向对齐 claude 桌面端实现，然后自己测试没问题后推给主管，记得在 vercel board 里汇报你的进度，如果实操测试通过后记得提一个合并 pr",
              offsetSeconds: 2,
            }),
            turnId: turn1,
          },
          {
            ...createUserMessage({
              id: MessageId.makeUnsafe("msg-u2-steer-restart"),
              text: "而且需要研究 claude 为什么随便一句话，白板里的效果都很好了，风格很统一，研究清楚也对齐",
              offsetSeconds: 8,
            }),
            dispatchMode: "steer",
            startsNewTurn: true,
            turnId: turn2,
          },
          {
            ...createAssistantMessage({
              id: MessageId.makeUnsafe("msg-a2-final"),
              text: "已完成对 Claude 桌面端白板的 REA 逆向对齐研究、双仓代码改造、全套自动化与真实画布实操验证，并已提交合并 PR。整个过程没有再出现红色误报错误框。",
              offsetSeconds: 22,
            }),
            turnId: turn2,
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("act-t1-start"),
            turnId: turn1,
            createdAt: isoAt(3),
            tone: "info",
            kind: "turn.started",
            summary: "Turn started",
            payload: {},
            sequence: 1,
          },
          {
            id: EventId.makeUnsafe("act-t1-tool"),
            turnId: turn1,
            createdAt: isoAt(5),
            tone: "tool",
            kind: "tool.completed",
            summary: "Inspect Claude desktop canvas bundle",
            payload: {
              itemType: "command_execution",
              status: "completed",
              title: "REA 逆向检查 Claude 桌面端画布实现",
            },
            sequence: 2,
          },
          {
            id: EventId.makeUnsafe("act-t1-steer-stop"),
            turnId: turn1,
            createdAt: isoAt(8),
            tone: "info",
            kind: "turn.stop-requested",
            summary: "Steer interrupt requested",
            payload: { requestedBy: "steer" },
            sequence: 3,
          },
          {
            id: EventId.makeUnsafe("act-t1-interrupted"),
            turnId: turn1,
            createdAt: isoAt(9),
            tone: "info",
            kind: "turn.completed",
            summary: "Turn interrupted",
            payload: { state: "interrupted" },
            sequence: 4,
          },
          {
            id: EventId.makeUnsafe("act-t2-start"),
            turnId: turn2,
            createdAt: isoAt(10),
            tone: "info",
            kind: "turn.started",
            summary: "Turn started",
            payload: {},
            sequence: 5,
          },
          {
            id: EventId.makeUnsafe("act-t2-completed"),
            turnId: turn2,
            createdAt: isoAt(22),
            tone: "info",
            kind: "turn.completed",
            summary: "Turn completed",
            payload: { state: "completed" },
            sequence: 6,
          },
        ],
        latestTurn: {
          turnId: turn2,
          state: "completed",
          requestedAt: isoAt(8),
          startedAt: isoAt(10),
          completedAt: isoAt(22),
          assistantMessageId: MessageId.makeUnsafe("msg-a2-final"),
        },
      },
    ],
    projects: [
      {
        ...base.projects[0]!,
        id: PROJECT_ID,
        title: "Moss 工作区",
      },
    ],
    updatedAt: NOW_ISO,
  } as OrchestrationReadModel;
}

describe("ChatView steering parity & UI stress (full app)", () => {
  installChatViewFixture();

  it("renders zh-CN native steering cleanly without error banners and captures screenshot", async () => {
    setImageLimitFixtureTheme("light");
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ localeOverride: "zh-CN", followUpBehavior: "steer" }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_ID, "同时顺便把风格统一性和边界缩放一起对齐测试");

    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-native-steer-target"),
      targetText: "请帮我分析 Claude 和 ChatGPT 引导对话的实现差异并完成重构",
      messagePairCount: 1,
      sessionStatus: "running",
    });

    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1200, height: 820 },
      snapshot: base,
    });

    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          const text = document.body.textContent ?? "";
          expect(text).toContain("正在引导对话");
          expect(text).toContain("同时顺便把风格统一性和边界缩放一起对齐测试");
          expect(text).not.toContain("服务商暂时无法完成此请求");
          expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
        },
        { timeout: 10_000, interval: 25 },
      );

      await waitForLayout();
      const shot = await page.screenshot({
        path: `${STEER_PARITY_SHOT_DIR}/steer-native-zh-light.png`,
      });
      expect(shot).toContain("steer-native-zh-light.png");
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["light", "dark"] as const)(
    "renders non-native steer-restart neutrally in zh-CN %s mode with zero red error boxes",
    async (theme) => {
      setImageLimitFixtureTheme(theme);
      localStorage.setItem(
        APP_SETTINGS_STORAGE_KEY,
        JSON.stringify({ localeOverride: "zh-CN", followUpBehavior: "steer" }),
      );

      const mounted = await mountChatView({
        viewport: { ...DEFAULT_VIEWPORT, width: 1200, height: 820 },
        snapshot: createSteerRestartComparisonSnapshot(),
      });

      try {
        await vi.waitFor(
          () => {
            const text = document.body.textContent ?? "";
            expect(text).toContain("正在引导对话");
            expect(text).not.toContain("已被引导打断");
            expect(text).not.toContain("已中断上轮并继续");
            expect(text).not.toContain("服务商暂时无法完成此请求");
            expect(document.querySelector('[data-interrupted-turn="true"]')).toBeNull();
            expect(document.querySelector('[data-stopped-turn="true"]')).toBeNull();
          },
          { timeout: 10_000, interval: 25 },
        );

        await waitForLayout();
        const filename = `steer-restart-zh-${theme}.png`;
        const shot = await page.screenshot({
          path: `${STEER_PARITY_SHOT_DIR}/${filename}`,
        });
        expect(shot).toContain(filename);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("stress-tests 12 rapid consecutive mid-run steers in real Chromium without errors or dropped messages", async () => {
    setImageLimitFixtureTheme("light");
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ localeOverride: "zh-CN", followUpBehavior: "steer" }),
    );

    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-stress-root"),
      targetText: "开始执行长时间多步骤重构任务",
      messagePairCount: 1,
      sessionStatus: "running",
    });

    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1200, height: 860 },
      snapshot: base,
    });

    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );

      const BURST = 12;
      for (let i = 1; i <= BURST; i += 1) {
        useComposerDraftStore.getState().setPrompt(THREAD_ID, `高频引导压力测试消息 #${i}`);
        composerForm.requestSubmit();
        await vi.waitFor(
          () => {
            const dispatched = wsRequests
              .map(readDispatchedCommand)
              .filter(
                (command) =>
                  command?.type === "thread.turn.start" && command.dispatchMode === "steer",
              );
            expect(dispatched.length).toBeGreaterThanOrEqual(i);
          },
          { timeout: 8_000, interval: 16 },
        );
      }

      await vi.waitFor(
        () => {
          const text = document.body.textContent ?? "";
          expect(text).toContain("正在引导对话");
          expect(text).toContain(`高频引导压力测试消息 #${BURST}`);
          expect(text).not.toContain("服务商暂时无法完成此请求");
          expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
        },
        { timeout: 10_000, interval: 25 },
      );

      await waitForLayout();
      const shot = await page.screenshot({
        path: `${STEER_PARITY_SHOT_DIR}/steer-stress-12x-zh-light.png`,
      });
      expect(shot).toContain("steer-stress-12x-zh-light.png");
    } finally {
      await mounted.cleanup();
    }
  });
});
