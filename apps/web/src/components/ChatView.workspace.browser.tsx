// FILE: ChatView.workspace.browser.tsx
// Purpose: Full-app ChatView browser tests for the chat's workspace: branches, worktrees, project cwd, terminals and project scripts.
//          The shared fixture is src/test/chatViewBrowserHarness.tsx; every ChatView.*.browser.tsx
//          keeps the one suite name, so case names (and the CI partitions) are unchanged.

import {
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  ThreadId,
  WS_METHODS,
} from "@moss/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { useComposerDraftStore } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useRightDockStore } from "../rightDockStore";
import { dockTerminalThreadId } from "../lib/dockTerminalScope";
import { collectLeaves } from "../splitView.logic";
import { resolveSplitViewPaneIdForThread, useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_VIEWPORT,
  NOW_ISO,
  OTHER_THREAD_ID,
  PROJECT_ID,
  THREAD_ID,
  UUID_ROUTE_RE,
  addThreadToSnapshot,
  contextMenuRows,
  createComposerImage,
  createDraftOnlySnapshot,
  createSnapshotForTargetUser,
  dispatchConfiguredShortcutWhenReady,
  fixture,
  installDeterministicSendNativeApi,
  mountChatView,
  readDispatchedCommand,
  readEmptyLandingEnvMode,
  setAttachmentCancelBarrier,
  setAttachmentUploadBarrier,
  setEmptyLandingEnvMode,
  waitForComposerEditor,
  waitForElement,
  waitForLayout,
  waitForSendButton,
  waitForServerConfigToApply,
  waitForURL,
  withHomeChatProject,
  withProjectScripts,
  withSettledThreadBranch,
  withStudioProject,
  wsRequests,
  installChatViewFixture,
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

  it("opens the project cwd for draft threads without a worktree path", async () => {
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
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      const openInVsCodeTrigger = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent?.trim() === "Open in VS Code",
          ) ?? null,
        "Unable to find Open in VS Code environment row.",
      );
      openInVsCodeTrigger.click();

      const vscodeOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
            (item) => item.textContent?.trim() === "VS Code",
          ) ?? null,
        "Unable to find VS Code editor option.",
      );
      vscodeOption.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("resets branch selector state when switching threads", async () => {
    // Use only a branch selector a person can reach: a closed Environment card keeps its own, inert.
    const reachableBranchTrigger = () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>('button[data-slot="combobox-trigger"]'),
      ].find((trigger) => !trigger.closest("[inert]")) ?? null;
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ localeOverride: "en", environmentPanelDefaultOpen: true }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-branch-selector-switch" as MessageId,
          targetText: "branch selector switch",
        }),
        OTHER_THREAD_ID,
      ),
    });

    try {
      const branchTrigger = await waitForElement(
        reachableBranchTrigger,
        "Unable to find branch selector trigger.",
      );
      await vi.waitFor(() => expect(branchTrigger.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      branchTrigger.click();

      const branchSearch = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search branches..."]'),
        "Unable to find branch selector search input.",
      );
      await page.getByPlaceholder("Search branches...").fill("stale-query");
      expect(branchSearch.value).toBe("stale-query");

      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${OTHER_THREAD_ID}`,
        "Thread route did not switch.",
      );
      await waitForLayout();

      await vi.waitFor(
        () => {
          expect(
            document.querySelector('input[placeholder="Search branches..."]'),
            "Branch selector state remained open after switching threads.",
          ).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );

      const nextBranchTrigger = await waitForElement(
        reachableBranchTrigger,
        "Unable to find branch selector after switching threads.",
      );
      nextBranchTrigger.click();
      const resetSearch = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search branches..."]'),
        "Unable to reopen branch selector after switching threads.",
      );
      expect(resetSearch.value).toBe("");
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns before sending from a settled thread on another branch", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withSettledThreadBranch(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-settled-branch-warning" as MessageId,
          targetText: "settled branch warning",
        }),
        "feature/finished",
      ),
      configureFixture: (nextFixture) => {
        nextFixture.gitBranchByCwd["/repo/project"] = "feature/current";
      },
    });

    try {
      await expect
        .element(page.getByTestId("composer-branch-mismatch-warning"))
        .toBeInTheDocument();
      const branchWarning = page.getByTestId("composer-branch-mismatch-warning").element();
      expect(branchWarning.getBoundingClientRect().height).toBeLessThanOrEqual(80);
      expect(branchWarning.textContent).toContain(
        "Sending a message will move this thread to the current branch",
      );
      const threadBranchLabel = branchWarning.querySelector<HTMLElement>(
        '[title="Thread branch: feature/finished"]',
      );
      const currentBranchLabel = branchWarning.querySelector<HTMLElement>(
        '[title="Current branch: feature/current"]',
      );
      expect(threadBranchLabel).not.toBeNull();
      expect(currentBranchLabel).not.toBeNull();
      expect(getComputedStyle(threadBranchLabel!).textOverflow).toBe("ellipsis");
      expect(getComputedStyle(currentBranchLabel!).textOverflow).toBe("ellipsis");
      expect(document.body.textContent).toContain("feature/finished");
      expect(document.body.textContent).toContain("feature/current");

      // Simulate an out-of-band checkout after the cached branch query resolved. The send
      // path must refresh Git status instead of trusting the stale composer warning.
      fixture.gitBranchByCwd["/repo/project"] = "feature/latest";
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "resume settled thread");
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => expect(composerEditor.textContent ?? "").toContain("resume settled thread"),
        { timeout: 8_000, interval: 16 },
      );
      wsRequests.length = 0;
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      await page.getByRole("button", { name: "Send message" }).click();

      await vi.waitFor(
        () => {
          const branchUpdate = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.meta.update" &&
                command.threadId === THREAD_ID &&
                command.branch === "feature/latest",
            );
          expect(branchUpdate).toBeTruthy();
          const branchUpdateIndex = wsRequests.findIndex((request) => {
            const command = readDispatchedCommand(request);
            return (
              command?.type === "thread.meta.update" &&
              command.threadId === THREAD_ID &&
              command.branch === "feature/latest"
            );
          });
          const turnStartIndex = wsRequests.findIndex(
            (request) => readDispatchedCommand(request)?.type === "thread.turn.start",
          );
          expect(turnStartIndex).toBeGreaterThan(branchUpdateIndex);
        },
        { timeout: 8_000, interval: 16 },
      );
      await vi.waitFor(
        () =>
          expect(
            document.querySelector('[data-testid="composer-branch-mismatch-warning"]'),
          ).toBeNull(),
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the activated branch through reconciliation and recaptures it when switching back", async () => {
    const base = addThreadToSnapshot(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-branch-activation" as MessageId,
        targetText: "branch activation snapshot",
      }),
      OTHER_THREAD_ID,
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        threads: base.threads.map((thread) =>
          Object.assign({}, thread, {
            branch: thread.id === THREAD_ID ? "feature/first" : "feature/second",
            settledAt: NOW_ISO,
          }),
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.gitBranchByCwd["/repo/project"] = "feature/current";
      },
    });
    const expectBranch = async (branch: string) => {
      await vi.waitFor(() =>
        expect(
          document.querySelector(
            `[data-testid="composer-branch-mismatch-warning"] [title="Thread branch: ${branch}"]`,
          ),
          `Expected ${branch} at ${mounted.router.state.location.pathname}; warning: ${document.querySelector('[data-testid="composer-branch-mismatch-warning"]')?.textContent}`,
        ).not.toBeNull(),
      );
    };
    try {
      await expectBranch("feature/first");
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, { branch: "feature/updated" })
            : thread,
        ),
      };
      useStore.getState().syncServerReadModel(fixture.snapshot);
      await waitForLayout();
      // Same-thread updates must not replace the original warning's branch.
      await expectBranch("feature/first");

      await mounted.router.navigate({ to: "/$threadId", params: { threadId: OTHER_THREAD_ID } });
      await expectBranch("feature/second");
      // Switch back immediately after the first committed warning, without waiting for timers.
      await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
      await expectBranch("feature/updated");
    } finally {
      await mounted.cleanup();
    }
  });

  it("restores a settled thread branch when turn start fails", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi({ rejectTurnStart: true });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withSettledThreadBranch(
        createSnapshotForTargetUser({
          targetMessageId: "msg-user-settled-branch-failed-send" as MessageId,
          targetText: "settled branch failed send",
        }),
        "feature/finished",
      ),
      configureFixture: (nextFixture) => {
        nextFixture.gitBranchByCwd["/repo/project"] = "feature/current";
      },
    });

    try {
      await expect
        .element(page.getByTestId("composer-branch-mismatch-warning"))
        .toBeInTheDocument();
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "retry after failed turn start");
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      wsRequests.length = 0;
      sendButton.click();

      await vi.waitFor(
        () => {
          const branchUpdates = wsRequests
            .map(readDispatchedCommand)
            .filter((command) => command?.type === "thread.meta.update" && "branch" in command)
            .map((command) => command?.branch);
          expect(branchUpdates).toEqual(["feature/current", "feature/finished"]);
          expect(useStore.getState().threadShellById?.[THREAD_ID]?.branch).toBe("feature/finished");
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect
        .element(page.getByTestId("composer-branch-mismatch-warning"))
        .toBeInTheDocument();
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
        "retry after failed turn start",
      );
    } finally {
      restoreNativeApi();
      await mounted.cleanup();
    }
  });

  it("keeps a failed send's explanation when a re-sync replaces the thread error", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi({ rejectTurnStart: true });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-failed-send-resync" as MessageId,
        targetText: "failed send across a reconnect",
      }),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "sent during the restart");
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      sendButton.click();

      const banner = page.getByRole("alert").filter({ hasText: "Turn start failed for test." });
      await expect.element(banner).toBeVisible();
      await vi.waitFor(
        () =>
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            "sent during the restart",
          ),
        { timeout: 8_000, interval: 16 },
      );

      // What a reconnect's snapshot does: the thread's error follows the server's session.
      useStore.getState().setError(THREAD_ID, null);
      await waitForLayout();
      await expect.element(banner).toBeVisible();

      await banner.getByRole("button", { name: /dismiss/i }).click();
      await expect.element(banner).not.toBeInTheDocument();
    } finally {
      restoreNativeApi();
      await mounted.cleanup();
    }
  });

  it("retains the opened terminal identity when path navigation fails", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("path-terminal-retry"),
        targetText: "Path navigation",
      }),
    });
    const previousNativeApi = window.nativeApi;
    const nativeApi = readNativeApi()!;
    const writes: Array<Parameters<typeof nativeApi.terminal.write>[0]> = [];
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...nativeApi,
        terminal: {
          ...nativeApi.terminal,
          write: async (input: Parameters<typeof nativeApi.terminal.write>[0]) => {
            if (input.onlyIfIdle) {
              writes.push(input);
              throw new Error("Activity check unavailable");
            }
            return nativeApi.terminal.write(input);
          },
        },
      },
    });
    try {
      const row = await waitForElement<HTMLElement>(
        () => document.querySelector("[data-thread-item] [data-thread-entry-point]"),
        "Expected sidebar thread row",
      );
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 160 }),
      );
      (
        await waitForElement<HTMLButtonElement>(
          () =>
            contextMenuRows().find((button) =>
              button.textContent?.includes("Open Path in Terminal"),
            ) ?? null,
          "Expected path action",
        )
      ).click();
      await expect.poll(() => writes.length).toBe(1);
      await expect
        .element(page.getByText("Unable to open terminal", { exact: true }))
        .toBeVisible();
      const state = useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]!;
      expect(state.terminalOpen).toBe(false);
      expect(state.activeTerminalId).toBe(writes[0]!.terminalId);
      expect(state.hasSession).toBe(true);
      useTerminalStateStore.getState().setTerminalOpen(THREAD_ID, true);
      expect(
        useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]?.activeTerminalId,
      ).toBe(writes[0]!.terminalId);
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

  it.each(["button", "draft shortcut", "split button"] as const)(
    "runs project scripts in the right dock at the worktree cwd via %s",
    async (entryPoint) => {
      useComposerDraftStore.setState({
        draftThreadsByThreadId: {
          [THREAD_ID]: {
            projectId: PROJECT_ID,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            entryPoint: "chat",
            branch: "feature/draft",
            worktreePath: "/repo/worktrees/feature-draft",
            envMode: "worktree",
          },
        },
        projectDraftThreadIdByProjectId: {
          [PROJECT_ID]: THREAD_ID,
        },
      });

      const baseSnapshot =
        entryPoint === "draft shortcut"
          ? createDraftOnlySnapshot()
          : createSnapshotForTargetUser({
              targetMessageId: MessageId.makeUnsafe("action-button-worktree"),
              targetText: "Keep this chat visible",
            });
      const snapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) => ({
          ...thread,
          envMode: "worktree",
          worktreePath: "/repo/worktrees/feature-draft",
        })),
      };
      useRightDockStore.setState({ dockStateByThreadId: {} });

      const mounted = await mountChatView({
        viewport: { ...DEFAULT_VIEWPORT, width: 1_800 },
        snapshot: withProjectScripts(
          entryPoint === "split button" ? addThreadToSnapshot(snapshot, OTHER_THREAD_ID) : snapshot,
          [
            {
              id: "test",
              name: "Test",
              command: "bun run test",
              icon: "test",
              runOnWorktreeCreate: false,
            },
          ],
        ),
        // The empty landing runs minimal chrome with no scripts control, so drafts
        // reach scripts through their keybindings; drive the same runProjectScript
        // path the way a user would.
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "script.test.run",
                shortcut: {
                  key: "t",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: true,
                  altKey: true,
                  modKey: true,
                },
              },
            ],
          };
        },
      });

      try {
        await waitForServerConfigToApply();
        if (entryPoint === "split button") {
          const splitViewId = useSplitViewStore.getState().createFromDrop({
            sourceThreadId: THREAD_ID,
            ownerProjectId: PROJECT_ID,
            droppedThreadId: OTHER_THREAD_ID,
            direction: "horizontal",
            side: "second",
          });
          const splitView = useSplitViewStore.getState().splitViewsById[splitViewId]!;
          const actionPaneId = resolveSplitViewPaneIdForThread(splitView, THREAD_ID)!;
          useSplitViewStore
            .getState()
            .setPanePanelState(splitViewId, actionPaneId, { panel: "diff" });
          await mounted.router.navigate({
            to: "/$threadId",
            params: { threadId: THREAD_ID },
            search: () => ({ splitViewId }),
          });
          await vi.waitFor(() =>
            expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(2),
          );
        }
        if (entryPoint !== "draft shortcut") {
          // Project scripts live in the Environment card (the upstream thread-details
          // layout), not in the header: open the card, then run the action from it.
          if (
            document.querySelector('[data-environment-panel-variant][aria-hidden="false"]') === null
          ) {
            await page
              .getByRole("button", { name: "Toggle environment panel", exact: true })
              .first()
              .click();
          }
          await page.getByRole("button", { name: "Run Test", exact: true }).first().click();
        } else {
          await dispatchConfiguredShortcutWhenReady(window, {
            key: "t",
            shiftKey: true,
            altKey: true,
          });
        }

        await vi.waitFor(
          () => {
            const openRequest = wsRequests.find(
              (request) =>
                request._tag === WS_METHODS.terminalOpen &&
                request.cwd === "/repo/worktrees/feature-draft",
            );
            expect(openRequest).toMatchObject({
              _tag: WS_METHODS.terminalOpen,
              threadId: dockTerminalThreadId(THREAD_ID),
              cwd: "/repo/worktrees/feature-draft",
              env: {
                MOSS_PROJECT_ROOT: "/repo/project",
                MOSS_WORKTREE_PATH: "/repo/worktrees/feature-draft",
              },
            });
          },
          { timeout: 8_000, interval: 16 },
        );

        await vi.waitFor(
          () => {
            const writeRequest = wsRequests.find(
              (request) => request._tag === WS_METHODS.terminalWrite,
            );
            expect(writeRequest).toMatchObject({
              _tag: WS_METHODS.terminalWrite,
              threadId: dockTerminalThreadId(THREAD_ID),
              data: "bun run test\r",
            });
          },
          { timeout: 8_000, interval: 16 },
        );
        await expect.element(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
        const terminalSelector =
          entryPoint === "split button"
            ? '[data-split-pane-focused] aside[aria-label="Terminal"]'
            : '[data-right-dock-content] aside[aria-label="Terminal"]';
        expect(document.querySelector(terminalSelector)).not.toBeNull();
        if (entryPoint === "split button") {
          expect(mounted.router.state.location.search.splitViewId).toBeDefined();
          expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(2);
        }
        expect((await waitForComposerEditor()).getBoundingClientRect().width).toBeGreaterThan(0);
        if (entryPoint === "split button") {
          const openedSessionIds = new Set(
            wsRequests
              .filter((request) => request._tag === WS_METHODS.terminalOpen)
              .map((request) => request.terminalId),
          );
          await page.getByRole("button", { name: "Hide terminal", exact: true }).click();
          await expect
            .element(page.getByRole("complementary", { name: "Terminal" }))
            .not.toBeInTheDocument();
          await page
            .getByRole("button", { name: "Toggle right sidebar", exact: true })
            .first()
            .click();
          await expect.element(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
          expect(
            new Set(
              wsRequests
                .filter((request) => request._tag === WS_METHODS.terminalOpen)
                .map((request) => request.terminalId),
            ),
          ).toEqual(openedSessionIds);
          const splitViewId = mounted.router.state.location.search.splitViewId!;
          const splitView = useSplitViewStore.getState().splitViewsById[splitViewId]!;
          expect(
            collectLeaves(splitView.root).find((leaf) => leaf.threadId === THREAD_ID)?.panel.panel,
          ).toBe("diff");
        }
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("creates a detached worktree on first send in New worktree mode", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-worktree-send-test" as MessageId,
        targetText: "new worktree send test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
          ).toBe(newThreadId);
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(mounted.router.state.status).toBe("idle");
        },
        { timeout: 8_000, interval: 16 },
      );
      await setEmptyLandingEnvMode("worktree");

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)?.envMode).toBe(
            "worktree",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().setPrompt(newThreadId, "Ship it");
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            envMode: "worktree",
            branch: "main",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("Ship it");
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      await sendButton.click();

      await vi.waitFor(
        () => {
          const createWorktreeRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.gitCreateDetachedWorktree &&
              request.cwd === "/repo/project" &&
              request.ref === "main" &&
              request.copyChangesFrom === "/repo/project",
          );
          expect(createWorktreeRequest).toBeTruthy();
          const temporaryBranch = createWorktreeRequest?.newBranch;
          expect(typeof temporaryBranch).toBe("string");
          expect(temporaryBranch).toMatch(/^moss\/[0-9a-f]{8}$/);

          const createThreadRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              typeof request.command === "object" &&
              request.command !== null &&
              "type" in request.command &&
              "threadId" in request.command &&
              request.command.type === "thread.create" &&
              request.command.threadId === newThreadId,
          );
          expect(createThreadRequest).toBeTruthy();
          expect(createThreadRequest?.command).toMatchObject({
            envMode: "worktree",
            branch: "main",
            worktreePath: null,
          });
          const linkedWorkspace = wsRequests
            .map(readDispatchedCommand)
            .find(
              (command) =>
                command?.type === "thread.meta.update" &&
                command.threadId === newThreadId &&
                command.worktreePath === "/repo/.codex/worktrees/generated/moss",
            );
          expect(linkedWorkspace).toMatchObject({
            envMode: "worktree",
            branch: temporaryBranch,
            worktreePath: "/repo/.codex/worktrees/generated/moss",
            associatedWorktreePath: "/repo/.codex/worktrees/generated/moss",
            associatedWorktreeBranch: temporaryBranch,
            associatedWorktreeRef: "0123456789abcdef0123456789abcdef01234567",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("keeps worktree setup resolvable while attachments upload", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    let releaseAttachmentUpload = () => {};
    let releaseAttachmentCancel = () => {};
    setAttachmentUploadBarrier(
      new Promise<void>((resolve) => {
        releaseAttachmentUpload = resolve;
      }),
    );
    setAttachmentCancelBarrier(
      new Promise<void>((resolve) => {
        releaseAttachmentCancel = resolve;
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-worktree-cancel-upload-test" as MessageId,
        targetText: "new worktree cancel upload test",
      }),
    });

    try {
      await page.getByTestId("new-thread-button").click();
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await setEmptyLandingEnvMode("worktree");
      await vi.waitFor(async () => {
        expect(await readEmptyLandingEnvMode()).toBe("worktree");
      });

      useComposerDraftStore.getState().setPrompt(newThreadId, "Cancel before upload finishes");
      useComposerDraftStore.getState().addImage(
        newThreadId,
        createComposerImage({
          id: "new-worktree-cancel-upload-image",
          previewUrl: "blob:new-worktree-cancel-upload-image",
        }),
      );
      const composerForm = document.querySelector<HTMLFormElement>(
        'form[data-chat-composer-form="true"]',
      );
      expect(composerForm).not.toBeNull();
      composerForm!.requestSubmit();

      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>('[data-timeline-row-kind="worktree-setup"]')
              ?.textContent,
        )
        .toContain("Linking thread workspace");
      const cancelButton = page.getByRole("button", { name: "Cancel" });
      await expect.element(cancelButton).toBeInTheDocument();
      expect(
        wsRequests.some(
          (candidate) => readDispatchedCommand(candidate)?.type === "thread.turn.start",
        ),
      ).toBe(false);

      await cancelButton.click();
      releaseAttachmentCancel();
      setAttachmentCancelBarrier(null);
      releaseAttachmentUpload();
      setAttachmentUploadBarrier(null);

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (candidate) => readDispatchedCommand(candidate)?.type === "thread.turn.start",
            ),
          ).toBe(false);
          expect(
            wsRequests.some(
              (candidate) =>
                candidate._tag === WS_METHODS.gitRemoveWorktree &&
                candidate.path === "/repo/.codex/worktrees/generated/moss" &&
                candidate.force === true &&
                candidate.reclaimTemporaryBranch === true,
            ),
          ).toBe(true);
          expect(document.querySelector('[data-timeline-row-kind="worktree-setup"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      releaseAttachmentCancel();
      setAttachmentCancelBarrier(null);
      releaseAttachmentUpload();
      setAttachmentUploadBarrier(null);
      await mounted.cleanup();
      restoreNativeApi();
    }
  });

  it("runs the setup action from the newly-created worktree before starting the turn", async () => {
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(
        withStudioProject(
          withHomeChatProject(
            createSnapshotForTargetUser({
              targetMessageId: "msg-user-new-worktree-setup-action-test" as MessageId,
              targetText: "new worktree setup action test",
            }),
          ),
        ),
        [
          {
            id: "setup",
            name: "Setup",
            command: "printf setup",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
      ),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId,
          ).toBe(newThreadId);
          expect(mounted.router.state.location.pathname).toBe(newThreadPath);
          expect(mounted.router.state.status).toBe("idle");
        },
        { timeout: 8_000, interval: 16 },
      );
      await setEmptyLandingEnvMode("worktree");

      useComposerDraftStore.getState().setPrompt(newThreadId, "Ship it with setup");
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).toMatchObject({
            envMode: "worktree",
            branch: "main",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          expect(composerEditor.textContent ?? "").toContain("Ship it with setup");
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      const composerForm = document.querySelector<HTMLFormElement>(
        'form[data-chat-composer-form="true"]',
      );
      expect(composerForm).not.toBeNull();
      composerForm!.requestSubmit();

      const createWorktreeRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.gitCreateDetachedWorktree &&
              candidate.cwd === "/repo/project" &&
              candidate.ref === "main",
          );
          expect(
            request,
            `Expected create worktree request; draft=${JSON.stringify(
              useComposerDraftStore.getState().getDraftThread(newThreadId),
            )}; path=${mounted.router.state.location.pathname}; forms=${
              document.querySelectorAll('form[data-chat-composer-form="true"]').length
            }; ui=${(document.body.textContent ?? "").slice(-300)}; saw ${wsRequests
              .map((candidate) => {
                const command = readDispatchedCommand(candidate);
                return command ? `${candidate._tag}:${command.type}` : candidate._tag;
              })
              .slice(-40)
              .join(", ")}`,
          ).toBeTruthy();
          if (!request || request._tag !== WS_METHODS.gitCreateDetachedWorktree) {
            throw new Error("Expected create worktree request.");
          }
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const createWorktreeIndex = wsRequests.indexOf(createWorktreeRequest);
      const worktreePath = "/repo/.codex/worktrees/generated/moss";

      const terminalOpenRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.terminalOpen &&
              candidate.threadId === dockTerminalThreadId(newThreadId) &&
              candidate.cwd === worktreePath,
          );
          expect(
            request,
            `Expected setup terminal open; saw ${wsRequests
              .map((candidate) => {
                const command = readDispatchedCommand(candidate);
                return command ? `${candidate._tag}:${command.type}` : candidate._tag;
              })
              .join(", ")}`,
          ).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const terminalOpenIndex = wsRequests.indexOf(terminalOpenRequest!);
      expect(terminalOpenIndex).toBeGreaterThan(createWorktreeIndex);
      expect(terminalOpenRequest).toMatchObject({
        _tag: WS_METHODS.terminalOpen,
        cwd: worktreePath,
        env: {
          MOSS_PROJECT_ROOT: "/repo/project",
          MOSS_WORKTREE_PATH: worktreePath,
        },
      });

      const terminalWriteRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find(
            (candidate) =>
              candidate._tag === WS_METHODS.terminalWrite &&
              candidate.threadId === dockTerminalThreadId(newThreadId) &&
              candidate.data === "printf setup\r",
          );
          expect(request).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      const terminalWriteIndex = wsRequests.indexOf(terminalWriteRequest!);
      expect(terminalWriteIndex).toBeGreaterThan(terminalOpenIndex);

      const turnStartRequest = await vi.waitFor(
        () => {
          const request = wsRequests.find((candidate) => {
            const command = readDispatchedCommand(candidate);
            return command?.type === "thread.turn.start" && command.threadId === newThreadId;
          });
          expect(request).toBeTruthy();
          return request;
        },
        { timeout: 10_000, interval: 16 },
      );
      expect(wsRequests.indexOf(turnStartRequest!)).toBeGreaterThan(terminalWriteIndex);
    } finally {
      await mounted.cleanup();
      restoreNativeApi();
    }
  });
});
