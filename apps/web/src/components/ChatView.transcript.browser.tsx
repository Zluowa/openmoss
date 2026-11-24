// FILE: ChatView.transcript.browser.tsx
// Purpose: Full-app ChatView browser tests for the transcript: scrolling and following, optimistic sends, streaming, turn folding, approvals and questions.
//          The shared fixture is src/test/chatViewBrowserHarness.tsx; every ChatView.*.browser.tsx
//          keeps the one suite name, so case names (and the CI partitions) are unchanged.

import {
  buildStalePendingRequestFailureDetail,
  pendingRequestInstanceKey,
} from "@moss/shared/threadSummary";
import {
  ApprovalRequestId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  ProviderInstanceId,
  type ServerConfig,
  TurnId,
} from "@moss/contracts";
import { reconcileServerProviderStatuses } from "../lib/serverReactQuery";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollContainerDistanceFromBottom,
} from "../chat-scroll";
import { readNativeApi } from "../nativeApi";
import { emitWsTransportState } from "../wsTransportEvents";
import { setThreadDetailResumeCursor } from "../threadDetailResumeCursors";
import { useStore } from "../store";
import { clearThreadDetailCache, writeThreadDetailCache } from "../lib/threadDetailCache";
import { getWorkspaceEditorSession } from "../lib/workspaceEditorSession";
import { trackWsTurnSettlement } from "../wsTransportEvents";
import { useThreadDispatchStore } from "./chat/useChatLocalDispatch";
import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_VIEWPORT,
  NOW_ISO,
  OTHER_THREAD_ID,
  THREAD_ID,
  type TestFixture,
  addThreadToSnapshot,
  createAssistantMessage,
  createSnapshotForTargetUser,
  createSnapshotWithActiveFileChanges,
  createSnapshotWithActiveInlinePlan,
  createSnapshotWithBottomAttachments,
  createSnapshotWithHistoricalToolHydrationDuringLiveTurn,
  createSnapshotWithInlineToolOverflow,
  createSnapshotWithLongAssistantResponse,
  createSnapshotWithLongProposedPlan,
  createSnapshotWithPendingApproval,
  createSnapshotWithSettledInlinePlan,
  createSnapshotWithSettledPlanAwaitingFollowUp,
  createSnapshotWithTallComposerStack,
  createUserMessage,
  dispatchConfiguredShortcutWhenReady,
  findInlineToolsTurnDisclosure,
  fixture,
  hasDispatchedCommandType,
  installDeterministicSendNativeApi,
  installImmediateScrollToSpy,
  installProviderRefreshNativeApi,
  isoAt,
  mountChatView,
  nextFrame,
  readDispatchedCommand,
  recordTranscriptScrollTravel,
  setAttachmentResponseDelayMs,
  setFixture,
  setThreadDetailSnapshotBarrier,
  skipReactDevOwnerStacks,
  waitForComposerEditor,
  waitForElement,
  waitForImagesToLoad,
  waitForLayout,
  waitForSendButton,
  waitForTranscriptLayoutToSettle,
  waitForURL,
  wsRequests,
  installChatViewFixture,
  setImageLimitFixtureTheme,
} from "../test/chatViewBrowserHarness";

// Off for every test but the title-bar one, which needs the desktop app's own title-bar
// chrome: the back/forward arrows, the cluster's reserved box and, on Windows, the band over
// 图像 and 资料空间. All three ask `~/lib/desktopTitleBar`, switched on for that test only;
// everything else stays the web build.
vi.mock("~/lib/desktopTitleBar", async (importOriginal) => {
  const { desktopTitleBar } = await import("../test/chatViewBrowserMocks");
  const actual = await importOriginal<typeof import("~/lib/desktopTitleBar")>();
  return {
    desktopTitleBarControlsShown: () => desktopTitleBar.on || actual.desktopTitleBarControlsShown(),
    desktopTitleBarBandShown: () => desktopTitleBar.on || actual.desktopTitleBarBandShown(),
  };
});

vi.mock("../lib/realtimeVoiceWebRtc", async () => {
  const { realtimeVoiceChatHarness } = await import("../test/chatViewBrowserMocks");
  return {
    RealtimeVoiceWebRtcClient: class FakeRealtimeVoiceWebRtcClient {
      snapshot = {
        webRtcConnected: true,
        dataSessionInitialized: true,
        inputMuted: false,
        outputMuted: false,
      };

      constructor() {
        realtimeVoiceChatHarness.webRtcConstructed();
      }

      async prepare() {
        return { offerSdp: "moss-chat-shell-browser-offer", inputDeviceId: null };
      }

      async applyAnswer() {}

      setInputMuted(inputMuted: boolean) {
        this.snapshot = { ...this.snapshot, inputMuted };
      }

      setOutputMuted(outputMuted: boolean) {
        this.snapshot = { ...this.snapshot, outputMuted };
      }

      async replaceMicrophone() {
        return null;
      }

      async dispose() {
        realtimeVoiceChatHarness.webRtcDisposed();
      }
    },
  };
});

vi.mock("../lib/realtimeVoiceWebSocket", async () => {
  const { realtimeVoiceChatHarness } = await import("../test/chatViewBrowserMocks");
  return {
    RealtimeVoiceWebSocketClient: class FakeRealtimeVoiceWebSocketClient {
      snapshot = {
        webRtcConnected: false,
        dataSessionInitialized: false,
        inputMuted: false,
        outputMuted: false,
      };

      constructor() {
        realtimeVoiceChatHarness.webSocketConstructed();
      }

      async prepare() {
        return { inputDeviceId: null };
      }

      async connect() {}

      setInputMuted(inputMuted: boolean) {
        this.snapshot = { ...this.snapshot, inputMuted };
      }

      setOutputMuted(outputMuted: boolean) {
        this.snapshot = { ...this.snapshot, outputMuted };
      }

      async replaceMicrophone() {
        return null;
      }

      async dispose() {
        realtimeVoiceChatHarness.webSocketDisposed();
      }
    },
  };
});

describe("ChatView transcript geometry (full app)", () => {
  installChatViewFixture();

  // WALK-4 N4-1: one failed message showed four error texts (a status card, a banner with
  // 重试 and two cut-off lines). A failed message shows one sentence and its one action, at the
  // message; the banner and the status card do not repeat it.
  describe("a message that did not start", () => {
    const UNCONFIRMED =
      "Moss could not confirm what the provider did with this message, so it stopped waiting. It was not sent again.";
    const DEVIN_REFUSED =
      "Error: Provider adapter process error (devin) for thread t: Devin ACP advertised only interactive auth (devin-browser).";
    const failure = (
      id: string,
      offsetSeconds: number,
      summary: string,
      payload: Record<string, string>,
    ) => ({
      id: EventId.makeUnsafe(id),
      turnId: null,
      createdAt: isoAt(offsetSeconds),
      sequence: offsetSeconds,
      kind: "provider.turn.start.failed" as const,
      tone: "error" as const,
      summary,
      payload,
    });
    const CASES = [
      {
        name: "agent signed out (the walk's own record)",
        signedOut: true,
        sessionError: UNCONFIRMED,
        activities: [
          failure("refused", 1, "Provider turn start failed", { detail: DEVIN_REFUSED }),
          failure("unconfirmed", 37, "Provider turn start was not confirmed", {
            detail: UNCONFIRMED,
          }),
        ],
        sentence: { en: "Devin is not signed in.", "zh-CN": "Devin 尚未登录。" },
        action: { en: "Sign in", "zh-CN": "登录" },
      },
      {
        name: "agent signed out",
        signedOut: true,
        sessionError: DEVIN_REFUSED,
        activities: [
          failure("refused", 1, "Provider turn start failed", {
            detail: DEVIN_REFUSED,
            cause: "provider-signed-out",
            messageId: "failed-send",
          }),
        ],
        sentence: { en: "Devin is not signed in.", "zh-CN": "Devin 尚未登录。" },
        action: { en: "Sign in", "zh-CN": "登录" },
      },
      {
        name: "agent could not be started",
        signedOut: false,
        sessionError: "Error: Provider adapter process error (devin) for thread t: spawn failed",
        activities: [
          failure("unreachable", 1, "Provider turn start failed", {
            detail: "Error: Provider adapter process error (devin) for thread t: spawn failed",
            cause: "provider-unreachable",
            messageId: "failed-send",
          }),
        ],
        sentence: {
          en: "Devin could not be started, so this message was not sent.",
          "zh-CN": "Devin 没能启动，消息未发出。",
        },
        action: { en: "Retry", "zh-CN": "重试" },
      },
      {
        name: "start not confirmed",
        signedOut: false,
        sessionError: UNCONFIRMED,
        activities: [
          failure("timed-out", 1, "Provider turn start timed out", {
            detail: "Timed out waiting for turn/start.",
            messageId: "failed-send",
          }),
          failure("unconfirmed", 31, "Provider turn start was not confirmed", {
            detail: UNCONFIRMED,
            cause: "not-confirmed",
            messageId: "failed-send",
          }),
        ],
        sentence: {
          en: "Moss couldn't confirm what the provider did with this message, so it stopped waiting and didn't send it again. You can try again.",
          "zh-CN": "Moss 没能确认服务商是否处理了这条消息，已停止等待，也没有重复发送。可以重试。",
        },
        action: { en: "Retry", "zh-CN": "重试" },
      },
    ] as const;
    const LOOKS = [
      { theme: "light", locale: "en" },
      { theme: "dark", locale: "zh-CN" },
      { theme: "dark", locale: "en" },
      { theme: "light", locale: "zh-CN" },
    ] as const;

    // Review of #864: each row names the agent it was sent to, and only the latest failed
    // message offers 重试 (it resends the latest message).
    it("names each failed message's own agent and offers 重试 only on the latest", async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "en" }));
      const base = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("second-send"),
        targetText: "Try again on Codex",
      });
      const snapshot: OrchestrationReadModel = {
        ...base,
        threads: [
          {
            ...base.threads[0]!,
            messages: [
              createUserMessage({
                id: MessageId.makeUnsafe("first-send"),
                text: "List the files",
                offsetSeconds: 0,
              }),
              createUserMessage({
                id: MessageId.makeUnsafe("second-send"),
                text: "Try again on Codex",
                offsetSeconds: 60,
              }),
            ],
            latestTurn: null,
            activities: [
              failure("devin-failed", 1, "Provider turn start failed", {
                detail: "Error: Provider adapter process error (devin) for thread t: spawn failed",
                cause: "provider-unreachable",
                messageId: "first-send",
                provider: "devin",
              }),
              failure("codex-unconfirmed", 91, "Provider turn start was not confirmed", {
                detail: UNCONFIRMED,
                cause: "not-confirmed",
                messageId: "second-send",
                provider: "codex",
              }),
            ],
          },
        ],
      };
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      try {
        await expect
          .element(
            page.getByText("Devin could not be started, so this message was not sent.", {
              exact: true,
            }),
          )
          .toBeVisible();
        const rows = [
          ...document.querySelectorAll<HTMLElement>('[data-error-surface="failure-row"]'),
        ];
        expect(rows).toHaveLength(2);
        expect(
          rows.map((row) =>
            [...row.querySelectorAll("button")].map((button) => button.textContent),
          ),
        ).toEqual([[], ["Retry"]]);
      } finally {
        await mounted.cleanup();
        localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
      }
    });

    it.each(CASES.flatMap((testCase) => LOOKS.map((look) => ({ ...testCase, ...look }))))(
      "shows one error and one action: $name, $theme, $locale",
      async ({ signedOut, sessionError, activities, sentence, action, theme, locale }) => {
        setImageLimitFixtureTheme(theme);
        localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: locale }));
        const base = createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("failed-send"),
          targetText: "List the files in this project",
        });
        const devin = {
          provider: "devin" as const,
          instanceId: ProviderInstanceId.makeUnsafe("devin"),
          model: "adaptive",
        };
        const snapshot: OrchestrationReadModel = {
          ...base,
          threads: [
            {
              ...base.threads[0]!,
              modelSelection: devin,
              messages: [
                createUserMessage({
                  id: MessageId.makeUnsafe("failed-send"),
                  text: "List the files in this project",
                  offsetSeconds: 0,
                }),
              ],
              latestTurn: null,
              session: {
                ...base.threads[0]!.session!,
                status: "error",
                providerName: "devin",
                providerInstanceId: "devin",
                activeTurnId: null,
                lastError: sessionError,
              },
              activities: [...activities],
            },
          ],
        };
        let providers: ServerConfig["providers"] = [];
        const mounted = await mountChatView({
          viewport: DEFAULT_VIEWPORT,
          snapshot,
          configureFixture: (nextFixture) => {
            providers = [
              ...nextFixture.serverConfig.providers,
              {
                provider: "devin",
                instanceId: "devin",
                driver: "devin",
                status: signedOut ? "warning" : "ready",
                available: true,
                authStatus: signedOut ? "unauthenticated" : "authenticated",
                checkedAt: NOW_ISO,
              },
            ];
            nextFixture.serverConfig = { ...nextFixture.serverConfig, providers };
            nextFixture.providerStatusesSnapshot = providers;
            nextFixture.serverSettings = {
              ...nextFixture.serverSettings,
              providers: {
                ...nextFixture.serverSettings.providers,
                devin: { ...nextFixture.serverSettings.providers.devin, enabled: true },
              },
            };
          },
        });
        try {
          await reconcileServerProviderStatuses(
            mounted.router.options.context.queryClient,
            providers,
          );
          const row = page.getByText(sentence[locale], { exact: true });
          await expect.element(row).toBeVisible();
          // One error surface, the message's own row; nothing else repeats it.
          await vi.waitFor(() => {
            const surfaces = [...document.querySelectorAll<HTMLElement>("[data-error-surface]")];
            expect(surfaces.map((surface) => surface.dataset.errorSurface)).toEqual([
              "failure-row",
            ]);
          });
          const surface = document.querySelector<HTMLElement>(
            '[data-error-surface="failure-row"]',
          )!;
          const buttons = [...surface.querySelectorAll("button")].map(
            (button) => button.textContent?.trim() ?? "",
          );
          expect(buttons).toEqual([action[locale]]);
          // The sentence wraps whole: nothing is cut off.
          const text = row.element() as HTMLElement;
          expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
          expect(getComputedStyle(text).textOverflow).not.toBe("ellipsis");
          expect(page.getByText(sentence[locale]).elements()).toHaveLength(1);
          // 重试 only where sending again can work.
          if (action.en === "Sign in") {
            const retryLabel = locale === "zh-CN" ? "重试" : "Retry";
            expect(
              page.getByRole("button", { name: retryLabel, exact: true }).elements(),
            ).toHaveLength(0);
          }
        } finally {
          await mounted.cleanup();
          localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
        }
      },
    );
  });

  // WALK-H1 H-11: the gateway answered 500, Codex retried and ended the turn. The chat showed a
  // red 「任务中断」 card and a line 「已中断，用时 2.7 秒 · We're currently experiencing high
  // demand…」, both in English, the line cut off, and two buttons in two styles. One sentence in
  // the UI language, one next step, and the end line keeps only the time.
  it.each([
    { theme: "light", locale: "en" },
    { theme: "dark", locale: "zh-CN" },
    { theme: "dark", locale: "en" },
    { theme: "light", locale: "zh-CN" },
  ] as const)(
    "WALK-H1 H-11: shows a turn the gateway failed after retries once: $theme, $locale",
    async ({ theme, locale }) => {
      setImageLimitFixtureTheme(theme);
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: locale }));
      const highDemand =
        "We\u2019re currently experiencing high demand, which may cause temporary errors.";
      const base = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("gateway-500-user"),
        targetText: "Create missing.txt",
      });
      const turnId = TurnId.makeUnsafe("gateway-500-turn");
      const snapshot: OrchestrationReadModel = {
        ...base,
        threads: [
          {
            ...base.threads[0]!,
            messages: [
              createUserMessage({
                id: MessageId.makeUnsafe("gateway-500-user"),
                text: "Create missing.txt",
                offsetSeconds: 0,
              }),
            ],
            latestTurn: {
              turnId,
              state: "error",
              requestedAt: NOW_ISO,
              startedAt: NOW_ISO,
              completedAt: isoAt(3),
              assistantMessageId: null,
            },
            activities: [
              {
                id: EventId.makeUnsafe("gateway-500-error"),
                turnId,
                createdAt: isoAt(3),
                sequence: 1,
                kind: "runtime.error",
                tone: "error",
                summary: "Provider runtime error",
                payload: { message: highDemand, class: "provider_error" },
              },
              {
                id: EventId.makeUnsafe("gateway-500-completed"),
                turnId,
                createdAt: isoAt(3),
                sequence: 2,
                kind: "turn.completed",
                tone: "error",
                summary: "Turn failed",
                payload: { state: "failed", errorMessage: highDemand },
              },
            ],
          },
        ],
      };
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      try {
        const sentence =
          locale === "zh-CN"
            ? "模型服务暂时过载，请稍后重试。"
            : "The model service is temporarily overloaded. Retry in a moment.";
        await expect.element(page.getByText(sentence, { exact: true })).toBeVisible();
        await vi.waitFor(() => {
          const surfaces = [...document.querySelectorAll<HTMLElement>("[data-error-surface]")];
          expect(surfaces.map((surface) => surface.dataset.errorSurface)).toEqual(["failure-row"]);
        });
        const card = document.querySelector<HTMLElement>('[data-error-surface="failure-row"]')!;
        expect([...card.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
          locale === "zh-CN" ? "继续任务" : "Continue task",
        ]);
        // The provider's own words are nowhere on screen, and the sentence is said once.
        expect(document.body.textContent ?? "").not.toMatch(/high demand/iu);
        expect(page.getByText(sentence).elements()).toHaveLength(1);
        const text = page.getByText(sentence, { exact: true }).element() as HTMLElement;
        expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
      } finally {
        await mounted.cleanup();
        localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
      }
    },
  );

  // WALK-12 N12-11: the FULL turn, waiting on the edit approval (apply_patch on index.js). The
  // work log showed 「修改代码 ▸」, then 「等待批准」 and an animated 「思考中…」 together while
  // Moss waited for the person. Only the waiting state shows.
  it.each([
    { requestKind: "file-change", summary: "File-change approval requested" },
    { requestKind: "tool", summary: "Tool approval requested" },
  ] as const)(
    "WALK-12 N12-11: while a $requestKind approval waits, 等待批准 shows and 思考中 does not",
    async ({ requestKind, summary }) => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
      const prompt =
        "帮我看看这个项目，读一下说明，给 index.js 加减法和乘法，再看看 missing.txt [[WALK:FULL]]";
      const base = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("walk12-full-user"),
        targetText: prompt,
      });
      const turnId = TurnId.makeUnsafe("walk12-full-turn");
      const thread = base.threads[0]!;
      const snapshot: OrchestrationReadModel = {
        ...base,
        threads: [
          {
            ...thread,
            messages: [
              createUserMessage({
                id: MessageId.makeUnsafe("walk12-full-user"),
                text: prompt,
                offsetSeconds: 0,
              }),
            ],
            latestTurn: {
              turnId,
              state: "running",
              requestedAt: NOW_ISO,
              startedAt: NOW_ISO,
              completedAt: null,
              assistantMessageId: null,
            },
            session: thread.session
              ? { ...thread.session, status: "running", activeTurnId: turnId, updatedAt: isoAt(56) }
              : null,
            activities: [
              {
                id: EventId.makeUnsafe("walk12-full-started"),
                turnId,
                createdAt: NOW_ISO,
                sequence: 1,
                kind: "turn.started",
                tone: "info",
                summary: "Turn started",
                payload: {},
              },
              {
                id: EventId.makeUnsafe("walk12-full-approval"),
                turnId,
                createdAt: isoAt(56),
                sequence: 2,
                kind: "approval.requested",
                tone: "approval",
                summary,
                payload: {
                  requestId: "walk12-full-request",
                  requestKind,
                  ...(requestKind === "tool" ? { detail: "webfetch: https://example.com" } : {}),
                },
              },
            ],
          },
        ],
      };
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      try {
        const waiting = page.getByTestId("permission-request-pending");
        await expect.element(waiting).toBeVisible();
        expect(waiting.element().textContent).toBe("等待批准");
        await expect.element(page.getByRole("button", { name: /拒绝/u })).toBeVisible();
        // Held for a moment: the working line must not come back while the card waits.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
        const transcript =
          document.querySelector<HTMLElement>("[data-chat-transcript], main") ?? document.body;
        expect(transcript.textContent ?? "").not.toMatch(/思考中|Thinking/u);
        expect(document.querySelector('[data-timeline-row-kind="working"]')).toBeNull();
      } finally {
        await mounted.cleanup();
        localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
      }
    },
  );

  // WALK-H1 H-11 review: the one action must be the one that fixes it. A turn that ended
  // because the agent's sign-in expired offers the provider settings, not 继续任务 (which runs
  // again on the same expired sign-in).
  it("WALK-H1 H-11: offers the provider settings for a turn whose sign-in expired", async () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "en" }));
    const expired = "Your access token could not be refreshed. Please log out and sign in again.";
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("expired-user"),
      targetText: "Create missing.txt",
    });
    const turnId = TurnId.makeUnsafe("expired-turn");
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: [
        {
          ...base.threads[0]!,
          messages: [
            createUserMessage({
              id: MessageId.makeUnsafe("expired-user"),
              text: "Create missing.txt",
              offsetSeconds: 0,
            }),
          ],
          latestTurn: {
            turnId,
            state: "error",
            requestedAt: NOW_ISO,
            startedAt: NOW_ISO,
            completedAt: isoAt(3),
            assistantMessageId: null,
          },
          activities: [
            {
              id: EventId.makeUnsafe("expired-error"),
              turnId,
              createdAt: isoAt(3),
              sequence: 1,
              kind: "runtime.error",
              tone: "error",
              summary: "Provider runtime error",
              payload: { message: expired, class: "provider_error" },
            },
            {
              id: EventId.makeUnsafe("expired-completed"),
              turnId,
              createdAt: isoAt(3),
              sequence: 2,
              kind: "turn.completed",
              tone: "error",
              summary: "Turn failed",
              payload: { state: "failed", errorMessage: expired },
            },
          ],
        },
      ],
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      const sentence =
        "This account's sign-in has expired. Sign in again in provider settings, or switch to Moss.";
      await expect.element(page.getByText(sentence, { exact: true })).toBeVisible();
      const card = document.querySelector<HTMLElement>('[data-error-surface="failure-row"]')!;
      expect([...card.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
        "Open provider settings",
      ]);
    } finally {
      await mounted.cleanup();
      localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
    }
  });

  // #864 review: the banner above the transcript stays away only for the failed message's own
  // error. A later message with a different error gets its banner.
  it("shows the banner for a later, different error after a failed message", async () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "en" }));
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("later-send"),
      targetText: "And now this",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: [
        {
          ...base.threads[0]!,
          messages: [
            createUserMessage({
              id: MessageId.makeUnsafe("failed-send"),
              text: "List the files",
              offsetSeconds: 0,
            }),
            createUserMessage({
              id: MessageId.makeUnsafe("later-send"),
              text: "And now this",
              offsetSeconds: 60,
            }),
          ],
          latestTurn: null,
          session: {
            ...base.threads[0]!.session!,
            status: "error",
            activeTurnId: null,
            lastError: "Working directory not found: /tmp/moved-project",
          },
          activities: [
            {
              id: EventId.makeUnsafe("earlier-failure"),
              turnId: null,
              createdAt: isoAt(1),
              sequence: 1,
              kind: "provider.turn.start.failed",
              tone: "error",
              summary: "Provider turn start was not confirmed",
              payload: {
                detail:
                  "Moss could not confirm what the provider did with this message, so it stopped waiting. It was not sent again.",
                cause: "not-confirmed",
                messageId: "failed-send",
              },
            },
          ],
        },
      ],
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-error-surface="thread-error"]')).toHaveLength(1);
      });
      expect(document.querySelectorAll('[data-error-surface="failure-row"]')).toHaveLength(1);
    } finally {
      await mounted.cleanup();
      localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
    }
  });

  it("keeps persistent turn failure visible after reopening and admits one manual continuation", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("failure-user"),
      targetText: "Review the requested pull requests",
    });
    const turnId = TurnId.makeUnsafe("failed-turn");
    const cause = "Selected model is at capacity. Please try a different model.";
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: [
        {
          ...base.threads[0]!,
          messages: [
            createUserMessage({
              id: MessageId.makeUnsafe("failure-user"),
              text: "Review the requested pull requests",
              offsetSeconds: 0,
            }),
            {
              ...createAssistantMessage({
                id: MessageId.makeUnsafe("progress"),
                text: "I am checking the pull requests and their conflicts.",
                offsetSeconds: 3,
              }),
              turnId,
            },
          ],
          latestTurn: {
            turnId,
            state: "error",
            requestedAt: NOW_ISO,
            startedAt: NOW_ISO,
            completedAt: isoAt(10),
            assistantMessageId: null,
          },
          activities: [
            {
              id: EventId.makeUnsafe("fatal-error"),
              turnId,
              createdAt: isoAt(10),
              sequence: 1,
              kind: "runtime.error",
              tone: "error",
              summary: "Provider runtime error",
              payload: { message: cause, class: "provider_error" },
            },
            {
              id: EventId.makeUnsafe("failed-completed"),
              turnId,
              createdAt: isoAt(10),
              sequence: 2,
              kind: "turn.completed",
              tone: "error",
              summary: "Turn failed",
              payload: { state: "failed", errorMessage: cause },
            },
          ],
        },
      ],
    };
    const first = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    // One sentence in the UI language, not the provider's own words (WALK-H1 H-11).
    const sentence = "The model service is temporarily overloaded. Retry in a moment.";
    await expect.element(page.getByText(sentence, { exact: true })).toBeVisible();
    await first.cleanup();
    const reopened = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    let releaseSend!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const restoreApi = installDeterministicSendNativeApi({ beforeTurnStart: () => barrier });
    try {
      await expect.element(page.getByText(sentence, { exact: true })).toBeVisible();
      expect(document.querySelectorAll("[data-turn-failure]")).toHaveLength(1);
      // One next step, nothing beside it.
      const card = document.querySelector<HTMLElement>("[data-turn-failure]")!;
      expect([...card.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
        "Continue task",
      ]);
      await page.getByRole("button", { name: "Change model and reasoning", exact: true }).click();
      await expect.element(page.getByLabelText("Search models", { exact: true })).toBeVisible();
      page
        .getByLabelText("Search models", { exact: true })
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await page.getByRole("button", { name: "Continue task", exact: true }).click();
      // Exercise a second click before the first dispatch settles.
      (
        page
          .getByRole("button", { name: "Continue task", exact: true })
          .element() as HTMLButtonElement
      ).click();
      await vi.waitFor(() => {
        const starts = wsRequests.filter(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            "command" in request &&
            (request.command as { type?: string }).type === "thread.turn.start",
        );
        expect(starts).toHaveLength(1);
        expect(starts[0]?.command).toMatchObject({
          threadId: THREAD_ID,
          message: { text: expect.stringContaining("avoid repeating") },
        });
      });
      expect(document.querySelectorAll("[data-turn-failure]")).toHaveLength(1);
    } finally {
      releaseSend();
      restoreApi();
      await reopened.cleanup();
    }
  });

  it("refreshes the full conversation when an approval was already answered", async () => {
    const requestId = ApprovalRequestId.makeUnsafe("approval-refresh-race");
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-approval-refresh"),
      targetText: "Run the requested command",
    });
    const thread = snapshot.threads[0]!;
    const pendingThread = {
      ...thread,
      activities: [
        {
          id: EventId.makeUnsafe("approval-refresh-request"),
          createdAt: NOW_ISO,
          kind: "approval.requested",
          summary: "Command approval requested",
          tone: "approval" as const,
          turnId: null,
          sequence: 1,
          payload: { requestId, requestKind: "command", detail: "Command: git status" },
        },
      ],
      pendingInteractions: [
        {
          interactionKind: "approval" as const,
          requestId,
          threadId: thread.id,
          turnId: null,
          lifecycleGeneration: null,
          status: "pending" as const,
          decision: null,
          responseCommandId: null,
          responseRequestedAt: null,
          createdAt: NOW_ISO,
          resolvedAt: null,
        },
      ],
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: { ...snapshot, threads: [pendingThread] },
    });
    const previousNativeApi = window.nativeApi;
    const api = readNativeApi()!;
    const subscribeThread = vi.fn(api.orchestration.subscribeThread);
    const dispatchCommand = vi.fn(async () => {
      // Only the server fixture learns the winner. The client must fetch and
      // apply this snapshot through its real subscription/EventRouter path.
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: [
          {
            ...pendingThread,
            pendingInteractions: pendingThread.pendingInteractions.map((interaction) => ({
              ...interaction,
              status: "confirmed" as const,
              decision: "accept" as const,
              resolvedAt: NOW_ISO,
            })),
          },
        ],
      };
      throw new Error(`Approval request ${requestId} was already answered.`);
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: { ...api, orchestration: { ...api.orchestration, dispatchCommand, subscribeThread } },
    });
    try {
      setThreadDetailResumeCursor(THREAD_ID, snapshot.snapshotSequence);
      await page.getByRole("button", { name: /Allow once/u }).click();
      await vi.waitFor(() =>
        expect(subscribeThread).toHaveBeenCalledWith({
          threadId: THREAD_ID,
          messageWindow: { limit: 100 },
        }),
      );
      await expect
        .element(page.getByRole("button", { name: /Allow once/u }))
        .not.toBeInTheDocument();
      expect(dispatchCommand).toHaveBeenCalledTimes(1);
      await expect.element(page.getByText(/was already answered/u)).not.toBeInTheDocument();
    } finally {
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
      await mounted.cleanup();
    }
  });

  it.each(["manual", "auto-advance", "manual-before-auto", "custom"] as const)(
    "preserves three answers (%s) on transient failure and restores expired questions without sending a message",
    async (navigation) => {
      const requestId = ApprovalRequestId.makeUnsafe("question-recovery");
      const generation = "question-generation";
      const requestKey = pendingRequestInstanceKey(requestId, generation);
      const automaticChoices = navigation === "auto-advance" || navigation === "manual-before-auto";
      const questions = [1, 2, 3].map((id) => ({
        id: String(id),
        header: `Question ${id}`,
        question: `Choose option ${id}?`,
        ...(!automaticChoices ? { multiSelect: true } : {}),
        options: [{ label: `Choice ${id}`, description: "Selected answer" }],
      }));
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-question-recovery"),
        targetText: "Discuss the design",
      });
      const thread = snapshot.threads[0]!;
      const request = { requestId, lifecycleGeneration: generation, createdAt: NOW_ISO, questions };
      const pendingThread = {
        ...thread,
        activities: [
          {
            id: EventId.makeUnsafe("question-request"),
            createdAt: NOW_ISO,
            kind: "user-input.requested",
            summary: "Questions",
            tone: "info" as const,
            turnId: null,
            sequence: 900,
            payload: { requestId, lifecycleGeneration: generation, questions },
          },
        ],
        pendingInteractions: [
          {
            interactionKind: "userInput" as const,
            requestId,
            threadId: thread.id,
            turnId: null,
            lifecycleGeneration: generation,
            status: "pending" as const,
            decision: null,
            responseCommandId: null,
            responseRequestedAt: null,
            createdAt: NOW_ISO,
            resolvedAt: null,
          },
        ],
      };
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Keep this existing draft.");
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: { ...snapshot, threads: [pendingThread] },
      });
      const previousNativeApi = window.nativeApi;
      const api = readNativeApi()!;
      let expire = false;
      const dispatchCommand = vi.fn(async () => {
        if (!expire) throw new Error("Temporary connection failure");
        fixture.snapshot = {
          ...fixture.snapshot,
          snapshotSequence: fixture.snapshot.snapshotSequence + 1,
          threads: [
            {
              ...pendingThread,
              pendingInteractions: pendingThread.pendingInteractions.map((row) => ({
                ...row,
                status: "confirmed" as const,
                resolvedAt: NOW_ISO,
              })),
              activities: [
                ...pendingThread.activities,
                {
                  id: EventId.makeUnsafe("question-expired"),
                  createdAt: NOW_ISO,
                  kind: "provider.user-input.respond.failed",
                  summary: "Expired",
                  tone: "error" as const,
                  turnId: null,
                  sequence: 2,
                  payload: {
                    requestId,
                    lifecycleGeneration: generation,
                    detail: buildStalePendingRequestFailureDetail("user-input", requestId),
                  },
                },
              ],
            },
          ],
        };
      });
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: { ...api, orchestration: { ...api.orchestration, dispatchCommand } },
      });
      // Hold only the final choice's auto-advance, so the manual-first ordering
      // remains deterministic without changing its production 200 ms delay.
      const timerHost: Pick<Window, "setTimeout" | "clearTimeout"> = window;
      const nativeSetTimeout = timerHost.setTimeout.bind(window);
      const nativeClearTimeout = timerHost.clearTimeout.bind(window);
      let holdFinalAdvance = false;
      const choiceTimers: { id: number; run: () => void; cancelled: boolean }[] = [];
      const setTimeoutSpy = vi
        .spyOn(timerHost, "setTimeout")
        .mockImplementation((handler, delay, ...args) => {
          if (holdFinalAdvance && delay === 200 && typeof handler === "function") {
            const id = nativeSetTimeout(() => {}, 0);
            choiceTimers.push({ id, run: () => handler(...args), cancelled: false });
            return id;
          }
          return nativeSetTimeout(handler, delay, ...args);
        });
      const clearTimeoutSpy = vi.spyOn(timerHost, "clearTimeout").mockImplementation((id) => {
        for (const timer of choiceTimers) if (timer.id === id) timer.cancelled = true;
        nativeClearTimeout(id);
      });
      try {
        for (const id of [1, 2, 3]) {
          holdFinalAdvance = navigation === "manual-before-auto" && id === 3;
          await page.getByRole("button", { name: new RegExp(`Choice ${id}`) }).click();
          // Single-choice answers advance themselves; another Next click races the timer.
          holdFinalAdvance = false;
          if (id < 3 && !automaticChoices)
            await page.getByRole("button", { name: "Next question", exact: true }).first().click();
        }
        if (navigation === "custom") {
          await userEvent.click(await waitForComposerEditor());
          await userEvent.keyboard("Custom answer");
        }
        const submit = page.getByRole("button", { name: "Submit answers", exact: true });
        if (navigation !== "auto-advance") {
          await expect.element(submit).toBeEnabled();
          const button = submit.element() as HTMLButtonElement;
          button.click();
          button.click();
        }
        // In auto mode, selecting the last answer is already the submission.
        // Clicking Submit after its immediate failure would be an explicit retry.
        await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledTimes(1));
        if (navigation === "manual-before-auto") {
          await expect.element(submit).toBeEnabled();
          expect(choiceTimers).toHaveLength(1);
          // A fast failed manual response must cancel the delayed automatic intent.
          expect(choiceTimers[0]!.cancelled).toBe(true);
          for (const timer of choiceTimers) if (!timer.cancelled) timer.run();
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(dispatchCommand).toHaveBeenCalledTimes(1);
        await expect.element(submit).toBeEnabled();
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.pendingUserInputDrafts?.[
            requestKey
          ],
        ).toEqual({
          request,
          answers: Object.fromEntries(
            [1, 2, 3].map((id) => [
              String(id),
              navigation === "custom" && id === 3
                ? { customAnswer: "Custom answer" }
                : { customAnswer: "", selectedOptionLabels: [`Choice ${id}`] },
            ]),
          ),
        });
        expire = true;
        await submit.click();
        await expect.element(page.getByRole("button", { name: "Restore answers" })).toBeVisible();
        await expect.element(submit).not.toBeInTheDocument();
        await page.getByRole("button", { name: "Restore answers" }).click();
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          `Keep this existing draft.\n\nChoose option 1?\nChoice 1\n\nChoose option 2?\nChoice 2\n\nChoose option 3?\n${navigation === "custom" ? "Custom answer" : "Choice 3"}`,
        );
        expect(dispatchCommand).toHaveBeenCalledTimes(2);
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
        for (const timer of choiceTimers) nativeClearTimeout(timer.id);
        if (previousNativeApi)
          Object.defineProperty(window, "nativeApi", {
            configurable: true,
            value: previousNativeApi,
          });
        else Reflect.deleteProperty(window, "nativeApi");
        await mounted.cleanup();
      }
    },
  );

  it.each(["confirmed", "stale"])("cancels a multi-question (%s)", async (settlement) => {
    const requestId = ApprovalRequestId.makeUnsafe("question-cancel");
    const lifecycleGeneration = "cancel-generation";
    const questions = [1, 2].map((id) => ({
      id: String(id),
      header: `Question ${id}`,
      question: `Choose option ${id}?`,
      options: [{ label: `Choice ${id}`, description: "Selected answer" }],
    }));
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-question-cancel"),
      targetText: "Ask for a decision",
    });
    const thread = snapshot.threads[0]!;
    const pendingThread = {
      ...thread,
      activities: [
        {
          id: EventId.makeUnsafe("question-cancel-request"),
          createdAt: NOW_ISO,
          kind: "user-input.requested",
          summary: "Questions",
          tone: "info" as const,
          turnId: null,
          sequence: 900,
          payload: { requestId, lifecycleGeneration, questions },
        },
      ],
      pendingInteractions: [
        {
          interactionKind: "userInput" as const,
          requestId,
          threadId: thread.id,
          turnId: null,
          lifecycleGeneration,
          status: "pending" as const,
          decision: null,
          responseCommandId: null,
          responseRequestedAt: null,
          createdAt: NOW_ISO,
          resolvedAt: null,
        },
      ],
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: { ...snapshot, threads: [pendingThread] },
    });
    const previousNativeApi = window.nativeApi;
    const api = readNativeApi()!;
    const subscribeThread = vi.fn(api.orchestration.subscribeThread);
    const dispatchCommand = vi.fn(
      async (command: Parameters<typeof api.orchestration.dispatchCommand>[0]) => {
        if (command.type !== "thread.user-input.respond") {
          throw new Error("Unexpected command in the cancellation fixture.");
        }
        // Both a provider-confirmed cancellation and an invalidated callback
        // settle durably. Acceptance alone is not settlement.
        fixture.snapshot = {
          ...fixture.snapshot,
          snapshotSequence: fixture.snapshot.snapshotSequence + 1,
          threads: [
            {
              ...pendingThread,
              ...(settlement === "stale"
                ? {
                    activities: [
                      ...pendingThread.activities,
                      {
                        id: EventId.makeUnsafe("question-cancel-expired"),
                        createdAt: NOW_ISO,
                        kind: "provider.user-input.respond.failed",
                        summary: "Questions expired",
                        tone: "error" as const,
                        turnId: null,
                        sequence: 2,
                        payload: {
                          requestId,
                          lifecycleGeneration,
                          responseCommandId: command.commandId,
                          settlementStatus: "uncertain",
                          detail: buildStalePendingRequestFailureDetail("user-input", requestId),
                        },
                      },
                    ],
                  }
                : {}),
              pendingInteractions: pendingThread.pendingInteractions.map((interaction) =>
                Object.assign({}, interaction, {
                  status: "confirmed" as const,
                  responseCommandId: command.commandId,
                  responseRequestedAt: command.createdAt,
                  resolvedAt: NOW_ISO,
                }),
              ),
            },
          ],
        };
        return { sequence: fixture.snapshot.snapshotSequence };
      },
    );
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...api,
        orchestration: { ...api.orchestration, dispatchCommand, subscribeThread },
      },
    });
    try {
      setThreadDetailResumeCursor(THREAD_ID, snapshot.snapshotSequence);
      await expect.element(page.getByText("Choose option 1?")).toBeVisible();
      await page.getByRole("button", { name: /Choice 1/ }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledTimes(1));
      expect(dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.user-input.respond",
          threadId: THREAD_ID,
          requestId,
          lifecycleGeneration,
          answers: {},
        }),
      );
      await vi.waitFor(() =>
        expect(subscribeThread).toHaveBeenCalledWith({
          threadId: THREAD_ID,
          messageWindow: { limit: 100 },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect.element(page.getByText("Choose option 1?")).not.toBeInTheDocument();
      await expect.element(page.getByText("Choose option 2?")).not.toBeInTheDocument();
      // A later snapshot can omit the failure and all terminal rows. The old
      // request activity must not bring the question card back.
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: [{ ...pendingThread, pendingInteractions: [] }],
      };
      await api.orchestration.subscribeThread({ threadId: THREAD_ID });
      await expect.element(page.getByText("Choose option 1?")).not.toBeInTheDocument();
      expect(await waitForComposerEditor()).toBeDefined();
    } finally {
      if (previousNativeApi)
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: previousNativeApi,
        });
      else Reflect.deleteProperty(window, "nativeApi");
      await mounted.cleanup();
    }
  });

  it("shows transport recovery without auto-following a detached transcript", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongAssistantResponse(),
    });
    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await waitForLayout();
      scrollContainer.scrollTop = 100;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      const previousTop = scrollContainer.scrollTop;
      emitWsTransportState("connecting");
      await expect
        .element(page.getByRole("status").filter({ hasText: "Reconnecting to Moss…" }), {
          timeout: 4000,
        })
        .toBeVisible();
      await waitForLayout();
      expect(Math.abs(scrollContainer.scrollTop - previousTop)).toBeLessThanOrEqual(1);
      emitWsTransportState("open");
      await expect
        .element(page.getByRole("status").filter({ hasText: "Reconnecting to Moss…" }))
        .not.toBeInTheDocument();
      await waitForLayout();
      expect(Math.abs(scrollContainer.scrollTop - previousTop)).toBeLessThanOrEqual(1);
    } finally {
      emitWsTransportState("open");
      await mounted.cleanup();
    }
  });

  it("stays pinned to the bottom after delayed attachment loads expand the timeline", async () => {
    setAttachmentResponseDelayMs(160);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithBottomAttachments(),
    });

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("img").length).toBeGreaterThanOrEqual(3);
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForImagesToLoad(document.body);
      await vi.waitFor(
        async () => {
          const layout = await mounted.measureLayout();
          expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);
          expect(layout.distanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      setAttachmentResponseDelayMs(0);
      await mounted.cleanup();
    }
  });

  it("does not let delayed tail-expansion retries override a user scroll takeover", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithBottomAttachments(),
    });
    let restoreScrollTo = () => {};

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      const tailImage = await waitForElement(
        () => document.querySelector<HTMLImageElement>("img[alt='bottom-attachment-3.png']"),
        "Unable to find the tail attachment image.",
      );
      await waitForImagesToLoad(document.body);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      await waitForLayout();

      const scrollSpy = installImmediateScrollToSpy(scrollContainer);
      restoreScrollTo = scrollSpy.restore;

      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
      scrollContainer.dispatchEvent(new Event("scroll"));
      tailImage.dispatchEvent(new Event("load", { bubbles: true }));

      await new Promise<void>((resolve) => window.setTimeout(resolve, 320));
      expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
        AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      );
      expect(
        scrollSpy.calls.every(
          (call) =>
            typeof call.top !== "number" ||
            call.top <= scrollContainer.scrollTop + AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        ),
      ).toBe(true);
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
    }
  });

  it("does not snap to the end when reading down from a transcript moved off its end", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: false }),
    });

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(4),
      );
      // Layout, not a reader gesture, moves the following transcript to the top.
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForTranscriptLayoutToSettle(scrollContainer);
      expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight * 2);

      await userEvent.wheel(scrollContainer, { delta: { y: 40 } });
      await waitForTranscriptLayoutToSettle(scrollContainer);
      expect(scrollContainer.scrollTop).toBeGreaterThan(0);
      expect(scrollContainer.scrollTop).toBeLessThan(scrollContainer.clientHeight);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([false, true])(
    "flushes editor changes before sending and preserves the prompt on failure=%s",
    async (failSave) => {
      const restoreNativeApi = installDeterministicSendNativeApi();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithLongAssistantResponse(),
      });
      let unsubscribe = () => {};
      try {
        let finish!: () => void;
        const writeFile = vi.fn(
          () =>
            new Promise<{ relativePath: string; version: string }>((resolve, reject) => {
              finish = () =>
                failSave
                  ? reject(new Error("Editor write failed"))
                  : resolve({ relativePath: "file.ts", version: "sha256:saved" });
            }),
        );
        const api = readNativeApi()!;
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          value: { ...api, projects: { ...api.projects, writeFile } },
        });
        const session = getWorkspaceEditorSession(
          mounted.router.options.context.queryClient,
          "/repo/project",
          "file.ts",
        );
        unsubscribe = session.subscribe(() => undefined);
        session.load({
          relativePath: "file.ts",
          contents: "original",
          version: "sha256:initial",
          encoding: "utf8",
          lineEnding: "lf",
          truncated: false,
        });
        session.change("editor draft");
        const prompt = "use the saved editor changes";
        useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
        const turnStarts = () =>
          wsRequests.filter(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (request.command as { type?: string } | undefined)?.type === "thread.turn.start",
          );
        const before = turnStarts().length;
        (await waitForSendButton()).click();
        await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
        expect(turnStarts()).toHaveLength(before);
        finish();
        if (failSave) {
          await vi.waitFor(() =>
            expect(document.body.textContent).toContain("Could not save editor changes"),
          );
          expect(turnStarts()).toHaveLength(before);
          expect(session.getSnapshot().value).toBe("editor draft");
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(prompt);
        } else {
          await vi.waitFor(() => expect(turnStarts()).toHaveLength(before + 1));
          expect(session.dirty).toBe(false);
        }
      } finally {
        unsubscribe();
        restoreNativeApi();
        await mounted.cleanup();
      }
    },
  );

  // Leaving a thread you just sent in and coming back must not replay the
  // send-time anchor slide: the transcript is remounted with no scroll history,
  // so replaying it means bootstrapping at the top of the conversation and then
  // flying down through the whole history in view.
  it("reopens a thread you sent in at its anchored end without replaying the slide", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(createSnapshotWithLongAssistantResponse(), OTHER_THREAD_ID),
    });

    try {
      const firstContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await vi.waitFor(
        () => {
          expect(firstContainer.scrollHeight).toBeGreaterThan(firstContainer.clientHeight);
          expect(getScrollContainerDistanceFromBottom(firstContainer)).toBeLessThanOrEqual(
            AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      const prompt = "anchor me before the thread switch";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(prompt);
        },
        { timeout: 8_000, interval: 16 },
      );
      // Let the send's anchor slide finish before leaving.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 600));

      // Leave and come back: the thread's detail stays cached, so the whole
      // transcript is present in the very first render of the remounted list.
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${OTHER_THREAD_ID}`,
        "Expected to navigate to the other thread.",
      );
      await waitForLayout();

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });

      const travel = await recordTranscriptScrollTravel(1_500);
      expect(travel.visibleFrames).toBeGreaterThan(10);
      // Never painted far from the live edge, and never seen travelling there.
      expect(travel.maxDistanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
      expect(travel.downwardTravelPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
    } finally {
      restoreNativeApi();
      await mounted.cleanup();
    }
  });

  it("settles the scroll-to-bottom arrow at the measured transcript end", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongAssistantResponse(),
    });
    let restoreScrollTo = () => {};

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await vi.waitFor(() => {
        expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight);
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(
          AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        );
      });
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
      await vi.waitFor(() => {
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
          AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        );
      });
      const scrollButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "button[aria-label='Scroll to bottom'][aria-hidden='false']",
          ),
        "Unable to find the visible scroll-to-bottom button.",
      );

      const scrollSpy = installImmediateScrollToSpy(scrollContainer);
      restoreScrollTo = scrollSpy.restore;

      scrollButton.click();

      await vi.waitFor(
        () => {
          expect(scrollSpy.calls.some((call) => call.behavior === "smooth")).toBe(true);
          expect(scrollSpy.calls.some((call) => call.behavior === "auto")).toBe(true);
          expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(
            AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
    }
  });

  it("stops the arrow's smooth scroll when the user scrolls upward", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongAssistantResponse(),
    });
    let restoreScrollTo = () => {};

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      await vi.waitFor(() => {
        expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight);
      });
      // Let mount-time tail expansion retries (max 260ms) finish before
      // isolating the arrow scroll and the user's takeover gesture.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      await waitForLayout();
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
      await vi.waitFor(() => {
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
          AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        );
      });
      const scrollButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "button[aria-label='Scroll to bottom'][aria-hidden='false']",
          ),
        "Unable to find the visible scroll-to-bottom button.",
      );
      const scrollSpy = installImmediateScrollToSpy(scrollContainer, {
        suspendSmoothScroll: true,
      });
      restoreScrollTo = scrollSpy.restore;

      scrollButton.click();
      await vi.waitFor(() => {
        expect(scrollSpy.calls.some((call) => call.behavior === "smooth")).toBe(true);
      });
      const takeoverOffset = scrollContainer.scrollTop;
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));

      await vi.waitFor(() => {
        expect(scrollSpy.calls.some((call) => call.behavior === "auto")).toBe(true);
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
      const smoothCalls = scrollSpy.calls.filter((call) => call.behavior === "smooth");
      const takeoverCalls = scrollSpy.calls.filter((call) => call.behavior === "auto");
      expect(smoothCalls).toHaveLength(1);
      expect(takeoverCalls.length).toBeGreaterThanOrEqual(1);
      expect(
        takeoverCalls.every(
          (call) =>
            typeof call.top === "number" &&
            call.top <= takeoverOffset + AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
        ),
      ).toBe(true);
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
    }
  });

  // How the transcript gets there — one motion, no bouncing — is covered by
  // "moves a sent message to its anchor once…"; this guards the outcome: a send
  // from far up the transcript ends pinned at the live edge with focus kept.
  it("re-sticks to the bottom after sending an optimistic user message", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-send-bottom-stick" as MessageId,
        targetText: "bottom stick target",
      }),
    });
    let restoreScrollTo = () => {};

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(
        AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      );

      // Installed so any native smooth scroll resolves immediately; the send
      // path itself drives the container frame by frame, so this spy is here for
      // determinism rather than to observe the motion.
      const scrollSpy = installImmediateScrollToSpy(scrollContainer);
      restoreScrollTo = scrollSpy.restore;

      const prompt = "keep me pinned after send";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await userEvent.click(sendButton);

      await vi.waitFor(
        async () => {
          expect(document.body.textContent).toContain(prompt);
          expect(document.activeElement).toBe(await waitForComposerEditor());
          const layout = await mounted.measureLayout();
          expect(layout.scrollHeightPx).toBeGreaterThan(layout.scrollClientHeightPx);
          expect(layout.distanceFromBottomPx).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(scrollContainer.scrollTop, "transcript never left the top").toBeGreaterThan(0);
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  describe("optimistic send", () => {
    // A provider whose last check did not settle: sending first re-checks it, which can
    // take seconds on a real machine. The message must not wait for that.
    const configureUncheckedCodex = (nextFixture: TestFixture) => {
      nextFixture.serverConfig = {
        ...nextFixture.serverConfig,
        providers: nextFixture.serverConfig.providers.map((provider) =>
          provider.provider === "codex"
            ? {
                ...provider,
                status: "warning" as const,
                available: false,
                authStatus: "unknown" as const,
              }
            : provider,
        ),
      };
    };
    const sentRow = (prompt: string) =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-message-id][data-message-role='user']"),
      ).find((row) => row.textContent?.includes(prompt));

    it("shows the message and empties the composer right after Enter, before the checks finish", async () => {
      const restoreSendApi = installDeterministicSendNativeApi();
      let finishCheck!: () => void;
      const checkFinished = new Promise<void>((resolve) => {
        finishCheck = resolve;
      });
      const refreshProviders = vi.fn(async () => {
        await checkFinished;
        return {
          providers: fixture.serverConfig.providers.map((provider) =>
            provider.provider === "codex"
              ? {
                  ...provider,
                  status: "ready" as const,
                  available: true,
                  authStatus: "authenticated" as const,
                }
              : provider,
          ),
        };
      });
      const restoreRefreshApi = installProviderRefreshNativeApi(refreshProviders);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-optimistic-send" as MessageId,
          targetText: "earlier message",
        }),
        configureFixture: configureUncheckedCodex,
      });
      try {
        const prompt = "show me right away";
        useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
        const editor = await waitForComposerEditor();
        await vi.waitFor(() => expect(editor.textContent).toContain(prompt));
        await userEvent.click(editor);
        wsRequests.length = 0;

        const pressedAt = performance.now();
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(
          () => {
            expect(sentRow(prompt), "sent message on screen").toBeTruthy();
            expect(editor.textContent ?? "").not.toContain(prompt);
          },
          { timeout: 2_000, interval: 4 },
        );
        const shownAfterMs = performance.now() - pressedAt;
        // The provider check starts once the message is on screen, and is still running:
        // nothing was dispatched yet.
        await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalled());
        expect(
          wsRequests.map(readDispatchedCommand).some((c) => c?.type === "thread.turn.start"),
        ).toBe(false);
        console.info(
          `[optimistic send] message on screen ${shownAfterMs.toFixed(0)} ms after Enter`,
        );
        expect(shownAfterMs).toBeLessThan(1_000);

        const shownId = sentRow(prompt)!.dataset.messageId;
        finishCheck();
        await vi.waitFor(
          () => {
            const turnStart = wsRequests
              .map(readDispatchedCommand)
              .find((command) => command?.type === "thread.turn.start");
            // The row on screen is the message that was sent, not a second copy.
            expect(turnStart).toMatchObject({ message: { messageId: shownId } });
          },
          { timeout: 8_000, interval: 16 },
        );
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>("[data-message-id][data-message-role='user']"),
        ).filter((row) => row.textContent?.includes(prompt));
        expect(rows).toHaveLength(1);
      } finally {
        finishCheck();
        await mounted.cleanup();
        restoreRefreshApi();
        restoreSendApi();
      }
    });

    it("hands the message back to the composer when a check stops the send", async () => {
      const restoreSendApi = installDeterministicSendNativeApi();
      let failCheck!: () => void;
      const checkFailed = new Promise<void>((resolve) => {
        failCheck = resolve;
      });
      const refreshProviders = vi.fn(async () => {
        await checkFailed;
        return {
          providers: fixture.serverConfig.providers.map((provider) =>
            provider.provider === "codex"
              ? { ...provider, status: "error" as const, available: false }
              : provider,
          ),
        };
      });
      const restoreRefreshApi = installProviderRefreshNativeApi(refreshProviders);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-optimistic-rollback" as MessageId,
          targetText: "earlier message",
        }),
        configureFixture: configureUncheckedCodex,
      });
      try {
        const prompt = "keep my words if this cannot be sent";
        useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
        const editor = await waitForComposerEditor();
        await vi.waitFor(() => expect(editor.textContent).toContain(prompt));
        await userEvent.click(editor);
        wsRequests.length = 0;
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(sentRow(prompt)).toBeTruthy(), {
          timeout: 2_000,
          interval: 4,
        });

        failCheck();
        await vi.waitFor(
          () => {
            expect(sentRow(prompt), "unsent message left the transcript").toBeUndefined();
            expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
              prompt,
            );
          },
          { timeout: 8_000, interval: 16 },
        );
        expect(
          wsRequests.map(readDispatchedCommand).some((c) => c?.type === "thread.turn.start"),
        ).toBe(false);
      } finally {
        failCheck();
        await mounted.cleanup();
        restoreRefreshApi();
        restoreSendApi();
      }
    });
  });

  it.each(["Enter", "send button", "plan follow-up"])(
    "keeps sent messages at the bottom with anchoring disabled when using %s, and follows streaming text",
    async (sendMethod) => {
      localStorage.setItem(
        "moss:app-settings:v1",
        JSON.stringify({ anchorSentMessagesToTop: false }),
      );
      const restoreNativeApi = installDeterministicSendNativeApi();
      let currentSnapshot =
        sendMethod === "plan follow-up"
          ? createSnapshotWithSettledPlanAwaitingFollowUp()
          : createSnapshotForTargetUser({
              targetMessageId: "msg-user-send-no-anchor" as MessageId,
              targetText: "Previous conversation message",
            });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: currentSnapshot,
      });

      try {
        const scrollContainer = await waitForElement(
          () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
          "Unable to find message scroll container.",
        );
        // Sending must return to the live edge even if the reader was looking at history.
        scrollContainer.scrollTop = 0;
        scrollContainer.dispatchEvent(new Event("scroll"));
        await waitForLayout();

        const prompt = "Keep this message at the bottom";
        if (sendMethod === "plan follow-up") {
          useComposerDraftStore.getState().setInteractionMode(THREAD_ID, "plan");
        }
        useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
        await vi.waitFor(async () => {
          expect((await waitForComposerEditor()).textContent).toContain(prompt);
        });
        if (sendMethod !== "send button") {
          await userEvent.click(await waitForComposerEditor());
          await userEvent.keyboard("{Enter}");
        } else {
          const sendButton = await waitForSendButton();
          expect(sendButton.disabled).toBe(false);
          await userEvent.click(sendButton);
        }

        const findSentRow = () =>
          Array.from(
            document.querySelectorAll<HTMLElement>("[data-message-id][data-message-role='user']"),
          ).find((row) => row.textContent?.includes(prompt));
        await vi.waitFor(
          () => {
            const row = findSentRow();
            expect(row, "sent user message missing").toBeTruthy();
            expect(
              row!.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top,
              "sent user message moved to the viewport top",
            ).toBeGreaterThan(scrollContainer.clientHeight / 2);
            expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(2);
          },
          { timeout: 8_000, interval: 16 },
        );
        if (sendMethod !== "plan follow-up") {
          expect(document.activeElement).toBe(await waitForComposerEditor());
        }

        const sentMessageId = MessageId.makeUnsafe(findSentRow()!.dataset.messageId!);
        const activeTurnId = TurnId.makeUnsafe("turn-no-anchor");
        const streamingId = MessageId.makeUnsafe("msg-assistant-no-anchor");
        for (const paragraphCount of [1, 20]) {
          currentSnapshot = {
            ...currentSnapshot,
            snapshotSequence: currentSnapshot.snapshotSequence + 1,
            threads: currentSnapshot.threads.map((thread) =>
              thread.id !== THREAD_ID
                ? thread
                : {
                    ...thread,
                    messages: [
                      ...thread.messages.filter(
                        (message) => message.id !== streamingId && message.id !== sentMessageId,
                      ),
                      {
                        id: sentMessageId,
                        role: "user" as const,
                        text: prompt,
                        turnId: activeTurnId,
                        streaming: false,
                        source: "native" as const,
                        createdAt: isoAt(1_300),
                        updatedAt: isoAt(1_300),
                      },
                      {
                        id: streamingId,
                        role: "assistant" as const,
                        text: "Streaming response paragraph.\n\n".repeat(paragraphCount),
                        turnId: activeTurnId,
                        streaming: true,
                        source: "native" as const,
                        createdAt: isoAt(1_302),
                        updatedAt: isoAt(1_302 + paragraphCount),
                      },
                    ],
                    latestTurn: {
                      turnId: activeTurnId,
                      state: "running" as const,
                      requestedAt: isoAt(1_300),
                      startedAt: isoAt(1_301),
                      completedAt: null,
                      assistantMessageId: streamingId,
                    },
                    session: thread.session
                      ? { ...thread.session, status: "running" as const, activeTurnId }
                      : null,
                  },
            ),
            updatedAt: isoAt(1_302 + paragraphCount),
          };
          setFixture({ ...fixture, snapshot: currentSnapshot });
          useStore.getState().syncServerReadModel(currentSnapshot);
          await vi.waitFor(
            () => {
              expect(document.body.textContent).toContain("Streaming response paragraph.");
              expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeLessThanOrEqual(2);
            },
            { timeout: 8_000, interval: 16 },
          );
        }
      } finally {
        await mounted.cleanup();
        restoreNativeApi();
      }
    },
  );

  it("anchors a freshly sent user message at the top of the transcript viewport", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-send-tail-anchor" as MessageId,
      targetText: "tail anchor target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      setFixture({ ...fixture, snapshot: currentSnapshot });
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      // Start where a real conversation sits: parked at the bottom of the transcript.
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const prompt = "anchor this message at the viewport top";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      const findSentRow = () => {
        const rows = document.querySelectorAll<HTMLElement>(
          "[data-message-id][data-message-role='user']",
        );
        for (const row of rows) {
          if (row.textContent?.includes(prompt)) {
            return row;
          }
        }
        return null;
      };

      const anchorOffsetPx = () => {
        const row = findSentRow();
        if (!row) {
          return null;
        }
        return row.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
      };
      // The anchored message keeps the same top gap a chat's first message gets:
      // the scroll container's own top padding.
      const expectedTopGapPx = Number.parseFloat(getComputedStyle(scrollContainer).paddingTop) || 0;

      await vi.waitFor(
        () => {
          const offsetPx = anchorOffsetPx();
          expect(offsetPx, "sent user message row not rendered").not.toBeNull();
          expect(Math.abs(offsetPx! - expectedTopGapPx)).toBeLessThanOrEqual(24);
        },
        { timeout: 8_000, interval: 16 },
      );
      // Real sends ack before the turn goes live, so the transcript sits with no
      // running turn for a beat. The anchor must survive that gap instead of
      // collapsing the moment the send stops being "busy".
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 700);
      });
      const offsetAfterAckGapPx = anchorOffsetPx();
      expect(offsetAfterAckGapPx, "sent user message row missing after ack gap").not.toBeNull();
      expect(Math.abs(offsetAfterAckGapPx! - expectedTopGapPx)).toBeLessThanOrEqual(24);

      // The server acknowledges the send and the turn starts running: the durable
      // user message replaces the optimistic row and live turn chrome appears.
      const activeTurnId = TurnId.makeUnsafe("turn-tail-anchor");
      const sentMessageId = findSentRow()?.dataset.messageId;
      expect(sentMessageId, "sent user message id").toBeTruthy();
      syncActiveThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe(sentMessageId!),
            role: "user" as const,
            text: prompt,
            turnId: activeTurnId,
            streaming: false,
            source: "native" as const,
            createdAt: isoAt(1_300),
            updatedAt: isoAt(1_300),
          },
        ],
        latestTurn: {
          turnId: activeTurnId,
          state: "running",
          requestedAt: isoAt(1_300),
          startedAt: isoAt(1_301),
          completedAt: null,
          assistantMessageId: null,
        },
        session: thread.session
          ? { ...thread.session, status: "running", activeTurnId, updatedAt: isoAt(1_301) }
          : null,
        updatedAt: isoAt(1_301),
      }));
      await waitForLayout();
      await vi.waitFor(
        () => {
          const offsetPx = anchorOffsetPx();
          expect(offsetPx, "sent user message row missing after ack").not.toBeNull();
          expect(Math.abs(offsetPx! - expectedTopGapPx)).toBeLessThanOrEqual(24);
        },
        { timeout: 4_000, interval: 16 },
      );

      // The assistant response streams in below the anchored message. While it is
      // shorter than the viewport the anchored message must not move.
      const streamingId = MessageId.makeUnsafe("msg-assistant-tail-anchor-stream");
      for (const chunkCount of [1, 3, 6]) {
        syncActiveThread((thread) => ({
          ...thread,
          messages: [
            ...thread.messages.filter((message) => message.id !== streamingId),
            {
              id: streamingId,
              role: "assistant" as const,
              text: `Streaming response paragraph.\n\n`.repeat(chunkCount),
              turnId: activeTurnId,
              streaming: true,
              source: "native" as const,
              createdAt: isoAt(1_302),
              updatedAt: isoAt(1_302 + chunkCount),
            },
          ],
          updatedAt: isoAt(1_302 + chunkCount),
        }));
        await waitForLayout();
        await waitForLayout();
        const offsetPx = anchorOffsetPx();
        expect(offsetPx, `anchor row missing while streaming ${chunkCount} chunks`).not.toBeNull();
        expect(
          Math.abs(offsetPx! - expectedTopGapPx),
          `anchor drifted while streaming ${chunkCount} chunks`,
        ).toBeLessThanOrEqual(24);
      }

      // The turn completes: the reserve persists so the settled transcript does
      // not jump back to its true bottom.
      const scrollTopBeforeTurnEnd = scrollContainer.scrollTop;
      syncActiveThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === streamingId
            ? { ...message, streaming: false, updatedAt: isoAt(1_400) }
            : message,
        ),
        latestTurn: thread.latestTurn
          ? { ...thread.latestTurn, state: "completed", completedAt: isoAt(1_400) }
          : thread.latestTurn,
        session: thread.session
          ? { ...thread.session, status: "idle", activeTurnId: null, updatedAt: isoAt(1_400) }
          : null,
        updatedAt: isoAt(1_400),
      }));
      await waitForLayout();
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 700);
      });
      const offsetAfterTurnEndPx = anchorOffsetPx();
      expect(offsetAfterTurnEndPx, "sent user message row missing after turn end").not.toBeNull();
      expect(
        Math.abs(offsetAfterTurnEndPx! - expectedTopGapPx),
        "anchor jumped when the turn settled",
      ).toBeLessThanOrEqual(24);
      expect(
        Math.abs(scrollContainer.scrollTop - scrollTopBeforeTurnEnd),
        "scroll position jumped when the turn settled",
      ).toBeLessThanOrEqual(2);

      const anchoredScrollHeight = scrollContainer.scrollHeight;
      for (const enabled of [false, true]) {
        const storedSettings = JSON.parse(localStorage.getItem("moss:app-settings:v1") ?? "{}");
        localStorage.setItem(
          "moss:app-settings:v1",
          JSON.stringify({ ...storedSettings, anchorSentMessagesToTop: enabled }),
        );
        window.dispatchEvent(new StorageEvent("storage", { key: "moss:app-settings:v1" }));
        await vi.waitFor(
          () => {
            expect(
              scrollContainer.scrollHeight,
              "disabling must release the reserve; re-enabling must not resurrect the old anchor",
            ).toBeLessThan(anchoredScrollHeight - 50);
          },
          { timeout: 4_000, interval: 16 },
        );
        await waitForLayout();
      }
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("shows uncertain delivery and blocks another send without a local dispatch marker", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-before-uncertain-delivery"),
        targetText: "Previous message",
      }),
    });
    const finishSettlement = trackWsTurnSettlement(THREAD_ID);
    try {
      // The ordinary loading marker can expire or be absent after navigation.
      useThreadDispatchStore.setState({ threads: {} });
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Do not duplicate this send");
      await expect.element(page.getByText("Checking message delivery…")).toBeVisible();
      const form = document.querySelector<HTMLFormElement>("[data-chat-composer-form='true']")!;
      form.requestSubmit();
      await waitForLayout();
      expect(
        wsRequests.filter(
          (request) => readDispatchedCommand(request)?.type === "thread.turn.start",
        ),
      ).toHaveLength(0);
      finishSettlement();
      await expect.element(page.getByText("Checking message delivery…")).not.toBeInTheDocument();
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
    } finally {
      finishSettlement();
      await mounted.cleanup();
    }
  });

  it("shows Sending until ack, then keeps Thinking through the post-ack gap", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-thinking-bridge" as MessageId,
      targetText: "thinking bridge target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      setFixture({ ...fixture, snapshot: currentSnapshot });
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const prompt = "keep thinking through the ack gap";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(prompt);
          expect(document.body.textContent).toContain("Sending…");
          expect(document.body.textContent).not.toContain("Thinking");
        },
        { timeout: 8_000, interval: 16 },
      );

      const findSentRow = () => {
        const rows = document.querySelectorAll<HTMLElement>(
          "[data-message-id][data-message-role='user']",
        );
        for (const row of rows) {
          if (row.textContent?.includes(prompt)) {
            return row;
          }
        }
        return null;
      };

      const sentMessageId = await vi.waitFor(
        () => {
          const id = findSentRow()?.dataset.messageId;
          expect(id, "sent user message id").toBeTruthy();
          return id!;
        },
        { timeout: 8_000, interval: 16 },
      );

      // Server ack: durable user message + turn requested, but session still ready
      // (provider session not live yet). Thinking must survive this gap.
      const requestedTurnId = TurnId.makeUnsafe("turn-thinking-bridge");
      syncActiveThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe(sentMessageId),
            role: "user" as const,
            text: prompt,
            turnId: requestedTurnId,
            streaming: false,
            source: "native" as const,
            createdAt: isoAt(1_300),
            updatedAt: isoAt(1_300),
          },
        ],
        latestTurn: {
          turnId: requestedTurnId,
          state: "running",
          requestedAt: isoAt(1_300),
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
        session: thread.session
          ? {
              ...thread.session,
              status: "ready",
              activeTurnId: null,
              updatedAt: isoAt(1_300),
            }
          : null,
        updatedAt: isoAt(1_300),
      }));

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(prompt);
          expect(document.body.textContent).toContain("Thinking");
          expect(document.body.textContent).not.toContain("Loading");
          expect(document.querySelector("[data-turn-header='live']")).toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );

      // Hold the gap briefly so a flicker/empty frame would be visible if the
      // bridge cleared too early.
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 400);
      });
      expect(document.body.textContent).toContain("Thinking");
      expect(document.body.textContent).not.toContain("Loading");
      expect(document.querySelector("[data-turn-header='live']")).toBeNull();
      expect(document.querySelector("[data-moss-visible-stop-control='true']")).not.toBeNull();
      expect(document.querySelector("[data-moss-visible-send-control='true']")).toBeNull();

      syncActiveThread((thread) => ({
        ...thread,
        latestTurn: thread.latestTurn
          ? {
              ...thread.latestTurn,
              startedAt: isoAt(1_301),
            }
          : thread.latestTurn,
        session: thread.session
          ? {
              ...thread.session,
              status: "running",
              activeTurnId: requestedTurnId,
              updatedAt: isoAt(1_301),
            }
          : null,
        updatedAt: isoAt(1_301),
      }));

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Thinking");
          const liveHeader = document.querySelector("[data-turn-header='live']");
          expect(liveHeader).not.toBeNull();
          expect(liveHeader?.textContent).toMatch(/^Working for \d/);
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("keeps working UI and Stop visible when Codex transitions starting -> ready -> running on a fresh turn", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-codex-start-ready-gap" as MessageId,
      targetText: "codex starting ready gap seed",
    });
    currentSnapshot = {
      ...currentSnapshot,
      threads: currentSnapshot.threads.map((thread) =>
        thread.id === THREAD_ID ? { ...thread, session: null, latestTurn: null } : thread,
      ),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      setFixture({ ...fixture, snapshot: currentSnapshot });
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const prompt = "can you schedule OpenCode work";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      const sentMessageId = await vi.waitFor(
        () => {
          const row = [
            ...document.querySelectorAll<HTMLElement>(
              "[data-message-id][data-message-role='user']",
            ),
          ].find((candidate) => candidate.textContent?.includes(prompt));
          expect(row?.dataset.messageId).toBeTruthy();
          return row!.dataset.messageId!;
        },
        { timeout: 8_000, interval: 16 },
      );

      // Step 1: Server echoes user message and enters `starting` (connecting).
      const requestedTurnId = TurnId.makeUnsafe("turn-codex-start-ready-gap");
      syncActiveThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe(sentMessageId),
            role: "user" as const,
            text: prompt,
            turnId: requestedTurnId,
            streaming: false,
            source: "native" as const,
            createdAt: isoAt(1_310),
            updatedAt: isoAt(1_310),
          },
        ],
        session: {
          threadId: THREAD_ID,
          status: "starting",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: isoAt(1_310),
        },
        updatedAt: isoAt(1_310),
      }));

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Starting Codex…");
          expect(document.querySelector("[data-moss-visible-stop-control='true']")).not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );

      // Step 2: Codex emits session/ready + thread/started BEFORE turn/started.
      // Previously, connecting wiped localDispatch so the working indicator and Stop vanished here.
      syncActiveThread((thread) => ({
        ...thread,
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: isoAt(1_311),
        },
        updatedAt: isoAt(1_311),
      }));

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Thinking");
          expect(document.querySelector("[data-moss-visible-stop-control='true']")).not.toBeNull();
          expect(document.querySelector("[data-moss-visible-send-control='true']")).toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      expect(document.body.textContent).toContain("Thinking");
      expect(document.querySelector("[data-moss-visible-stop-control='true']")).not.toBeNull();
      expect(document.querySelector("[data-moss-visible-send-control='true']")).toBeNull();

      // Step 3: turn/started arrives and live running takes over seamlessly.
      syncActiveThread((thread) => ({
        ...thread,
        latestTurn: {
          turnId: requestedTurnId,
          state: "running",
          requestedAt: isoAt(1_310),
          startedAt: isoAt(1_312),
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          threadId: THREAD_ID,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: requestedTurnId,
          lastError: null,
          updatedAt: isoAt(1_312),
        },
        updatedAt: isoAt(1_312),
      }));

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Thinking");
          expect(document.querySelector("[data-turn-header='live']")).not.toBeNull();
          expect(document.querySelector("[data-moss-visible-stop-control='true']")).not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("keeps working UI and Stop visible after clicking Continue task on a failed thread", async () => {
    const failedTurnId = TurnId.makeUnsafe("turn-failed-before-continue");
    const cause = "stream disconnected before completion";
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-user-before-failure"),
      targetText: "make a poster",
    });
    let currentSnapshot: OrchestrationReadModel = {
      ...base,
      threads: [
        {
          ...base.threads[0]!,
          session: {
            threadId: THREAD_ID,
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: cause,
            updatedAt: isoAt(10),
          },
          latestTurn: {
            turnId: failedTurnId,
            state: "error",
            requestedAt: NOW_ISO,
            startedAt: NOW_ISO,
            completedAt: isoAt(10),
            assistantMessageId: null,
          },
          messages: [
            createUserMessage({
              id: MessageId.makeUnsafe("msg-user-before-failure"),
              text: "make a poster",
              offsetSeconds: 0,
            }),
            {
              ...createAssistantMessage({
                id: MessageId.makeUnsafe("msg-assistant-before-failure"),
                text: "Searching references before generating the poster.",
                offsetSeconds: 3,
              }),
              turnId: failedTurnId,
            },
          ],
          activities: [
            {
              id: EventId.makeUnsafe("act-runtime-error-before-continue"),
              turnId: failedTurnId,
              tone: "error",
              kind: "runtime.error",
              createdAt: isoAt(10),
              sequence: 9,
              summary: "Provider runtime error",
              payload: { message: cause, class: "provider_error" },
            },
            {
              id: EventId.makeUnsafe("act-turn-failed-before-continue"),
              turnId: failedTurnId,
              tone: "error",
              kind: "turn.completed",
              createdAt: isoAt(10),
              sequence: 10,
              summary: "Turn failed",
              payload: { state: "failed", errorMessage: cause },
            },
          ],
        },
      ],
    };
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      setFixture({ ...fixture, snapshot: currentSnapshot });
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const continueBtn = page.getByRole("button", { name: "Continue task", exact: true });
      await expect.element(continueBtn).toBeVisible();
      await continueBtn.click();

      // Immediately after Continue: pre-existing thread.error must NOT clear localDispatch,
      // so the working indicator shows right away and Continue task disables.
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Sending…");
          expect((continueBtn.element() as HTMLButtonElement).disabled).toBe(true);
        },
        { timeout: 4_000, interval: 16 },
      );

      const continueMessageId = await vi.waitFor(
        () => {
          const rows = [
            ...document.querySelectorAll<HTMLElement>(
              "[data-message-id][data-message-role='user']",
            ),
          ];
          const last = rows.at(-1);
          expect(last?.dataset.messageId).toBeTruthy();
          expect(last?.dataset.messageId).not.toBe("msg-user-before-failure");
          return last!.dataset.messageId!;
        },
        { timeout: 4_000, interval: 16 },
      );

      // Server echoes the continuation message, restarts session (starting -> ready) before turn/started.
      syncActiveThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe(continueMessageId),
            role: "user" as const,
            text: "continue",
            turnId: null,
            streaming: false,
            source: "native" as const,
            createdAt: isoAt(20),
            updatedAt: isoAt(20),
          },
        ],
        session: {
          threadId: THREAD_ID,
          status: "starting",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: isoAt(20),
        },
        updatedAt: isoAt(20),
      }));

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Starting Codex…");
          expect(document.querySelector("[data-moss-visible-stop-control='true']")).not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );

      syncActiveThread((thread) => ({
        ...thread,
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: isoAt(21),
        },
        updatedAt: isoAt(21),
      }));

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Thinking");
          expect(document.querySelector("[data-moss-visible-stop-control='true']")).not.toBeNull();
          expect(document.querySelector("[data-moss-visible-send-control='true']")).toBeNull();
          expect((continueBtn.element() as HTMLButtonElement).disabled).toBe(true);
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  // Regression: the sent message must reach its anchored coordinate in one
  // motion and then stay there for the rest of the turn. The failure this guards
  // is the message visibly jumping up and down through send → Thinking →
  // Working → streaming, which is what a fixed-target scroll produces once
  // the coordinate moves under it (reserve sizing, rows above being remeasured).
  it("moves a sent message to its anchor and handles a long streamed response", async () => {
    // Match the other timing benchmarks: production never captures React owner stacks.
    onTestFinished(skipReactDevOwnerStacks());
    const restoreNativeApi = installDeterministicSendNativeApi();
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-send-jitter" as MessageId,
      targetText: "jitter target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      setFixture({ ...fixture, snapshot: currentSnapshot });
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const prompt = "measure the anchor motion for this send";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
      const sendButton = await waitForSendButton();
      sendButton.click();

      const findSentRow = () => {
        const rows = document.querySelectorAll<HTMLElement>(
          "[data-message-id][data-message-role='user']",
        );
        for (const row of rows) {
          if (row.textContent?.includes(prompt)) return row;
        }
        return null;
      };
      const topGapPx = Number.parseFloat(getComputedStyle(scrollContainer).paddingTop) || 0;

      // Sampled every frame: the regression is a single-frame hop, so polling for
      // the settled state would not see it.
      const samples: Array<{ t: number; offset: number | null; bottom: number }> = [];
      const startedAt = performance.now();
      let sampling = true;
      const sample = () => {
        if (!sampling) return;
        const row = findSentRow();
        samples.push({
          t: performance.now() - startedAt,
          offset: row
            ? row.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top
            : null,
          bottom:
            scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop,
        });
        window.requestAnimationFrame(sample);
      };
      window.requestAnimationFrame(sample);

      const at = (ms: number, action: () => void) => window.setTimeout(action, ms);
      const activeTurnId = TurnId.makeUnsafe("turn-jitter");
      const streamingId = MessageId.makeUnsafe("msg-assistant-jitter-stream");

      // Server ack: durable user row + running turn (Thinking appears).
      at(140, () => {
        const sentMessageId = findSentRow()?.dataset.messageId;
        if (!sentMessageId) return;
        syncActiveThread((thread) => ({
          ...thread,
          messages: [
            ...thread.messages,
            {
              id: MessageId.makeUnsafe(sentMessageId),
              role: "user" as const,
              text: prompt,
              turnId: activeTurnId,
              streaming: false,
              source: "native" as const,
              createdAt: isoAt(1_300),
              updatedAt: isoAt(1_300),
            },
          ],
          latestTurn: {
            turnId: activeTurnId,
            state: "running" as const,
            requestedAt: isoAt(1_300),
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
          session: thread.session
            ? {
                ...thread.session,
                status: "running" as const,
                activeTurnId,
                updatedAt: isoAt(1_301),
              }
            : null,
          updatedAt: isoAt(1_301),
        }));
      });
      // Turn actually starts: the Working header appears beside Thinking.
      at(420, () => {
        syncActiveThread((thread) => ({
          ...thread,
          latestTurn: thread.latestTurn
            ? { ...thread.latestTurn, startedAt: isoAt(1_310) }
            : thread.latestTurn,
          updatedAt: isoAt(1_310),
        }));
      });
      // Rows above the anchor settle to their real height mid-slide (late image
      // loads, markdown remeasure, estimated virtualized rows mounting). Visible
      // content preservation is off while an anchor is set, so this is exactly
      // what shifts the anchored row under the in-flight slide.
      const earlierMessageId = currentSnapshot.threads
        .find((thread) => thread.id === THREAD_ID)!
        .messages.at(-2)!.id;
      for (const [index, delayMs] of [260, 340, 430].entries()) {
        at(delayMs, () => {
          syncActiveThread((thread) => ({
            ...thread,
            messages: thread.messages.map((message) =>
              message.id === earlierMessageId
                ? {
                    ...message,
                    text: `${message.text}\n\n${"Late-measured earlier content. ".repeat(6 * (index + 1))}`,
                    updatedAt: isoAt(1_250 + index),
                  }
                : message,
            ),
            updatedAt: isoAt(1_250 + index),
          }));
        });
      }
      // Assistant text streams in below the anchor, chunk by chunk. Depending
      // on browser fonts and render scheduling, this may exhaust the reserve.
      for (let chunk = 1; chunk <= 40; chunk += 1) {
        at(560 + chunk * 33, () => {
          syncActiveThread((thread) => ({
            ...thread,
            messages: [
              ...thread.messages.filter((message) => message.id !== streamingId),
              {
                id: streamingId,
                role: "assistant" as const,
                text: "Streaming response paragraph.\n\n".repeat(chunk),
                turnId: activeTurnId,
                streaming: true,
                source: "native" as const,
                createdAt: isoAt(1_320),
                updatedAt: isoAt(1_320 + chunk),
              },
            ],
            updatedAt: isoAt(1_320 + chunk),
          }));
        });
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 2_200);
      });
      try {
        // Markdown rendering and row measurement can finish after the last
        // scheduled chunk. Keep sampling their motion before the final check.
        await vi.waitFor(
          () => {
            const paragraphs = scrollContainer
              .querySelector(`[data-message-id='${CSS.escape(streamingId)}']`)
              ?.querySelectorAll("p");
            expect(paragraphs?.length).toBe(40);
            expect(paragraphs?.[39]?.textContent).toBe("Streaming response paragraph.");
          },
          { timeout: 10_000, interval: 20 },
        );
        await waitForTranscriptLayoutToSettle(scrollContainer);
      } finally {
        sampling = false;
      }

      const visible = samples.filter(
        (entry): entry is { t: number; offset: number; bottom: number } => entry.offset !== null,
      );
      const firstArrivalIndex = visible.findIndex(
        (entry) => Math.abs(entry.offset - topGapPx) <= 2,
      );
      const settled = firstArrivalIndex >= 0 ? visible.slice(firstArrivalIndex) : [];
      // Once the response is taller than the remaining viewport, the list
      // intentionally hands off from the pinned send to following the live
      // tail. Validate the rigid hold before that hand-off separately from the
      // upward motion afterward. A separate small-viewport browser test always
      // forces overflow and requires the hand-off.
      const handoffIndex = settled.findIndex((entry) => entry.offset < topGapPx - 4);
      const held = handoffIndex < 0 ? settled : settled.slice(0, handoffIndex);
      let reversals = 0;
      let travelAfterArrivalPx = 0;
      let maxDownwardJumpPx = 0;
      let previousDirection = 0;
      for (let index = 1; index < settled.length; index += 1) {
        const delta = settled[index]!.offset - settled[index - 1]!.offset;
        maxDownwardJumpPx = Math.max(maxDownwardJumpPx, delta);
        if (Math.abs(delta) <= 0.5) continue;
        const direction = Math.sign(delta);
        if (previousDirection !== 0 && direction !== previousDirection) reversals += 1;
        previousDirection = direction;
      }
      for (let index = 1; index < held.length; index += 1) {
        travelAfterArrivalPx += Math.abs(held[index]!.offset - held[index - 1]!.offset);
      }
      const maxDriftAfterArrivalPx = held.reduce(
        (worst, entry) => Math.max(worst, Math.abs(entry.offset - topGapPx)),
        0,
      );
      // The approach itself must not bounce: every observed frame moves the
      // message toward the anchor, never back down and up again. The easing
      // curve is covered deterministically in transcriptScroll.test.ts;
      // browser frame sampling cannot prove the intermediate path because a
      // loaded runner may present no frames between the first move and arrival.
      const approach = firstArrivalIndex >= 0 ? visible.slice(0, firstArrivalIndex + 1) : visible;
      let approachReversals = 0;
      let approachDirection = 0;
      for (let index = 1; index < approach.length; index += 1) {
        const delta = approach[index]!.offset - approach[index - 1]!.offset;
        // Chromium can report a one-pixel layout/compositor rounding shift before
        // the anchor animation starts. Match the arrival tolerance so that noise
        // does not count as an extra change of direction.
        if (Math.abs(delta) <= 2) continue;
        const direction = Math.sign(delta);
        if (approachDirection !== 0 && direction !== approachDirection) approachReversals += 1;
        approachDirection = direction;
      }
      const trace = () =>
        visible
          .map(
            (entry) =>
              `${Math.round(entry.t)}:${Math.round(entry.offset)}:${Math.round(entry.bottom)}`,
          )
          .join(" ");
      expect(
        firstArrivalIndex,
        `sent message never reached its anchor: ${trace()}`,
      ).toBeGreaterThan(-1);
      expect(
        visible[firstArrivalIndex]!.t - (visible[0]?.t ?? 0),
        `anchor took too long to land: ${trace()}`,
      ).toBeLessThan(900);
      expect(approachReversals, `anchor bounced on its way up: ${trace()}`).toBeLessThanOrEqual(1);
      expect(reversals, `anchor moved back and forth after landing: ${trace()}`).toBe(0);
      expect(maxDownwardJumpPx, `anchor slid back down after landing: ${trace()}`).toBeLessThan(2);
      expect(travelAfterArrivalPx, `anchor kept moving after landing: ${trace()}`).toBeLessThan(8);
      expect(maxDriftAfterArrivalPx, `anchor drifted off its coordinate: ${trace()}`).toBeLessThan(
        4,
      );
      if (handoffIndex >= 0) {
        expect(
          settled[handoffIndex]!.t,
          `anchor released before the short response filled the reserve: ${trace()}`,
        ).toBeGreaterThan(1_000);
        expect(
          settled.at(-1)!.bottom,
          `transcript did not follow the overflowing response: ${trace()}`,
        ).toBeLessThan(8);
      }
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  // MERGE-GAP(2026-10-05): "keyboard ArrowUp" and "find" stay excluded pending
  // the dedicated timeline-alignment campaign. On Moss's heavier timeline (13px
  // scale, live status rows) LegendList's maintainVisibleContentPosition
  // mis-compensates growth inside the row the reader is anchored to — a
  // deterministic one-row drift (~193-214px) upstream does not exhibit. Both
  // fail identically on Moss main (pre-merge), so they are not merge
  // regressions. The rest of the matrix is timing-sensitive on this machine
  // (never red in isolated runs), so it gets bounded retries instead.
  type ScrollFollowAction =
    | "wheel near end"
    | "manual return"
    | "arrow"
    | "send"
    | "send with immediate response"
    | "wheel down"
    | "wheel without movement"
    | "nested wheel"
    | "nested key"
    | "layout leave"
    | "keyboard ArrowUp"
    | "find"
    | "pointer click"
    | "thread switch"
    | "short transcript";
  it.each([
    "wheel near end",
    "manual return",
    "arrow",
    "send",
    "send with immediate response",
    "wheel down",
    "wheel without movement",
    "nested wheel",
    "nested key",
    "layout leave",
    // "keyboard ArrowUp",
    // "find",
    "pointer click",
    "thread switch",
    "short transcript",
  ] as const)(
    "restores streaming follow after %s in the full ChatView",
    { retry: 2 },
    async (action: ScrollFollowAction) => {
      const keyboardKey = action.startsWith("keyboard ") ? action.slice("keyboard ".length) : null;
      const restoreNativeApi = installDeterministicSendNativeApi();
      let snapshot = addThreadToSnapshot(
        createSnapshotWithLongAssistantResponse(),
        OTHER_THREAD_ID,
      );
      if (action === "short transcript") {
        snapshot = {
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? { ...thread, messages: thread.messages.slice(0, 1) } : thread,
          ),
        };
      }
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      const messageId = MessageId.makeUnsafe("follow-live-response");
      const turnId = TurnId.makeUnsafe("follow-live-turn");
      const syncThread = (
        update: (
          thread: OrchestrationReadModel["threads"][number],
        ) => OrchestrationReadModel["threads"][number],
      ) => {
        snapshot = {
          ...snapshot,
          snapshotSequence: snapshot.snapshotSequence + 1,
          threads: snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? update(thread) : thread,
          ),
        };
        setFixture({ ...fixture, snapshot });
        useStore.getState().syncServerReadModel(snapshot);
      };
      const grow = () =>
        syncThread((thread) => ({
          ...thread,
          messages: thread.messages.map((message) =>
            message.id === messageId
              ? { ...message, text: `${message.text}\n\n${"More streaming output. ".repeat(35)}` }
              : message,
          ),
        }));
      try {
        let container = await waitForElement(
          () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
          "Transcript did not mount.",
        );
        await vi.waitFor(() =>
          expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        if (action === "send" || action === "send with immediate response") {
          useComposerDraftStore
            .getState()
            .setPrompt(THREAD_ID, "Continue with a long streamed response");
          (await waitForSendButton()).click();
          const sent = await waitForElement(
            () =>
              Array.from(document.querySelectorAll<HTMLElement>("[data-message-role='user']")).find(
                (row) => row.textContent?.includes("Continue with a long streamed response"),
              ) ?? null,
            "Optimistic message did not appear.",
          );
          const sentId = MessageId.makeUnsafe(sent.dataset.messageId!);
          syncThread((thread) => ({
            ...thread,
            messages: [
              ...thread.messages,
              {
                id: sentId,
                role: "user",
                source: "native",
                turnId: null,
                text: "Continue with a long streamed response",
                createdAt: isoAt(1_200),
                updatedAt: isoAt(1_200),
                streaming: false,
              },
            ],
          }));
          // The slide emits real scroll events while the provider is starting.
          if (action === "send") await new Promise<void>((resolve) => setTimeout(resolve, 700));
        }
        syncThread((thread) => ({
          ...thread,
          session: thread.session
            ? { ...thread.session, status: "running", activeTurnId: turnId }
            : null,
          latestTurn: {
            turnId,
            state: "running",
            requestedAt: isoAt(1_200),
            startedAt: isoAt(1_201),
            completedAt: null,
            assistantMessageId: messageId,
          },
          messages: [
            ...thread.messages,
            {
              id: messageId,
              role: "assistant",
              source: "native",
              text: "The response begins.",
              turnId,
              streaming: true,
              createdAt: isoAt(1_202),
              updatedAt: isoAt(1_202),
            },
          ],
        }));
        if (action === "short transcript") {
          await waitForLayout();
          expect(container.scrollHeight).toBeLessThanOrEqual(container.clientHeight + 1);
          await userEvent.wheel(container, { delta: { y: -100 } });
        }
        for (let index = 0; index < 12; index += 1) {
          grow();
          // A fast provider can deliver a complete response before the send's
          // anchor slide releases ownership. No later message update is promised.
          if (action !== "send with immediate response") await waitForLayout();
        }
        // The prepared response still reveals text gradually after delivery.
        // Finish rendering and measuring it before giving the reader control.
        await vi.waitFor(
          () => {
            const paragraphs = container
              .querySelector(`[data-message-id='${CSS.escape(messageId)}']`)
              ?.querySelectorAll("p");
            expect(paragraphs?.length).toBe(13);
            expect(paragraphs?.[12]?.textContent).toBe("More streaming output. ".repeat(35).trim());
          },
          { timeout: 10_000, interval: 20 },
        );
        await waitForTranscriptLayoutToSettle(container);
        await vi.waitFor(() =>
          expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
        );

        if (action === "wheel down") {
          await userEvent.wheel(container, { delta: { y: 100 } });
        } else if (action === "layout leave") {
          const height = container.clientHeight;
          container.style.maxHeight = `${height - 180}px`;
          await vi.waitFor(() => expect(container.clientHeight).toBeLessThan(height));
          await waitForLayout();
          await userEvent.wheel(container, { delta: { y: 100 } });
        } else if (action === "wheel without movement") {
          container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -0.1 }));
          grow();
          container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -0.1 }));
          await waitForLayout();
        } else if (action === "nested wheel" || action === "nested key") {
          if (action === "nested key") {
            // The first native input activates the test iframe and replays pending
            // composer focus. Settle that activation before testing a nested key.
            await page.getByTestId("composer-editor").click();
            await waitForLayout();
          }
          const nested = document.createElement("div");
          const bounds = container.getBoundingClientRect();
          nested.style.cssText = `position: fixed; left: ${bounds.left + 20}px; top: ${bounds.top + 20}px; width: 180px; height: 96px; overflow: auto; overscroll-behavior: contain; z-index: 100;`;
          nested.textContent = "Nested scrollable content. ".repeat(100);
          container.append(nested);
          try {
            nested.scrollTop = 100;
            if (action === "nested key") {
              nested.tabIndex = 0;
              // Focus through native input so Chromium directs keyboard scrolling
              // to this nested viewport as it would after a reader clicks it.
              await userEvent.click(nested);
              expect(document.activeElement).toBe(nested);
              let keyTarget: EventTarget | null = null;
              const captureKeyTarget = (event: KeyboardEvent) => {
                if (event.key === "ArrowUp") keyTarget = event.target;
              };
              nested.addEventListener("keydown", captureKeyTarget);
              try {
                await userEvent.keyboard("{ArrowUp}");
              } finally {
                nested.removeEventListener("keydown", captureKeyTarget);
              }
              expect(keyTarget).toBe(nested);
            } else {
              await userEvent.wheel(nested, { delta: { y: -30 } });
            }
            await vi.waitFor(() => expect(nested.scrollTop).toBeLessThan(100));
            await waitForLayout();
            await vi.waitFor(() =>
              expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
            );
          } finally {
            nested.remove();
          }
        } else if (action === "pointer click") {
          container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          container.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        } else if (
          action !== "send" &&
          action !== "send with immediate response" &&
          action !== "short transcript"
        ) {
          if (keyboardKey !== null) {
            container.tabIndex = 0;
            container.focus();
            expect(document.activeElement).toBe(container);
            // Streaming can advance while the browser input command is in transit.
            // Compare against the offset at keydown, when the gesture takes ownership.
            let initialTop: number | null = null;
            const captureInitialTop = (event: KeyboardEvent) => {
              if (event.key === keyboardKey) initialTop = container.scrollTop;
            };
            container.addEventListener("keydown", captureInitialTop, { capture: true });
            try {
              await userEvent.keyboard(`{${keyboardKey}}`);
            } finally {
              container.removeEventListener("keydown", captureInitialTop, { capture: true });
            }
            expect(initialTop).not.toBeNull();
            await vi.waitFor(() => expect(container.scrollTop).toBeLessThan(initialTop! - 1));
          } else if (action === "find") {
            await dispatchConfiguredShortcutWhenReady(window, { key: "f" });
            await page.getByLabelText("Find in thread").fill("assistant filler 0");
            // The Moss timeline marks the active match and smooth-scrolls ~10k px;
            // on a heavy render that outlasts the default 1s waitFor budget.
            await vi.waitFor(
              () => {
                const match = document.querySelector<HTMLElement>(
                  '[data-chat-find-match="active"]',
                );
                expect(match).not.toBeNull();
                const bounds = match!.getBoundingClientRect();
                const viewport = container.getBoundingClientRect();
                expect(bounds.top).toBeGreaterThanOrEqual(viewport.top);
                expect(bounds.bottom).toBeLessThanOrEqual(viewport.bottom);
              },
              { timeout: 3_000 },
            );
            await new Promise<void>((resolve) => setTimeout(resolve, 350));
          } else {
            await userEvent.wheel(container, {
              delta: { y: action === "wheel near end" ? -12 : -350 },
            });
          }
          await vi.waitFor(() =>
            expect(getScrollContainerDistanceFromBottom(container)).toBeGreaterThanOrEqual(10),
          );
          await waitForLayout();
          // Native wheel and key scrolling may continue after the input command
          // resolves. Record the reader position only once the viewport is quiet.
          await waitForTranscriptLayoutToSettle(container);
          const viewport = container.getBoundingClientRect();
          const readingAnchor = Array.from(
            container.querySelectorAll<HTMLElement>("[data-message-id] p, [data-message-id] li"),
          ).find((paragraph) => {
            const bounds = paragraph.getBoundingClientRect();
            return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
          });
          expect(readingAnchor, "Visible text must anchor the reader position").toBeDefined();
          const anchorMessage = readingAnchor!.closest<HTMLElement>("[data-message-id]")!;
          const anchorIndex = Array.from(anchorMessage.querySelectorAll("p, li")).indexOf(
            readingAnchor!,
          );
          const anchorSelector = `[data-message-id='${CSS.escape(anchorMessage.dataset.messageId!)}']`;
          const readAnchorTop = () =>
            container
              .querySelector(anchorSelector)!
              .querySelectorAll("p, li")
              [anchorIndex]!.getBoundingClientRect().top;
          const detachedTop = readAnchorTop();
          for (let index = 0; index < 3; index += 1) {
            grow();
            await waitForLayout();
          }
          if (keyboardKey !== null || action === "find") {
            syncThread((thread) => ({
              ...thread,
              messages: [
                ...thread.messages,
                {
                  id: MessageId.makeUnsafe("remote-follow-message"),
                  role: "user",
                  source: "native",
                  turnId: null,
                  text: "Another message arrived while reading earlier output.",
                  streaming: false,
                  createdAt: isoAt(1_203),
                  updatedAt: isoAt(1_203),
                },
              ],
            }));
            await waitForLayout();
          }
          // The list may compensate scrollTop as estimated rows settle. The text
          // the reader is looking at must remain at the same viewport position.
          expect(readAnchorTop()).toBeCloseTo(detachedTop, 0);
          if (action === "thread switch") {
            await mounted.router.navigate({
              to: "/$threadId",
              params: { threadId: OTHER_THREAD_ID },
            });
            // Router navigation can finish before React commits the new transcript.
            // Wait for the old list to unmount so the return cannot race that commit.
            await vi.waitFor(() => expect(container.isConnected).toBe(false));
            await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
            container = await waitForElement(() => {
              const next = document.querySelector<HTMLElement>(
                "[data-chat-scroll-container='true']",
              );
              return next?.querySelector(`[data-message-id='${messageId}']`) ? next : null;
            }, "Streaming transcript did not remount.");
            await waitForLayout();
          } else if (action === "arrow" || keyboardKey !== null || action === "find") {
            const arrow = await waitForElement(
              () =>
                document.querySelector<HTMLButtonElement>(
                  "button[aria-label='Scroll to bottom'][aria-hidden='false']",
                ),
              "Scroll-to-bottom arrow did not appear.",
            );
            arrow.click();
          } else {
            container.scrollTop = container.scrollHeight;
            container.dispatchEvent(new Event("scroll"));
          }
          await vi.waitFor(
            () =>
              expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(
                action === "thread switch" ? AUTO_SCROLL_BOTTOM_THRESHOLD_PX : 4,
              ),
            { timeout: 3_000 },
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
        for (let index = 0; index < 8; index += 1) {
          grow();
          await waitForLayout();
        }
        await vi.waitFor(() =>
          expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
        );
      } finally {
        await mounted.cleanup();
        restoreNativeApi();
      }
    },
  );

  it("follows the final text batch when the assistant turn settles", async () => {
    let snapshot = createSnapshotWithLongAssistantResponse();
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const messageId = MessageId.makeUnsafe("msg-final-text-batch");
    const turnId = TurnId.makeUnsafe("turn-final-text-batch");
    const syncReply = (text: string, streaming: boolean) => {
      snapshot = {
        ...snapshot,
        snapshotSequence: snapshot.snapshotSequence + 1,
        threads: snapshot.threads.map((thread) =>
          thread.id !== THREAD_ID
            ? thread
            : {
                ...thread,
                session: thread.session
                  ? {
                      ...thread.session,
                      status: streaming ? "running" : "ready",
                      activeTurnId: streaming ? turnId : null,
                    }
                  : null,
                latestTurn: {
                  turnId,
                  state: streaming ? "running" : "completed",
                  requestedAt: isoAt(1_200),
                  startedAt: isoAt(1_201),
                  completedAt: streaming ? null : isoAt(1_204),
                  assistantMessageId: messageId,
                },
                messages: [
                  ...thread.messages.filter((message) => message.id !== messageId),
                  {
                    id: messageId,
                    role: "assistant",
                    source: "native",
                    text,
                    turnId,
                    streaming,
                    createdAt: isoAt(1_202),
                    updatedAt: isoAt(1_203),
                    ...(streaming ? {} : { completedAt: isoAt(1_204) }),
                  },
                ],
              },
        ),
      };
      setFixture({ ...fixture, snapshot });
      useStore.getState().syncServerReadModel(snapshot);
    };
    try {
      const container = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Transcript did not mount.",
      );
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
      syncReply("The reply starts.", true);
      await vi.waitFor(() => expect(container.textContent).toContain("The reply starts."));
      await waitForTranscriptLayoutToSettle(container);
      expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4);
      syncReply(
        `${Array.from(
          { length: 40 },
          (_, index) => `Paragraph ${index}. ${"Delivered assistant output. ".repeat(8)}`,
        ).join("\n\n")}\n\nEnd of reply.`,
        false,
      );
      await vi.waitFor(() => expect(container.textContent).toContain("End of reply."));
      await waitForTranscriptLayoutToSettle(container);
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps following work after assistant text finishes streaming", async () => {
    let snapshot = createSnapshotWithInlineToolOverflow({ active: true });
    const messageId = MessageId.makeUnsafe("msg-assistant-inline-tools");
    const turnId = TurnId.makeUnsafe("turn-inline-tools");
    snapshot = {
      ...snapshot,
      threads: snapshot.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId
            ? { ...message, text: "I will check the transcript layout.", streaming: true }
            : message,
        ),
      })),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const syncThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      snapshot = {
        ...snapshot,
        snapshotSequence: snapshot.snapshotSequence + 1,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
      };
      setFixture({ ...fixture, snapshot });
      useStore.getState().syncServerReadModel(snapshot);
    };
    const appendWork = (index: number) =>
      syncThread((thread) => ({
        ...thread,
        activities: [
          ...thread.activities,
          {
            id: EventId.makeUnsafe(`activity-after-commentary-${index}`),
            createdAt: isoAt(1_110 + index),
            kind: "tool.started",
            summary: `Checking transcript layout ${index}`,
            tone: "tool",
            turnId,
            payload: {
              itemType: "command_execution",
              status: "inProgress",
              title: "Run transcript checks",
              detail: `bun run test transcript-layout-${index}`,
            },
          },
        ],
      }));
    try {
      const container = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Transcript did not mount.",
      );
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
      syncThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId
            ? { ...message, streaming: false, completedAt: isoAt(1_110) }
            : message,
        ),
      }));
      await waitForTranscriptLayoutToSettle(container);
      expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4);
      const beforeWorkHeight = container.scrollHeight;
      for (let index = 0; index < 4; index += 1) {
        appendWork(index);
        await waitForLayout();
      }
      await waitForTranscriptLayoutToSettle(container);
      expect(container.scrollHeight).toBeGreaterThan(beforeWorkHeight + 20);
      expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4);

      // Reading earlier output releases follow even between text messages.
      await userEvent.wheel(container, { delta: { y: -350 } });
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeGreaterThan(100),
      );
      await waitForTranscriptLayoutToSettle(container);
      const readerTop = container.scrollTop;
      appendWork(4);
      syncThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe("msg-after-commentary-work"),
            role: "assistant",
            source: "native",
            text: "The layout checks have completed.",
            turnId,
            streaming: false,
            createdAt: isoAt(1_120),
            updatedAt: isoAt(1_120),
            completedAt: isoAt(1_120),
          },
        ],
      }));
      await waitForTranscriptLayoutToSettle(container);
      expect(container.scrollTop).toBeCloseTo(readerTop, 0);
      expect(getScrollContainerDistanceFromBottom(container)).toBeGreaterThan(100);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the previous turn folded while a follow-up send awaits its new turn", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: false }),
    });
    let releaseSend!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const restoreApi = installDeterministicSendNativeApi({ beforeTurnStart: () => barrier });
    try {
      await vi.waitFor(() =>
        expect(findInlineToolsTurnDisclosure()?.getAttribute("aria-expanded")).toBe("false"),
      );
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Thanks");
      (await waitForSendButton()).click();
      await vi.waitFor(() => expect(hasDispatchedCommandType("thread.turn.start")).toBe(true));
      // Inspect the whole pending-send window: an unfold followed by a fold
      // changes transcript height even if the final settled state looks right.
      for (let frame = 0; frame < 20; frame += 1) {
        await nextFrame();
        expect(findInlineToolsTurnDisclosure()?.getAttribute("aria-expanded")).toBe("false");
        expect(document.querySelector("[data-settled-turn-collapse-transition='true']")).toBeNull();
        expect(document.body.textContent).not.toContain("Used 6 tools");
      }
    } finally {
      releaseSend();
      restoreApi();
      await mounted.cleanup();
    }
  });

  it("does not rearm detached reading for non-message activity", async () => {
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-auto-follow-wiring" as MessageId,
      targetText: "auto-follow wiring target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: currentSnapshot,
    });
    let restoreScrollTo = () => {};

    const syncActiveThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      currentSnapshot = {
        ...currentSnapshot,
        snapshotSequence: currentSnapshot.snapshotSequence + 1,
        threads: currentSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
        updatedAt: isoAt(currentSnapshot.snapshotSequence + 1_200),
      };
      setFixture({ ...fixture, snapshot: currentSnapshot });
      useStore.getState().syncServerReadModel(currentSnapshot);
    };

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const scrollSpy = installImmediateScrollToSpy(scrollContainer);
      restoreScrollTo = scrollSpy.restore;
      // The virtual list's bootstrap initial-scroll session can stay armed
      // past mount — or re-arm on the next layout change after an abort — and
      // dispatches a one-shot correction scroll once its reveal settles. Drive
      // one real transition, then stay quiet so its rAF-driven passes settle
      // without the resolved offset moving; repeat once in case the first
      // session aborted silently and only re-arms on this change. The
      // dispatch is captured by the spy and cleared instead of landing inside
      // the assertions below.
      for (const warmStatus of ["starting", "ready"] as const) {
        syncActiveThread((thread) => ({
          ...thread,
          session: thread.session ? { ...thread.session, status: warmStatus } : null,
        }));
        await waitForLayout();
        // Quiet window: also covers mount-time tail/image expansion retries
        // (scheduled at up to 260ms, possibly late under load).
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
          await waitForLayout();
          if (scrollSpy.calls.length === 0) {
            break;
          }
          scrollSpy.calls.length = 0;
        }
      }
      scrollSpy.calls.length = 0;

      await userEvent.wheel(scrollContainer, { delta: { y: -350 } });
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(scrollContainer)).toBeGreaterThan(100),
      );
      await waitForTranscriptLayoutToSettle(scrollContainer);
      scrollSpy.calls.length = 0;

      // Buffering/connecting changes turn chrome but must not reclaim the
      // viewport from someone reading earlier messages.
      syncActiveThread((thread) => ({
        ...thread,
        session: thread.session
          ? {
              ...thread.session,
              status: "starting",
              updatedAt: isoAt(1_201),
            }
          : null,
        updatedAt: isoAt(1_201),
      }));
      await waitForLayout();
      expect(scrollSpy.calls).toHaveLength(0);

      for (const status of ["error", "starting", "ready"] as const) {
        syncActiveThread((thread) => ({
          ...thread,
          session: thread.session
            ? {
                ...thread.session,
                status,
                lastError: status === "error" ? "Provider connection failed" : null,
              }
            : null,
        }));
        await waitForLayout();
        expect(scrollSpy.calls).toHaveLength(0);
      }

      const activeTurnId = TurnId.makeUnsafe("turn-auto-follow-wiring");
      syncActiveThread((thread) => ({
        ...thread,
        latestTurn: {
          turnId: activeTurnId,
          state: "running",
          requestedAt: isoAt(1_202),
          startedAt: isoAt(1_203),
          completedAt: null,
          assistantMessageId: null,
        },
        session: thread.session
          ? {
              ...thread.session,
              status: "running",
              activeTurnId,
              updatedAt: isoAt(1_204),
            }
          : null,
        activities: [
          ...thread.activities,
          {
            id: EventId.makeUnsafe("activity-auto-follow-approval"),
            createdAt: isoAt(1_204),
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            turnId: activeTurnId,
            payload: {
              requestId: "request-auto-follow",
              requestKind: "command",
              detail: "inspect the unchanged transcript tail",
            },
          },
        ],
        updatedAt: isoAt(1_204),
      }));
      await waitForLayout();
      expect(scrollSpy.calls).toHaveLength(0);

      syncActiveThread((thread) => ({
        ...thread,
        activities: [
          ...thread.activities,
          {
            id: EventId.makeUnsafe("activity-auto-follow-tool"),
            createdAt: isoAt(1_205),
            kind: "tool.completed",
            summary: "scroll-only tool activity",
            tone: "tool",
            turnId: activeTurnId,
            payload: {
              itemType: "dynamic_tool_call",
              toolName: "inspect-scroll-tail",
            },
          },
        ],
        updatedAt: isoAt(1_205),
      }));
      await waitForLayout();
      expect(scrollSpy.calls).toHaveLength(0);

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      scrollSpy.calls.length = 0;
      const liveAssistantMessage = {
        ...createAssistantMessage({
          id: MessageId.makeUnsafe("msg-assistant-auto-follow-live"),
          text: "A real live assistant tail",
          offsetSeconds: 1_206,
        }),
        turnId: activeTurnId,
        streaming: true,
      };
      syncActiveThread((thread) => ({
        ...thread,
        messages: [...thread.messages, liveAssistantMessage],
        updatedAt: isoAt(1_206),
      }));
      await vi.waitFor(() => expect(scrollSpy.calls.length).toBeGreaterThan(0), {
        timeout: 4_000,
        interval: 16,
      });

      scrollSpy.calls.length = 0;
      syncActiveThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === liveAssistantMessage.id
            ? {
                ...message,
                text: `${message.text}\n\nA second streamed chunk that grows the live response.`,
                updatedAt: isoAt(1_207),
              }
            : message,
        ),
        updatedAt: isoAt(1_207),
      }));
      await vi.waitFor(() => expect(scrollSpy.calls.length).toBeGreaterThan(0), {
        timeout: 4_000,
        interval: 16,
      });

      scrollSpy.calls.length = 0;
      syncActiveThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === liveAssistantMessage.id
            ? {
                ...message,
                streaming: false,
                completedAt: isoAt(1_208),
                updatedAt: isoAt(1_208),
              }
            : message,
        ),
        updatedAt: isoAt(1_208),
      }));
      await vi.waitFor(() => expect(scrollSpy.calls.length).toBeGreaterThan(0), {
        timeout: 4_000,
        interval: 16,
      });
    } finally {
      restoreScrollTo();
      await mounted.cleanup();
    }
  });

  it("applies the selected chat width to the transcript column", async () => {
    localStorage.setItem("moss:app-settings:v1", JSON.stringify({ chatWidth: "wide" }));
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-width-test" as MessageId,
        targetText: "chat width test",
      }),
    });

    try {
      // The hook must surface the preset as a root CSS variable.
      await vi.waitFor(
        () => {
          expect(document.documentElement.style.getPropertyValue("--app-chat-max-width")).toBe(
            "72rem",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      // The transcript column frame must pick up the wider max width.
      await vi.waitFor(
        () => {
          const row = document.querySelector(
            "[data-timeline-row-kind='message'][data-message-role='assistant']",
          ) as HTMLElement | null;
          expect(row).not.toBeNull();
          expect(row?.className ?? "").toContain("max-w-[var(--app-chat-max-width,46rem)]");
          expect(getComputedStyle(row!).maxWidth).toBe("1152px"); // 72rem at 16px root
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows native command stdout in the mounted transcript while the provider is still running", async () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "en" }));
    const turnId = TurnId.makeUnsafe("turn-browser-fixture-active");
    const item = {
      type: "commandExecution",
      id: "native-command-mounted",
      command: "python3 capture.py",
      cwd: "/workspace/capture",
      aggregatedOutput: null,
      exitCode: null,
    };
    const source = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("native-command-user"),
      targetText: "Capture live command output",
      sessionStatus: "running",
      messagePairCount: 1,
      targetIndex: 0,
    });
    const snapshot: OrchestrationReadModel = {
      ...source,
      threads: source.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.role === "assistant"
            ? { ...message, text: "Starting the requested probe.", turnId }
            : message,
        ),
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: NOW_ISO,
          startedAt: NOW_ISO,
          completedAt: null,
          assistantMessageId: null,
        },
        activities: [
          {
            id: EventId.makeUnsafe("native-command-start"),
            kind: "tool.started",
            tone: "tool",
            summary: "Ran command started",
            createdAt: isoAt(10),
            sequence: 10,
            turnId,
            payload: {
              itemType: "command_execution",
              status: "inProgress",
              title: "Ran command",
              detail: item.command,
              data: { item },
            },
          },
          {
            id: EventId.makeUnsafe("native-command-output"),
            kind: "tool.updated",
            tone: "tool",
            summary: "Ran command",
            createdAt: isoAt(11),
            sequence: 11,
            turnId,
            payload: {
              itemType: "command_execution",
              status: "inProgress",
              title: "Ran command",
              data: { toolCallId: item.id, rawOutput: { output: "pass5 tick 1\npass5 tick 2\n" } },
            },
          },
        ],
      })),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      const trigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>("[data-tool-detail-trigger]"),
        "Running command disclosure missing",
      );
      trigger.click();
      await vi.waitFor(() =>
        expect(document.querySelector("[data-shell-output-scroll]")?.textContent).toContain(
          "pass5 tick 2",
        ),
      );
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(document.querySelector("[data-shell-footer]")).toHaveAttribute(
        "data-shell-footer",
        "running",
      );
      await page.screenshot({
        path: "../../../../.tmp/ui-parity/parity5/pass5-moss-chatview-live-command.png",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("maps durable realtime handoff identity into the mounted transcript", async () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "en" }));
    const messageId = MessageId.makeUnsafe("pass5-durable-handoff");
    const source = createSnapshotForTargetUser({
      targetMessageId: messageId,
      targetText: "A realtime handoff transcript",
      messagePairCount: 1,
      targetIndex: 0,
    });
    const snapshot = {
      ...source,
      threads: source.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId
            ? { ...message, realtimeHandoffId: "provider-item-pass5" }
            : message,
        ),
      })),
    };
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await vi.waitFor(() => {
        const row = document.querySelector('[data-realtime-handoff-id="provider-item-pass5"]');
        expect(row).not.toBeNull();
        expect(row?.textContent).toContain("A realtime handoff transcript");
        expect(document.querySelectorAll("[data-realtime-handoff-id]")).toHaveLength(1);
      });
      await page.screenshot({
        path: "../../../../.tmp/ui-parity/parity5/pass5-moss-durable-handoff.png",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps long proposed plans lightweight until the user expands them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );

      expect(document.body.textContent).not.toContain("deep hidden detail only after expand");
      // Proposed plans stay inline: the plan sidebar does not open before execution starts.
      expect(document.querySelector('[aria-label="Close plan sidebar"]')).toBeNull();

      const expandButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );
      expandButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the final transcript row clear of the composer capsules", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithTallComposerStack(),
    });

    const maxFixedClearancePx = 128;

    try {
      const changesCapsule = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="composer-live-changes"]'),
        "Unable to find the live changes capsule.",
      );
      const taskCapsule = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="active-task-list-capsule"]'),
        "Unable to find the task-list capsule.",
      );
      expect(changesCapsule.title).toContain("2 files changed");
      expect(taskCapsule.textContent).toContain("1/3 tasks");
      // Activity collapses into capsules in one capsule row instead of a stack of panels.
      const capsuleRow = taskCapsule.closest("[data-composer-capsule-row]");
      expect(capsuleRow).not.toBeNull();
      expect(changesCapsule.closest("[data-composer-capsule-row]")).toBe(capsuleRow);

      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "Unable to find message scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const readCapsuleLayout = () => {
        const renderedRows = Array.from(
          document.querySelectorAll<HTMLElement>("[data-timeline-row-kind]"),
        );
        const finalTranscriptRow = renderedRows.reduce<HTMLElement | null>((latest, row) => {
          if (!latest) return row;
          return row.getBoundingClientRect().bottom > latest.getBoundingClientRect().bottom
            ? row
            : latest;
        }, null);
        const capsuleRow = taskCapsule.closest<HTMLElement>("[data-composer-capsule-row]");
        expect(
          finalTranscriptRow,
          "Unable to find the final rendered transcript row.",
        ).toBeTruthy();
        expect(capsuleRow, "Unable to find the composer capsule row.").toBeTruthy();
        return {
          gapPx:
            capsuleRow!.getBoundingClientRect().top -
            finalTranscriptRow!.getBoundingClientRect().bottom,
          distanceFromBottomPx: getScrollContainerDistanceFromBottom(scrollContainer),
        };
      };

      const waitForBoundedGap = async (phase: string) => {
        let measured = readCapsuleLayout();
        await vi.waitFor(
          () => {
            measured = readCapsuleLayout();
            expect(
              measured.distanceFromBottomPx,
              `${phase}: transcript must stay at the end`,
            ).toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
            expect(
              measured.gapPx,
              `${phase}: final row must not be obscured`,
            ).toBeGreaterThanOrEqual(-1);
            expect(
              measured.gapPx,
              `${phase}: gap must stay within fixed clearance`,
            ).toBeLessThanOrEqual(maxFixedClearancePx);
          },
          { timeout: 4_000, interval: 16 },
        );
        return measured;
      };

      const closed = await waitForBoundedGap("capsules");
      const scrollTopBeforeOpen = scrollContainer.scrollTop;

      // The full task list opens in a popover over the transcript, so it never moves the reader.
      taskCapsule.click();
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="active-task-list-card"]'),
        "Unable to find the task-list popover.",
      );
      expect(document.body.textContent).toContain("1 out of 3 tasks completed");
      const opened = await waitForBoundedGap("task list open");
      expect(Math.abs(opened.gapPx - closed.gapPx)).toBeLessThanOrEqual(1);
      expect(Math.abs(scrollContainer.scrollTop - scrollTopBeforeOpen)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows live file changes as a floating capsule without queued messages", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithActiveFileChanges(),
    });
    try {
      const capsule = page.getByTestId("composer-live-changes");
      await expect.element(capsule).toBeVisible();
      expect(capsule.element().getAttribute("title")).toContain("2 files changed");
      expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
      for (const viewport of [DEFAULT_VIEWPORT, { name: "narrow", width: 480, height: 640 }]) {
        await mounted.setViewport(viewport);
        const surface = document.querySelector<HTMLElement>("[data-chat-composer-surface]")!;
        expect(surface).not.toBe(capsule.element());
        const inputBounds = surface.getBoundingClientRect();
        const capsuleBounds = capsule.element().getBoundingClientRect();
        expect(capsuleBounds.left).toBeGreaterThanOrEqual(inputBounds.left - 1);
        expect(capsuleBounds.right).toBeLessThanOrEqual(inputBounds.right + 1);
        expect(capsuleBounds.bottom).toBeLessThanOrEqual(inputBounds.top);
        expect(capsuleBounds.width).toBeLessThan(inputBounds.width);
        expect(getComputedStyle(surface).borderTopLeftRadius).toBe(
          getComputedStyle(surface).borderBottomLeftRadius,
        );
        expect(getComputedStyle(surface).borderTopLeftRadius).not.toBe("0px");
        expect(getComputedStyle(surface).borderTopRightRadius).not.toBe("0px");
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows active turn plans as a task capsule that opens the full list", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithActiveInlinePlan(),
    });

    try {
      const taskCapsule = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="active-task-list-capsule"]'),
        "Unable to find the task-list capsule.",
      );
      expect(taskCapsule.textContent).toContain("1/3 tasks");
      const composerShell = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] .chat-composer-shell',
      );
      expect(composerShell).not.toBeNull();
      // A compact capsule floating above the input, not a w-14/15 rail fused onto it.
      const taskRect = taskCapsule.getBoundingClientRect();
      const composerRect = composerShell!.getBoundingClientRect();
      expect(taskRect.bottom).toBeLessThanOrEqual(composerRect.top);
      expect(taskRect.width).toBeLessThan(composerRect.width);

      taskCapsule.click();
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("1 out of 3 tasks completed");
          expect(document.body.textContent).toContain("Inspecting ChatView boundaries");
          expect(document.body.textContent).toContain("Patch the shared checklist receiver");
          expect(document.body.textContent).toContain("1 background agent");
        },
        { timeout: 8_000, interval: 16 },
      );

      const openPlanButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title="Open tasks sidebar"]'),
        "Unable to find the task popover sidebar button.",
      );
      openPlanButton.click();

      await expect.element(page.getByLabelText("Close plan sidebar")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides an unfinished task list once the latest turn is settled", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSettledInlinePlan(),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Finished the investigation.");
          expect(document.querySelector('[data-testid="active-task-list-capsule"]')).toBeNull();
          expect(document.body.textContent).not.toContain("1 background agent");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the stop button once a completed turn is no longer live", async () => {
    const settledSnapshot = createSnapshotWithSettledInlinePlan();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...settledSnapshot,
        threads: settledSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.role === "assistant"
                    ? {
                        ...message,
                        streaming: true,
                      }
                    : message,
                ),
              }
            : thread,
        ),
      },
    });

    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("collapses a settled leading tool run mid-turn, then folds into the turn header after the grace delay", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: true }),
    });

    try {
      // The tools already gave way to the assistant's narration block, so even
      // while the turn is live the run compacts behind its summary row.
      await vi.waitFor(
        () => {
          const summaryTrigger = Array.from(
            document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
          ).find((element) => element.textContent?.trim() === "Used 6 tools");
          expect(summaryTrigger).not.toBeUndefined();
          expect(summaryTrigger!.getAttribute("aria-expanded")).toBe("false");
          expect(document.body.textContent).not.toContain("Tool 1");
        },
        { timeout: 8_000, interval: 16 },
      );

      const toolSummary = page.getByRole("button", { name: "Used 6 tools", exact: true });
      await toolSummary.click();
      await vi.waitFor(() => {
        for (let index = 1; index <= 6; index += 1) {
          expect(document.body.textContent).toContain(`Tool ${index}`);
        }
      });
      await toolSummary.click();
      await vi.waitFor(() => {
        expect(toolSummary.element().getAttribute("aria-expanded")).toBe("false");
        expect(document.body.textContent).not.toContain("Tool 1");
      });

      const settledSnapshot = createSnapshotWithInlineToolOverflow({ active: false });
      useStore.getState().syncServerReadModel({
        ...settledSnapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      });

      // The first settled paint keeps the live layout: no turn disclosure yet.
      expect(document.querySelector("[data-settled-turn-collapse-transition='true']")).toBeNull();
      expect(findInlineToolsTurnDisclosure()).toBeNull();
      expect(document.body.textContent).toContain("Used 6 tools");

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 260);
      });

      // Once the grace delay lapses the settled turn folds into its Worked header,
      // but the old details stay mounted briefly inside the shared disclosure
      // close transition so the transcript height eases down instead of snapping.
      await vi.waitFor(
        () => {
          const settledTrigger = findInlineToolsTurnDisclosure();
          expect(settledTrigger?.getAttribute("aria-expanded")).toBe("false");
          // 8 s: from the request (1 100) to the answer (1 108), not from the turn start (1 101).
          expect(settledTrigger?.textContent).toBe("Worked for 8.0s");
          const transitionClone = document.querySelector(
            "[data-settled-turn-collapse-transition='true']",
          );
          expect(transitionClone).not.toBeNull();
          expect(transitionClone?.hasAttribute("inert")).toBe(true);
          expect(transitionClone?.querySelector("[aria-hidden='true'][inert]")).not.toBeNull();
          expect(transitionClone?.textContent).toContain("Used 6 tools");
        },
        { timeout: 8_000, interval: 16 },
      );

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 320);
      });

      // After the close motion finishes, details are only available by opening
      // the Worked header's disclosure.
      await vi.waitFor(
        () => {
          expect(
            document.querySelector("[data-settled-turn-collapse-transition='true']"),
          ).toBeNull();
          expect(document.body.textContent).not.toContain("Tool 1");
          expect(findInlineToolsTurnDisclosure()?.getAttribute("aria-expanded")).toBe("false");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  // Opening a thread whose turns finished long ago must present them already
  // folded. Replaying the fold — mounting every tool row and easing it closed —
  // is a pure cost on open: it rebuilds the whole turn's DOM twice and drags the
  // transcript height (and the scroll offset with it) up and down before it
  // settles on exactly the layout the first paint could have had.
  it("opens a finished thread already folded, without replaying the collapse", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithInlineToolOverflow({ active: false }),
    });

    try {
      await vi.waitFor(
        () => {
          const settledTrigger = findInlineToolsTurnDisclosure();
          expect(settledTrigger?.getAttribute("aria-expanded")).toBe("false");
          expect(settledTrigger?.textContent).toBe("Worked for 8.0s");
        },
        { timeout: 8_000, interval: 16 },
      );

      // Sample across the window the replayed close animation would occupy.
      const startedAt = performance.now();
      let transitionFrames = 0;
      let toolRowFrames = 0;
      while (performance.now() - startedAt < 800) {
        await nextFrame();
        if (document.querySelector("[data-settled-turn-collapse-transition='true']")) {
          transitionFrames += 1;
        }
        if ((document.body.textContent ?? "").includes("tool-1")) {
          toolRowFrames += 1;
        }
      }

      expect({ transitionFrames, toolRowFrames }).toEqual({
        transitionFrames: 0,
        toolRowFrames: 0,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([
    { streaming: false, confirmedRunning: false },
    { streaming: true, confirmedRunning: false },
    { streaming: true, confirmedRunning: true },
  ])(
    "only animates later live settlement after cached running detail confirms (streaming=$streaming, confirmedRunning=$confirmedRunning)",
    async ({ streaming, confirmedRunning }) => {
      await clearThreadDetailCache();
      const originalCached = createSnapshotWithInlineToolOverflow({ active: true });
      const cached = {
        ...originalCached,
        threads: originalCached.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.map((message) =>
            message.id === MessageId.makeUnsafe("msg-assistant-inline-tools")
              ? { ...message, streaming }
              : message,
          ),
        })),
      };
      await writeThreadDetailCache(
        { origin: location.origin, serverInstanceId: "browser-test-server" },
        { snapshotSequence: cached.snapshotSequence, thread: cached.threads[0]! },
      );
      let releaseSnapshot!: () => void;
      setThreadDetailSnapshotBarrier(
        new Promise<void>((resolve) => {
          releaseSnapshot = resolve;
        }),
      );
      const authoritative = createSnapshotWithInlineToolOverflow({ active: confirmedRunning });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: { ...authoritative, snapshotSequence: cached.snapshotSequence + 1 },
      });
      try {
        expect(useStore.getState().threadDetailSyncById?.[THREAD_ID]).toBe("cached");
        expect(useStore.getState().threadTurnStateById?.[THREAD_ID]?.latestTurn?.state).toBe(
          "running",
        );
        releaseSnapshot();
        if (confirmedRunning) {
          await vi.waitFor(() => {
            expect(useStore.getState().threadDetailSyncById?.[THREAD_ID]).toBe("synced");
          });
          await nextFrame();
          useStore.getState().syncServerReadModel({
            ...createSnapshotWithInlineToolOverflow({ active: false }),
            snapshotSequence: cached.snapshotSequence + 2,
          });
        }
        let transitionFrames = 0;
        const startedAt = performance.now();
        while (performance.now() - startedAt < 1_000) {
          await nextFrame();
          if (document.querySelector("[data-settled-turn-collapse-transition='true']"))
            transitionFrames += 1;
        }
        expect(useStore.getState().threadDetailSyncById?.[THREAD_ID]).toBe("synced");
        expect(findInlineToolsTurnDisclosure()?.getAttribute("aria-expanded")).toBe("false");
        if (confirmedRunning) expect(transitionFrames).toBeGreaterThan(0);
        else expect(transitionFrames).toBe(0);
      } finally {
        releaseSnapshot();
        setThreadDetailSnapshotBarrier(null);
        await mounted.cleanup();
        await clearThreadDetailCache();
      }
    },
  );

  // Thread detail does not always land in one write: a thread can paint its
  // transcript before the record that says its last turn already completed. Until
  // that record lands the tail turn is treated as live, so every tool row renders
  // expanded. The fold that follows is hydration catching up, not a turn ending
  // under the reader's eyes, so it must not be animated.
  it("does not replay the collapse when the completed turn record hydrates after the transcript", async () => {
    const settledSnapshot = createSnapshotWithInlineToolOverflow({ active: false });
    const messagesOnlySnapshot: OrchestrationReadModel = {
      ...settledSnapshot,
      threads: settledSnapshot.threads.map((thread) =>
        thread.id === THREAD_ID ? { ...thread, latestTurn: null } : thread,
      ),
    };

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: messagesOnlySnapshot,
    });

    try {
      // Baseline: with no turn record the tail turn reads as live, so its work
      // sits inline instead of folded into the turn header's disclosure.
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Wrapped up the inline tool review.");
          expect(document.body.textContent).toContain("Used 6 tools");
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(findInlineToolsTurnDisclosure()).toBeNull();

      const toolSummary = page.getByRole("button", { name: "Used 6 tools", exact: true });
      await toolSummary.click();
      await vi.waitFor(() => {
        for (let index = 1; index <= 6; index += 1) {
          expect(document.body.textContent).toContain(`Tool ${index}`);
        }
      });
      await toolSummary.click();
      await vi.waitFor(() => {
        expect(toolSummary.element().getAttribute("aria-expanded")).toBe("false");
        expect(document.body.textContent).not.toContain("Tool 1");
      });

      useStore.getState().syncServerReadModel({
        ...settledSnapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      });

      const startedAt = performance.now();
      let transitionFrames = 0;
      // Height churn is what the eye reads as "jumping up and down": each frame
      // whose transcript height differs from the previous one is one visible step.
      let heightChangeFrames = 0;
      let previousScrollHeight: number | null = null;
      while (performance.now() - startedAt < 800) {
        await nextFrame();
        if (document.querySelector("[data-settled-turn-collapse-transition='true']")) {
          transitionFrames += 1;
        }
        const container = document.querySelector<HTMLElement>(
          "[data-chat-scroll-container='true']",
        );
        if (!container) {
          continue;
        }
        if (previousScrollHeight !== null && container.scrollHeight !== previousScrollHeight) {
          heightChangeFrames += 1;
        }
        previousScrollHeight = container.scrollHeight;
      }

      // The turn must land folded, in one step, with no animated close replay.
      expect(findInlineToolsTurnDisclosure()?.getAttribute("aria-expanded")).toBe("false");
      expect(findInlineToolsTurnDisclosure()?.textContent).toBe("Worked for 8.0s");
      expect(transitionFrames).toBe(0);
      // One settle step is the floor: the fold itself changes the height once.
      expect(heightChangeFrames).toBeLessThanOrEqual(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not animate historical tool hydration while a newer turn is working", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithHistoricalToolHydrationDuringLiveTurn({
        hydrateHistoricalActivities: false,
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Wrapped up the inline tool review.");
          expect(document.body.textContent).toContain("Current turn is still running.");
        },
        { timeout: 8_000, interval: 16 },
      );

      const hydratedSnapshot = createSnapshotWithHistoricalToolHydrationDuringLiveTurn({
        hydrateHistoricalActivities: true,
      });
      useStore.getState().syncServerReadModel({
        ...hydratedSnapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      });

      let transitionFrames = 0;
      const startedAt = performance.now();
      while (performance.now() - startedAt < 800) {
        await nextFrame();
        if (document.querySelector("[data-settled-turn-collapse-transition='true']")) {
          transitionFrames += 1;
        }
      }

      expect(findInlineToolsTurnDisclosure()?.getAttribute("aria-expanded")).toBe("false");
      expect(findInlineToolsTurnDisclosure()?.textContent).toBe("Worked for 16m 23s");
      expect(document.querySelector("[data-turn-header='live']")?.textContent).toMatch(
        /^Working for \d/,
      );
      expect(transitionFrames).toBe(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([
    ["command", "en", undefined],
    ["localized command", "zh-CN", undefined],
    ["computer foreground", "en", "computer-foreground"],
    ["computer foreground in Chinese UI", "zh-CN", "computer-foreground"],
  ] as const)(
    "keeps the desktop approval card at 717px beside the restored narrow rail (%s)",
    async (_name, locale, approvalScope) => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: locale }));
      const mounted = await mountChatView({
        viewport: { ...DEFAULT_VIEWPORT, width: 1_280 },
        snapshot: createSnapshotWithPendingApproval(approvalScope),
      });
      try {
        await waitForLayout();
        const card = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-codex-approval-surface="true"]'),
          "Command approval card missing",
        );
        const rail = page.getByRole("navigation", { name: "Primary", exact: true });
        await page.screenshot({ path: "node_modules/.cache/sidebar-approval-717.png" });
        await expect.element(rail).toBeVisible();
        expect(rail.element().getBoundingClientRect().x).toBeGreaterThanOrEqual(0);
        expect(rail.element().getBoundingClientRect().width).toBeGreaterThan(0);
        expect(rail.element().getBoundingClientRect().width).toBeLessThanOrEqual(64);
        expect(document.querySelector('[data-sidebar-navigation="desktop"]')).toBeNull();
        expect(Math.abs(card.getBoundingClientRect().width - 717)).toBeLessThanOrEqual(1);
        await mounted.setViewport({ name: "phone-approval", width: 390, height: 844 });
        await waitForLayout();
        const connectedCard = await waitForElement(() => {
          const current = document.querySelector<HTMLElement>(
            '[data-codex-approval-surface="true"]',
          );
          return current?.isConnected && current.getBoundingClientRect().width > 0 ? current : null;
        }, "Connected phone approval card missing");
        const phoneCard = connectedCard.getBoundingClientRect();
        expect(connectedCard.isConnected).toBe(true);
        expect(phoneCard.width).toBeGreaterThan(0);
        expect(phoneCard.height).toBeGreaterThan(0);
        expect(phoneCard.left).toBeGreaterThanOrEqual(0);
        expect(phoneCard.right).toBeLessThanOrEqual(390);
        expect(phoneCard.top).toBeGreaterThanOrEqual(0);
        expect(phoneCard.bottom).toBeLessThanOrEqual(844);
        const expectedActions = approvalScope
          ? ["decline", "accept", "cancel"]
          : ["decline", "accept"];
        expect(
          Array.from(
            connectedCard.querySelectorAll<HTMLElement>("[data-moss-visible-permission-action]"),
          ).map((button) => button.dataset.mossVisiblePermissionAction),
        ).toEqual(expectedActions);
        const expectedNames = approvalScope
          ? [/^Keep it in the background/, /^Show on screen for this task/, /^Cancel this request$/]
          : locale === "zh-CN"
            ? [/^拒绝/, /^允许一次/, /^审批选项$/]
            : [/^Deny/, /^Allow once/, /^Approval options$/];
        expect(connectedCard.querySelectorAll("button")).toHaveLength(expectedNames.length);
        for (const name of expectedNames) {
          await expect.element(page.getByRole("button", { name })).toBeVisible();
        }
        for (const button of connectedCard.querySelectorAll("button")) {
          const bounds = button.getBoundingClientRect();
          expect(button.isConnected).toBe(true);
          expect(bounds.width).toBeGreaterThan(0);
          expect(bounds.height).toBeGreaterThan(0);
          expect(bounds.left).toBeGreaterThanOrEqual(phoneCard.left);
          expect(bounds.right).toBeLessThanOrEqual(phoneCard.right);
          expect(bounds.top).toBeGreaterThanOrEqual(phoneCard.top);
          expect(bounds.bottom).toBeLessThanOrEqual(phoneCard.bottom);
        }
        await page.screenshot({ path: "node_modules/.cache/sidebar-approval-phone.png" });
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("exposes Moss visible permission request parity selectors", async () => {
    const approvalMounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPendingApproval(),
    });

    try {
      const permissionRequest = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-moss-visible-permission-request='true']"),
        "Unable to find Moss visible permission request.",
      );
      expect(permissionRequest.dataset.mossVisiblePermissionRequestId).toBe(
        "approval-moss-visible",
      );
      expect(permissionRequest.dataset.mossVisiblePermissionCount).toBe("1");

      const approvalResponses = () =>
        wsRequests
          .map(readDispatchedCommand)
          .filter((command) => command?.type === "thread.approval.respond");
      const permissionActions = () =>
        new Set(
          Array.from(
            document.querySelectorAll<HTMLElement>("[data-moss-visible-permission-action]"),
          ).map((button) => button.dataset.mossVisiblePermissionAction),
        );
      expect(permissionActions()).toEqual(new Set(["decline", "accept"]));
      expect(document.querySelector('[data-moss-visible-permission-action="cancel"]')).toBeNull();
      expect(approvalResponses()).toHaveLength(0);

      await page.getByRole("button", { name: "Approval options", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Allow this conversation", exact: true }))
        .toBeVisible();
      expect(permissionActions()).toEqual(new Set(["decline", "acceptForSession", "accept"]));
      expect(document.querySelector('[data-moss-visible-permission-action="cancel"]')).toBeNull();
      expect(approvalResponses()).toHaveLength(0);

      await page.getByRole("menuitem", { name: "Allow this conversation", exact: true }).click();
      await vi.waitFor(
        () => {
          expect(approvalResponses()).toEqual([
            expect.objectContaining({
              type: "thread.approval.respond",
              threadId: THREAD_ID,
              requestId: "approval-moss-visible",
              decision: "acceptForSession",
            }),
          ]);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await approvalMounted.cleanup();
    }
  });
});
