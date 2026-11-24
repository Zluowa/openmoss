// FILE: ChatView.composer.browser.tsx
// Purpose: Full-app ChatView browser tests for the composer: sending, model and effort pickers, voice, queued follow-ups, quotes, predictions, provider handoff.
//          The shared fixture is src/test/chatViewBrowserHarness.tsx; every ChatView.*.browser.tsx
//          keeps the one suite name, so case names (and the CI partitions) are unchanged.

import {
  MODEL_OPTIONS_BY_PROVIDER,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type DesktopRealtimeVoiceOverlayCommand,
  type DesktopRealtimeVoiceOverlayHandoff,
  type OrchestrationReadModel,
  ProviderInstanceId,
  type ServerConfig,
  TurnId,
  WS_METHODS,
} from "@moss/contracts";
import { INTERRUPTED_TASK_CONTINUATION_PROMPT } from "@moss/shared/turnResume";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  removeInlineTerminalContextPlaceholder,
} from "../lib/terminalContext";
import { extractTrailingBrowserAnnotations } from "../lib/browserAnnotations";
import { isMacNavigatorPlatform } from "../lib/utils";
import { STARRED_MODELS_STORAGE_KEY } from "../lib/starredModels";
import { readNativeApi } from "../nativeApi";
import {
  endQueuedComposerAutoDispatch,
  tryBeginQueuedComposerAutoDispatch,
} from "../lib/queuedComposerDrain";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { makeDomainEvent } from "../storeTestFixtures";
import { hasUnseenSnoozeReturn } from "./Sidebar.logic";
import {
  ACTIVE_REALTIME_VOICE_STATE,
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_VIEWPORT,
  INACTIVE_REALTIME_VOICE_STATE,
  type MountedChatView,
  NOW_ISO,
  OTHER_THREAD_ID,
  PROJECT_ID,
  REALTIME_VOICE_SESSION_ID,
  THREAD_ID,
  type TestFixture,
  addThreadToSnapshot,
  configureMossManagedDefaults,
  createAssistantMessage,
  createComposerImage,
  createDraftOnlySnapshot,
  createEmptyRealtimeVoiceRouteSnapshot,
  createIssue550Snapshot,
  createRealtimeVoiceRouteSnapshot,
  createSnapshotForTargetUser,
  createSnapshotWithActiveFileChanges,
  createSnapshotWithInterruptedTurn,
  createSnapshotWithSettledPlanAwaitingFollowUp,
  createTerminalContext,
  createUserMessage,
  dispatchComposerFocusToggleShortcut,
  dispatchComposerPickerShortcut,
  dispatchConfiguredShortcut,
  dispatchModelCycleShortcutWhenReady,
  fixture,
  hasDispatchedCommandType,
  installDeterministicSendNativeApi,
  installImageLimitDiagnostics,
  installRealtimeVoiceChatNativeApi,
  isoAt,
  mountChatView,
  nextFrame,
  queryComposerShell,
  readDispatchedCommand,
  setAttachmentUploadBarrier,
  setComposerPredictionSuggestion,
  setFixture,
  setImageLimitFixtureTheme,
  skipReactDevOwnerStacks,
  turnStartText,
  updateInterruptedThreadSnapshot,
  waitForComposerEditor,
  waitForComposerPickerSurfaceOpen,
  waitForElement,
  waitForLayout,
  waitForSendButton,
  waitForServerConfigToApply,
  waitUntilPerformanceTime,
  wsRequests,
  installChatViewFixture,
} from "../test/chatViewBrowserHarness";
import { realtimeVoiceChatHarness } from "../test/chatViewBrowserMocks";

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

  it("serves valid provider discovery responses without disabling composer features", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("provider-discovery-fixture"),
        targetText: "Provider discovery fixture",
      }),
    });
    try {
      const api = readNativeApi()!;
      // Exercise the real RPC decoder, so a generic {} fixture cannot silently
      // turn normal thread switches into repeated background discovery errors.
      await expect(
        api.provider.getComposerCapabilities({ provider: "codex" }),
      ).resolves.toMatchObject({
        provider: "codex",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsPluginMentions: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
      });
      await expect(
        api.provider.getComposerCapabilities({ provider: "claudeAgent" }),
      ).resolves.toMatchObject({
        provider: "claudeAgent",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsThreadImport: true,
      });
      await expect(api.provider.listAgents({ provider: "codex" })).resolves.toMatchObject({
        agents: [],
      });
      for (const input of [
        { provider: "codex", instanceId: ProviderInstanceId.makeUnsafe("missing-instance") },
        { provider: "claudeAgent", instanceId: ProviderInstanceId.makeUnsafe("codex") },
      ] as const) {
        await expect(api.provider.getComposerCapabilities(input)).rejects.toThrow(
          /Unknown or mismatched provider instance/,
        );
      }
      // Failed requests must leave the shared connection usable for later RPCs.
      await expect(
        api.provider.listSkills({ provider: "codex", cwd: "/repo/project" }),
      ).resolves.toMatchObject({ skills: [] });
      await expect(
        api.provider.listPlugins({ provider: "codex", cwd: "/repo/project" }),
      ).resolves.toMatchObject({ marketplaces: [] });
      await expect(
        api.provider.listCommands({ provider: "claudeAgent", cwd: "/repo/project" }),
      ).resolves.toMatchObject({ commands: [] });
      fixture.serverSettings = {
        ...fixture.serverSettings,
        providerInstances: {
          ...fixture.serverSettings.providerInstances,
          codex: { driver: "codex", enabled: false, config: {} },
        },
      };
      await expect(api.provider.getComposerCapabilities({ provider: "codex" })).resolves.toEqual({
        provider: "codex",
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: false,
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps near-cap composer work bounded while live activities arrive", async () => {
    onTestFinished(skipReactDevOwnerStacks());
    const percentile = (samples: readonly number[], fraction: number): number => {
      const ordered = [...samples].sort((left, right) => left - right);
      return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0;
    };
    const cases = [
      { name: "short", messageCount: 10, activityCount: 20 },
      { name: "near-cap", messageCount: 81, activityCount: 1_609 },
    ] as const;
    const measure = async (benchmarkCase: (typeof cases)[number]) => {
      const commits: number[] = [];
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createIssue550Snapshot(benchmarkCase),
        onRender: (_id, phase, actualDuration) => {
          if (phase === "update") commits.push(actualDuration);
        },
      });
      try {
        const editor = await waitForComposerEditor();
        await userEvent.click(editor);
        commits.length = 0;
        // Hydration lands in waves (shell snapshot, then the throttled thread-detail
        // flush) and each wave replaces the activity list wholesale, erasing early
        // live appends. Measure only after the list has been complete and quiet for
        // a full flush cycle.
        const activityCount = () =>
          useStore.getState().activityIdsByThreadId?.[THREAD_ID]?.length ?? -1;
        await vi.waitFor(() => expect(activityCount()).toBe(benchmarkCase.activityCount));
        // Bigger fixtures flush in more waves; require the count to be unchanged
        // across a full flush cycle before the measured loop starts.
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        await vi.waitFor(() => expect(activityCount()).toBe(benchmarkCase.activityCount));
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        await vi.waitFor(() => expect(activityCount()).toBe(benchmarkCase.activityCount));

        const inputToPaintMs: number[] = [];
        const fixtureThread = () =>
          fixture.snapshot.threads.find((thread) => thread.id === THREAD_ID)!;
        for (let index = 0; index < 12; index += 1) {
          const startedAt = performance.now();
          const liveActivity = {
            id: EventId.makeUnsafe(`activity-issue-550-live-${index}`),
            createdAt: isoAt(benchmarkCase.messageCount * 2 + benchmarkCase.activityCount + index),
            kind: "tool.completed" as const,
            summary: `live tool ${index}`,
            tone: "tool" as const,
            turnId: null,
            payload: {
              itemType: "dynamic_tool_call",
              toolName: `live-tool-${index}`,
            },
          };
          // Projection reads must see the live activity too: a later projection
          // snapshot replaces the client list wholesale, so a client-only injection
          // would be erased on the next reconcile.
          const thread = fixtureThread();
          fixture.snapshot = {
            ...fixture.snapshot,
            threads: fixture.snapshot.threads.map((candidate) =>
              candidate.id === THREAD_ID
                ? { ...candidate, activities: [...candidate.activities, liveActivity] }
                : candidate,
            ),
          };
          useStore.getState().applyOrchestrationEventsHotPath([
            makeDomainEvent(
              "thread.activity-appended",
              {
                threadId: THREAD_ID,
                activity: {
                  id: liveActivity.id,
                  createdAt: liveActivity.createdAt,
                  kind: "tool.completed",
                  summary: liveActivity.summary,
                  tone: "tool",
                  turnId: null,
                  payload: {
                    itemType: "dynamic_tool_call",
                    toolName: `live-tool-${index}`,
                  },
                },
              },
              { sequence: benchmarkCase.activityCount + index + 1 },
            ),
          ]);
          await userEvent.keyboard("x");
          await nextFrame();
          inputToPaintMs.push(performance.now() - startedAt);
        }

        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          "x".repeat(12),
        );
        // A reconcile wave in flight during the loop can briefly erase the newest
        // append; the fixture snapshot now carries every live activity, so the
        // state converges on the next reconcile.
        await vi.waitFor(() =>
          expect(useStore.getState().activityIdsByThreadId?.[THREAD_ID]).toHaveLength(
            benchmarkCase.activityCount + 12,
          ),
        );
        return {
          name: benchmarkCase.name,
          inputP95Ms: percentile(inputToPaintMs, 0.95),
          reactCommitTotalMs: commits.reduce((total, duration) => total + duration, 0),
        };
      } finally {
        await mounted.cleanup();
        useComposerDraftStore.setState({ draftsByThreadId: {} });
      }
    };

    // Run the full measured path once per case first: a mount alone leaves the
    // live-activity path cold, and the first near-cap sample was the slowest.
    for (const benchmarkCase of cases) await measure(benchmarkCase);

    // Pair each short run with a near-cap run. One noisy profiler sample on a
    // shared CI worker must not decide whether the limit is met.
    const reports: Array<Awaited<ReturnType<typeof measure>> & { sample: number }> = [];
    const ratios: number[] = [];
    for (let sample = 0; sample < 3; sample += 1) {
      const short = { sample, ...(await measure(cases[0])) };
      const nearCap = { sample, ...(await measure(cases[1])) };
      reports.push(short, nearCap);
      ratios.push(nearCap.reactCommitTotalMs / short.reactCommitTotalMs);
    }

    const medianRatio = ratios.sort((left, right) => left - right)[1]!;
    // Preserve the existing Issue #550 regression limit after the performance changes.
    expect(
      medianRatio,
      `Issue #550 benchmark: ${JSON.stringify({ reports, ratios })}`,
    ).toBeLessThan(2.5);
  });

  describe("provider handoff destination", () => {
    const withClaudeReady = (nextFixture: TestFixture) => {
      const providers: ServerConfig["providers"] = [
        ...nextFixture.serverConfig.providers,
        {
          provider: "claudeAgent",
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: NOW_ISO,
        },
      ];
      nextFixture.serverConfig = { ...nextFixture.serverConfig, providers };
      nextFixture.providerStatusesSnapshot = providers;
    };

    async function mountWithCapturedCommands(
      snapshot: OrchestrationReadModel = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-handoff-destination"),
        targetText: "Fix the flaky reconnect test",
      }),
      // Models the server's reaction to a dispatched command.
      respond?: (
        command: Parameters<
          NonNullable<typeof window.nativeApi>["orchestration"]["dispatchCommand"]
        >[0],
      ) => void,
      respondDelayMs = 50,
      configureFixture: (fixture: TestFixture) => void = withClaudeReady,
    ) {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot,
        configureFixture,
      });
      const previousNativeApi = window.nativeApi;
      const api = readNativeApi()!;
      const commands: Array<Parameters<typeof api.orchestration.dispatchCommand>[0]> = [];
      const dispatchCommand = vi.fn(
        async (command: Parameters<typeof api.orchestration.dispatchCommand>[0]) => {
          commands.push(command);
          if (respond) setTimeout(() => respond(command), respondDelayMs);
          return { sequence: fixture.snapshot.snapshotSequence };
        },
      );
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: { ...api, orchestration: { ...api.orchestration, dispatchCommand } },
      });
      await waitForServerConfigToApply();
      return {
        commands,
        setViewport: mounted.setViewport,
        cleanup: async () => {
          if (previousNativeApi)
            Object.defineProperty(window, "nativeApi", {
              configurable: true,
              value: previousNativeApi,
            });
          else Reflect.deleteProperty(window, "nativeApi");
          await mounted.cleanup();
        },
      };
    }

    async function openHandoffMenu() {
      const trigger = page.getByRole("button", { name: "Hand off thread" });
      await expect.element(trigger).toBeEnabled();
      // The first click can land while the chat is still hydrating and the menu
      // closes again; reopen until the destinations render.
      await vi.waitFor(
        async () => {
          if (!document.querySelector("[data-handoff-destination]")) {
            await trigger.click();
          }
          expect(document.querySelector("[data-handoff-destination]")).not.toBeNull();
        },
        { timeout: 10_000, interval: 500 },
      );
      await expect.element(page.getByText("Continue in this thread")).toBeVisible();
      await expect.element(page.getByText("Continue in a new thread")).toBeVisible();
    }

    it.each([
      {
        provider: "claudeAgent" as const,
        model: "claude-opus-4-6",
        sessionStatus: "ready" as const,
      },
      {
        provider: "codex" as const,
        model: "gpt-5.3-codex",
        sessionStatus: "ready" as const,
      },
      {
        provider: "claudeAgent" as const,
        model: "claude-opus-4-6",
        sessionStatus: "running" as const,
      },
      {
        provider: "codex" as const,
        model: "gpt-5.3-codex",
        sessionStatus: "running" as const,
      },
    ])(
      "shows a dismissible pre-send tip above the composer when leaving Claude for $provider ($sessionStatus)",
      async ({ provider, model, sessionStatus }) => {
        const snapshot = createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("msg-claude-model-switch"),
          targetText: "Continue the task",
          sessionStatus,
        });
        const thread = snapshot.threads[0]!;
        const claudeSnapshot: OrchestrationReadModel = {
          ...snapshot,
          threads: [
            {
              ...thread,
              modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
              session: { ...thread.session!, providerName: "claudeAgent" },
            },
          ],
        };
        const mounted = await mountWithCapturedCommands(
          claudeSnapshot,
          respondToHandoff("completed"),
        );
        try {
          await waitForServerConfigToApply();
          const note = page.getByTestId("composer-claude-model-switch-note");
          await expect.element(note).not.toBeInTheDocument();
          const surface = document.querySelector<HTMLElement>("[data-chat-composer-surface]")!;
          const originalHeight = surface.getBoundingClientRect().height;
          useComposerDraftStore.getState().setModelSelection(THREAD_ID, { provider, model });
          await vi.waitFor(() => expect(note.query()).not.toBeNull(), { timeout: 3_000 });
          await expect.element(note).toBeVisible();
          expect(surface.contains(note.element())).toBe(false);
          // Stacked panels share the composer's top border by one pixel.
          expect(note.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
            surface.getBoundingClientRect().top + 1,
          );
          expect(surface.getBoundingClientRect().height).toBeCloseTo(originalHeight, 0);
          await expect
            .element(note)
            .toHaveTextContent(provider === "claudeAgent" ? "Next reply" : "new provider");
          expect(document.querySelector('[role="alertdialog"]')).toBeNull();
          expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();
          useComposerDraftStore.getState().setPrompt(THREAD_ID, "Continue the task");
          if (sessionStatus === "ready") {
            await expect
              .element(page.getByRole("button", { name: "Send message", exact: true }))
              .toBeEnabled();
          } else {
            await expect
              .element(page.getByRole("button", { name: "Stop generation", exact: true }))
              .toBeVisible();
          }
          const screenshotName =
            provider === "claudeAgent"
              ? "claude-model-switch-note"
              : "claude-provider-handoff-note";
          await page.screenshot({
            path: `../../../../output/playwright/${screenshotName}.png`,
          });
          await mounted.setViewport({ name: "narrow", width: 480, height: 640 });
          await expect.element(note).toBeVisible();
          expect(surface.contains(note.element())).toBe(false);
          await page.screenshot({
            path: `../../../../output/playwright/${screenshotName}-narrow.png`,
          });
          await note.getByRole("button", { name: "Dismiss tip" }).click();
          await expect.element(note).not.toBeInTheDocument();

          useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
            options: { effort: "high" },
          });
          await expect.element(note).not.toBeInTheDocument();
          useComposerDraftStore.getState().setModelSelection(THREAD_ID, { provider, model });
          await expect.element(note).toBeVisible();
          document
            .querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]')!
            .requestSubmit();
          const handoffBlocked = sessionStatus === "running" && provider !== "claudeAgent";
          if (handoffBlocked) {
            await vi.waitFor(() =>
              expect(document.body.textContent).toContain("Cannot switch to Codex yet"),
            );
            expect(mounted.commands).toHaveLength(0);
            expect(
              useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns,
            ).toHaveLength(0);
            await expect.element(note).toBeVisible();
          } else if (sessionStatus === "running") {
            await vi.waitFor(() => {
              expect(
                useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns[0],
              ).toMatchObject({ kind: "chat", modelSelection: { provider, model } });
              expect(document.querySelector('[data-testid="queued-follow-up-row"]')).not.toBeNull();
            });
            expect(fixture.snapshot.threads[0]?.modelSelection.provider).toBe("claudeAgent");
            expect(fixture.snapshot.threads[0]?.session?.status).toBe("running");
          } else {
            await vi.waitFor(() =>
              expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
                true,
              ),
            );
          }
          if (!handoffBlocked) {
            await expect.element(note).not.toBeInTheDocument();
          }
        } finally {
          await mounted.cleanup();
        }
      },
    );

    it("continues in the same thread by rebinding its provider", async () => {
      const mounted = await mountWithCapturedCommands(undefined, respondToHandoff("completed"));
      try {
        await openHandoffMenu();
        const sameThreadItem = document.querySelector<HTMLElement>(
          '[data-handoff-destination="this-thread"]',
        );
        expect(sameThreadItem?.textContent).toContain("Claude");
        sameThreadItem!.click();
        await vi.waitFor(() => expect(mounted.commands).toHaveLength(1));
        expect(mounted.commands[0]).toMatchObject({
          type: "thread.meta.update",
          threadId: THREAD_ID,
          providerHandoff: true,
          modelSelection: { provider: "claudeAgent" },
        });
        // The handoff waits for its durable outcome, not just command admission.
        // Settle it before unmounting so its timeout cannot toast over a later test.
        await vi.waitFor(() =>
          expect(fixture.snapshot.threads[0]?.modelSelection.provider).toBe("claudeAgent"),
        );
        // Same thread: no new thread, and the route stays put.
        expect(mounted.commands.some((command) => command.type === "thread.handoff.create")).toBe(
          false,
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("still hands off to a new thread with the imported transcript", async () => {
      const mounted = await mountWithCapturedCommands();
      try {
        await openHandoffMenu();
        document.querySelector<HTMLElement>('[data-handoff-destination="new-thread"]')!.click();
        await vi.waitFor(() =>
          expect(mounted.commands.some((command) => command.type === "thread.handoff.create")).toBe(
            true,
          ),
        );
        const create = mounted.commands.find((command) => command.type === "thread.handoff.create");
        expect(create).toMatchObject({
          sourceThreadId: THREAD_ID,
          projectId: PROJECT_ID,
          modelSelection: { provider: "claudeAgent" },
        });
        expect(create && "threadId" in create ? create.threadId : null).not.toBe(THREAD_ID);
        expect(
          create && "importedMessages" in create
            ? create.importedMessages.some((message) =>
                message.text.includes("Fix the flaky reconnect test"),
              )
            : false,
        ).toBe(true);
        expect(mounted.commands.some((command) => command.type === "thread.meta.update")).toBe(
          false,
        );
      } finally {
        await mounted.cleanup();
      }
    });

    // Server reaction to a same-thread handoff: the outcome row keyed by the
    // command, plus (on success) the thread rebound to the target provider.
    const respondToHandoff =
      (outcome: "completed" | "failed") =>
      (
        command: Parameters<
          NonNullable<typeof window.nativeApi>["orchestration"]["dispatchCommand"]
        >[0],
      ) => {
        if (command.type !== "thread.meta.update" || command.providerHandoff !== true) return;
        const { commandId, modelSelection } = command;
        const targetProvider = modelSelection?.provider ?? "claudeAgent";
        const targetModel = modelSelection?.model ?? "claude-sonnet-4-6";
        fixture.snapshot = {
          ...fixture.snapshot,
          snapshotSequence: fixture.snapshot.snapshotSequence + 1,
          threads: fixture.snapshot.threads.map((thread) =>
            thread.id !== THREAD_ID
              ? thread
              : {
                  ...thread,
                  ...(outcome === "completed"
                    ? {
                        modelSelection: {
                          provider: targetProvider,
                          model: targetModel,
                        },
                        session: {
                          threadId: THREAD_ID,
                          status: "ready" as const,
                          providerName: targetProvider,
                          providerInstanceId: modelSelection?.instanceId ?? targetProvider,
                          runtimeMode: "full-access" as const,
                          activeTurnId: null,
                          lastError: null,
                          updatedAt: NOW_ISO,
                        },
                      }
                    : {}),
                  activities: [
                    ...thread.activities,
                    {
                      id: EventId.makeUnsafe(
                        outcome === "completed"
                          ? `provider-handoff:${commandId}`
                          : `provider-handoff-failed:${commandId}`,
                      ),
                      createdAt: new Date().toISOString(),
                      kind:
                        outcome === "completed" ? "provider.handoff" : "provider.handoff.failed",
                      summary: outcome === "completed" ? "Handed off" : "Handoff failed",
                      tone: outcome === "completed" ? ("info" as const) : ("error" as const),
                      turnId: null,
                      sequence: 950,
                      payload: {
                        sourceProvider: thread.modelSelection.provider,
                        sourceModel: thread.modelSelection.model,
                        targetProvider,
                        targetModel,
                        ...(outcome === "failed" ? { detail: "Claude CLI is not signed in." } : {}),
                      },
                    },
                  ],
                },
          ),
        };
        useStore.getState().syncServerReadModel(fixture.snapshot);
      };

    async function pickClaudeAndSend(text: string) {
      useComposerDraftStore.getState().setModelSelectionAndSticky(THREAD_ID, {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
      });
      useComposerDraftStore.getState().setPrompt(THREAD_ID, text);
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => expect(composerEditor.textContent ?? "").toContain(text), {
        timeout: 8_000,
        interval: 16,
      });
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      sendButton.click();
      return composerEditor;
    }

    it("offers a Moss handoff from the composer when personal usage runs out", async () => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "quota-limit-message" as MessageId,
        targetText: "Help me compare the options.",
        targetIndex: 0,
        messagePairCount: 1,
        sessionStatus: "error",
      });
      const limitedSnapshot = {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          session: {
            ...thread.session!,
            providerInstanceId: "codex",
            lastError: "You've hit your usage limit. Try again at Nov 23rd, 2026 11:00 PM.",
          },
        })),
      };
      const mounted = await mountWithCapturedCommands(
        limitedSnapshot,
        respondToHandoff("completed"),
        50,
        configureMossManagedDefaults,
      );
      try {
        const banner = page.getByTestId("personal-usage-limit-banner");
        const editor = await waitForComposerEditor();
        await expect.element(banner).toBeVisible();
        await expect.element(page.getByText("assistant filler 0", { exact: true })).toBeVisible();
        expect(banner.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
          editor.getBoundingClientRect().top,
        );
        await banner.getByRole("button", { name: "Switch to Moss" }).click();
        await vi.waitFor(() => {
          expect(
            document
              .querySelector("[data-moss-visible-composer-shell]")
              ?.getAttribute("data-moss-visible-provider-instance"),
          ).toBe("codex_moss");
          expect(document.querySelector('[data-testid="personal-usage-limit-banner"]')).toBeNull();
        });
        useComposerDraftStore.getState().setPrompt(THREAD_ID, "Continue the comparison.");
        const send = await waitForSendButton();
        await vi.waitFor(() => expect(send.disabled).toBe(false));
        send.click();
        await vi.waitFor(
          () => {
            expect(mounted.commands).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  threadId: THREAD_ID,
                  type: "thread.meta.update",
                  providerHandoff: true,
                  modelSelection: expect.objectContaining({ instanceId: "codex_moss" }),
                }),
                expect.objectContaining({
                  threadId: THREAD_ID,
                  type: "thread.turn.start",
                  modelSelection: expect.objectContaining({ instanceId: "codex_moss" }),
                }),
              ]),
            );
          },
          { timeout: 8_000 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("hands the thread off before sending when the composer picks another provider", async () => {
      // The target takes a while to start; the message must show meanwhile.
      const mounted = await mountWithCapturedCommands(
        undefined,
        respondToHandoff("completed"),
        1_500,
      );
      try {
        await pickClaudeAndSend("Review the reconnect fix");
        await vi.waitFor(
          () =>
            expect(
              [...document.querySelectorAll('[data-message-role="user"]')].some((row) =>
                (row.textContent ?? "").includes("Review the reconnect fix"),
              ),
            ).toBe(true),
          { timeout: 1_000, interval: 16 },
        );
        expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
          false,
        );
        await vi.waitFor(
          () =>
            expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
              true,
            ),
          { timeout: 8_000, interval: 16 },
        );
        const handoffIndex = mounted.commands.findIndex(
          (command) => command.type === "thread.meta.update" && "providerHandoff" in command,
        );
        const turnStartIndex = mounted.commands.findIndex(
          (command) => command.type === "thread.turn.start",
        );
        expect(mounted.commands[handoffIndex]).toMatchObject({
          threadId: THREAD_ID,
          providerHandoff: true,
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        });
        const handoffActivity = fixture.snapshot.threads
          .find((thread) => thread.id === THREAD_ID)!
          .activities.find((activity) => activity.kind === "provider.handoff")!;
        const sentTurn = mounted.commands[turnStartIndex]!;
        expect(sentTurn.type).toBe("thread.turn.start");
        if (sentTurn.type !== "thread.turn.start") throw new Error("Expected turn start");
        expect(Date.parse(sentTurn.createdAt)).toBeGreaterThan(
          Date.parse(handoffActivity.createdAt),
        );
        await vi.waitFor(() => {
          const divider = document.querySelector('[data-provider-handoff-divider="true"]')!;
          const userMessage = [...document.querySelectorAll('[data-message-role="user"]')].find(
            (row) => (row.textContent ?? "").includes("Review the reconnect fix"),
          )!;
          expect(
            divider.compareDocumentPosition(userMessage) & Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy();
        });
        // The message only goes out once the target is up, and to the target.
        expect(turnStartIndex).toBeGreaterThan(handoffIndex);
        expect(mounted.commands[turnStartIndex]).toMatchObject({
          threadId: THREAD_ID,
          modelSelection: { provider: "claudeAgent" },
        });
        expect(mounted.commands.some((command) => command.type === "thread.handoff.create")).toBe(
          false,
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("never persists a provider switch before its explicit handoff", async () => {
      const mounted = await mountWithCapturedCommands(undefined, respondToHandoff("completed"));
      try {
        await pickClaudeAndSend("Continue on the selected provider");
        await vi.waitFor(() =>
          expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
            true,
          ),
        );
        // An ordinary metadata update changes the durable provider immediately.
        // Persisting Claude first makes the real decider refuse the later
        // explicit handoff as a same-provider switch, and loses source provenance.
        const providerUpdates = mounted.commands.filter(
          (command) =>
            command.type === "thread.meta.update" &&
            command.modelSelection?.provider === "claudeAgent",
        );
        expect(providerUpdates[0]).toMatchObject({ providerHandoff: true });
      } finally {
        await mounted.cleanup();
      }
    });

    it("hands off the captured selection when the picker changes during attachment upload", async () => {
      let releaseUpload = () => {};
      setAttachmentUploadBarrier(
        new Promise<void>((resolve) => {
          releaseUpload = resolve;
        }),
      );
      const mounted = await mountWithCapturedCommands(undefined, respondToHandoff("completed"));
      try {
        useComposerDraftStore.getState().addImage(
          THREAD_ID,
          createComposerImage({
            id: "handoff-upload-image",
            previewUrl: "blob:handoff-upload-image",
          }),
        );
        await pickClaudeAndSend("Continue after uploading");
        // The optimistic row proves this send captured Claude and is now waiting
        // on its real attachment route, before preparing the provider handoff.
        await vi.waitFor(() =>
          expect(
            [...document.querySelectorAll('[data-message-role="user"]')].some((row) =>
              (row.textContent ?? "").includes("Continue after uploading"),
            ),
          ).toBe(true),
        );
        useComposerDraftStore.getState().setModelSelectionAndSticky(THREAD_ID, {
          provider: "codex",
          model: "gpt-5.5",
        });
        // The composer trigger shows the model without its family prefix ("5.5").
        await vi.waitFor(() =>
          expect(
            document.querySelector<HTMLButtonElement>(
              'button[aria-label="Change model and reasoning"]',
            )?.textContent ?? "",
          ).toContain("5.5"),
        );
        releaseUpload();
        await vi.waitFor(() =>
          expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
            true,
          ),
        );
        expect(
          mounted.commands.find(
            (command) => command.type === "thread.meta.update" && command.providerHandoff === true,
          ),
        ).toMatchObject({
          threadId: THREAD_ID,
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        });
        expect(
          mounted.commands.find((command) => command.type === "thread.turn.start"),
        ).toMatchObject({ modelSelection: { provider: "claudeAgent" } });
      } finally {
        releaseUpload();
        setAttachmentUploadBarrier(null);
        await mounted.cleanup();
      }
    });

    it("keeps the message in the composer when the picked provider cannot start", async () => {
      const mounted = await mountWithCapturedCommands(undefined, respondToHandoff("failed"));
      try {
        const composerEditor = await pickClaudeAndSend("Review the reconnect fix");
        await expect
          .element(page.getByText("Claude could not start: Claude CLI is not signed in."))
          .toBeVisible();
        expect(mounted.commands.some((command) => command.type === "thread.turn.start")).toBe(
          false,
        );
        // The send rolled back: the message left the transcript for the composer.
        await vi.waitFor(() =>
          expect(composerEditor.textContent ?? "").toContain("Review the reconnect fix"),
        );
        expect(
          [...document.querySelectorAll('[data-message-role="user"]')].some((row) =>
            (row.textContent ?? "").includes("Review the reconnect fix"),
          ),
        ).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });

    it("shows the handoff event with its source, target, and transferred context", async () => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-handoff-event"),
        targetText: "Fix the flaky reconnect test",
      });
      const thread = snapshot.threads[0]!;
      const handedOffThread = {
        ...thread,
        modelSelection: { provider: "claudeAgent" as const, model: "claude-sonnet-4-6" },
        activities: [
          {
            id: EventId.makeUnsafe("provider-handoff:event"),
            // Mid-conversation: after an assistant reply, before the next user
            // message, where it used to fold into the settled turn's work group.
            createdAt: isoAt(124),
            kind: "provider.handoff",
            summary: "Handed off from Codex (gpt-5) to Claude (claude-sonnet-4-6)",
            tone: "info" as const,
            turnId: null,
            sequence: 900,
            payload: {
              sourceProvider: "codex",
              sourceModel: "gpt-5.5",
              targetProvider: "claudeAgent",
              targetModel: "claude-sonnet-4-6",
              contextText: "Most recent imported messages:\nUser:\nFix the flaky reconnect test",
              sourceModelSelection: {
                provider: "codex",
                model: "gpt-5.5",
                options: { reasoningEffort: "high", fastMode: true },
              },
              targetModelSelection: {
                provider: "claudeAgent",
                model: "claude-sonnet-4-6",
                options: { effort: "medium" },
              },
              contextCharacters: 66,
            },
          },
        ],
      };
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: { ...snapshot, threads: [handedOffThread] },
        configureFixture: withClaudeReady,
      });
      try {
        // A transcript boundary of its own, naming both models, not a work row.
        const divider = await vi.waitFor(() => {
          const element = document.querySelector<HTMLElement>(
            '[data-provider-handoff-divider="true"]',
          );
          expect(element).not.toBeNull();
          return element!;
        });
        expect(divider.textContent).toContain("Context handoff");
        expect(divider.textContent).toContain("GPT-5.5");
        expect(divider.textContent).toContain("Claude Sonnet 4.6");
        // Effort and fast mode read like the composer's model trigger.
        expect(divider.textContent).toContain("High");
        expect(divider.textContent).toContain("Medium");
        expect(divider.querySelector('[aria-label="Fast mode"]')).not.toBeNull();
        divider.querySelector("button")!.click();
        await expect.element(page.getByText("Transferred context", { exact: true })).toBeVisible();
        const context = document.querySelector('[data-provider-handoff-context="true"]');
        expect(context?.textContent).toContain("Fix the flaky reconnect test");
        // The transcript before the handoff stays in place.
        await expect.element(page.getByText("assistant filler 21")).toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    });
  });

  it("uses the persisted thread access mode instead of a stale composer draft", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-runtime-stale-draft" as MessageId,
      targetText: "Hub worker awaiting approval",
    });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) =>
        Object.assign({}, thread, {
          runtimeMode: "approval-required" as const,
          session: thread.session
            ? { ...thread.session, runtimeMode: "approval-required" as const }
            : null,
        }),
      ),
    };
    useComposerDraftStore.getState().setRuntimeMode(THREAD_ID, "full-access");
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await expect
        .element(page.getByRole("button", { name: "Change permissions", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Change permissions", exact: true }))
        .toHaveTextContent("Ask for approval");
      const trigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title^="Ask for approval:"]'),
        "Missing persisted access mode trigger",
      );
      trigger.click();
      const fullAccess = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim().startsWith("Full access"),
          ) ?? null,
        "Missing Full access override",
      );
      fullAccess.click();
      // Moss applies Full access only after the existing confirmation.
      await expect.element(page.getByRole("alertdialog")).toBeVisible();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await vi.waitFor(() => {
        expect(
          wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.runtime-mode.set")
            .map((command) => command?.runtimeMode),
        ).toEqual(["full-access"]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches a rapid access-mode reversal while the server projection is stale", async () => {
    const baseSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-runtime-reversal" as MessageId,
      targetText: "runtime reversal",
    });
    const snapshot: OrchestrationReadModel = {
      ...baseSnapshot,
      threads: baseSnapshot.threads.map((thread) => ({
        ...thread,
        runtimeMode: "approval-required",
        session: thread.session
          ? {
              ...thread.session,
              runtimeMode: "approval-required",
            }
          : null,
      })),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      const supervisedTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title^="Ask for approval:"]'),
        "Unable to find the Ask for approval access-mode trigger.",
      );
      supervisedTrigger.click();
      const autoOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim().startsWith("Approve for me"),
          ) ?? null,
        "Unable to find the Approve for me access-mode option.",
      );
      autoOption.click();

      const autoTrigger = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[title^="Approve for me:"]'),
        "Approve for me did not become the acknowledged composer access mode.",
      );
      autoTrigger.click();
      const supervisedOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim().startsWith("Ask for approval"),
          ) ?? null,
        "Unable to find the Ask for approval access-mode option.",
      );
      supervisedOption.click();

      await vi.waitFor(
        () => {
          const runtimeModes = wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.runtime-mode.set")
            .map((command) => command?.runtimeMode);
          expect(runtimeModes).toEqual(["auto", "approval-required"]);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates composer automations as heartbeat runs on the current chat", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-current-chat-automation" as MessageId,
        targetText: "current chat automation target",
      }),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "/automation say hi every 15 seconds 3 times total");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const automationCreateRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.automationCreate,
          );
          expect(automationCreateRequest).toMatchObject({
            _tag: WS_METHODS.automationCreate,
            mode: "heartbeat",
            targetThreadId: THREAD_ID,
            sourceThreadId: THREAD_ID,
            worktreeMode: "auto",
            maxIterations: 3,
            prompt: "say hi",
            schedule: { type: "interval", everySeconds: 15 },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();

      expect(hasDispatchedCommandType("thread.create")).toBe(false);
      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("promotes draft chats before creating composer heartbeat automations", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: "feature/draft-automation",
          worktreePath: "/repo/worktrees/draft-automation",
          envMode: "worktree",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: {
        reasoningEffort: "low",
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_ID, "/automation say hi every 15 seconds for 3 times");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await vi.waitFor(
        () => {
          const createThreadIndex = wsRequests.findIndex((request) => {
            const command = readDispatchedCommand(request);
            return command?.type === "thread.create" && command.threadId === THREAD_ID;
          });
          const automationCreateIndex = wsRequests.findIndex(
            (request) => request._tag === WS_METHODS.automationCreate,
          );
          expect(createThreadIndex).toBeGreaterThanOrEqual(0);
          expect(automationCreateIndex).toBeGreaterThan(createThreadIndex);

          const createThreadCommand = readDispatchedCommand(wsRequests[createThreadIndex]!);
          expect(createThreadCommand).toMatchObject({
            type: "thread.create",
            threadId: THREAD_ID,
            createdAt: expect.any(String),
            envMode: "worktree",
            branch: "feature/draft-automation",
            worktreePath: "/repo/worktrees/draft-automation",
            associatedWorktreePath: "/repo/worktrees/draft-automation",
            associatedWorktreeBranch: "feature/draft-automation",
            associatedWorktreeRef: "feature/draft-automation",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                reasoningEffort: "low",
              },
            },
            runtimeMode: "full-access",
            interactionMode: "default",
          });
          expect(createThreadCommand?.createdAt).not.toBe(NOW_ISO);

          expect(wsRequests[automationCreateIndex]).toMatchObject({
            _tag: WS_METHODS.automationCreate,
            mode: "heartbeat",
            targetThreadId: THREAD_ID,
            sourceThreadId: THREAD_ID,
            worktreeMode: "auto",
            maxIterations: 3,
            prompt: "say hi",
            schedule: { type: "interval", everySeconds: 15 },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();

      expect(hasDispatchedCommandType("thread.turn.start")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not promote draft chats until a reviewed automation is submitted", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "/automation say hi every 15 seconds");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("say hi every 15 seconds");
        },
        { timeout: 8_000, interval: 16 },
      );

      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await expect.element(page.getByText("Fast recurring loop")).toBeInTheDocument();
      expect(hasDispatchedCommandType("thread.create")).toBe(false);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.automationCreate)).toBe(
        false,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("cycles model effort with Shift+Tab in the existing model picker", async () => {
    localStorage.setItem("moss:app-settings:v1", JSON.stringify({ composerEffortSlider: true }));
    localStorage.setItem(
      STARRED_MODELS_STORAGE_KEY,
      JSON.stringify([
        { provider: "codex", model: "gpt-5.4", effort: "medium", fastMode: true, thinking: null },
      ]),
    );
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "medium", fastMode: true },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });
    const focusTarget = document.createElement("button");
    focusTarget.type = "button";
    focusTarget.textContent = "Focus sink";
    document.body.appendChild(focusTarget);

    try {
      await waitForServerConfigToApply();
      const readInteractionMode = () =>
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode ?? "default";
      const readModelSelection = () =>
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
          .codex;
      expect(readInteractionMode()).toBe("default");

      focusTarget.focus();
      focusTarget.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect(readInteractionMode()).toBe("default");
      expect(readModelSelection()).toMatchObject({ options: { reasoningEffort: "medium" } });
      expect(document.querySelector('[role="slider"][aria-label="Reasoning effort"]')).toBeNull();

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      const searchbox = page.getByRole("searchbox", { name: "Search models" });
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();
      expect(readModelSelection()).toMatchObject({ options: { reasoningEffort: "medium" } });
      expect(document.querySelector('[role="slider"][aria-label="Reasoning effort"]')).toBeNull();
      let shortcutTarget: HTMLElement = composerEditor;
      for (const [effort, label] of [
        ["high", "High"],
        ["xhigh", "Extra High"],
        ["low", "Low"],
      ] as const) {
        const event = new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        shortcutTarget.dispatchEvent(event);
        await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
        // The agent column beside the models shows the starred list as the open one.
        await expect
          .element(
            page
              .getByRole("group", { name: /^(?:Agent|智能体)$/u })
              .getByRole("menuitem", { name: /^(?:Starred|收藏)$/u }),
          )
          .toHaveAttribute("aria-current", "true");
        await expect.element(page.getByRole("menuitem", { name: /^GPT-5\.4/u })).toBeVisible();
        expect(
          page.getByRole("dialog", { name: "Model effort", exact: true }).elements(),
        ).toHaveLength(0);
        await expect.element(slider).toHaveAttribute("aria-valuetext", label);
        expect(event.defaultPrevented).toBe(true);
        expect(readModelSelection()).toMatchObject({
          provider: "codex",
          model: "gpt-5.4",
          options: { reasoningEffort: effort, fastMode: true },
        });
        expect(readInteractionMode()).toBe("default");
        await vi.waitFor(() => expect(document.activeElement).toBe(searchbox.element()));
        shortcutTarget = searchbox.element() as HTMLElement;
      }
    } finally {
      focusTarget.remove();
      await mounted.cleanup();
    }
  });

  it("keeps the model picker open for 1500ms after the latest Shift+Tab press", async () => {
    localStorage.setItem("moss:app-settings:v1", JSON.stringify({ composerEffortSlider: true }));
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "low" },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-preview-timer" as MessageId,
        targetText: "effort preview timer",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      let shortcutTarget: HTMLElement = composerEditor;
      const pressShortcut = () =>
        shortcutTarget.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      const searchbox = page.getByRole("searchbox", { name: "Search models" });
      // Time each step from the presses, not from the checks between them: opening the
      // picker can take most of a second on a loaded runner, and a fixed sleep after it
      // pushes the second press past the first preview, when the picker is already gone.
      const firstPressAt = performance.now();
      pressShortcut();
      await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
      await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
      await vi.waitFor(() => expect(document.activeElement).toBe(searchbox.element()));
      shortcutTarget = searchbox.element() as HTMLElement;
      await waitUntilPerformanceTime(firstPressAt + 900);
      const secondPressAt = performance.now();
      expect(
        secondPressAt - firstPressAt,
        "the second press must land while the first preview is still open",
      ).toBeLessThan(1_500);
      pressShortcut();
      await expect.element(slider).toHaveAttribute("aria-valuetext", "High");
      // Past the first press's 1500ms, so only the second press can still hold it open.
      await waitUntilPerformanceTime(secondPressAt + 900);
      expect(performance.now() - firstPressAt).toBeGreaterThan(1_500);
      await expect.element(slider).toBeVisible();
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();
        },
        { timeout: 1_500, interval: 16 },
      );
      await vi.waitFor(() => expect(document.activeElement).toBe(composerEditor));
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a manually opened model picker open after the effort shortcut timer expires", async () => {
    localStorage.setItem("moss:app-settings:v1", JSON.stringify({ composerEffortSlider: true }));
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "medium" },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-preview-manual-picker" as MessageId,
        targetText: "manual model picker",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await expect
        .element(page.getByRole("slider", { name: "Reasoning effort" }))
        .toHaveAttribute("aria-valuetext", "High");
      const searchbox = page.getByRole("searchbox", { name: "Search models" });
      await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
      await vi.waitFor(() => expect(document.activeElement).toBe(searchbox.element()));
      dispatchComposerPickerShortcut(searchbox.element(), "m");
      await waitForComposerPickerSurfaceOpen();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1_700));
      await expect
        .element(page.getByRole("searchbox", { name: "Search models" }), { timeout: 1_000 })
        .toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the existing slider menu open when choosing another model after Shift+Tab", async () => {
    localStorage.setItem("moss:app-settings:v1", JSON.stringify({ composerEffortSlider: true }));
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "medium" },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-shortcut-model-selection" as MessageId,
        targetText: "choose model from effort shortcut",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      const searchbox = page.getByRole("searchbox", { name: "Search models" });
      const slider = page.getByRole("slider", { name: "Reasoning effort" });
      await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
      await expect.element(slider, { timeout: 1_000 }).toHaveAttribute("aria-valuetext", "High");
      // Moss0027s catalog also lists GPT-5.5 Codex variants; pick the plain GPT-5.5.
      await page.getByRole("menuitem", { name: /^GPT-5\.5(?! Codex)/u }).click();
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toMatchObject({ model: "gpt-5.5" });
      });
      await waitForLayout();
      await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
      await expect.element(slider, { timeout: 1_000 }).toHaveAttribute("aria-valuetext", "High");
      // A real key press on the focused slider (UI SDK's slider ignores dispatched key events).
      (slider.element() as HTMLElement).focus();
      await userEvent.keyboard("{ArrowLeft}");
      await expect.element(slider, { timeout: 1_000 }).toHaveAttribute("aria-valuetext", "Medium");
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
          .codex,
      ).toMatchObject({ model: "gpt-5.5", options: { reasoningEffort: "medium" } });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1_700));
      await expect.element(searchbox, { timeout: 1_000 }).toBeVisible();
      await expect.element(slider, { timeout: 1_000 }).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the existing model picker effort menu when its slider setting is disabled", async () => {
    localStorage.setItem("moss:app-settings:v1", JSON.stringify({ composerEffortSlider: false }));
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "medium" },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-shortcut-menu-setting" as MessageId,
        targetText: "effort menu setting",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
          .codex,
      ).toMatchObject({ options: { reasoningEffort: "high" } });
      await expect
        .element(page.getByRole("searchbox", { name: "Search models" }), { timeout: 1_000 })
        .toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: /^Effort.*High/u })).toBeVisible();
      expect(page.getByRole("slider", { name: "Reasoning effort" }).elements()).toHaveLength(0);
      expect(
        page.getByRole("dialog", { name: "Model effort", exact: true }).elements(),
      ).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the same voice buttons, mic included, for a thread on another agent's model (walk V-1)", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-voice-other-model"),
      targetText: "Voice on another model",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
            options: { effort: "high" },
          },
          session: { ...thread.session!, providerName: "claudeAgent" },
        })),
      },
    });
    try {
      await waitForComposerEditor();
      const shell = queryComposerShell();
      const mic = page.getByRole("button", { name: "Dictate", exact: true });
      await expect.element(mic).toBeVisible();
      expect(shell.contains(mic.element())).toBe(true);
      const box = mic.element().getBoundingClientRect();
      expect(box.width).toBeGreaterThan(16);
      expect(box.height).toBeGreaterThan(16);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps one composer shape in a started thread, pickers inside it (walk D-4)", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-single-row-composer"),
        targetText: "Single row composer",
      }),
    });
    try {
      const editor = await waitForComposerEditor();
      const shell = queryComposerShell;
      const expectBlockWithPickersInside = () => {
        const model = page
          .getByRole("button", { name: "Change model and reasoning", exact: true })
          .element();
        const footer = shell().querySelector<HTMLElement>("[data-chat-composer-footer]")!;
        // As on the empty landing: the editor on top, the + / permission / model / send row
        // under it, all inside the one box. Nothing moves to a row under the box.
        expect(shell().contains(model)).toBe(true);
        expect(footer.contains(model)).toBe(true);
        expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          editor.getBoundingClientRect().bottom - 1,
        );
        expect(document.querySelector("[data-chat-composer-status-row]")).toBeNull();
      };
      await vi.waitFor(expectBlockWithPickersInside);
      const height = shell().getBoundingClientRect().height;

      await userEvent.click(editor);
      await userEvent.keyboard("ok");
      expectBlockWithPickersInside();
      expect(shell().getBoundingClientRect().height).toBeCloseTo(height, 0);

      await userEvent.keyboard("{Shift>}{Enter}{/Shift}Second line");
      await vi.waitFor(() =>
        expect(shell().getBoundingClientRect().height).toBeGreaterThan(height),
      );
      expectBlockWithPickersInside();
      expect(document.activeElement).toBe(editor);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps long branch controls separate from the model in a narrow editor chat", async () => {
    const longBranch =
      "feature/verify-the-composer-in-a-very-narrow-editor-sidebar-with-a-long-branch-name";
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("msg-narrow-composer-branch"),
      targetText: "Narrow editor composer",
    });
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1280, height: 720 },
      strictMode: true,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
            options: { effort: "high" },
          },
          session: { ...thread.session!, providerName: "claudeAgent" },
        })),
      },
      initialEntry: `/${THREAD_ID}?view=editor`,
      configureFixture: (state) => {
        state.gitBranchByCwd["/repo/project"] = longBranch;
      },
    });
    try {
      await waitForComposerEditor();
      const branch = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="combobox-trigger"]'),
        "Unable to find the branch control.",
      );
      const model = page
        .getByRole("button", { name: "Change model and reasoning", exact: true })
        .element();
      await vi.waitFor(() => expect(branch.textContent).toContain(longBranch));
      const branchRect = branch.getBoundingClientRect();
      const modelRect = model.getBoundingClientRect();
      const shellRect = queryComposerShell().getBoundingClientRect();
      expect(branchRect.width).toBeGreaterThan(48);
      expect(branch.scrollWidth).toBeLessThanOrEqual(branch.clientWidth + 1);
      expect(branchRect.left).toBeGreaterThanOrEqual(shellRect.left - 1);
      expect(branchRect.right).toBeLessThanOrEqual(shellRect.right + 1);
      expect(modelRect.right).toBeLessThanOrEqual(shellRect.right);
      expect(
        branchRect.right <= modelRect.left ||
          branchRect.bottom <= modelRect.top ||
          modelRect.bottom <= branchRect.top,
      ).toBe(true);
      await userEvent.fill(page.getByTestId("composer-editor"), "Bozza breve");
      await page.getByRole("button", { name: "Add files and more", exact: true }).click();
      await expect
        .element(page.getByRole("option", { name: "Files and folders", exact: true }))
        .toBeVisible();
      await page.getByRole("option", { name: "Plan mode", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Plan", exact: true })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the row under the composer aligned while the Environment card is docked", async () => {
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ localeOverride: "en", environmentPanelDefaultOpen: true }),
    );
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-status-row-inset"),
        targetText: "Status row inset",
      }),
    });
    try {
      await waitForComposerEditor();
      const shell = document.querySelector<HTMLElement>(
        'form[data-chat-composer-form="true"] .chat-composer-shell',
      )!;
      const statusRow = shell.querySelector<HTMLElement>("[data-chat-composer-footer]")!;
      const environmentPanel = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-environment-panel-variant]") ?? null,
        "Unable to find the actual Environment panel for the composer inset check.",
      );
      const expectRowUnderComposer = () => {
        const shellRect = shell.getBoundingClientRect();
        const rowRect = statusRow.getBoundingClientRect();
        expect(rowRect.left).toBeGreaterThanOrEqual(shellRect.left);
        expect(rowRect.right).toBeLessThanOrEqual(shellRect.right);
        expect(rowRect.width).toBeGreaterThan(shellRect.width - 32);
      };
      const expectDockedEnvironment = () => {
        expect(environmentPanel.dataset.environmentPanelVariant).toBe("docked");
        expect(environmentPanel.getAttribute("aria-hidden")).toBe("false");
        expect(environmentPanel.hasAttribute("inert")).toBe(false);
        const card = environmentPanel.firstElementChild as HTMLElement;
        expect(getComputedStyle(card).opacity).toBe("1");
        expect(card.getBoundingClientRect().width).toBeGreaterThan(0);
        expect(card.getBoundingClientRect().height).toBeGreaterThan(0);
      };
      await vi.waitFor(
        () => {
          expectDockedEnvironment();
          expectRowUnderComposer();
        },
        { timeout: 4_000, interval: 16 },
      );
      const shellRightBefore = shell.getBoundingClientRect().right;

      // The right sidebar owns the separate dock. Opening it constrains this pane:
      // Environment becomes floating and closes under the default constrained policy.
      await page.getByRole("button", { name: "Toggle right sidebar", exact: true }).click();
      await vi.waitFor(
        () => {
          expect(environmentPanel.dataset.environmentPanelVariant).toBe("floating");
          expect(environmentPanel.getAttribute("aria-hidden")).toBe("true");
          expect(environmentPanel.hasAttribute("inert")).toBe(true);
          expect(Math.abs(shell.getBoundingClientRect().right - shellRightBefore)).toBeGreaterThan(
            20,
          );
          expectRowUnderComposer();
        },
        { timeout: 4_000, interval: 16 },
      );
      await page.getByRole("button", { name: "Toggle right sidebar", exact: true }).click();
      await vi.waitFor(
        () => {
          expectDockedEnvironment();
          expectRowUnderComposer();
          expect(
            Math.abs(shell.getBoundingClientRect().right - shellRightBefore),
          ).toBeLessThanOrEqual(1);
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("protects typed drafts while preserving history browsing from an empty composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("msg-prompt-history"),
        targetText: "Earlier submitted prompt",
      }),
    });
    try {
      const editor = await waitForComposerEditor();
      await userEvent.click(editor);
      const phrase = "Keep this unsent draft while moving the caret. ";
      const draft = phrase.repeat(8);
      // Exercise caret/history behavior while allowing React to finish a frame between
      // typing bursts, rather than hundreds of automation keys in one update batch.
      for (let index = 0; index < 8; index += 1) {
        await userEvent.keyboard(phrase);
        await nextFrame();
      }
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}Second line");
      const prompt = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt;
      await userEvent.keyboard("{ArrowUp>10/}");
      expect(editor.textContent).toContain(draft);
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(prompt);

      await userEvent.clear(editor);
      await userEvent.keyboard("{ArrowUp}");
      await vi.waitFor(() => expect(editor.textContent).toBe("filler user message 21"));
      await userEvent.keyboard("{ArrowUp}");
      await vi.waitFor(() => expect(editor.textContent).toBe("filler user message 20"));
      await userEvent.keyboard("{ArrowDown}{ArrowDown}");
      await vi.waitFor(() => expect(editor.textContent).toBe(""));

      await userEvent.keyboard("{ArrowUp}");
      await vi.waitFor(() => expect(editor.textContent).toBe("filler user message 21"));
      await userEvent.keyboard(" edited");
      await userEvent.keyboard("{ArrowUp>3/}{ArrowDown}");
      expect(editor.textContent).toBe("filler user message 21 edited");
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles composer focus with Cmd+L (Ctrl+L off macOS)", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-composer-focus-shortcut" as MessageId,
        targetText: "composer focus shortcut",
      }),
    });
    const focusTarget = document.createElement("button");
    focusTarget.type = "button";
    focusTarget.textContent = "Focus sink";
    document.body.appendChild(focusTarget);

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      focusTarget.focus();
      expect(document.activeElement).toBe(focusTarget);

      if (!isMacNavigatorPlatform()) {
        // Win+L is the system's lock chord there; Moss must not claim it.
        expect(dispatchComposerFocusToggleShortcut("meta").defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(focusTarget);
      }

      const focusEvent = dispatchComposerFocusToggleShortcut();
      expect(focusEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(composerEditor);
      });

      const blurEvent = dispatchComposerFocusToggleShortcut();
      expect(blurEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(document.activeElement).not.toBe(composerEditor);
      });
    } finally {
      focusTarget.remove();
      await mounted.cleanup();
    }
  });

  it("cycles the active provider model without opening the picker", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-cycle-shortcut" as MessageId,
        targetText: "model cycle shortcut",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();

      await dispatchModelCycleShortcutWhenReady(composerEditor, "]");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
        ).toMatchObject({ provider: "codex", model: MODEL_OPTIONS_BY_PROVIDER.codex[0]!.slug });
      });
      expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();

      await dispatchModelCycleShortcutWhenReady(composerEditor, "[");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
            .codex,
          // Backward from the first catalog entry wraps to its tail. The tail is
          // Moss's managed-model catalog, not upstream's gpt-5.2.
        ).toMatchObject({
          provider: "codex",
          model: MODEL_OPTIONS_BY_PROVIDER.codex.at(-1)!.slug,
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the composer model picker with configured keybinding labels loaded", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-picker-configured-shortcut" as MessageId,
        targetText: "configured model picker shortcut",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "modelPicker.toggle",
              shortcut: {
                key: "m",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: true,
                modKey: true,
              },
            },
          ],
        };
      },
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      composerEditor.focus();
      dispatchConfiguredShortcut(composerEditor, { key: "m", altKey: true });

      await waitForComposerPickerSurfaceOpen();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the composer effort picker surface", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-effort-picker-shortcut" as MessageId,
        targetText: "effort picker shortcut",
      }),
      configureFixture: (nextFixture) => {
        const providers: ServerConfig["providers"] = [
          ...nextFixture.serverConfig.providers,
          {
            provider: "claudeAgent",
            instanceId: "claudeAgent",
            driver: "claudeAgent",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: NOW_ISO,
          },
        ];
        nextFixture.serverConfig = { ...nextFixture.serverConfig, providers };
        nextFixture.providerStatusesSnapshot = providers;
      },
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await waitForServerConfigToApply();
      const queryClient = mounted.router.options.context.queryClient;
      const catalogKey = ["provider-discovery", "models", "claudeAgent"];
      await vi.waitFor(() => expect(queryClient.isFetching({ queryKey: catalogKey })).toBe(0));
      // Simulate a cold non-selected catalog after any route-level prewarming.
      queryClient.removeQueries({ queryKey: catalogKey });
      wsRequests.length = 0;
      composerEditor.focus();
      dispatchComposerPickerShortcut(composerEditor, "e");

      await waitForComposerPickerSurfaceOpen();
      expect(
        wsRequests.filter(
          (request) =>
            request._tag === WS_METHODS.providerListModels && request.provider === "claudeAgent",
        ),
      ).toEqual([]);
      expect(
        page.getByRole("button", { name: "Refresh models", exact: true }).elements(),
      ).toHaveLength(0);
      await vi.waitFor(() => {
        expect(wsRequests).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              _tag: WS_METHODS.providerListModels,
              provider: "codex",
              instanceId: "codex",
              refresh: "if-stale",
            }),
          ]),
        );
      });
      expect(
        wsRequests.filter(
          (request) =>
            request._tag === WS_METHODS.providerListModels && request.provider === "claudeAgent",
        ),
      ).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps removed terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as MessageId,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const store = useComposerDraftStore.getState();
      const currentPrompt = store.draftsByThreadId[THREAD_ID]?.prompt ?? "";
      const nextPrompt = removeInlineTerminalContextPlaceholder(currentPrompt, 0);
      store.setPrompt(THREAD_ID, nextPrompt.prompt);
      store.removeTerminalContext(THREAD_ID, "ctx-removed");

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_ID,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
          expect(document.body.textContent).toContain(addedLabel);
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_ID, `yoo${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}waddup`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as MessageId,
        targetText: "expired pill warning target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Expired terminal context omitted from message",
          );
          expect(document.body.textContent).not.toContain(expiredLabel);
          expect(document.body.textContent).toContain("yoowaddup");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends every browser annotation as prompt context without upload attachments", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const prompt = "Delete everything I annotated.";
    const store = useComposerDraftStore.getState();
    store.setPrompt(THREAD_ID, prompt);
    expect(
      store.addBrowserAnnotation(THREAD_ID, {
        id: "annotation-without-comment",
        tabId: "tab-a",
        source: {
          url: "https://example.test/landing",
          pageTitle: "Landing page",
        },
        selector: "#hero-title",
        tagName: "h1",
        role: null,
        name: null,
        text: "Build faster",
        fingerprint: "fnv1a64:0123456789abcdef",
        comment: null,
        capturedAt: NOW_ISO,
      }),
    ).toBe(true);
    expect(
      store.addBrowserAnnotation(THREAD_ID, {
        id: "annotation-with-comment",
        tabId: "tab-a",
        source: {
          url: "https://example.test/pricing",
          pageTitle: "Pricing",
        },
        selector: "#legacy-plan",
        tagName: "section",
        role: "region",
        name: "Legacy plan",
        text: "Legacy",
        fingerprint: "fnv1a64:fedcba9876543210",
        comment: "This one is obsolete.",
        capturedAt: NOW_ISO,
      }),
    ).toBe(true);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-browser-annotations-send" as MessageId,
        targetText: "browser annotations send target",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-testid="browser-annotation-chip"]')).toHaveLength(
          2,
        );
      });

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof candidate.command === "object" &&
              candidate.command !== null &&
              "type" in candidate.command &&
              candidate.command.type === "thread.turn.start",
          );
          expect(request).toBeTruthy();
          const command = request!.command as {
            message?: { messageId?: unknown; text?: unknown; attachments?: unknown[] };
          };
          expect(typeof command.message?.messageId).toBe("string");
          expect(typeof command.message?.text).toBe("string");
          const serializedPayload = (command.message!.text as string).split("\n").at(-2);
          expect(serializedPayload).toBeTruthy();
          expect(JSON.parse(serializedPayload!)?.messageId).toBe(command.message!.messageId);
          const extracted = extractTrailingBrowserAnnotations(
            command.message!.text as string,
            MessageId.makeUnsafe(command.message!.messageId as string),
          );
          expect(extracted.promptText).toBe(prompt);
          expect(
            extracted.annotations.map(({ id, ordinal, comment, source }) => ({
              id,
              ordinal,
              comment,
              url: source.url,
            })),
          ).toEqual([
            {
              id: "annotation-without-comment",
              ordinal: 1,
              comment: null,
              url: "https://example.test/landing",
            },
            {
              id: "annotation-with-comment",
              ordinal: 2,
              comment: "This one is obsolete.",
              url: "https://example.test/pricing",
            },
          ]);
          expect(command.message?.attachments ?? []).toHaveLength(0);
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.browserAnnotations ?? [],
          ).toHaveLength(0);
          expect(document.body.textContent).not.toContain("<browser_annotations>");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("steers a running turn when Follow-up behavior is set to Steer", async () => {
    localStorage.setItem("moss:app-settings:v1", JSON.stringify({ followUpBehavior: "steer" }));
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "steer this running turn");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-running-steer-setting" as MessageId,
        targetText: "running steer setting target",
        sessionStatus: "running",
      }),
    });

    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          const turnStart = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.turn.start" &&
                command.dispatchMode === "steer" &&
                typeof command.message === "object" &&
                command.message !== null &&
                "text" in command.message &&
                typeof command.message.text === "string" &&
                command.message.text.includes("steer this running turn"),
            );
          expect(turnStart).toBeTruthy();
          expect(document.querySelector('[data-testid="queued-follow-up-row"]')).toBeNull();
          expect(document.body.textContent).toContain("Steering conversation");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps queued follow-ups when you switch threads and come back", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "queue survives thread switch");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-running-queue-switch" as MessageId,
          targetText: "running queue switch target",
          sessionStatus: "running",
        }),
        OTHER_THREAD_ID,
      ),
    });
    try {
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      composerForm.requestSubmit();

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          expect(document.body.textContent).toContain("queue survives thread switch");
          expect(document.body.textContent).toContain("Steer");
          expect(document.querySelector('button[aria-label="Stop generation"]')).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForLayout();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });
      await waitForLayout();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
          expect(document.body.textContent).toContain("queue survives thread switch");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  describe("a follow-up sent while a turn runs", () => {
    const RUNNING_TURN_ID = TurnId.makeUnsafe("turn-running-follow-up");
    const runningTurn = {
      turnId: RUNNING_TURN_ID,
      state: "running" as const,
      requestedAt: isoAt(1_000),
      startedAt: isoAt(1_001),
      completedAt: null,
      assistantMessageId: null,
    };
    const withSession = (
      snapshot: OrchestrationReadModel,
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => Partial<OrchestrationReadModel["threads"][number]>,
    ): OrchestrationReadModel => ({
      ...snapshot,
      snapshotSequence: snapshot.snapshotSequence + 1,
      threads: snapshot.threads.map((thread) =>
        thread.id === THREAD_ID ? { ...thread, ...update(thread) } : thread,
      ),
    });
    const turnStartsWith = (text: string) =>
      wsRequests
        .map(readDispatchedCommand)
        .filter(
          (command) =>
            command?.type === "thread.turn.start" &&
            typeof command.message === "object" &&
            command.message !== null &&
            "text" in command.message &&
            typeof command.message.text === "string" &&
            command.message.text.includes(text),
        );
    const expectNoStartingNotice = () => {
      const text = document.body.textContent ?? "";
      expect(text).not.toContain("The session is still starting");
      expect(text).not.toContain("会话仍在启动");
    };

    it("queues it while the running turn's session reconnects and sends it once the turn ends", async () => {
      const restoreNativeApi = installDeterministicSendNativeApi();
      const followUp = "follow-up typed while the turn reconnects";
      let snapshot = withSession(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-running-reconnect" as MessageId,
          targetText: "running reconnect target",
        }),
        (thread) => ({
          latestTurn: runningTurn,
          session: { ...thread.session!, status: "running", activeTurnId: RUNNING_TURN_ID },
        }),
      );
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      try {
        // The owner's case: Codex is visibly working (Stop shown) when the server
        // reports the session as `starting` again for a background reconnect.
        snapshot = withSession(snapshot, (thread) => ({
          session: { ...thread.session!, status: "starting" },
        }));
        setFixture({ ...fixture, snapshot });
        useStore.getState().syncServerReadModel(snapshot);
        await vi.waitFor(() =>
          expect(getThreadFromState(useStore.getState(), THREAD_ID)?.session?.status).toBe(
            "connecting",
          ),
        );
        await expect
          .element(page.getByRole("button", { name: "Stop generation" }))
          .toBeInTheDocument();
        await page.getByTestId("composer-editor").fill(followUp);
        await userEvent.keyboard("{Enter}");

        await vi.waitFor(
          () => {
            const rows = document.querySelectorAll('[data-testid="queued-follow-up-row"]');
            expect(rows).toHaveLength(1);
            expect(rows[0]?.textContent).toContain(followUp);
          },
          { timeout: 8_000, interval: 16 },
        );
        expectNoStartingNotice();
        expect(turnStartsWith(followUp)).toHaveLength(0);
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe("");

        // The turn ends and the session is ready: the queued message goes out once.
        snapshot = withSession(snapshot, (thread) => ({
          latestTurn: { ...runningTurn, state: "completed", completedAt: isoAt(1_100) },
          session: { ...thread.session!, status: "ready", activeTurnId: null },
        }));
        setFixture({ ...fixture, snapshot });
        useStore.getState().syncServerReadModel(snapshot);

        await vi.waitFor(
          () => {
            expect(turnStartsWith(followUp)).toHaveLength(1);
            expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(
              0,
            );
          },
          { timeout: 8_000, interval: 16 },
        );
        await waitForLayout();
        expect(turnStartsWith(followUp)).toHaveLength(1);
        expectNoStartingNotice();
      } finally {
        await mounted.cleanup();
        restoreNativeApi();
      }
    });

    it("queues it while a running chat's cached detail is still being verified", async () => {
      const followUp = "follow-up typed during background verification";
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: withSession(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-running-verify" as MessageId,
            targetText: "running verify target",
            sessionStatus: "running",
          }),
          () => ({ latestTurn: runningTurn }),
        ),
      });
      try {
        useStore.setState((state) => ({
          ...state,
          threadDetailSyncById: { ...(state.threadDetailSyncById ?? {}), [THREAD_ID]: "cached" },
        }));
        await page.getByTestId("composer-editor").fill(followUp);
        await userEvent.keyboard("{Enter}");

        await vi.waitFor(
          () => {
            const rows = document.querySelectorAll('[data-testid="queued-follow-up-row"]');
            expect(rows).toHaveLength(1);
            expect(rows[0]?.textContent).toContain(followUp);
          },
          { timeout: 8_000, interval: 16 },
        );
        expectNoStartingNotice();
        expect(turnStartsWith(followUp)).toHaveLength(0);
      } finally {
        await mounted.cleanup();
      }
    });
  });

  it("marks a chat back from snooze as seen once it is opened", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: "msg-snooze-return" as MessageId,
      targetText: "Snoozed chat",
    });
    const finishedTurn = {
      turnId: TurnId.makeUnsafe("turn-snooze-return"),
      state: "completed" as const,
      requestedAt: isoAt(-700),
      startedAt: isoAt(-690),
      completedAt: isoAt(-600),
      assistantMessageId: null,
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        {
          ...base,
          threads: base.threads.map((thread) =>
            thread.id === THREAD_ID ? { ...thread, latestTurn: finishedTurn } : thread,
          ),
        },
        OTHER_THREAD_ID,
      ),
      initialEntry: `/${OTHER_THREAD_ID}`,
    });
    try {
      await waitForLayout();
      // The reminder fires while another chat is open: THREAD_ID returns unread. The server
      // clock is ahead of this one, so a visit stamped with this clock's now stays before it.
      const reminderAt = new Date(Date.now() + 60_000).toISOString();
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? { ...thread, snoozedUntil: null, snoozeReminderAt: reminderAt, updatedAt: reminderAt }
            : thread,
        ),
      };
      useStore.getState().syncServerReadModel(fixture.snapshot);
      const returnedChat = () => useStore.getState().sidebarThreadSummaryById[THREAD_ID]!;
      expect(hasUnseenSnoozeReturn(returnedChat())).toBe(true);

      await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
      await vi.waitFor(() => expect(hasUnseenSnoozeReturn(returnedChat())).toBe(false));
    } finally {
      await mounted.cleanup();
    }
  });

  it("editing a queued follow-up with live file changes removes only that row and restores its images to the composer", async () => {
    const queuedImage = createComposerImage({
      id: "queued-image-1",
      previewUrl: "blob:queued-image-1",
      name: "queued-image.png",
    });
    const firstQueuedPrompt = "first queued prompt with image";
    const secondQueuedPrompt = "second queued prompt stays queued";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithActiveFileChanges(),
    });

    try {
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-1",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: firstQueuedPrompt,
        prompt: firstQueuedPrompt,
        images: [queuedImage],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-2",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: secondQueuedPrompt,
        prompt: secondQueuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(2);
        },
        { timeout: 8_000, interval: 16 },
      );

      // The queued rail and input form one continuous outline, including on narrow panes.
      for (const viewport of [DEFAULT_VIEWPORT, { name: "narrow", width: 480, height: 640 }]) {
        await mounted.setViewport(viewport);
        const surface = document.querySelector<HTMLElement>("[data-chat-composer-surface]")!;
        const rail = document
          .querySelector<HTMLElement>('[data-testid="queued-follow-up-row"]')!
          .closest<HTMLElement>(".chat-composer-stacked-top")!;
        const inputBounds = surface.getBoundingClientRect();
        const railBounds = rail.getBoundingClientRect();
        expect(railBounds.left).toBeCloseTo(inputBounds.left, 1);
        expect(railBounds.right).toBeCloseTo(inputBounds.right, 1);
        expect(railBounds.bottom).toBeCloseTo(inputBounds.top + 1, 1);
        expect(getComputedStyle(surface).borderTopLeftRadius).toBe("0px");
        expect(getComputedStyle(surface).borderTopRightRadius).toBe("0px");
        expect(getComputedStyle(surface).borderBottomLeftRadius).not.toBe("0px");
      }
      await mounted.setViewport(DEFAULT_VIEWPORT);

      const actionButtons = document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Queued follow-up actions"]',
      );
      await page.getByRole("button", { name: "Steer", exact: true }).first().hover();
      await expect
        .element(page.getByText("Send this follow-up now to redirect the current work."))
        .toHaveTextContent(
          "Send this follow-up now to redirect the current work. If native steering is unavailable, stop the current turn and start a new one.",
        );
      expect(
        document.querySelectorAll('button[aria-label="Delete queued follow-up"]'),
      ).toHaveLength(2);
      actionButtons[0]?.click();

      const editMenuItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Edit queued follow-up",
          ) ?? null,
        "Unable to find edit queued follow-up menu item.",
      );
      expect(document.querySelectorAll('[data-slot="menu-item"]')).toHaveLength(1);
      editMenuItem.click();

      await vi.waitFor(
        () => {
          const queuedRows = document.querySelectorAll<HTMLElement>(
            '[data-testid="queued-follow-up-row"]',
          );
          expect(queuedRows).toHaveLength(1);
          expect(queuedRows[0]?.textContent ?? "").toContain(secondQueuedPrompt);
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            firstQueuedPrompt,
          );
          expect(
            useComposerDraftStore
              .getState()
              .draftsByThreadId[THREAD_ID]?.images.map((image) => image.name),
          ).toEqual(["queued-image.png"]);
          // The restored image renders as a thumbnail chip whose filename lives in
          // its accessible label/title, not in text content.
          expect(document.querySelector('[aria-label="Preview queued-image.png"]')).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("auto-dispatches a queued turn without wiping the live composer draft", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const queuedPrompt = "queued prompt that should auto-send";
    const draftBeingTyped = "draft the user is still typing";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-auto-dispatch-target" as MessageId,
        targetText: "auto dispatch target",
        // Idle session so the auto-dispatch effect (gated on phase !== "running")
        // drains the queue, mirroring a turn that just finished.
        sessionStatus: "ready",
      }),
    });

    try {
      // The user is mid-draft in the composer while a turn-completion drain fires.
      useComposerDraftStore.getState().setPrompt(THREAD_ID, draftBeingTyped);
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-auto",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.turn.start" &&
              "threadId" in request.command &&
              request.command.threadId === THREAD_ID &&
              "message" in request.command &&
              typeof request.command.message === "object" &&
              request.command.message !== null &&
              "text" in request.command.message &&
              typeof request.command.message.text === "string" &&
              request.command.message.text.includes(queuedPrompt),
          );
          expect(turnStartRequest).toBeTruthy();
          // Queue drained...
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
          // ...but the in-progress composer draft is left untouched.
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            draftBeingTyped,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  describe("queue paused by Stop", () => {
    const queuedPrompt = "queued prompt held after stop";
    const stoppedTurnId = TurnId.makeUnsafe("turn-stopped-by-user");
    const sentQueuedPrompt = () =>
      wsRequests.some((request) => turnStartText(request)?.includes(queuedPrompt) === true);

    async function mountPausedQueue(kind: "chat" | "plan-follow-up" = "chat") {
      const baseSnapshot =
        kind === "plan-follow-up"
          ? createSnapshotWithSettledPlanAwaitingFollowUp()
          : createSnapshotForTargetUser({
              targetMessageId: "msg-user-paused-queue-target" as MessageId,
              targetText: "paused queue target",
              sessionStatus: "ready",
            });
      const snapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                // Claude settles a stopped turn as "completed"; the recorded Stop still holds.
                latestTurn: {
                  turnId: stoppedTurnId,
                  state: "completed",
                  requestedAt: NOW_ISO,
                  startedAt: NOW_ISO,
                  completedAt: NOW_ISO,
                  assistantMessageId: null,
                },
              }
            : thread,
        ),
      };
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      const queuedTurn = {
        id: "queued-turn-paused",
        kind: "chat" as const,
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex" as const,
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: { provider: "codex" as const, model: "gpt-5" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        envMode: "local" as const,
      };
      useComposerDraftStore
        .getState()
        .enqueueQueuedTurn(
          THREAD_ID,
          kind === "plan-follow-up"
            ? { ...queuedTurn, kind, text: queuedPrompt, interactionMode: "plan" }
            : queuedTurn,
        );
      if (kind === "plan-follow-up") {
        useComposerDraftStore.getState().setInteractionMode(THREAD_ID, "plan");
      }
      // Same tick as the enqueue: the Stop action recorded this turn before it settled.
      useComposerDraftStore.getState().pauseQueuedTurnsAfterStop(THREAD_ID, stoppedTurnId);

      await vi.waitFor(
        () => {
          const notice = document.querySelector('[data-testid="queued-follow-up-paused-notice"]');
          expect(notice?.textContent).toContain("Queue paused");
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
        },
        { timeout: 8_000, interval: 16 },
      );
      // Give the drain a few frames: a held queue must not send on its own.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(sentQueuedPrompt()).toBe(false);
      return mounted;
    }

    it("holds the queue with a notice and sends it after Resume", async () => {
      const restoreNativeApi = installDeterministicSendNativeApi();
      const mounted = await mountPausedQueue();
      try {
        await page.getByRole("button", { name: "Resume", exact: true }).click();

        await vi.waitFor(
          () => {
            expect(sentQueuedPrompt()).toBe(true);
            expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(
              0,
            );
          },
          { timeout: 8_000, interval: 16 },
        );
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId ?? null,
        ).toBe(null);
      } finally {
        await mounted.cleanup();
        restoreNativeApi();
      }
    });

    it.each(["chat", "plan-follow-up"] as const)(
      "sends a %s typed by hand first and releases the stop pause",
      async (kind) => {
        const restoreNativeApi = installDeterministicSendNativeApi();
        const mounted = await mountPausedQueue(kind);
        const manualPrompt = "message typed while the queue is paused";
        try {
          useComposerDraftStore.getState().setPrompt(THREAD_ID, manualPrompt);
          const composerEditor = await waitForComposerEditor();
          await vi.waitFor(() => expect(composerEditor.textContent ?? "").toContain(manualPrompt), {
            timeout: 8_000,
            interval: 16,
          });
          if (kind === "plan-follow-up") {
            await userEvent.click(composerEditor);
            await userEvent.keyboard("{Enter}");
          } else {
            const sendButton = await waitForSendButton();
            await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
              timeout: 8_000,
              interval: 16,
            });
            sendButton.click();
          }

          await vi.waitFor(() => {
            expect(
              wsRequests.some((request) => turnStartText(request)?.includes(manualPrompt) === true),
            ).toBe(true);
          });
          if (kind === "plan-follow-up") {
            await page.screenshot({
              path: "../../../../output/playwright/queue-plan-resume.png",
            });
          }
          await vi.waitFor(
            () => {
              expect(
                wsRequests.some(
                  (request) => turnStartText(request)?.includes(manualPrompt) === true,
                ),
              ).toBe(true);
              expect(
                useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId ??
                  null,
              ).toBe(null);
            },
            { timeout: 8_000, interval: 16 },
          );
          // The typed message goes first; the queued one waits for that turn to end.
          expect(sentQueuedPrompt()).toBe(false);
        } finally {
          await mounted.cleanup();
          restoreNativeApi();
        }
      },
    );

    it("preserves the last queued item and stop hold when Steer fails", async () => {
      let releaseSend!: () => void;
      const sendBarrier = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      const restoreNativeApi = installDeterministicSendNativeApi({
        beforeTurnStart: () => sendBarrier,
        rejectTurnStart: true,
      });
      const mounted = await mountPausedQueue();
      const originalQueue =
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]!.queuedTurns;
      try {
        const steer = page.getByRole("button", { name: "Steer", exact: true }).first();
        await steer.click();
        await vi.waitFor(() => expect(sentQueuedPrompt()).toBe(true));
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns).toEqual(
          originalQueue,
        );
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId,
        ).toBe(stoppedTurnId);
        const acquired = tryBeginQueuedComposerAutoDispatch(THREAD_ID);
        if (acquired) endQueuedComposerAutoDispatch(THREAD_ID);
        expect(acquired).toBe(false);
        await steer.click();
        expect(
          wsRequests.filter((request) => turnStartText(request)?.includes(queuedPrompt)),
        ).toHaveLength(1);
        releaseSend();
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain("Turn start failed for test."),
        );
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns).toEqual(
          originalQueue,
        );
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId,
        ).toBe(stoppedTurnId);
      } finally {
        releaseSend();
        await mounted.cleanup();
        restoreNativeApi();
      }
    });

    it("releases the stop hold after a queued plan follow-up Steer succeeds", async () => {
      const restoreNativeApi = installDeterministicSendNativeApi();
      const mounted = await mountPausedQueue("plan-follow-up");
      const queuedTurn =
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]!.queuedTurns[0]!;
      useComposerDraftStore
        .getState()
        .enqueueQueuedTurn(THREAD_ID, { ...queuedTurn, id: "remaining-plan-follow-up" });
      try {
        await page.getByRole("button", { name: "Steer", exact: true }).first().click();
        await vi.waitFor(() => {
          expect(
            useComposerDraftStore
              .getState()
              .draftsByThreadId[THREAD_ID]?.queuedTurns.map((turn) => turn.id),
          ).toEqual(["remaining-plan-follow-up"]);
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId ??
              null,
          ).toBe(null);
        });
        expect(
          wsRequests.filter((request) => turnStartText(request)?.includes(queuedPrompt)),
        ).toHaveLength(1);
      } finally {
        await mounted.cleanup();
        restoreNativeApi();
      }
    });

    it("preserves a newer Stop and a replacement queued item while Steer completes", async () => {
      let releaseSend!: () => void;
      const sendBarrier = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      const restoreNativeApi = installDeterministicSendNativeApi({
        beforeTurnStart: () => sendBarrier,
      });
      const mounted = await mountPausedQueue();
      const queuedTurn =
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]!.queuedTurns[0]!;
      const newerStoppedTurnId = TurnId.makeUnsafe("newer-stop-while-steering");
      try {
        await page.getByRole("button", { name: "Steer", exact: true }).first().click();
        await vi.waitFor(() => expect(sentQueuedPrompt()).toBe(true));
        useComposerDraftStore
          .getState()
          .enqueueQueuedTurn(THREAD_ID, { ...queuedTurn, id: "edited-queued-turn" });
        useComposerDraftStore.getState().removeQueuedTurn(THREAD_ID, queuedTurn.id);
        useComposerDraftStore.getState().pauseQueuedTurnsAfterStop(THREAD_ID, newerStoppedTurnId);
        releaseSend();
        await vi.waitFor(() => {
          const acquired = tryBeginQueuedComposerAutoDispatch(THREAD_ID);
          if (acquired) endQueuedComposerAutoDispatch(THREAD_ID);
          expect(acquired).toBe(true);
        });
        // Let the accepted turn and its draft effects settle before inspecting newer controls.
        await waitForLayout();
        expect(
          useComposerDraftStore
            .getState()
            .draftsByThreadId[THREAD_ID]?.queuedTurns.map((turn) => turn.id),
        ).toEqual(["edited-queued-turn"]);
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queueStoppedTurnId,
        ).toBe(newerStoppedTurnId);
        expect(
          wsRequests.filter((request) => turnStartText(request)?.includes(queuedPrompt)),
        ).toHaveLength(1);
      } finally {
        releaseSend();
        await mounted.cleanup();
        restoreNativeApi();
      }
    });
  });

  it("auto-dispatches a queued chat turn as a chat message even while a plan follow-up is pending", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const queuedPrompt = "queued chat turn that must stay a chat message";
    const queuedImage = createComposerImage({
      id: "queued-plan-image-1",
      previewUrl: "blob:queued-plan-image-1",
      name: "queued-plan-image.png",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      // Plan mode, settled turn, actionable proposed plan -> the live composer is
      // showing the plan follow-up prompt at the moment the queue drains.
      snapshot: createSnapshotWithSettledPlanAwaitingFollowUp(),
    });

    try {
      await waitForComposerEditor();
      // Make the live composer's interaction mode explicitly "plan" so the
      // plan-follow-up branch in onSend is live. The queued chat turn below
      // carries its own "default" mode and an image attachment, both of which the
      // misroute (onSubmitPlanFollowUp) would discard.
      useComposerDraftStore.getState().setInteractionMode(THREAD_ID, "plan");
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id: "queued-turn-plan-chat",
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: queuedPrompt,
        prompt: queuedPrompt,
        images: [queuedImage],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.turn.start" &&
              "threadId" in request.command &&
              request.command.threadId === THREAD_ID &&
              "message" in request.command &&
              typeof request.command.message === "object" &&
              request.command.message !== null &&
              "text" in request.command.message &&
              typeof request.command.message.text === "string" &&
              request.command.message.text.includes(queuedPrompt),
          );
          expect(turnStartRequest).toBeTruthy();
          const command = turnStartRequest!.command as {
            interactionMode?: unknown;
            message?: { attachments?: Array<{ type?: unknown; name?: unknown }> };
          };
          // Dispatched as a normal chat turn: it keeps the queued turn's own
          // "default" interaction mode rather than being coerced to "plan" by the
          // plan-follow-up path.
          expect(command.interactionMode).toBe("default");
          // ...and the queued image survives instead of being dropped to [].
          const attachments = command.message?.attachments ?? [];
          expect(attachments).toHaveLength(1);
          expect(attachments[0]?.type).toBe("image");
          expect(attachments[0]?.name).toBe("queued-plan-image.png");
          // Queue drained.
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("auto-dispatches only the queue head until the previous turn is live", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const firstQueuedPrompt = "queued follow-up A stays the only dispatch";
    const secondQueuedPrompt = "queued follow-up B must wait for the live turn";
    let currentSnapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-queued-gap-target" as MessageId,
      targetText: "queued gap target",
      sessionStatus: "running",
    });

    const enqueueQueuedChatTurn = (id: string, prompt: string) => {
      useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, {
        id,
        kind: "chat",
        createdAt: NOW_ISO,
        previewText: prompt,
        prompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider: "codex",
        selectedModel: "gpt-5",
        selectedPromptEffort: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
      });
    };

    const turnStartCommands = () =>
      wsRequests.flatMap((request) => {
        if (request._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return [];
        }
        const command = request.command;
        if (
          typeof command !== "object" ||
          command === null ||
          !("type" in command) ||
          command.type !== "thread.turn.start"
        ) {
          return [];
        }
        return [
          command as {
            threadId?: unknown;
            message?: { messageId?: unknown; text?: unknown };
          },
        ];
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
      enqueueQueuedChatTurn("queued-turn-gap-a", firstQueuedPrompt);
      enqueueQueuedChatTurn("queued-turn-gap-b", secondQueuedPrompt);

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(2);
        },
        { timeout: 8_000, interval: 16 },
      );

      syncActiveThread((thread) => ({
        ...thread,
        session: thread.session
          ? {
              ...thread.session,
              status: "ready",
              activeTurnId: null,
              updatedAt: isoAt(1_200),
            }
          : null,
        updatedAt: isoAt(1_200),
      }));

      const firstCommand = await vi.waitFor(
        () => {
          const match = turnStartCommands().find((command) =>
            String(command.message?.text ?? "").includes(firstQueuedPrompt),
          );
          expect(match, "first queued turn should auto-dispatch").toBeTruthy();
          return match!;
        },
        { timeout: 8_000, interval: 16 },
      );
      const sentMessageId = String(firstCommand.message?.messageId ?? "");
      expect(sentMessageId, "dispatched user message id").not.toBe("");

      const requestedTurnId = TurnId.makeUnsafe("turn-queued-gap");
      syncActiveThread((thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe(sentMessageId),
            role: "user" as const,
            text: firstQueuedPrompt,
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

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 500);
      });

      expect(turnStartCommands()).toHaveLength(1);
      expect(String(turnStartCommands()[0]?.message?.text ?? "")).toContain(firstQueuedPrompt);
      expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
      expect(document.body.textContent).toContain(secondQueuedPrompt);

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

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 400);
      });

      expect(turnStartCommands()).toHaveLength(1);
      expect(document.querySelectorAll('[data-testid="queued-follow-up-row"]')).toHaveLength(1);
      expect(document.body.textContent).toContain(secondQueuedPrompt);
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  const selectAssistantFiller = async (options: { keepFocus?: boolean } = {}) => {
    const source = page.getByText("assistant filler 21", { exact: true });
    await expect.element(source).toBeVisible();
    expect(source.element().closest("[data-assistant-message-id]")).not.toBeNull();
    // keepFocus selects without a click, so a focused composer stays focused.
    if (!options.keepFocus) await source.click();
    const sourceNode = source.element();
    const range = document.createRange();
    range.selectNodeContents(sourceNode);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const rect = range.getBoundingClientRect();
    sourceNode.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: rect.right,
        clientY: rect.bottom,
      }),
    );
  };

  it("quotes a selected passage into the composer; Enter in the pill and the card doesn't send", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-selection-reply" as MessageId,
      targetText: "Selection reply test",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.slice(-2),
        })),
      },
    });
    const turnStarts = () =>
      wsRequests
        .map(readDispatchedCommand)
        .filter((command) => command?.type === "thread.turn.start");
    try {
      // A draft already in the composer is what a leaked Enter would send.
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Draft so far.");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() => expect(composerEditor.textContent).toContain("Draft so far."));
      await waitForLayout();
      composerEditor.focus();
      await selectAssistantFiller({ keepFocus: true });
      await expect.element(page.getByRole("toolbar", { name: "Selection actions" })).toBeVisible();
      wsRequests.length = 0;
      // The composer keeps focus while transcript text is selected, so a popover Enter
      // that fell through would send this draft.
      expect(document.activeElement).toBe(composerEditor);

      // One Enter on the pill, held long enough to repeat: it opens the Reply card.
      await userEvent.keyboard("{Enter>6}");
      const replyField = page.getByRole("textbox", { name: "Your reply" });
      await expect.element(replyField).toHaveFocus();
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.assistantSelections ?? [],
      ).toHaveLength(0);
      await userEvent.keyboard("{/Enter}");

      // Enter in the card, held too, adds the quote and hands focus back to the composer.
      await userEvent.keyboard("{Enter>6}");
      await vi.waitFor(() => expect(document.activeElement).toBe(composerEditor));
      await userEvent.keyboard("{/Enter}");

      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
        expect(draft?.assistantSelections.map((selection) => selection.text)).toEqual([
          "assistant filler 21",
        ]);
      });
      await expect
        .element(page.getByRole("toolbar", { name: "Selection actions" }))
        .not.toBeInTheDocument();
      expect(document.querySelectorAll("[data-composer-quote-row]")).toHaveLength(1);
      expect(document.querySelector('[data-transcript-reply-card="true"]')).toBeNull();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 600));
      expect(turnStarts()).toHaveLength(0);
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
        "Draft so far.",
      );

      // Only the reader's own Enter, after writing, sends the quote with their words.
      await userEvent.keyboard("{End} Explain this selected passage");
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(
        () => {
          const sends = turnStarts();
          expect(sends).toHaveLength(1);
          expect(sends[0]).toMatchObject({ threadId: THREAD_ID });
          const text = String((sends[0]?.message as { text?: string } | undefined)?.text ?? "");
          expect(text).toContain("Draft so far. Explain this selected passage");
          expect(text).toContain("<assistant_selection>");
          expect(text).toContain("assistant filler 21");
        },
        { timeout: 15_000 },
      );
    } finally {
      window.getSelection()?.removeAllRanges();
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("quote + Enter + Enter sends nothing until the reader writes", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-quote-only" as MessageId,
      targetText: "Quote only test",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.slice(-2),
        })),
      },
    });
    const turnStarts = () =>
      wsRequests
        .map(readDispatchedCommand)
        .filter((command) => command?.type === "thread.turn.start");
    try {
      const composerEditor = await waitForComposerEditor();
      await waitForLayout();
      composerEditor.focus();
      await selectAssistantFiller({ keepFocus: true });
      await expect.element(page.getByRole("toolbar", { name: "Selection actions" })).toBeVisible();
      wsRequests.length = 0;
      const userRowsBefore = document.querySelectorAll('[data-message-role="user"]').length;

      // Enter on the pill opens the card, Enter in the card quotes; then separate Enters
      // in the empty composer.
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("textbox", { name: "Your reply" })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() =>
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.assistantSelections,
        ).toHaveLength(1),
      );
      expect(document.activeElement).toBe(composerEditor);
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard("{Enter}");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 600));

      expect(turnStarts()).toHaveLength(0);
      expect(document.querySelectorAll('[data-message-role="user"]').length).toBe(userRowsBefore);
      const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
      expect(draft?.assistantSelections).toHaveLength(1);
      expect(document.querySelectorAll("[data-composer-quote-row]")).toHaveLength(1);
      expect((await waitForSendButton()).disabled).toBe(true);

      // The reader's words make it a message: one send with the quote and the text.
      await userEvent.keyboard("What does this mean?");
      await vi.waitFor(async () => expect((await waitForSendButton()).disabled).toBe(false));
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(
        () => {
          const sends = turnStarts();
          expect(sends).toHaveLength(1);
          const text = String((sends[0]?.message as { text?: string } | undefined)?.text ?? "");
          expect(text).toContain("What does this mean?");
          expect(text).toContain("<assistant_selection>");
          expect(text).toContain("assistant filler 21");
        },
        { timeout: 15_000 },
      );
    } finally {
      window.getSelection()?.removeAllRanges();
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("quotes into the composer from Reply, the card's reply and Add to prompt, keeping the draft", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-selection-reply-button" as MessageId,
      targetText: "Selection reply button test",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.slice(-2),
        })),
      },
    });
    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Keep the current draft");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(() =>
        expect(composerEditor.textContent).toContain("Keep the current draft"),
      );
      await waitForLayout();
      await selectAssistantFiller();
      wsRequests.length = 0;
      await page.getByRole("button", { name: "Reply", exact: true }).click();
      // Reply opens the card on the passage; the composer draft is untouched so far.
      const replyField = page.getByRole("textbox", { name: "Your reply" });
      await expect.element(replyField).toHaveFocus();
      // Ctrl+Enter is not offered while the composer holds a draft: it would send it too.
      await userEvent.keyboard("Shorter please");
      await page.getByRole("button", { name: "Add to prompt" }).click();
      await vi.waitFor(() => expect(document.activeElement).toBe(composerEditor));
      const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
      expect(draft?.prompt).toBe("Keep the current draft");
      expect(
        draft?.assistantSelections.map((selection) => [selection.text, selection.comment]),
      ).toEqual([["assistant filler 21", "Shorter please"]]);
      await expect.element(page.getByText("With reply", { exact: true })).toBeVisible();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
      expect(
        wsRequests
          .map(readDispatchedCommand)
          .some((command) => command?.type === "thread.turn.start"),
      ).toBe(false);
    } finally {
      window.getSelection()?.removeAllRanges();
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("shows a quoted passage inside the one composer box, above the editor (walk D-4)", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-quote-strip" as MessageId,
      targetText: "Quote strip test",
    });
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await waitForComposerEditor();
      const form = () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]')!;
      useComposerDraftStore.getState().addAssistantSelection(THREAD_ID, {
        type: "assistant-selection",
        id: "quote-strip-1",
        assistantMessageId: "msg-assistant-filler-1",
        text: "A passage quoted from the reply",
      });
      await vi.waitFor(() => {
        expect(document.querySelectorAll("[data-composer-quote-row]")).toHaveLength(1);
      });
      const quote = document.querySelector<HTMLElement>("[data-composer-quote-row]")!;
      const editor = form().querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
      expect(queryComposerShell().contains(quote)).toBe(true);
      expect(quote.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        editor.getBoundingClientRect().top + 1,
      );
      const footer = queryComposerShell().querySelector<HTMLElement>(
        "[data-chat-composer-footer]",
      )!;
      expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        editor.getBoundingClientRect().bottom - 1,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends the quote with the card's reply on Ctrl+Enter when the composer is empty", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-selection-send-reply" as MessageId,
      targetText: "Selection send reply test",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.slice(-2),
        })),
      },
    });
    const turnStarts = () =>
      wsRequests
        .map(readDispatchedCommand)
        .filter((command) => command?.type === "thread.turn.start");
    try {
      await waitForComposerEditor();
      await waitForLayout();
      await selectAssistantFiller();
      wsRequests.length = 0;
      await page.getByRole("button", { name: "Reply", exact: true }).click();
      await expect.element(page.getByRole("textbox", { name: "Your reply" })).toHaveFocus();
      await userEvent.keyboard("Why this one?");
      await userEvent.keyboard("{Control>}{Enter}{/Control}");
      await vi.waitFor(
        () => {
          const sends = turnStarts();
          expect(sends).toHaveLength(1);
          const text = String((sends[0]?.message as { text?: string } | undefined)?.text ?? "");
          expect(text).toContain("<assistant_selection>");
          expect(text).toContain("assistant filler 21");
          expect(text).toContain("- reply to the selection above:\n  Why this one?");
        },
        { timeout: 15_000 },
      );
      expect(document.querySelector('[data-transcript-reply-card="true"]')).toBeNull();
      await vi.waitFor(() =>
        expect(
          useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.assistantSelections ?? [],
        ).toHaveLength(0),
      );
    } finally {
      window.getSelection()?.removeAllRanges();
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it.each(["extras panel", "edit button"])(
    "sets a literal control-word goal from the %s",
    async (entryPoint) => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-literal-goal-test" as MessageId,
        targetText: "literal goal test",
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...snapshot,
          threads: [{ ...snapshot.threads[0]!, goal: "clear" }],
        },
      });
      const restoreNativeApi = installDeterministicSendNativeApi();

      try {
        if (entryPoint === "edit button") {
          // The goal capsule opens its panel; Edit lives there.
          await page.getByTestId("composer-goal-header").click();
          await page.getByRole("button", { name: "Edit goal" }).click();
        } else {
          useComposerDraftStore.getState().setPrompt(THREAD_ID, "clear");
          const composerEditor = await waitForComposerEditor();
          await vi.waitFor(() => expect(composerEditor.textContent ?? "").toContain("clear"));
          await page.getByLabelText("Add files and more").click();
          await page.getByRole("option", { name: "Goal", exact: true }).click();
        }
        await vi.waitFor(() =>
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            "/goal -- clear",
          ),
        );
        const sendButton = await waitForSendButton();
        sendButton.click();

        await vi.waitFor(() => {
          const request = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              request.command.type === "thread.meta.update" &&
              "goal" in request.command,
          );
          expect(request?.command).toMatchObject({ type: "thread.meta.update", goal: "clear" });
        });
      } finally {
        restoreNativeApi();
        await mounted.cleanup();
      }
    },
  );

  it.each([
    { sessionStatus: "ready" as const, startBehavior: "start-with-message" },
    { sessionStatus: "running" as const, startBehavior: undefined },
  ])(
    "sends a new /goal as a visible message only when the thread is idle ($sessionStatus)",
    async ({ sessionStatus, startBehavior }) => {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "/goal ship the release");
      const restoreNativeApi = installDeterministicSendNativeApi();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-goal-test" as MessageId,
          targetText: "new goal test",
          sessionStatus,
        }),
      });

      try {
        const composerForm = await waitForElement(
          () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
          "Unable to find composer form.",
        );
        composerForm.requestSubmit();

        const goalUpdateIndex = () =>
          wsRequests.findIndex(
            (request) => readDispatchedCommand(request)?.type === "thread.meta.update",
          );
        await vi.waitFor(() => expect(goalUpdateIndex()).toBeGreaterThanOrEqual(0));
        const goalUpdate = readDispatchedCommand(wsRequests[goalUpdateIndex()]!);
        expect(goalUpdate?.goal).toBe("ship the release");
        // One server command owns persistence, the visible message, and the first turn.
        expect(goalUpdate?.goalStartBehavior).toBe(startBehavior);
        expect(wsRequests.map(turnStartText).filter((text) => text !== null)).toEqual([]);
      } finally {
        restoreNativeApi();
        await mounted.cleanup();
      }
    },
  );

  it("preserves a rejected first /goal command for retry", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "/goal ship the release");
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-goal-retry" as MessageId,
        targetText: "goal retry",
      }),
    });
    const api = readNativeApi()!;
    let rejectGoal = true;
    const goalCommands: unknown[] = [];
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: async (
            command: Parameters<typeof api.orchestration.dispatchCommand>[0],
          ) => {
            if (command.type === "thread.meta.update" && command.goal !== undefined) {
              goalCommands.push(command);
              if (rejectGoal) throw new Error("Goal was not accepted.");
            }
            return api.orchestration.dispatchCommand(command);
          },
        },
      },
    });
    try {
      const form = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );
      form.requestSubmit();
      await expect.element(page.getByText("Could not update thread goal")).toBeInTheDocument();
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
        "/goal ship the release",
      );
      rejectGoal = false;
      form.requestSubmit();
      await vi.waitFor(() => expect(goalCommands).toHaveLength(2));
      expect(goalCommands).toEqual([
        expect.objectContaining({
          goal: "ship the release",
          goalStartBehavior: "start-with-message",
        }),
        expect.objectContaining({
          goal: "ship the release",
          goalStartBehavior: "start-with-message",
        }),
      ]);
      await vi.waitFor(() =>
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe(""),
      );
      expect(wsRequests.map(turnStartText).filter((text) => text !== null)).toEqual([]);
    } finally {
      restoreNativeApi();
      await mounted.cleanup();
    }
  });

  it("activates Debug with /debug and returns to Default from the badge and /default", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-debug-mode-test" as MessageId,
        targetText: "debug mode test",
      }),
    });

    try {
      const readInteractionMode = () =>
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode ?? "default";
      const runSlashCommand = async (command: string) => {
        useComposerDraftStore.getState().setPrompt(THREAD_ID, command);
        const composerEditor = await waitForComposerEditor();
        await vi.waitFor(() => expect(composerEditor.textContent ?? "").toContain(command));
        const sendButton = await waitForSendButton();
        expect(sendButton.disabled).toBe(false);
        sendButton.click();
      };

      await runSlashCommand("/debug");
      await vi.waitFor(() => expect(readInteractionMode()).toBe("debug"));
      const debugBadge = page.getByTitle("Debug mode — click to return to normal build mode");
      await expect.element(debugBadge).toBeInTheDocument();
      await debugBadge.click();
      await vi.waitFor(() => expect(readInteractionMode()).toBe("default"));

      await runSlashCommand("/debug");
      await vi.waitFor(() => expect(readInteractionMode()).toBe("debug"));
      await runSlashCommand("/default");
      await vi.waitFor(() => expect(readInteractionMode()).toBe("default"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the localized Resume affordance in the dark narrow composer", async () => {
    const diagnostics = installImageLimitDiagnostics();
    const restoreNativeApi = installDeterministicSendNativeApi();
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
    setImageLimitFixtureTheme("dark");
    const mounted = await mountChatView({
      viewport: {
        name: "resume-dark-390",
        width: 390,
        height: 844,
      },
      snapshot: createSnapshotWithInterruptedTurn(),
    });

    try {
      const resumeButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[data-moss-visible-resume-control="true"]',
          ),
        "Unable to find localized Resume control in dark narrow composer.",
      );
      expect(resumeButton.getAttribute("aria-label")).toBe("继续运行");
      expect(resumeButton.title).toBe("继续运行");
      expect(resumeButton.dataset.mossVisibleResumeState).toBe("ready");
      const screenshotPath = await page.screenshot({
        path: "../../../../.tmp/ui-parity/HEL-46-composer-resume-dark-390.png",
      });
      expect(screenshotPath).toContain("HEL-46-composer-resume-dark-390.png");
      const diagnosticsMessages = diagnostics.assertHealthy();
      expect(diagnosticsMessages.filter(({ level }) => level === "error")).toEqual([]);
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
      diagnostics.dispose();
    }
  });

  it("offers Continue after Stop and explains a refusal in plain words", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi({
      rejectResume: `Orchestration command invariant failed (thread.turn.resume): Thread '${THREAD_ID}' already has an active or queued turn.`,
    });
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
    // The stopped turn's own message carries no turn id, as every plain send leaves it.
    const snapshot = updateInterruptedThreadSnapshot(
      createSnapshotWithInterruptedTurn(),
      (thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.role === "user" ? { ...message, turnId: null } : message,
        ),
      }),
    );
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

    try {
      const resumeButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[data-moss-visible-resume-control="true"]',
          ),
        "Continue is not offered after Stop.",
      );
      resumeButton.click();
      await vi.waitFor(() =>
        expect(
          wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (request as { command?: { type?: string } }).command?.type === "thread.turn.resume",
          ),
        ).toBe(true),
      );
      await expect
        .element(page.getByText("这个对话还在运行，或还有消息在排队。等它结束后再继续。"))
        .toBeInTheDocument();
      expect(document.body.textContent ?? "").not.toContain("already has an active or queued turn");
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
      localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
    }
  });

  it.each([
    ["zh-CN", "继续刚才的任务。"],
    ["en", INTERRUPTED_TASK_CONTINUATION_PROMPT],
  ] as const)(
    "shows a continuation as the person's own line in %s",
    async (localeOverride, visibleLine) => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride }));
      const snapshot = updateInterruptedThreadSnapshot(
        createSnapshotWithInterruptedTurn(),
        (thread) => ({
          ...thread,
          messages: thread.messages.map((message) =>
            // The newest person message, so the transcript renders it at the bottom.
            message.id === "msg-user-21"
              ? { ...message, text: INTERRUPTED_TASK_CONTINUATION_PROMPT }
              : message,
          ),
        }),
      );
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });

      try {
        await expect.element(page.getByText(visibleLine, { exact: true })).toBeInTheDocument();
        if (localeOverride === "zh-CN") {
          expect(document.body.textContent ?? "").not.toContain(
            INTERRUPTED_TASK_CONTINUATION_PROMPT,
          );
        }
      } finally {
        await mounted.cleanup();
        localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
      }
    },
  );

  function snapshotWithSettledTurn(latestTurnId: TurnId) {
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("prediction-idle-target"),
      targetText: "prediction idle thread",
      messagePairCount: 2,
    });
    return {
      ...base,
      threads: base.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              latestTurn: {
                turnId: latestTurnId,
                state: "completed" as const,
                requestedAt: isoAt(10),
                startedAt: isoAt(11),
                completedAt: isoAt(12),
                assistantMessageId: MessageId.makeUnsafe("msg-assistant-1"),
              },
            }
          : thread,
      ),
    };
  }

  it.each([false, true])(
    "asks for a composer prediction when it opens an idle thread (StrictMode: %s)",
    async (strictMode) => {
      const latestTurnId = TurnId.makeUnsafe("turn-prediction-idle");
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        // StrictMode's dev remount aborts the first request; the composer must ask again.
        strictMode,
        snapshot: snapshotWithSettledTurn(latestTurnId),
      });

      try {
        await vi.waitFor(() =>
          expect(
            wsRequests.find(
              (request) => request._tag === WS_METHODS.serverGenerateComposerPrediction,
            ),
          ).toMatchObject({ threadId: THREAD_ID, expectedTurnId: latestTurnId }),
        );
        // The model had nothing for this turn: no ghost text, the placeholder stays.
        await expect.element(page.getByTestId("composer-prediction")).not.toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("shows the suggestion as ghost text and Tab makes it an unsent draft", async () => {
    setComposerPredictionSuggestion("继续把剩下的两个测试也修好");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithSettledTurn(TurnId.makeUnsafe("turn-prediction-accept")),
    });

    try {
      const ghost = page.getByTestId("composer-prediction");
      await expect.element(ghost).toHaveTextContent("继续把剩下的两个测试也修好Tab");
      const editor = page.getByTestId("composer-editor");
      await editor.click();
      const requestsBeforeAccept = wsRequests.length;
      await userEvent.keyboard("{Tab}");

      await expect.element(editor).toHaveTextContent("继续把剩下的两个测试也修好");
      await expect.element(ghost).not.toBeInTheDocument();
      // Accepting only fills the composer: nothing is sent.
      expect(
        wsRequests
          .slice(requestsBeforeAccept)
          .some((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the localized product title when a zh-CN draft starts voice chat", async () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
    localStorage.setItem("moss.realtimeVoice.onboarding.completed.v1", "1");
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: THREAD_ID },
    });
    const voiceApi = installRealtimeVoiceChatNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      wsRequests.length = 0;
      const startButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[data-moss-realtime-voice-launch="true"][data-moss-realtime-voice-action="start"]',
          ),
        "Unable to find Realtime Voice start control on the zh-CN draft.",
      );
      startButton.click();

      await vi.waitFor(
        () => {
          const createThread = wsRequests
            .map(readDispatchedCommand)
            .find((command) => command?.type === "thread.create" && command.threadId === THREAD_ID);
          expect(createThread).toMatchObject({
            title: "新建语音对话",
            projectId: PROJECT_ID,
            modelSelection: { instanceId: "codex", model: "gpt-5" },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      voiceApi.restore();
    }
  });

  it("keeps first-run voice onboarding pending across draft promotion remounts", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: { [PROJECT_ID]: THREAD_ID },
    });
    const voiceApi = installRealtimeVoiceChatNativeApi({
      ...INACTIVE_REALTIME_VOICE_STATE,
      phase: "failed",
      threadId: THREAD_ID,
      error: "Previous launch failed before the draft was promoted.",
    });
    let mounted: MountedChatView | null = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });
    let remounted: MountedChatView | null = null;

    try {
      const startButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[data-moss-realtime-voice-launch="true"][data-moss-realtime-voice-action="start"]',
          ),
        "Unable to find Realtime Voice start control on the local draft.",
      );
      startButton.click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests
              .map(readDispatchedCommand)
              .some(
                (command) => command?.type === "thread.create" && command.threadId === THREAD_ID,
              ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      const promotedSnapshot = addThreadToSnapshot(fixture.snapshot, THREAD_ID);
      fixture.snapshot = promotedSnapshot;
      useStore.getState().syncServerReadModel(promotedSnapshot);

      await vi.waitFor(
        () => {
          expect(
            document.querySelector('[data-moss-realtime-voice-onboarding="true"]'),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.cleanup();
      mounted = null;
      remounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: promotedSnapshot,
      });

      await vi.waitFor(
        () => {
          expect(
            document.querySelector('[data-moss-realtime-voice-onboarding="true"]'),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted?.cleanup();
      await remounted?.cleanup();
      voiceApi.restore();
    }
  });
  it("keeps one active voice transport across real ChatView A-to-B-to-A routing", async () => {
    const reportedErrorStacks: string[] = [];
    const originalConsoleError = console.error;
    const errorObserver = vi.spyOn(console, "error").mockImplementation((...args) => {
      for (const value of args) {
        if (value instanceof Error) reportedErrorStacks.push(value.stack ?? String(value));
      }
      originalConsoleError(...args);
    });
    onTestFinished(() => errorObserver.mockRestore());
    localStorage.setItem("moss.realtimeVoice.onboarding.completed.v1", "1");
    const voiceApi = installRealtimeVoiceChatNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createRealtimeVoiceRouteSnapshot(),
    });

    try {
      const startButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[data-moss-realtime-voice-launch="true"][data-moss-realtime-voice-action="start"]',
          ),
        "Unable to find Realtime Voice start control in ChatView.",
      );
      startButton.click();

      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-moss-realtime-voice-stage="true"]')).toBeTruthy();
          expect(
            document.querySelector('[data-moss-realtime-voice-composer-controls="true"]'),
          ).toBeTruthy();
          expect(voiceApi.start).toHaveBeenCalledTimes(1);
          expect(voiceApi.reportClientState).toHaveBeenCalledTimes(1);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(realtimeVoiceChatHarness.webRtcConstructed).toHaveBeenCalledTimes(1);
      expect(realtimeVoiceChatHarness.webSocketConstructed).toHaveBeenCalledTimes(1);
      expect(voiceApi.onEvent).toHaveBeenCalledTimes(1);

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
          expect(document.querySelector('[data-moss-realtime-voice-stage="true"]')).toBeNull();
          expect(
            document.querySelector(
              'button[data-moss-realtime-voice-launch="true"][data-moss-realtime-voice-action="return"]',
            ),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      const returnToVoiceOwner = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[data-moss-realtime-voice-launch="true"][data-moss-realtime-voice-action="return"]',
          ),
        "Unable to find the production return-to-voice-owner control in thread B.",
      );
      expect(returnToVoiceOwner.disabled).toBe(false);
      returnToVoiceOwner.click();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
          expect(document.querySelector('[data-moss-realtime-voice-stage="true"]')).toBeTruthy();
          expect(
            document.querySelector('[data-moss-realtime-voice-composer-controls="true"]'),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
          expect(document.querySelector('[data-moss-realtime-voice-stage="true"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      const ordinaryThreadPrompt = "ordinary B message must not enter owner A voice";
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, ordinaryThreadPrompt);
      const otherThreadComposer = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find thread B composer.",
      );
      otherThreadComposer.requestSubmit();

      await vi.waitFor(
        () => {
          const threadBTurn = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.turn.start" && command.threadId === OTHER_THREAD_ID,
            );
          expect(threadBTurn).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(voiceApi.appendText).not.toHaveBeenCalled();
      expect(voiceApi.stop).not.toHaveBeenCalled();
      expect(realtimeVoiceChatHarness.webRtcDisposed).not.toHaveBeenCalled();

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
          expect(document.querySelector('[data-moss-realtime-voice-stage="true"]')).toBeTruthy();
          expect(
            document.querySelector('[data-moss-realtime-voice-composer-controls="true"]'),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      const ownerThreadPrompt = "owner A text stays on the ordinary task model";
      const ownerTurnsBefore = wsRequests
        .map(readDispatchedCommand)
        .filter(
          (command) => command?.type === "thread.turn.start" && command.threadId === THREAD_ID,
        ).length;
      useComposerDraftStore.getState().setPrompt(THREAD_ID, ownerThreadPrompt);
      const ownerComposer = await waitForElement(
        () => document.querySelector<HTMLFormElement>('form[data-chat-composer-form="true"]'),
        "Unable to find thread A composer after return.",
      );
      ownerComposer.requestSubmit();
      await vi.waitFor(
        () => {
          const ownerTurns = wsRequests
            .map(readDispatchedCommand)
            .filter(
              (command) => command?.type === "thread.turn.start" && command.threadId === THREAD_ID,
            );
          expect(ownerTurns).toHaveLength(ownerTurnsBefore + 1);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(voiceApi.appendText).not.toHaveBeenCalled();

      expect(voiceApi.start).toHaveBeenCalledTimes(1);
      expect(voiceApi.onEvent).toHaveBeenCalledTimes(1);
      expect(voiceApi.unsubscribe).not.toHaveBeenCalled();
      expect(voiceApi.stop).not.toHaveBeenCalled();
      expect(realtimeVoiceChatHarness.webRtcConstructed).toHaveBeenCalledTimes(1);
      expect(realtimeVoiceChatHarness.webSocketConstructed).toHaveBeenCalledTimes(1);
      expect(realtimeVoiceChatHarness.webRtcDisposed).not.toHaveBeenCalled();
      expect(reportedErrorStacks).toEqual([]);
    } finally {
      if (reportedErrorStacks.length > 0) {
        console.info("MOSS_CHATVIEW_VOICE_ROUTE_ERROR_STACKS", JSON.stringify(reportedErrorStacks));
      }
      await mounted.cleanup();
      voiceApi.restore();
    }

    expect(voiceApi.unsubscribe).toHaveBeenCalledTimes(1);
    expect(realtimeVoiceChatHarness.webRtcDisposed).toHaveBeenCalledTimes(1);
  });

  it("replaces the empty-thread hero with Codex's transcript-and-voice-stage layout", async () => {
    localStorage.setItem("moss.realtimeVoice.onboarding.completed.v1", "1");
    document.documentElement.classList.add("dark");
    const voiceApi = installRealtimeVoiceChatNativeApi();
    let mounted: MountedChatView | null = null;
    const previousDesktopBridge = window.desktopBridge;
    let overlayCommandListener:
      | ((
          command: DesktopRealtimeVoiceOverlayCommand,
          handoff: DesktopRealtimeVoiceOverlayHandoff | null,
        ) => void)
      | null = null;
    const overlayPublish = vi.fn(async () => undefined);

    try {
      mounted = await mountChatView({
        viewport: { ...DEFAULT_VIEWPORT, name: "voice-visual", width: 1_603, height: 915 },
        snapshot: createEmptyRealtimeVoiceRouteSnapshot(),
      });
      await expect.element(page.getByTestId("empty-landing-heading")).toBeInTheDocument();
      const startButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[data-moss-realtime-voice-launch="true"][data-moss-realtime-voice-action="start"]',
          ),
        "Unable to find Realtime Voice start control on the empty thread.",
      );
      startButton.click();

      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-testid="empty-landing-heading"]')).toBeNull();
          expect(document.querySelector("[data-chat-transcript-pane]")).toBeTruthy();
          expect(document.querySelector('[data-moss-realtime-voice-stage="true"]')).toBeTruthy();
          expect(
            document.querySelector('[data-moss-realtime-voice-composer-controls="true"]'),
          ).toBeTruthy();
          expect(document.querySelector('[data-empty-landing-composer-block="true"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? {
                ...thread,
                messages: [
                  createUserMessage({
                    id: "voice-persisted-user" as MessageId,
                    text: "empty-thread typed voice prompt persisted",
                    offsetSeconds: 6_000,
                  }),
                  createAssistantMessage({
                    id: "voice-persisted-assistant" as MessageId,
                    text: "empty-thread voice reply persisted",
                    offsetSeconds: 6_001,
                  }),
                ],
              }
            : thread,
        ),
      };
      useStore.getState().syncServerReadModel(fixture.snapshot);

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("empty-thread typed voice prompt persisted");
          expect(document.body.textContent).toContain("empty-thread voice reply persisted");
          expect(document.querySelector('[data-moss-realtime-voice-stage="true"]')).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(voiceApi.start).toHaveBeenCalledTimes(1);
      expect(voiceApi.onEvent).toHaveBeenCalledTimes(1);
      expect(voiceApi.stop).not.toHaveBeenCalled();
      expect(realtimeVoiceChatHarness.webRtcConstructed).toHaveBeenCalledTimes(1);
      expect(realtimeVoiceChatHarness.webRtcDisposed).not.toHaveBeenCalled();
      const screenshotPath = await page.screenshot({
        path: "../../../../.tmp/realtime-voice/moss-realtime-voice-chatview-active-1603x915.png",
      });
      expect(screenshotPath).toContain("moss-realtime-voice-chatview-active-1603x915.png");

      Object.defineProperty(window, "desktopBridge", {
        configurable: true,
        writable: true,
        value: {
          ...(previousDesktopBridge ?? {}),
          setTheme: vi.fn(async () => undefined),
          realtimeVoice: {
            setGlobalShortcut: vi.fn(async (shortcut: string | null) => ({
              registered: shortcut !== null,
              shortcut,
              reason: null,
            })),
            captureScreenContext: vi.fn(async () => {
              throw new Error("screen context is outside this browser fixture");
            }),
            onToggle: vi.fn(() => () => undefined),
            overlay: {
              publish: overlayPublish,
              onCommand: vi.fn((listener) => {
                overlayCommandListener = listener;
                return () => {
                  if (overlayCommandListener === listener) overlayCommandListener = null;
                };
              }),
            },
          },
        } as NonNullable<typeof window.desktopBridge>,
      });
      voiceApi.emit({
        type: "state",
        sessionId: REALTIME_VOICE_SESSION_ID,
        threadId: THREAD_ID,
        createdAt: "2026-07-30T15:00:00.000Z",
        state: { ...ACTIVE_REALTIME_VOICE_STATE, activity: "speaking" },
      });
      const detachButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[aria-label="Move voice chat to floating overlay"]',
          ),
        "Unable to find the voice orb detach control.",
      );
      detachButton.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      );
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-moss-realtime-voice-stage="true"]')).toBeNull();
          expect(document.querySelector('[data-testid="empty-landing-heading"]')).toBeNull();
          expect(overlayPublish).toHaveBeenCalledWith(
            expect.objectContaining({
              mediaOwnerActive: true,
              snapshot: expect.objectContaining({ phase: "active" }),
            }),
          );
          expect(overlayCommandListener).not.toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      const handoffListener = overlayCommandListener as
        | ((
            command: DesktopRealtimeVoiceOverlayCommand,
            handoff: DesktopRealtimeVoiceOverlayHandoff | null,
          ) => void)
        | null;
      if (!handoffListener) {
        throw new Error("Expected the native overlay handoff listener to be registered.");
      }
      handoffListener("handoff", null);
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-moss-realtime-voice-stage="true"]')).toBeTruthy();
          expect(document.querySelector('[data-testid="empty-landing-heading"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted?.cleanup();
      voiceApi.restore();
      if (previousDesktopBridge) {
        Object.defineProperty(window, "desktopBridge", {
          configurable: true,
          writable: true,
          value: previousDesktopBridge,
        });
      } else {
        Reflect.deleteProperty(window, "desktopBridge");
      }
      document.documentElement.classList.remove("dark");
    }
  });
});
