// FILE: ChatView.shell.browser.tsx
// Purpose: Full-app ChatView browser tests for the shell around the chat: sidebar, rail, title bar, tabs, split panes, side chats, Mossbot.
//          The shared fixture is src/test/chatViewBrowserHarness.tsx; every ChatView.*.browser.tsx
//          keeps the one suite name, so case names (and the CI partitions) are unchanged.

import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "../localization/zhCN";
import { EventId, MessageId, ThreadId, TurnId, WS_METHODS } from "@moss/contracts";
import { HttpResponse, http } from "msw";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { preloadSettingsPages } from "./settings/SettingsDialog";
import { useComposerDraftStore } from "../composerDraftStore";
import { setFeatureFlagEnabled } from "../featureFlags";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { isMacNavigatorPlatform } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { layoutReport } from "../lib/selfReport/layoutReport";
import { settleLayout } from "../lib/selfReport/screenshot";
import { showContextMenuFallback } from "../contextMenuFallback";
import { useRightDockStore } from "../rightDockStore";
import { closeSettings, openSettings, settingsDialogStore } from "../settingsDialogStore";
import { GITHUB_INBOX_DOCK_HOST_ID } from "../rightDockStore.logic";
import { useOpenThreadTabsStore } from "../openThreadTabsStore";
import { resolveSplitViewPaneIdForThread, useSplitViewStore } from "../splitViewStore";
import { splitViewPaneScopeId } from "../lib/chatPaneScope";
import { gitQueryKeys } from "../lib/gitReactQuery";
import { useRailShellStore } from "../railShellStore";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import { getAppTypographyScale } from "../lib/appTypography";
import { threadJumpCommandForIndex } from "../keybindings";
import { useStore } from "../store";
import { pageAssistantThreads } from "../lib/pageAi/pageAssistantThread";
import { createShellSnapshotFromReadModel } from "../test/effectRpcWebSocketMock";
import { unconfiguredMossCloudAccountState } from "../test/mossAccountStateFixtures";
import { useTerminalStateStore } from "../terminalStateStore";
import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_VIEWPORT,
  HOME_PROJECT_ID,
  MOSS_SEQUENCE_SESSION_ID,
  NOW_ISO,
  OTHER_THREAD_ID,
  PROJECT_ID,
  THREAD_ID,
  THREAD_TITLE,
  UUID_ROUTE_RE,
  type ViewportSpec,
  addThreadToSnapshot,
  contextMenuRows,
  createAssistantMessage,
  createDraftOnlySnapshot,
  createMossVisibleSequenceEvent,
  createSnapshotForTargetUser,
  createSnapshotWithInlineToolOverflow,
  createSnapshotWithLongAssistantResponse,
  createSnapshotWithPendingApproval,
  createUserMessage,
  dispatchConfiguredShortcut,
  dispatchConfiguredShortcutWhenReady,
  fixture,
  installMossVisibleSequenceNativeApi,
  isTranscriptContentVisible,
  mountChatView,
  mousePointerEvent,
  nextFrame,
  setMossCloudAccountStateOverride,
  setViewport,
  skipReactDevOwnerStacks,
  threadDetailSnapshotBarrierById,
  triggerChatNewShortcutUntilPath,
  triggerThreadShortcutUntilPath,
  waitForComposerEditor,
  waitForElement,
  waitForLayout,
  waitForNewThreadShortcutLabel,
  waitForServerConfigToApply,
  waitForSplitChatReady,
  waitForURL,
  withActiveHomeChatThread,
  withHomeChatProject,
  worker,
  wsRequests,
  installChatViewFixture,
} from "../test/chatViewBrowserHarness";
import { desktopTitleBar } from "../test/chatViewBrowserMocks";

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

  it("keeps the active chat explicitly unread until the next visit", async () => {
    const snapshot = createSnapshotWithInlineToolOverflow({ active: false });
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      const shell = () => useStore.getState().threadShellById?.[THREAD_ID];
      const completedAt = snapshot.threads.find((thread) => thread.id === THREAD_ID)!.latestTurn!
        .completedAt!;
      await expect
        .poll(() => Date.parse(shell()?.lastVisitedAt ?? ""))
        .toBeGreaterThanOrEqual(Date.parse(completedAt));
      const input = document.querySelector('[data-chat-composer-form="true"]')!;
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "u",
          code: "KeyU",
          metaKey: isMacNavigatorPlatform(),
          ctrlKey: !isMacNavigatorPlatform(),
          altKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();
      expect(Date.parse(shell()?.lastVisitedAt ?? "")).toBe(Date.parse(completedAt) - 1);
      await mounted.router.navigate({ to: "/" });
      await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
      await expect
        .poll(() => Date.parse(shell()?.lastVisitedAt ?? ""))
        .toBeGreaterThanOrEqual(Date.parse(completedAt));
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a 资料空间 item's own chat out of the main sidebar, even with messages (walk S-6)", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("item-chat-hidden"),
      targetText: "A chat with a message",
    });
    const started = {
      ...base.threads[0]!,
      title: "Started chat",
      latestUserMessageAt: "2026-01-02T00:00:00.000Z",
    };
    const itemChatId = OTHER_THREAD_ID;
    // The 问 Moss chat of a slide deck, after the person asked it something.
    const itemChat = {
      ...base.threads[0]!,
      id: itemChatId,
      title: "Deck chat",
      session: { ...base.threads[0]!.session!, threadId: itemChatId },
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      latestUserMessageAt: "2026-01-03T00:00:00.000Z",
    };
    pageAssistantThreads.set("default:local:slides:deck-1", itemChatId);
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1280 },
      snapshot: { ...base, threads: [started, itemChat] },
    });
    try {
      await waitForLayout();
      const sidebar = () =>
        document.querySelector<HTMLElement>('[data-slot="sidebar"][data-side="left"]')!;
      await vi.waitFor(() => expect(sidebar().textContent).toContain("Started chat"));
      // Open project or closed (Recent): the item's chat is in neither list.
      expect(sidebar().textContent).not.toContain("Deck chat");
      useStore.getState().setProjectExpanded(PROJECT_ID, false);
      await vi.waitFor(() => expect(sidebar().textContent).toContain("Recent"));
      expect(sidebar().textContent).not.toContain("Deck chat");
    } finally {
      pageAssistantThreads.forget("default:local:slides:deck-1");
      // Later tests expect the fixture project open, as it starts.
      useStore.getState().setProjectExpanded(PROJECT_ID, true);
      await mounted.cleanup();
    }
  });

  it("never lands 首页 on a 资料空间 item's chat, and lists Getting started under the chats (walk D-3, R-5)", async () => {
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("recent-unstarted"),
      targetText: "A chat with a message",
    });
    const started = { ...base.threads[0]!, title: "Started chat" };
    const itemChatId = OTHER_THREAD_ID;
    // What a 资料空间 item makes for its 问 Moss panel, the newest chat of all.
    const itemChat = {
      ...base.threads[0]!,
      id: itemChatId,
      title: "Untitled slides",
      session: { ...base.threads[0]!.session!, threadId: itemChatId },
      createdAt: "2099-01-03T00:00:00.000Z",
      updatedAt: "2099-01-03T00:00:00.000Z",
      messages: [],
    };
    pageAssistantThreads.set("default:local:slides:untitled", itemChatId);
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1280 },
      snapshot: { ...base, threads: [started, itemChat] },
      configureFixture: (nextFixture) => {
        // A home folder, as on every real PC: with no chat left, 首页 opens a new chat there.
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester",
        };
      },
    });
    try {
      await waitForLayout();
      // 首页 from another page, once the chat the person was in is gone (archived elsewhere):
      // a new chat, never the item's chat, although it is the newest one.
      await mounted.router.navigate({ to: "/mossbot" });
      await expect.poll(() => mounted.router.state.location.pathname).toBe("/mossbot");
      useStore.getState().syncServerReadModel({
        ...base,
        snapshotSequence: base.snapshotSequence + 1,
        threads: [itemChat],
      });
      const rail = page.getByRole("navigation", { name: "Primary", exact: true });
      await rail.getByRole("button", { name: "Home", exact: true }).click();
      await expect.poll(() => mounted.router.state.location.pathname).not.toBe("/mossbot");
      expect(mounted.router.state.location.pathname).not.toBe(`/${itemChatId}`);
      // Recent: the started chat comes back, the item's chat stays out.
      useStore.getState().syncServerReadModel({
        ...base,
        snapshotSequence: base.snapshotSequence + 2,
        threads: [started, itemChat],
      });
      useStore.getState().setProjectExpanded(PROJECT_ID, false);
      await vi.waitFor(() => {
        const recent = Array.from(document.querySelectorAll("span")).find(
          (span) => span.textContent === "Recent",
        );
        expect(recent).toBeTruthy();
        const group = recent!.closest<HTMLElement>('[data-sidebar="group"]')!;
        expect(group.textContent).toContain("Started chat");
        expect(group.textContent).not.toContain("Untitled slides");
      });
      expect(document.querySelector("[data-sidebar-getting-started]")).not.toBeNull();
    } finally {
      pageAssistantThreads.forget("default:local:slides:untitled");
      // Later tests expect the fixture project open, as it starts.
      useStore.getState().setProjectExpanded(PROJECT_ID, true);
      await mounted.cleanup();
    }
  });

  it.each([
    { attentionFirst: false, reminderSeen: false, newerClientCompletion: false },
    { attentionFirst: true, reminderSeen: true, newerClientCompletion: false },
    { attentionFirst: true, reminderSeen: false, newerClientCompletion: false },
    { attentionFirst: true, reminderSeen: true, newerClientCompletion: true },
  ])(
    "reopens a snapshot project with attentionFirst=$attentionFirst and reminderSeen=$reminderSeen, newerClientCompletion=$newerClientCompletion",
    async ({ attentionFirst, reminderSeen, newerClientCompletion }) => {
      const base = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("snapshot-project-order"),
        targetText: "Open the existing project",
      });
      const neutral = {
        ...base.threads[0]!,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [],
        latestUserMessageAt: "2026-01-01T00:00:00.000Z",
      };
      const reminderId = OTHER_THREAD_ID;
      const newestId = ThreadId.makeUnsafe("snapshot-project-newest");
      const reminder = {
        ...neutral,
        id: reminderId,
        title: "Returned reminder",
        session: { ...neutral.session!, threadId: reminderId },
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
        latestUserMessageAt: "2026-02-01T00:00:00.000Z",
        snoozeReminderAt: "2026-02-02T00:00:00.000Z",
      };
      const newest = {
        ...neutral,
        id: newestId,
        title: "Latest project chat",
        session: { ...neutral.session!, threadId: newestId },
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
        latestUserMessageAt: "2026-03-01T00:00:00.000Z",
      };
      localStorage.setItem(
        "moss:app-settings:v1",
        JSON.stringify({
          sidebarThreadSortOrder: "updated_at",
          sidebarThreadAttentionFirst: attentionFirst,
        }),
      );
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: { ...base, threads: [neutral, reminder, newest] },
      });
      try {
        if (reminderSeen)
          useStore.getState().markThreadVisited(reminderId, "2026-02-03T00:00:00.000Z");
        if (newerClientCompletion) {
          // This update arrives after the response snapshot was captured. The
          // stale response must not overwrite the client's newer completed turn.
          useStore.getState().syncServerReadModel({
            ...base,
            snapshotSequence: base.snapshotSequence + 1,
            threads: [
              neutral,
              {
                ...reminder,
                latestTurn: {
                  turnId: TurnId.makeUnsafe("new-client-completion"),
                  state: "completed",
                  requestedAt: "2026-02-04T00:00:00.000Z",
                  startedAt: "2026-02-04T00:00:01.000Z",
                  completedAt: "2026-02-04T00:01:00.000Z",
                  assistantMessageId: null,
                },
              },
              newest,
            ],
          });
        }
        await page.getByRole("button", { name: "Add project", exact: true }).click();
        await page.getByLabelText("Project folder path").fill("/repo/project");
        await page.getByRole("button", { name: "Create project", exact: true }).click();
        const expectedId =
          attentionFirst && (!reminderSeen || newerClientCompletion) ? reminderId : newestId;
        await waitForURL(
          mounted.router,
          (path) => path === `/${expectedId}`,
          "Snapshot project opening ignored the attention preference or visited reminder state.",
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.each([
    { activityViewEnabled: false, customShortcut: false },
    { activityViewEnabled: true, customShortcut: false },
    { activityViewEnabled: false, customShortcut: true },
    { activityViewEnabled: true, customShortcut: true },
  ])(
    "keeps sidebar shortcut hints clear of row content (Activity: $activityViewEnabled, custom: $customShortcut)",
    async ({ activityViewEnabled, customShortcut }) => {
      const base = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("shortcut-layout"),
        targetText: "Review the sidebar layout",
      });
      const titles = [
        "Review authentication and session recovery",
        "Improve the checkout flow",
        "Check the background worker",
        "Update the account settings",
        "Investigate a long-running worktree task",
        "Review the session cancellation tests",
        "Review the deployment checklist",
      ];
      const now = new Date().toISOString();
      const threads = titles.map((title, index) => ({
        ...base.threads[0]!,
        id: index === 0 ? THREAD_ID : ThreadId.makeUnsafe(`shortcut-layout-${index}`),
        title,
        createdAt: now,
        updatedAt: now,
        latestTurn: {
          turnId: TurnId.makeUnsafe(`shortcut-layout-turn-${index}`),
          state: "completed" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          assistantMessageId: null,
        },
        session: {
          ...base.threads[0]!.session!,
          threadId: index === 0 ? THREAD_ID : ThreadId.makeUnsafe(`shortcut-layout-${index}`),
          updatedAt: now,
        },
        messages: index === 0 ? base.threads[0]!.messages : [],
        envMode: index % 2 === 0 ? ("local" as const) : ("worktree" as const),
        worktreePath: index % 2 === 0 ? null : `/repo/worktrees/sidebar-${index}`,
        branch: index % 2 === 0 ? "main" : "fix/authentication-session-recovery",
        forkSourceThreadId: index === 1 ? THREAD_ID : null,
        parentThreadId:
          index === 0 ? ThreadId.makeUnsafe("shortcut-layout-6") : index === 5 ? THREAD_ID : null,
        subagentNickname: index === 0 ? "Atlas" : index === 5 ? "Nova" : null,
      }));
      const snapshot = {
        ...base,
        projects: base.projects.map((project) => ({
          ...project,
          title: "Customer portal workspace",
        })),
        threads,
      };
      const previousPins = usePinnedThreadsStore.getState().pinnedThreadIds;
      usePinnedThreadsStore.setState({
        pinnedThreadIds: threads.slice(1, 4).map((thread) => thread.id),
      });
      onTestFinished(() => {
        usePinnedThreadsStore.setState({ pinnedThreadIds: previousPins });
      });
      localStorage.setItem("moss:sidebar-ui:v1", JSON.stringify({ activityViewEnabled }));
      if (customShortcut) {
        const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
        onTestFinished(() => platformSpy.mockRestore());
      }
      const mounted = await mountChatView({
        viewport: { ...DEFAULT_VIEWPORT, width: 1280, height: 800 },
        snapshot,
        configureFixture: (nextFixture) => {
          if (!customShortcut) return;
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: Array.from({ length: 9 }, (_, index) => ({
              command: threadJumpCommandForIndex(index)!,
              shortcut: {
                key: String(index + 1),
                modKey: false,
                metaKey: true,
                ctrlKey: true,
                shiftKey: true,
                altKey: true,
              },
            })),
          };
        },
      });
      try {
        await waitForServerConfigToApply();
        const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
        expect(sidebar).toBeTruthy();
        const wrapper = sidebar.closest<HTMLElement>('[data-slot="sidebar-wrapper"]')!;
        const resizeSidebar = async (width: number) => {
          wrapper.style.setProperty("--sidebar-width", `${width}px`);
          await vi.waitFor(() =>
            expect(sidebar.getBoundingClientRect().width).toBeCloseTo(width, 0),
          );
        };
        const mod = isMacNavigatorPlatform() ? "Meta" : "Control";
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        await userEvent.unhover(sidebar);
        for (const fontSize of [13, 18]) {
          const scale = getAppTypographyScale(fontSize);
          for (const [token, value] of Object.entries({
            ui: scale.uiPx,
            "ui-lg": scale.uiLgPx,
            "ui-sm": scale.uiSmPx,
            "ui-xs": scale.uiXsPx,
            "ui-meta": scale.uiMetaPx,
          })) {
            document.documentElement.style.setProperty(`--app-font-size-${token}`, `${value}px`);
          }
          for (const width of [208, 256, 320]) {
            await resizeSidebar(width);
            window.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: mod,
                metaKey: customShortcut || mod === "Meta",
                ctrlKey: customShortcut || mod === "Control",
                altKey: customShortcut,
                shiftKey: customShortcut,
                bubbles: true,
              }),
            );
            await waitForLayout();
            const hints = [...sidebar.querySelectorAll<HTMLElement>('[data-slot="kbd"]')].filter(
              (hint) => hint.closest("[data-thread-item]"),
            );
            expect(hints.length).toBe(activityViewEnabled ? 5 : 7);
            if (!activityViewEnabled) {
              expect(sidebar.textContent).toContain("Atlas");
              // The open subagent reveals its own child as well as its ancestors.
              expect(sidebar.textContent).toContain("Nova");
            }
            if (customShortcut) expect(hints[0]!.textContent).toContain("Ctrl+Alt+Shift+Meta");
            for (const hint of hints) {
              const row = hint.closest<HTMLElement>("[data-thread-item]")!;
              expect(row).toBeTruthy();
              const hintRect = hint.getBoundingClientRect();
              expect(hintRect.right).toBeLessThanOrEqual(row.getBoundingClientRect().right);
              // The chord is one capsule now; it must keep at least a key's width.
              expect(hintRect.width).toBeGreaterThanOrEqual(20);
              for (const chip of row.querySelectorAll<HTMLElement>(".sidebar-icon-chip")) {
                const rect = chip.getBoundingClientRect();
                if (rect.top < hintRect.bottom && rect.bottom > hintRect.top) {
                  expect(rect.right).toBeLessThanOrEqual(hintRect.left);
                }
              }
              const labels = [...row.querySelectorAll<HTMLElement>("span")].filter(
                (element) =>
                  element.classList.contains("truncate-fade") ||
                  (!element.parentElement?.closest(".truncate-fade") &&
                    (element.textContent === "Customer portal workspace" ||
                      titles.includes(element.textContent ?? ""))),
              );
              expect(labels.length).toBeGreaterThan(0);
              for (const label of labels) {
                const rect = label.getBoundingClientRect();
                if (rect.top < hintRect.bottom && rect.bottom > hintRect.top) {
                  expect(
                    rect.right,
                    `${label.textContent} overlaps ${hint.textContent}`,
                  ).toBeLessThanOrEqual(hintRect.left);
                }
              }
            }
            for (const hoverHint of hints.filter(
              (hint, index) =>
                index === 0 || hint.closest("[data-thread-item]")!.textContent?.includes("Atlas"),
            )) {
              const row = hoverHint.closest<HTMLElement>("[data-thread-item]")!;
              let interaction = "hover";
              await userEvent.hover(row);
              const actions = activityViewEnabled
                ? row.querySelector<HTMLElement>(
                    'span[class*="group-hover/activity-row:opacity-100"]',
                  )!
                : row.querySelector<HTMLElement>('[data-testid^="thread-hover-actions-"]')!;
              // The geometry contract is about settled hover/focus visibility, not
              // transition timing. Under parallel Chromium CI, animation frames can
              // lag past waitFor's deadline. Keep the real hover/focus selectors
              // active but make these two measured transitions instantaneous.
              hoverHint.style.setProperty("transition-duration", "0s", "important");
              actions.style.setProperty("transition-duration", "0s", "important");
              const hoverGroup = row.closest<HTMLElement>(
                activityViewEnabled
                  ? '[class~="group/activity-row"]'
                  : '[class~="group/thread-row"]',
              )!;
              await userEvent.unhover(row);
              await userEvent.hover(row);
              const assertHoverLayout = () => {
                const hintOpacity = Number(getComputedStyle(hoverHint).opacity);
                const actionsOpacity = Number(getComputedStyle(actions).opacity);
                const rect = row.getBoundingClientRect();
                const group = hoverHint.closest<HTMLElement>(
                  '[class~="group/thread-row"], [class~="group/activity-row"]',
                );
                const target = row.matches('[role="button"]')
                  ? row
                  : row.querySelector<HTMLElement>('button, [role="button"]');
                const debug =
                  hintOpacity === 0 && actionsOpacity === 1
                    ? undefined
                    : JSON.stringify({
                        interaction,
                        fontSize,
                        width,
                        hint: hoverHint.textContent,
                        rowHover: row.matches(":hover"),
                        rowFocusWithin: row.matches(":focus-within"),
                        groupHover: group?.matches(":hover"),
                        groupFocusWithin: group?.matches(":focus-within"),
                        connected: row.isConnected && hoverHint.isConnected,
                        target: target?.outerHTML.slice(0, 250),
                        activeElement: document.activeElement?.outerHTML.slice(0, 250),
                        activeFocusVisible: document.activeElement?.matches(":focus-visible"),
                        documentHasFocus: document.hasFocus(),
                        rowRect: rect.toJSON(),
                        rowCenterHit: document
                          .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                          ?.outerHTML.slice(0, 250),
                        hintOpacity,
                        actionsOpacity,
                        hintClasses: hoverHint.className,
                        actionsClasses: actions.className,
                      });
                expect(hintOpacity, debug).toBe(0);
                expect(actionsOpacity, debug).toBe(1);
                const actionsRect = actions.getBoundingClientRect();
                for (const label of [...row.querySelectorAll<HTMLElement>("span")].filter(
                  (element) =>
                    // Popups render in place now (in the top layer, inside their trigger's
                    // row); a tooltip's text is not row content.
                    !element.closest('[data-slot$="-positioner"]') &&
                    (element.classList.contains("truncate-fade") ||
                      (!element.parentElement?.closest(".truncate-fade") &&
                        (element.textContent === "Customer portal workspace" ||
                          titles.includes(element.textContent ?? "")))),
                )) {
                  const rect = label.getBoundingClientRect();
                  if (rect.top < actionsRect.bottom && rect.bottom > actionsRect.top) {
                    expect(
                      rect.right,
                      `${label.textContent} overlaps hover actions`,
                    ).toBeLessThanOrEqual(actionsRect.left);
                  }
                }
              };
              await vi.waitFor(assertHoverLayout, { timeout: 3_000 });
              await userEvent.unhover(row);
              const focusTarget = row.matches('[role="button"]')
                ? row
                : row.querySelector<HTMLElement>('button, [role="button"]')!;
              interaction = "focus";
              focusTarget.focus();
              await vi.waitFor(assertHoverLayout, { timeout: 3_000 });
              focusTarget.blur();
            }
            window.dispatchEvent(new KeyboardEvent("keyup", { key: mod, bubbles: true }));
            await waitForLayout();
            expect(sidebar.querySelector('[data-thread-item] [data-slot="kbd"]')).toBeNull();
          }
        }
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.each(["user", "assistant"] as const)(
    "opens the linked PR number from a %s message when the repository path also contains pull",
    async (role) => {
      useRightDockStore.setState({ dockStateByThreadId: {} });
      const url = "https://github.com/pull/123/pull/456";
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("linked-pr"),
        targetText: url,
      });
      const message =
        role === "user"
          ? createUserMessage({
              id: MessageId.makeUnsafe("linked-pr"),
              text: url,
              offsetSeconds: 0,
            })
          : createAssistantMessage({
              id: MessageId.makeUnsafe("linked-pr"),
              text: `[Inspect PR](${url})`,
              offsetSeconds: 0,
            });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: { ...snapshot, threads: [{ ...snapshot.threads[0]!, messages: [message] }] },
      });
      const previousNativeApi = window.nativeApi;
      const api = readNativeApi()!;
      const repository = { nameWithOwner: "pull/123", url: "https://github.com/pull/123" };
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: {
          ...api,
          git: {
            ...api.git,
            githubRepository: async () => ({ repository, repositories: [repository] }),
          },
        },
      });
      try {
        const link = page.getByRole(role === "user" ? "button" : "link", {
          name: role === "user" ? "pull/123#456" : "Inspect PR",
          exact: true,
        });
        await link.click({ button: "right" });
        await expect
          .element(page.getByRole("button", { name: "Open pull request", exact: true }))
          .toBeVisible();
        await expect
          .element(page.getByRole("button", { name: "Open in browser", exact: true }))
          .toBeVisible();
        await expect
          .element(page.getByRole("button", { name: "Open in external browser", exact: true }))
          .toBeVisible();
        await expect
          .element(page.getByRole("button", { name: "Copy link", exact: true }))
          .toBeVisible();
        await page.getByRole("button", { name: "Open pull request", exact: true }).click();
        await vi.waitFor(() => {
          expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]?.panes).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: "pullRequest",
                pullRequestProjectId: PROJECT_ID,
                pullRequestRepository: "pull/123",
                pullRequestNumber: 456,
              }),
            ]),
          );
        });
        useRightDockStore.setState({ dockStateByThreadId: {} });
        await link.click();
        await vi.waitFor(() => {
          expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]?.panes).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ kind: "pullRequest", pullRequestNumber: 456 }),
            ]),
          );
        });
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
    },
  );

  it.each([
    { kind: "forked", repository: "acme/widgets", opens: "the host chat dock" },
    { kind: "forked", repository: "other/repo", opens: "the external browser" },
    { kind: "standalone", repository: "acme/widgets", opens: "Code review" },
  ] as const)(
    "opens a $repository pull request link from a $kind side chat in $opens",
    async ({ kind, repository: linkedRepository }) => {
      useRightDockStore.setState({ dockStateByThreadId: {} });
      const url = `https://github.com/${linkedRepository}/pull/41`;
      const sidechatId = ThreadId.makeUnsafe("sidechat-pr-link");
      const base = addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("sidechat-pr-main"),
          targetText: "Main conversation",
        }),
        sidechatId,
      );
      const snapshot = {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === sidechatId
            ? {
                ...thread,
                ...(kind === "forked"
                  ? { sidechatSourceThreadId: THREAD_ID }
                  : {
                      sidechatContext: {
                        kind: "github-item" as const,
                        itemKind: "pullRequest" as const,
                        repository: "acme/widgets",
                        number: 1368,
                        url: "https://github.com/acme/widgets/pull/1368",
                      },
                    }),
                messages: [
                  createAssistantMessage({
                    id: MessageId.makeUnsafe("sidechat-pr-link"),
                    text: `[Inspect PR](${url})`,
                    offsetSeconds: 0,
                  }),
                ],
              }
            : thread,
        ),
      };
      const dockHostId = kind === "forked" ? THREAD_ID : GITHUB_INBOX_DOCK_HOST_ID;
      useRightDockStore.getState().openPane(dockHostId, { kind: "sidechat", threadId: sidechatId });
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      const previousNativeApi = window.nativeApi;
      const api = readNativeApi()!;
      const repository = { nameWithOwner: "acme/widgets", url: "https://github.com/acme/widgets" };
      const openedExternally: string[] = [];
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: {
          ...api,
          githubInbox: {
            ...api.githubInbox,
            connection: async () => ({ state: "connected", login: "fixture-user" }),
          },
          git: {
            ...api.git,
            githubRepository: async () => ({ repository, repositories: [repository] }),
          },
          shell: {
            ...api.shell,
            openExternal: async (href: string) => {
              openedExternally.push(href);
            },
          },
        },
      });
      const pullRequestNumbers = (hostId: ThreadId) =>
        (useRightDockStore.getState().dockStateByThreadId[hostId]?.panes ?? [])
          .filter((pane) => pane.kind === "pullRequest")
          .map((pane) => pane.pullRequestNumber);
      try {
        if (kind === "standalone") {
          await mounted.router.navigate({
            to: "/pull-requests",
            search: {
              kind: "pullRequest",
              selectedProjectId: PROJECT_ID,
              selectedRepo: "acme/widgets",
              number: 1368,
            },
          });
        }
        await page.getByRole("link", { name: "Inspect PR", exact: true }).click();
        await vi.waitFor(() => {
          if (kind === "standalone") {
            expect(mounted.router.state.location.pathname).toBe("/pull-requests");
            expect(mounted.router.state.location.search).toMatchObject({
              kind: "pullRequest",
              selectedProjectId: PROJECT_ID,
              selectedRepo: "acme/widgets",
              number: 41,
            });
          } else if (linkedRepository === "acme/widgets") {
            expect(pullRequestNumbers(THREAD_ID)).toEqual([41]);
          } else {
            expect(openedExternally).toEqual([url]);
          }
        });
        // Nothing lands in the side chat's own dock, which no surface renders.
        expect(pullRequestNumbers(sidechatId)).toEqual([]);
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
    },
  );

  it("WALK-6 H-1: nothing opens by itself, the feature tour is gone and 欢迎导览 still opens the setup", async () => {
    const snapshot = createSnapshotWithLongAssistantResponse();
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
      await page.getByTestId("composer-editor").click();
      // One tour entry: 关于 offers no feature tour.
      await mounted.router.navigate({ to: "/settings", search: { section: "advanced" } });
      await expect.element(page.getByText("Release notes", { exact: true })).toBeVisible();
      expect(page.getByRole("button", { name: "Replay feature tour" }).elements()).toHaveLength(0);
      // The first-time setup is still there for a person who wants to run it again.
      await mounted.router.navigate({ to: "/settings", search: { section: "general" } });
      await page.getByRole("button", { name: "Open welcome tour" }).click();
      const welcome = page.getByRole("dialog", { name: /^Welcome to / });
      await expect.element(welcome).toBeVisible();
      // 设置 stays open under the tour; each dialog draws its own backdrop and viewport.
      const tour = welcome.element();
      const overlayOwners = () =>
        [
          ...document.querySelectorAll(
            '[data-slot="dialog-backdrop"], [data-slot="dialog-viewport"]',
          ),
        ]
          .map((layer) => {
            const portal = layer.parentElement;
            if (portal?.querySelector('[data-testid="settings-dialog"]')) return "settings";
            return portal?.contains(tour) ? "tour" : "other";
          })
          .sort();
      expect(overlayOwners()).toEqual(["settings", "settings", "tour", "tour"]);
      // Skipping it takes the tour's backdrop and viewport with it: only 设置 is left, and its
      // page takes clicks again.
      await page.getByRole("button", { name: "Skip setup" }).click();
      await expect.element(welcome).not.toBeInTheDocument();
      await expect.poll(overlayOwners).toEqual(["settings", "settings"]);
      await page.getByRole("button", { name: "Open welcome tour" }).click({ trial: true });
    } finally {
      await mounted.cleanup();
    }
  });

  it("WALK-10 #890: 设置 → 通用 keeps only the lines a person relies on", async () => {
    const snapshot = createSnapshotWithLongAssistantResponse();
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      // The app loads the pages once its shell is idle. A cold dev-server page takes about two
      // seconds for that load, and only the tests that ran earlier in the file used to pay it;
      // settle the same load here so the wait below is for what a person sees.
      await preloadSettingsPages();
      await mounted.router.navigate({ to: "/settings", search: { section: "general" } });
      await vi.waitFor(() =>
        expect(document.querySelector("[data-settings-section=general] header h1")).not.toBeNull(),
      );
      const general = document.querySelector<HTMLElement>("[data-settings-section=general]")!;
      // Rule 1: one title, no subtitle under it.
      expect(general.querySelector("header")!.querySelectorAll("p")).toHaveLength(0);
      // Rule 4: the label says what the control does.
      expect(general.textContent).toContain("Where new chats work");
      // The first-time setup stays reachable.
      expect(general.textContent).toContain("Open welcome tour");
      // Rule 2: a line stays only for what is deleted, sent, charged or changed at the next start.
      const lines = [...general.querySelectorAll('[data-slot="settings-row"] p')]
        .map((line) => line.textContent?.trim() ?? "")
        .filter((line) => line.length > 0);
      expect(lines).toEqual([
        "Suggests your next message in gray; Tab puts it in.",
        "Remove an unused worktree after archiving. The branch stays.",
        // What is sent and what never is.
        "Send a report when Moss hits an error. Chats, code and keys are never included.",
      ]);
    } finally {
      await mounted.cleanup();
    }
  });

  // #1374: real route, dock and Lexical composers; only the server boundary is
  // simulated. The main agent must keep running while the panel toggles.
  it("previews split widths without persisting and restores the released ratio after remount", async () => {
    const snapshot = addThreadToSnapshot(
      createSnapshotWithLongAssistantResponse(),
      OTHER_THREAD_ID,
    );
    let mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Resize draft");
      const splitViewId = useSplitViewStore.getState().createFromDrop({
        sourceThreadId: THREAD_ID,
        ownerProjectId: PROJECT_ID,
        droppedThreadId: OTHER_THREAD_ID,
        direction: "horizontal",
        side: "second",
      });
      const openSplit = () =>
        mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: THREAD_ID },
          search: () => ({ splitViewId }),
        });
      await openSplit();
      await waitForSplitChatReady([THREAD_ID, OTHER_THREAD_ID]);
      const editors = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')];
      const divider = document.querySelector<HTMLElement>('[data-split-divider="true"]')!;
      const frame = divider.parentElement!.getBoundingClientRect();
      const sourceScope = splitViewPaneScopeId(
        splitViewId,
        resolveSplitViewPaneIdForThread(
          useSplitViewStore.getState().splitViewsById[splitViewId]!,
          THREAD_ID,
        )!,
      );
      const sourceChat = document.querySelector(`[data-chat-pane-scope="${sourceScope}"]`)!;
      const sourceBox = sourceChat.closest('[data-slot="sidebar-inset"]')!.parentElement!;
      const persistedRatio = () =>
        JSON.parse(localStorage.getItem("moss:split-view-state:v1")!).state.splitViewsById[
          splitViewId
        ].root.ratio;
      const dispatch = (target: EventTarget, type: string, ratio: number, buttons: number) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            pointerType: "mouse",
            button: 0,
            buttons,
            clientX: frame.left + frame.width * ratio,
            clientY: frame.top + frame.height / 2,
          }),
        );
      const widthBefore = sourceBox.getBoundingClientRect().width;
      dispatch(divider, "pointerdown", 0.5, 1);
      const overlay = document.querySelector("[data-panel-resize-overlay]") ?? window;
      dispatch(overlay, "pointermove", 0.65, 1);
      await vi.waitFor(() =>
        expect(sourceBox.getBoundingClientRect().width).toBeCloseTo(frame.width * 0.65, 0),
      );
      expect(sourceBox.getBoundingClientRect().width).toBeGreaterThan(widthBefore);
      expect(persistedRatio()).toBe(0.5);
      expect([...document.querySelectorAll('[contenteditable="true"]')]).toEqual(editors);
      expect(sourceChat.textContent).toContain("Resize draft");
      dispatch(overlay, "pointerup", 0.65, 0);
      await vi.waitFor(() => expect(persistedRatio()).toBeCloseTo(0.65));
      expect([...document.querySelectorAll('[contenteditable="true"]')]).toEqual(editors);
      const saved = localStorage.getItem("moss:split-view-state:v1")!;
      await mounted.cleanup();
      useSplitViewStore.setState({ splitViewsById: {}, splitViewIdBySourceThreadId: {} });
      localStorage.setItem("moss:split-view-state:v1", saved);
      await useSplitViewStore.persist.rehydrate();
      mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      await openSplit();
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(2),
      );
      const restoredDivider = document.querySelector<HTMLElement>('[data-split-divider="true"]')!;
      const restoredFrame = restoredDivider.parentElement!.getBoundingClientRect();
      expect(restoredDivider.getBoundingClientRect().left - restoredFrame.left).toBeCloseTo(
        restoredFrame.width * 0.65,
        0,
      );
      expect(persistedRatio()).toBeCloseTo(0.65);
    } finally {
      window.dispatchEvent(new Event("blur"));
      await mounted.cleanup();
    }
  });

  it.each(["surviving", "closing"] as const)(
    "closes a source pane into a survivor that anchors its own split (%s pane focused)",
    async (focused) => {
      const snapshot = withHomeChatProject(
        addThreadToSnapshot(createSnapshotWithLongAssistantResponse(), OTHER_THREAD_ID),
      );
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot,
        configureFixture: (nextFixture) => {
          nextFixture.welcome = {
            ...nextFixture.welcome,
            homeDir: "/Users/tester",
            chatWorkspaceRoot: "/Users/tester/Documents/Moss",
          };
        },
      });
      try {
        // The survivor already anchors its own split, so it cannot take over this one.
        const survivorSplitId = useSplitViewStore.getState().createFromThread({
          sourceThreadId: THREAD_ID,
          ownerProjectId: PROJECT_ID,
        });
        const splitViewId = useSplitViewStore.getState().createFromDrop({
          sourceThreadId: OTHER_THREAD_ID,
          ownerProjectId: PROJECT_ID,
          droppedThreadId: THREAD_ID,
          direction: "horizontal",
          side: "second",
        });
        await mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: THREAD_ID },
          search: () => ({ splitViewId }),
        });
        await waitForSplitChatReady([THREAD_ID, OTHER_THREAD_ID]);
        const split = useSplitViewStore.getState().splitViewsById[splitViewId]!;
        const editorForThread = (threadId: ThreadId) => {
          const scope = splitViewPaneScopeId(
            splitViewId,
            resolveSplitViewPaneIdForThread(split, threadId)!,
          );
          return document.querySelector<HTMLElement>(
            `[data-chat-pane-scope="${scope}"] [contenteditable="true"]`,
          )!;
        };
        const survivingEditor = editorForThread(THREAD_ID);
        const closingEditor = editorForThread(OTHER_THREAD_ID);
        // The dropped pane (the survivor) starts focused, so only the closing variant needs to
        // move focus. Pane focus follows mousedown, so that variant clicks the closing editor.
        if (focused === "closing") {
          await userEvent.click(closingEditor);
        }
        await vi.waitFor(() => {
          const focusedThreadId = focused === "surviving" ? THREAD_ID : OTHER_THREAD_ID;
          const current = useSplitViewStore.getState().splitViewsById[splitViewId]!;
          expect(current.focusedPaneId).toBe(
            resolveSplitViewPaneIdForThread(current, focusedThreadId),
          );
          expect(mounted.router.state.location.pathname).toBe(`/${focusedThreadId}`);
        });
        await userEvent.click(
          closingEditor
            .closest('[data-slot="sidebar-inset"]')!
            .querySelector<HTMLButtonElement>('button[aria-label="Close chat"]')!,
        );
        await vi.waitFor(() => {
          expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
          expect(mounted.router.state.location.search.splitViewId).toBeUndefined();
          expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(1);
          expect(useSplitViewStore.getState().splitViewsById[splitViewId]).toBeUndefined();
        });
        await waitForLayout();
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
        expect(document.querySelector('[contenteditable="true"]')).toBe(survivingEditor);
        expect(useSplitViewStore.getState().splitViewIdBySourceThreadId[THREAD_ID]).toBe(
          survivorSplitId,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it.each([
    { width: 1_920, layout: "beside-chat", toolbar: "compact" },
    // The pane fits the chat but not the panel's usual minimum: the panel narrows.
    { width: 1_600, layout: "beside-chat", toolbar: "compact" },
    { width: 1_100, layout: "covers-chat", toolbar: "compact" },
  ] as const)(
    "fits a split pane's diff panel and loads its content ($width px window)",
    async (scenario) => {
      const snapshot = addThreadToSnapshot(
        createSnapshotWithLongAssistantResponse(),
        OTHER_THREAD_ID,
      );
      const mounted = await mountChatView({
        viewport: { name: "owner-window", width: scenario.width, height: 900 },
        snapshot,
        configureFixture: (nextFixture) => {
          nextFixture.workingTreePatchByCwd["/repo/project"] = [
            "diff --git a/src/plugin.json b/src/plugin.json",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/src/plugin.json",
            "@@ -0,0 +1,3 @@",
            "+{",
            '+  "name": "moss-image-studio"',
            "+}",
            "",
          ].join("\n");
        },
      });
      try {
        const splitViewId = useSplitViewStore.getState().createFromDrop({
          sourceThreadId: THREAD_ID,
          ownerProjectId: PROJECT_ID,
          droppedThreadId: OTHER_THREAD_ID,
          direction: "horizontal",
          side: "second",
        });
        await mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: THREAD_ID },
          search: () => ({ splitViewId }),
        });
        await waitForSplitChatReady([THREAD_ID, OTHER_THREAD_ID]);
        const split = useSplitViewStore.getState().splitViewsById[splitViewId]!;
        if (split.root.kind !== "split" || split.root.second.kind !== "leaf") {
          throw new Error("Expected two panes");
        }
        const paneRoot = document.querySelector<HTMLElement>(
          `[data-split-pane-id="${split.root.second.id}"]`,
        )!;
        const chatWidthBefore = paneRoot
          .querySelector<HTMLElement>("[data-chat-pane-scope]")!
          .getBoundingClientRect().width;
        await userEvent.click(
          paneRoot.querySelector<HTMLButtonElement>(
            'header button[aria-label="Toggle diff panel"]',
          )!,
        );
        const toolbar = await vi.waitFor(() => {
          const element = paneRoot.querySelector<HTMLElement>("[data-diff-toolbar]");
          expect(element?.dataset.diffToolbar).toBe(scenario.toolbar);
          return element!;
        }, 10_000);
        await waitForLayout();
        // Every control sits inside the header and none overlaps another.
        const toolbarRect = toolbar.getBoundingClientRect();
        const controls = [...toolbar.querySelectorAll<HTMLElement>("button")]
          .map((button) => button.getBoundingClientRect())
          .filter((rect) => rect.width > 0);
        expect(toolbarRect.right).toBeLessThanOrEqual(window.innerWidth + 0.5);
        expect(controls.length).toBeGreaterThanOrEqual(3);
        for (const rect of controls) {
          expect(rect.left).toBeGreaterThanOrEqual(toolbarRect.left - 0.5);
          expect(rect.right).toBeLessThanOrEqual(toolbarRect.right + 0.5);
        }
        for (const [index, a] of controls.entries()) {
          for (const b of controls.slice(index + 1)) {
            const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            expect(overlap).toBeLessThanOrEqual(0.5);
          }
        }
        // The panel settles on its content, not on a loading skeleton.
        await vi.waitFor(
          () =>
            expect(
              [...paneRoot.querySelectorAll('[role="status"][aria-live="polite"]')].map((node) =>
                node.getAttribute("aria-label"),
              ),
            ).toEqual([]),
          { timeout: 5_000 },
        );
        await vi.waitFor(() => expect(paneRoot.textContent).toContain("plugin.json"));
        // The chat never drops below its readable width: beside the panel when the pane fits
        // both, otherwise the panel covers it, and closing the panel brings it back whole.
        const panel = paneRoot.querySelector<HTMLElement>("[data-split-pane-panel]")!;
        const paneRect = paneRoot.getBoundingClientRect();
        expect(panel.dataset.splitPanePanel).toBe(scenario.layout);
        if (scenario.layout === "covers-chat") {
          expect(Math.abs(panel.getBoundingClientRect().width - paneRect.width)).toBeLessThan(1);
          // It covers the chat below the pane's header; the header's own buttons stay usable.
          const toggle = paneRoot.querySelector<HTMLButtonElement>(
            'header button[aria-label="Toggle diff panel"]',
          )!;
          const toggleRect = toggle.getBoundingClientRect();
          expect(
            toggle.contains(
              document.elementFromPoint(
                toggleRect.left + toggleRect.width / 2,
                toggleRect.top + toggleRect.height / 2,
              ),
            ),
          ).toBe(true);
        } else {
          // The chat keeps the 20rem a split pane's chat needs beside the panel.
          const besideWidth = paneRect.width - panel.getBoundingClientRect().width;
          expect(besideWidth).toBeGreaterThanOrEqual(20 * 16 - 1);
        }
        await waitForLayout();
        // The diff itself draws (its file, not just an empty shell).
        await vi.waitFor(
          () => {
            const file = panel.querySelector<HTMLElement>(".diff-render-file");
            expect(file?.getBoundingClientRect().height ?? 0).toBeGreaterThan(40);
          },
          { timeout: 10_000 },
        );
        await page.screenshot({
          path: `../../../../output/playwright/split-diff-panel-${scenario.width}.png`,
        });
        await userEvent.click(
          toolbar.querySelector<HTMLButtonElement>('button[aria-label="Close file view"]')!,
        );
        await vi.waitFor(() =>
          expect(paneRoot.querySelector("[data-split-pane-panel]")).toBeNull(),
        );
        const chatPane = paneRoot.querySelector<HTMLElement>("[data-chat-pane-scope]")!;
        await vi.waitFor(() =>
          expect(Math.abs(chatPane.getBoundingClientRect().width - chatWidthBefore)).toBeLessThan(
            1,
          ),
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("keeps the surviving non-route chat mounted when a split collapses", async () => {
    const snapshot = addThreadToSnapshot(
      createSnapshotWithLongAssistantResponse(),
      OTHER_THREAD_ID,
    );
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      mounted.router.options.context.queryClient.setQueryData(
        gitQueryKeys.workingTreeDiffStats("/repo/project"),
        { additions: 604, deletions: 27, fileCount: 18 },
      );
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "surviving draft");
      const splitViewId = useSplitViewStore.getState().createFromDrop({
        sourceThreadId: THREAD_ID,
        ownerProjectId: PROJECT_ID,
        droppedThreadId: OTHER_THREAD_ID,
        direction: "horizontal",
        side: "second",
      });
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
        search: () => ({ splitViewId }),
      });
      await waitForSplitChatReady([THREAD_ID, OTHER_THREAD_ID]);
      const split = useSplitViewStore.getState().splitViewsById[splitViewId]!;
      if (
        split.root.kind !== "split" ||
        split.root.first.kind !== "leaf" ||
        split.root.second.kind !== "leaf"
      )
        throw new Error("Expected two panes");
      const scope = splitViewPaneScopeId(splitViewId, split.root.second.id);
      const survivingEditor = document.querySelector<HTMLElement>(
        `[data-chat-pane-scope="${scope}"] [contenteditable="true"]`,
      )!;
      const survivingChat = survivingEditor.closest("[data-chat-pane-scope]")!;
      await vi.waitFor(() => expect(survivingEditor.textContent).toContain("surviving draft"));
      const closingScope = splitViewPaneScopeId(splitViewId, split.root.first.id);
      const closingChat = document.querySelector(`[data-chat-pane-scope="${closingScope}"]`)!;
      const closingPane = closingChat.closest('[data-slot="sidebar-inset"]')!;
      const survivingPane = survivingChat.closest('[data-slot="sidebar-inset"]')!;
      await userEvent.click(survivingEditor);
      await vi.waitFor(() =>
        expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`),
      );
      for (const chat of [closingPane, survivingPane]) {
        const header = chat.querySelector("header")!;
        expect(header.querySelectorAll('button[aria-label="Close chat"]')).toHaveLength(1);
        expect(header.querySelector('button[aria-label="Expand this chat"]')).toBeNull();
        expect(header.querySelector('button[aria-label="Change thread"]')).toBeNull();
        expect(header.querySelector('[data-slot="diff-stat"]')).toBeNull();
        const close = header.querySelector<HTMLButtonElement>('button[aria-label="Close chat"]')!;
        const diff = header.querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle diff panel"]',
        )!;
        expect(getComputedStyle(close).color).toBe(getComputedStyle(diff).color);
      }
      await page.screenshot({ path: "../../../../output/playwright/split-chat-headers.png" });
      await userEvent.click(
        closingPane.querySelector<HTMLButtonElement>('button[aria-label="Close chat"]')!,
      );
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
        expect(mounted.router.state.location.search.splitViewId).toBeUndefined();
        expect(document.querySelectorAll('[contenteditable="true"]').length).toBe(1);
      });
      expect(document.querySelector('[contenteditable="true"]')).toBe(survivingEditor);
      expect(document.querySelector("[data-chat-pane-scope]")).toBe(survivingChat);
      expect(survivingEditor.textContent).toContain("surviving draft");
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["source", "non-source", "delayed non-source"] as const)(
    "closes only the inactive ordinary %s pane and preserves the focused chat",
    async (scenario) => {
      const closing = scenario === "source" ? "source" : "non-source";
      const detailDelayMs = scenario === "delayed non-source" ? 2_000 : 0;
      const thirdId = ThreadId.makeUnsafe("third-ordinary-grid-chat");
      let releaseDetail: (() => void) | undefined;
      let detailDelayTimeout: ReturnType<typeof setTimeout> | undefined;
      if (detailDelayMs > 0) {
        threadDetailSnapshotBarrierById.set(
          thirdId,
          new Promise<void>((resolve) => {
            releaseDetail = resolve;
          }),
        );
        onTestFinished(() => {
          if (detailDelayTimeout !== undefined) clearTimeout(detailDelayTimeout);
          releaseDetail?.();
          threadDetailSnapshotBarrierById.delete(thirdId);
        });
      }
      const snapshot = addThreadToSnapshot(
        addThreadToSnapshot(createSnapshotWithLongAssistantResponse(), OTHER_THREAD_ID),
        thirdId,
      );
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      try {
        const splitViewId = useSplitViewStore.getState().createFromDrop({
          sourceThreadId: THREAD_ID,
          ownerProjectId: PROJECT_ID,
          droppedThreadId: OTHER_THREAD_ID,
          direction: "horizontal",
          side: "second",
        });
        const split = useSplitViewStore.getState().splitViewsById[splitViewId]!;
        useSplitViewStore.getState().dropThreadOnPane({
          splitViewId,
          targetPaneId: resolveSplitViewPaneIdForThread(split, OTHER_THREAD_ID)!,
          threadId: thirdId,
          direction: "vertical",
          side: "second",
        });
        await mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: THREAD_ID },
          search: () => ({ splitViewId }),
        });
        if (releaseDetail) {
          detailDelayTimeout = setTimeout(releaseDetail, detailDelayMs);
        }
        await waitForSplitChatReady([THREAD_ID, OTHER_THREAD_ID, thirdId]);
        const readySplit = useSplitViewStore.getState().splitViewsById[splitViewId]!;
        const editorForThread = (threadId: ThreadId) => {
          const scope = splitViewPaneScopeId(
            splitViewId,
            resolveSplitViewPaneIdForThread(readySplit, threadId)!,
          );
          return document.querySelector<HTMLElement>(
            `[data-chat-pane-scope="${scope}"] [contenteditable="true"]`,
          )!;
        };
        // Wait out the thread-detail wave: the pane first renders the ordinary
        // branch (hydration "loading"), then flips to the centered landing once the
        // empty detail syncs. The flip legitimately remounts the composer; only the
        // split close below must keep it alive.
        await vi.waitFor(() => {
          const editor = editorForThread(thirdId);
          expect(
            editor
              .closest("[data-chat-composer-slot]")
              ?.getAttribute("data-empty-landing-composer-block"),
          ).toBe("true");
        });
        const retainedEditor = editorForThread(thirdId);
        await userEvent.click(retainedEditor);
        await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe(`/${thirdId}`));
        const closingThreadId = closing === "source" ? THREAD_ID : OTHER_THREAD_ID;
        const closingPane = editorForThread(closingThreadId).closest(
          '[data-slot="sidebar-inset"]',
        )!;
        await userEvent.click(
          closingPane.querySelector<HTMLButtonElement>('button[aria-label="Close chat"]')!,
        );
        await vi.waitFor(() => {
          expect(mounted.router.state.location.pathname).toBe(`/${thirdId}`);
          expect(mounted.router.state.location.search.splitViewId).toBe(splitViewId);
          expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(2);
          const remaining = useSplitViewStore.getState().splitViewsById[splitViewId]!;
          expect(resolveSplitViewPaneIdForThread(remaining, closingThreadId)).toBeNull();
          expect(remaining.focusedPaneId).toBe(resolveSplitViewPaneIdForThread(remaining, thirdId));
        });
        expect(retainedEditor.isConnected).toBe(true);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("opens one sidechat, preserves its draft on toggle, and restores composer focus", async () => {
    useRightDockStore.setState({ dockStateByThreadId: {} });
    const mainSnapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("sidechat-shortcut-main"),
      targetText: "Main conversation continues",
      sessionStatus: "running",
    });
    const expiredId = ThreadId.makeUnsafe("expired-sidechat-shortcut");
    const withExpiredSidechat = addThreadToSnapshot(mainSnapshot, expiredId);
    const snapshot = {
      ...withExpiredSidechat,
      threads: withExpiredSidechat.threads.map((thread) =>
        thread.id === expiredId
          ? { ...thread, sidechatSourceThreadId: THREAD_ID, sidechatExpiredAt: NOW_ISO }
          : thread,
      ),
    };
    useRightDockStore.getState().openPane(THREAD_ID, { kind: "sidechat", threadId: expiredId });
    useRightDockStore.getState().setDockOpen(THREAD_ID, false);
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const previousNativeApi = window.nativeApi;
    const api = readNativeApi()!;
    const commands: Record<string, unknown>[] = [];
    let releaseFork!: () => void;
    const forkBarrier = new Promise<void>((resolve) => {
      releaseFork = resolve;
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: async (command: Record<string, unknown>) => {
            commands.push(command);
            if (command.type === "thread.fork.create") {
              await forkBarrier;
              const next = addThreadToSnapshot(fixture.snapshot, command.threadId as ThreadId);
              fixture.snapshot = {
                ...next,
                threads: next.threads.map((thread) =>
                  thread.id === command.threadId
                    ? { ...thread, sidechatSourceThreadId: THREAD_ID }
                    : thread,
                ),
              };
            }
            return { sequence: fixture.snapshot.snapshotSequence };
          },
          getShellSnapshot: async () => createShellSnapshotFromReadModel(fixture.snapshot),
        },
      },
    });
    try {
      let mainEditor = await waitForComposerEditor();
      const expectMainFocus = async () => {
        await vi.waitFor(() => {
          const current = document.querySelector<HTMLElement>(
            '[data-chat-pane-scope="single"] [contenteditable="true"]',
          );
          expect(current).not.toBeNull();
          expect(document.activeElement).toBe(current);
          mainEditor = current!;
        });
      };
      mainEditor.focus();
      await dispatchConfiguredShortcutWhenReady(mainEditor, { key: "s", altKey: true });
      dispatchConfiguredShortcut(mainEditor, { key: "s", altKey: true });
      await vi.waitFor(() =>
        expect(commands.filter((c) => c.type === "thread.fork.create")).toHaveLength(1),
      );
      expect(commands[0]).toMatchObject({
        sourceThreadId: THREAD_ID,
        sidechatSourceThreadId: THREAD_ID,
        projectId: PROJECT_ID,
        envMode: "local",
        branch: "main",
        worktreePath: null,
        runtimeMode: "full-access",
        modelSelection: { provider: "codex", model: "gpt-5" },
      });
      releaseFork();
      let sideEditor = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-chat-pane-scope^="dock-sidechat:"] [contenteditable="true"]',
          ),
        "Sidechat composer missing",
      );
      await vi.waitFor(() => expect(document.activeElement).toBe(sideEditor));
      const sidechatPane = sideEditor.closest("[data-chat-pane-scope]")!;
      expect(sidechatPane.querySelector('[data-testid="empty-landing-heading"]')).toBeNull();
      expect(sidechatPane.querySelector("[data-empty-landing-controls]")).toBeNull();
      expect(sidechatPane.querySelector('[role="combobox"]')).toBeNull();
      expect(sidechatPane.textContent).not.toContain("Import your Claude Code");
      expect(sidechatPane.textContent).not.toContain("Let's build");
      expect(sidechatPane.textContent).not.toContain("Local");
      await userEvent.type(sideEditor, "Keep this tangent");
      const panes = useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.panes;
      const livePane = panes.find((pane) => pane.threadId === commands[0]!.threadId)!;
      expect(livePane.threadId).not.toBe(expiredId);
      const closeShortcut = dispatchConfiguredShortcut(sideEditor, { key: "s", altKey: true });
      expect(closeShortcut.defaultPrevented).toBe(true);
      expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.open).toBe(false);
      await expectMainFocus();
      expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.open).toBe(false);
      dispatchConfiguredShortcut(mainEditor, { key: "s", altKey: true });
      await vi.waitFor(() => {
        const current = document.querySelector<HTMLElement>(
          '[data-chat-pane-scope^="dock-sidechat:"] [contenteditable="true"]',
        );
        expect(current).not.toBeNull();
        expect(document.activeElement).toBe(current);
        sideEditor = current!;
      });
      expect(sideEditor.textContent).toContain("Keep this tangent");
      expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.panes).toEqual(panes);
      expect(commands.filter((c) => c.type === "thread.fork.create")).toHaveLength(1);

      // A menu closing on Escape gets the first key, even if it removes its DOM.
      const dismissedMenu = showContextMenuFallback([{ id: "keep", label: "Keep side chat" }]);
      sideEditor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await expect(dismissedMenu).resolves.toBeNull();
      expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.open).toBe(true);
      sideEditor = document.querySelector<HTMLElement>(
        '[data-chat-pane-scope^="dock-sidechat:"] [contenteditable="true"]',
      )!;
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      sideEditor.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      await expectMainFocus();
      expect(useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!.open).toBe(false);
      // Removing the tab must not force another fork of the source conversation.
      useRightDockStore.getState().closePane(THREAD_ID, livePane.id);
      dispatchConfiguredShortcut(mainEditor, { key: "s", altKey: true });
      await vi.waitFor(() => {
        const reopened = useRightDockStore.getState().dockStateByThreadId[THREAD_ID]!;
        expect(reopened.open).toBe(true);
        expect(reopened.panes.find((pane) => pane.id === reopened.activePaneId)?.threadId).toBe(
          livePane.threadId,
        );
      });
      expect(commands.filter((c) => c.type === "thread.fork.create")).toHaveLength(1);
      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
      expect(useStore.getState().threadSessionById?.[THREAD_ID]?.status).toBe("running");
      expect(
        commands.some((c) => c.type === "thread.turn.interrupt" || c.type === "thread.delete"),
      ).toBe(false);
    } finally {
      releaseFork();
      Object.defineProperty(window, "nativeApi", { configurable: true, value: previousNativeApi });
      await mounted.cleanup();
      useRightDockStore.setState({ dockStateByThreadId: {} });
    }
  });

  it("preserves the automatic project name when saving only its appearance", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("project-appearance-name"),
      targetText: "Project appearance",
    });
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await waitForLayout();
      const projectRow = document.querySelector<HTMLButtonElement>(
        `[data-project-hover-anchor="${PROJECT_ID}"] button`,
      );
      expect(projectRow).not.toBeNull();
      projectRow!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 160 }),
      );
      await page.getByRole("menuitem", { name: "Edit project", exact: true }).click();
      await page.getByRole("button", { name: "Choose icon" }).click();
      await page.getByRole("radio", { name: "Blue", exact: true }).click();
      await page.getByRole("radio", { name: "Launch", exact: true }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();

      const project = () => useStore.getState().projects.find((item) => item.id === PROJECT_ID);
      await expect
        .poll(() => project()?.appearance)
        .toEqual({
          kind: "icon",
          icon: "rocket",
          color: "blue",
        });
      expect(project()?.localName).toBeNull();
      const persisted = JSON.parse(localStorage.getItem("moss:renderer-state:v8") ?? "{}");
      expect(persisted.projectNamesByCwd["/repo/project"]).toBeUndefined();

      useStore.getState().syncServerReadModel({
        ...snapshot,
        snapshotSequence: snapshot.snapshotSequence + 1,
        projects: snapshot.projects.map((item) =>
          item.id === PROJECT_ID ? { ...item, title: "Renamed upstream" } : item,
        ),
      });
      expect(project()?.name).toBe("Renamed upstream");
      expect(project()?.appearance).toEqual({ kind: "icon", icon: "rocket", color: "blue" });
    } finally {
      await mounted.cleanup();
    }
  });

  // Keep phone-sheet coverage separate from the persistent desktop rail.
  async function openPhonePrimaryRail(mounted: {
    setViewport: (viewport: ViewportSpec) => Promise<void>;
  }) {
    await mounted.setViewport({ name: "phone", width: 540, height: 900 });
    if (document.querySelector('nav[aria-label="Primary"]') == null) {
      await page.getByRole("button", { name: "Toggle thread sidebar", exact: true }).click();
    }
    const rail = page.getByRole("navigation", { name: "Primary" });
    await expect.element(rail).toBeVisible();
    return rail;
  }

  it("keeps the default desktop rail visible when the thread panel is collapsed", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("desktop-rail-defaults"),
        targetText: "Desktop rail defaults",
      }),
    });
    try {
      await waitForLayout();
      const rail = page.getByRole("navigation", { name: "Primary", exact: true });
      await expect.element(rail).toBeVisible();
      expect(document.querySelectorAll('nav[aria-label="Primary"]')).toHaveLength(1);
      expect(document.querySelector('[data-sidebar-navigation="desktop"]')).toBeNull();
      const bounds = rail.element().getBoundingClientRect();
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.width).toBeLessThanOrEqual(64);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      for (const name of [
        "Home",
        "资料空间",
        "Scheduled",
        "Images",
        "Inbox",
        "Code review",
        "Plugins",
        "More",
      ]) {
        await expect.element(rail.getByRole("button", { name, exact: true })).toBeVisible();
      }
      for (const name of ["History", "Library", "Spaces", "Kanban", "Tasks"]) {
        await expect
          .element(rail.getByRole("button", { name, exact: true }))
          .not.toBeInTheDocument();
      }
      await page.getByRole("button", { name: "Toggle thread sidebar", exact: true }).click();
      await expect
        .poll(() => document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state"))
        .toBe("collapsed");
      await expect.element(rail).toBeVisible();
      await expect.element(rail.getByRole("button", { name: "Home", exact: true })).toBeVisible();
      await expect.element(rail.getByTestId("rail-account-menu-trigger")).toBeVisible();
      await page.getByRole("button", { name: "Toggle thread sidebar", exact: true }).click();
      await expect
        .poll(() => document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state"))
        .toBe("expanded");
      await expect.element(rail).toBeVisible();
      await rail.getByTestId("rail-account-menu-trigger").click();
      await vi.waitFor(() => {
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
      });
      await expect
        .element(page.getByRole("menuitem", { name: "Profile", exact: true }))
        .toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: /Settings/ })).toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: "Sign in", exact: true }))
        .toBeVisible();
      await page.getByRole("menuitem", { name: "Profile", exact: true }).click();
      await expect.poll(() => mounted.router.state.location.pathname).toBe("/profile");
      await expect.element(page.getByTestId("profile-sign-in")).toBeVisible();
      await page.getByTestId("moss-profile-back").click();
      await expect.poll(() => mounted.router.state.location.pathname).not.toBe("/profile");
      await expect.element(rail).toBeVisible();
      // The old History proxy opened this same search palette. Both existing
      // search entries remain connected after the clock becomes Scheduled.
      for (const name of ["Search"]) {
        await page.getByRole("button", { name, exact: true }).click();
        await expect.element(page.getByPlaceholder("Search chats or run a command")).toBeVisible();
        await userEvent.keyboard("{Escape}");
        await expect
          .element(page.getByPlaceholder("Search chats or run a command"))
          .not.toBeInTheDocument();
      }
      const initialPath = mounted.router.state.location.pathname;
      await page.getByRole("button", { name: "Mossbot", exact: true }).last().click();
      await expect.poll(() => mounted.router.state.location.pathname).toBe("/mossbot");
      await rail.getByRole("button", { name: "Home", exact: true }).click();
      await expect.poll(() => mounted.router.state.location.pathname).toBe(initialPath);
      await rail.getByRole("button", { name: "Scheduled", exact: true }).click();
      await expect.poll(() => mounted.router.state.location.pathname).toBe("/automations");
      // location changes before the route commits. Home reads the committed
      // section, so finish opening Scheduled before asking it to return.
      // The sidebar panel keeps its own "New automation" button while the redesigned
      // /automations page renders the "New task" split trigger.
      await expect
        .poll(() => page.getByRole("button", { name: "New automation", exact: true }).all().length)
        .toBeGreaterThanOrEqual(1);
      await expect
        .poll(() => page.getByRole("button", { name: /New task|新建任务/ }).all().length)
        .toBeGreaterThanOrEqual(1);
      await expect.poll(() => mounted.router.state.isLoading).toBe(false);
      await rail.getByRole("button", { name: "Home", exact: true }).click();
      await expect.poll(() => mounted.router.state.location.pathname).toBe(initialPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets a rail click win over a destination that is still loading", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("rail-latest-wins"),
        targetText: "Rail latest wins",
      }),
    });
    try {
      await waitForLayout();
      const rail = page.getByRole("navigation", { name: "Primary", exact: true });
      await expect.element(rail.getByRole("button", { name: "Home", exact: true })).toBeVisible();
      const initialPath = mounted.router.state.location.pathname;
      for (const open of [
        () => page.getByRole("button", { name: "Mossbot", exact: true }).last(),
        () => rail.getByRole("button", { name: "Scheduled", exact: true }),
      ]) {
        // Ask for a destination and press Home before its route has committed, as a person does on a
        // slow first visit: Home is the latest request, so Home wins.
        (open().element() as HTMLElement).click();
        await expect.poll(() => mounted.router.state.location.pathname).not.toBe(initialPath);
        (rail.getByRole("button", { name: "Home", exact: true }).element() as HTMLElement).click();
        await expect.poll(() => mounted.router.state.isLoading).toBe(false);
        await expect.poll(() => mounted.router.state.location.pathname).toBe(initialPath);
        // and it stays there once every pending load has settled
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(mounted.router.state.location.pathname).toBe(initialPath);
      }
    } finally {
      await mounted.cleanup();
    }
  });

  // The self-report tool `layout_report` must catch the onboarding overflow the owner found on
  // 2026-11-18 (fixed by #674): the stage with no top bar above it, its controls under the
  // desktop window's own buttons. Recreated here by hiding that top bar.
  it("layout_report finds nothing wrong on the Mossbot page as shipped (no second onboarding)", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("mossbot-onboarding-self-report"),
        targetText: "Mossbot onboarding self-report",
      }),
    });
    try {
      await waitForLayout();
      await page.getByRole("button", { name: "Mossbot", exact: true }).last().click();
      await expect.poll(() => mounted.router.state.location.pathname).toBe("/mossbot");
      await expect.poll(() => document.querySelector("[data-mossbot-workspace]")).not.toBeNull();
      // The Mossbot page itself, never an intro stage (walk 2026-11-24, D-7).
      expect(document.querySelector("[data-mossbot-onboarding]")).toBeNull();
      // The acceptance window and the owner's window.
      for (const viewport of [
        { name: "acceptance", width: 1101, height: 782 },
        { name: "owner", width: 1375, height: 886 },
      ]) {
        await setViewport(viewport);
        await waitForLayout();
        const at = `${viewport.width}x${viewport.height}`;
        // As the tool measures: settled first (fonts, running transitions, two frames).
        await settleLayout();
        const report = await layoutReport({
          root: "[data-mossbot-workspace]",
          windowControls: "windows",
        });
        // As shipped: nothing under the window's buttons, nothing cut, nothing spilling.
        expect(report.findings, at).toEqual([]);
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens Mossbot on its own page with no second onboarding, the panel and toggle as left (walk D-7, R-9)", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("mossbot-onboarding-shell"),
        targetText: "Mossbot onboarding shell",
      }),
    });
    const sidebarState = () =>
      document.querySelector('[data-slot="sidebar"][data-side="left"]')?.getAttribute("data-state");
    const toggle = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Toggle thread sidebar"]');
    try {
      await waitForLayout();
      for (const preferenceOpen of [true, false]) {
        if ((sidebarState() === "expanded") !== preferenceOpen) {
          await page.getByRole("button", { name: "Toggle thread sidebar", exact: true }).click();
          await expect.poll(sidebarState).toBe(preferenceOpen ? "expanded" : "collapsed");
        }
        const toggleBefore = toggle()!.getBoundingClientRect();
        await mounted.router.navigate({ to: "/mossbot" });
        await expect.poll(() => mounted.router.state.location.pathname).toBe("/mossbot");
        await expect.poll(() => document.querySelector("[data-mossbot-workspace]")).not.toBeNull();
        // The plain page: no full-window intro stage, no way back into one.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(document.querySelector("[data-mossbot-onboarding]")).toBeNull();
        expect(page.getByRole("button", { name: "Skip intro" }).elements()).toHaveLength(0);
        expect(page.getByRole("button", { name: "Show the intro" }).elements()).toHaveLength(0);
        // The panel stays as the person left it and the title-bar toggle stays where it was.
        expect(sidebarState()).toBe(preferenceOpen ? "expanded" : "collapsed");
        const toggleOnMossbot = toggle()!;
        expect(getComputedStyle(toggleOnMossbot).visibility).toBe("visible");
        expect(toggleOnMossbot.disabled).toBe(false);
        // With the panel open the toggle stays put. With it collapsed the toggle rides into
        // each page's own header, which is not the same x everywhere (R-9, left to the lead).
        if (preferenceOpen) {
          expect(
            Math.abs(toggleOnMossbot.getBoundingClientRect().left - toggleBefore.left),
          ).toBeLessThan(1);
        }
        await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
        await expect.poll(() => mounted.router.state.location.pathname).not.toBe("/mossbot");
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the sidebar toggle in one place on every page, panel open or collapsed (walk R-9)", async () => {
    desktopTitleBar.on = true;
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1280 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("titlebar-toggle-place"),
        targetText: "Title bar toggle place",
      }),
    });
    const sidebarState = () =>
      document.querySelector('[data-slot="sidebar"][data-side="left"]')?.getAttribute("data-state");
    const toggle = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Toggle thread sidebar"]')!;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 450)); // the panel's slide
    const place = () => {
      const rect = toggle().getBoundingClientRect();
      return { left: Math.round(rect.left), top: Math.round(rect.top) };
    };
    const setPanel = async (open: boolean, at = "") => {
      if ((sidebarState() === "expanded") !== open) {
        toggle().click();
        await expect
          .poll(sidebarState, { message: `${at} panel ${open ? "opens" : "closes"}` })
          .toBe(open ? "expanded" : "collapsed");
      }
      await settle();
    };
    // The cluster (toggle, and the arrows in the desktop app) is drawn over the title bar:
    // a click reaches it, and no text or control of the page lies under it.
    // Electron folds the drag and no-drag boxes of the page in document order: the last one
    // over a point decides whether a click there drags the window.
    const nativeRegionsOver = (box: DOMRect) =>
      Array.from(document.querySelectorAll<HTMLElement>("body *")).flatMap((element) => {
        const rect = element.getBoundingClientRect();
        if (
          rect.width === 0 ||
          rect.height === 0 ||
          rect.right <= box.left ||
          box.right <= rect.left ||
          rect.bottom <= box.top ||
          box.bottom <= rect.top
        ) {
          return [];
        }
        const region = getComputedStyle(element).getPropertyValue("-webkit-app-region");
        return region === "drag" || region === "no-drag" ? [{ rect, region }] : [];
      });
    const nativeRegionAt = (regions: ReturnType<typeof nativeRegionsOver>, x: number, y: number) =>
      regions.reduce(
        (last, { rect, region }) =>
          x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom ? region : last,
        "",
      );
    const expectClearOfPage = (at: string) => {
      const cluster = toggle().parentElement!;
      const box = cluster.getBoundingClientRect();
      // One cluster: one Back and one Forward on screen.
      for (const name of ["Back", "Forward"]) {
        expect(
          document.querySelectorAll(`button[aria-label="${name}"]`),
          `${at}: one ${name}`,
        ).toHaveLength(1);
      }
      const regions = nativeRegionsOver(box);
      // Every control of the cluster takes a click at its centre, and nothing of the page
      // lies over its edges (a rounded corner may hand the edge to the cluster itself).
      for (const control of cluster.querySelectorAll<HTMLButtonElement>("button")) {
        const rect = control.getBoundingClientRect();
        const y = rect.top + rect.height / 2;
        const centre = document.elementFromPoint(rect.left + rect.width / 2, y);
        // A disabled arrow (nowhere to go) takes no pointer: then nothing else may be on top.
        expect(
          (control.disabled ? cluster : control).contains(centre),
          `${at}: ${control.ariaLabel} takes the click`,
        ).toBe(true);
        expect(
          nativeRegionAt(regions, rect.left + rect.width / 2, y),
          `${at}: ${control.ariaLabel} does not drag the window`,
        ).toBe("no-drag");
        for (const x of [rect.left + 1, rect.right - 1]) {
          const edge = document.elementFromPoint(x, y);
          expect(cluster.contains(edge), `${at}: ${control.ariaLabel} edge is clear`).toBe(true);
        }
      }
      const underneath = Array.from(
        document.querySelectorAll<HTMLElement>("h1, h2, h3, button, a, input, [role='tab']"),
      ).filter((element) => {
        if (cluster.contains(element) || element.closest("[aria-hidden='true']")) return false;
        // The panel's resize edge runs the full height beside the rail, under the cluster
        // (the click checks above show the cluster is on top); it is not page content.
        if (element.dataset.slot === "sidebar-rail") return false;
        if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
          return false;
        }
        const other = element.getBoundingClientRect();
        if (other.width === 0 || other.height === 0) return false;
        return (
          other.left < box.right &&
          box.left < other.right &&
          other.top < box.bottom &&
          box.top < other.bottom
        );
      });
      expect(
        underneath.map((element) => element.textContent?.trim() || element.tagName),
        `${at}: nothing of the page under the title-bar controls`,
      ).toEqual([]);
    };
    try {
      await waitForLayout();
      await setPanel(true);
      expect(
        toggle().parentElement!.querySelectorAll("button").length,
        "toggle, Back and Forward render",
      ).toBe(3);
      const home = place();
      // Every page the rail opens, by clicking its button, then settings. Mossbot is left out
      // only because main still runs its own onboarding there, which holds the panel and
      // disables the toggle; #820 removes that onboarding and puts Mossbot back in this list.
      const rail = document.querySelector<HTMLElement>('nav[aria-label="Primary"]')!;
      const railLabels = Array.from(rail.querySelectorAll<HTMLButtonElement>("button"))
        .filter((button) => !button.hasAttribute("aria-haspopup")) // menus (More), not pages
        .map((button) => button.getAttribute("aria-label") ?? "")
        .filter((label) => label !== "" && label !== "Mossbot");
      expect(railLabels.length, "rail items").toBeGreaterThanOrEqual(5);
      const panelHeldOn: string[] = [];
      const bandOn: string[] = [];
      const visited: string[] = [];
      // Pages opened from elsewhere than a rail button (应用页 from the built-in apps, the board
      // when hidden from the rail) go by route.
      const routes = ["/apps", "/kanban"] as const;
      for (const to of [...railLabels, ...routes, "settings"]) {
        if ((routes as readonly string[]).includes(to)) {
          await mounted.router.navigate({ to: to as (typeof routes)[number] });
          await expect.poll(() => mounted.router.state.location.pathname).toBe(to);
          await expect.poll(() => mounted.router.state.status).toBe("idle");
          await settle();
          visited.push(to);
        } else if (to === "settings") {
          // Settings opens over the shell as a modal: the cluster keeps its place under the
          // modal's overlay (back/forward must not act behind an open dialog), and takes clicks
          // again once it closes.
          openSettings({ section: "general" });
          await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();
          await settle();
          expect(place(), "settings").toEqual(home);
          closeSettings();
          await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
        } else {
          const item = () =>
            rail.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(to)}"]`)!;
          item().click();
          await expect
            .poll(() => item().getAttribute("aria-current"), { message: `${to} is current` })
            .toBe("page");
          // The rail re-syncs its item once the route has loaded; act after that.
          await expect
            .poll(() => mounted.router.state.status, { message: `${to} loads` })
            .toBe("idle");
          await settle();
          visited.push(to);
        }
        // A full-width page (收信箱, 代码审查…) brings the panel back when the toggle opens it.
        // On 资料空间 the toggle shows and hides that page's own sidebar (WALK-6 R-9).
        if (sidebarState() === "collapsed") {
          toggle().click();
          for (let waited = 0; waited < 2000 && sidebarState() === "collapsed"; waited += 100) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          await settle();
        }
        const held = sidebarState() === "collapsed";
        if (to === "资料空间" || to === "Images") {
          // Full-window pages: the Windows title band is there to drag the window by.
          expect(
            document.querySelector("[data-moss-destination-menubar]"),
            `${to}: title band`,
          ).not.toBeNull();
          bandOn.push(to);
        }
        if (held) panelHeldOn.push(to);
        for (const open of held ? [false] : [true, false]) {
          await setPanel(open, `${to} (${mounted.router.state.location.pathname}):`);
          const at = `${to} (${mounted.router.state.location.pathname}), panel ${open ? "open" : "collapsed"}`;
          expect(place(), at).toEqual(home);
          expectClearOfPage(at);
        }
        if (!held) await setPanel(true, `${to}, back:`);
      }
      expect(panelHeldOn, "pages that keep the panel hidden").toEqual([]);
      expect([...bandOn].sort(), "full-window pages visited").toEqual(["Images", "资料空间"]);
      expect(visited, "every rail page was visited").toEqual([...railLabels, ...routes]);
    } finally {
      desktopTitleBar.on = false;
      closeSettings();
      await mounted.cleanup();
    }
  });

  it("WALK-6 R-9 on 资料空间: the title bar's toggle hides and shows the 资料空间 sidebar", async () => {
    desktopTitleBar.on = true;
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1280 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("space-toggle"),
        targetText: "Space toggle",
      }),
    });
    const toggle = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Toggle thread sidebar"]')!;
    const spaceSidebar = () => document.querySelector<HTMLElement>("[data-space-sidebar]");
    const shown = () => {
      const box = spaceSidebar()?.getBoundingClientRect();
      return !!box && box.width > 0 && box.height > 0;
    };
    try {
      await waitForLayout();
      // The walker's steps: rail → 资料空间, then the toggle at the title bar's left, twice.
      const rail = document.querySelector<HTMLElement>('nav[aria-label="Primary"]')!;
      rail.querySelector<HTMLButtonElement>('button[aria-label="资料空间"]')!.click();
      await expect.poll(shown, { message: "资料空间 opens with its sidebar" }).toBe(true);
      const centre = () => {
        const rect = toggle().getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      };
      expect(toggle().contains(centre()), "the toggle takes the click").toBe(true);
      toggle().click();
      await expect.poll(shown, { message: "the toggle hides the 资料空间 sidebar" }).toBe(false);
      toggle().click();
      await expect.poll(shown, { message: "the toggle shows it again" }).toBe(true);
      // The chat panel stays away on 资料空间: nothing of it is on screen.
      const chatPanel = document.querySelector<HTMLElement>(
        '[data-slot="sidebar"][data-side="left"]',
      );
      expect(chatPanel?.checkVisibility() ?? false).toBe(false);
    } finally {
      desktopTitleBar.on = false;
      await mounted.cleanup();
    }
  });

  it("WALK-6 R-9: 定时任务 → 图像 → 收信箱 → 代码审查, then Back three times ends on 定时任务 passing 图像", async () => {
    desktopTitleBar.on = true;
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1280 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("rail-history"),
        targetText: "Rail history",
      }),
    });
    // The rail's English names: 定时任务 Scheduled, 图像 Images, 收信箱 Inbox, 代码审查 Code review.
    const rail = () => document.querySelector<HTMLElement>('nav[aria-label="Primary"]')!;
    const current = () =>
      rail()
        .querySelector('button[aria-current="page"]')
        ?.getAttribute("aria-label")
        ?.split(" · ")[0] ?? null; // a badge adds " · <count>"
    const imagesShown = () => document.querySelector("[data-moss-images-destination]") !== null;
    const arrow = (name: "Back" | "Forward") => {
      const buttons = document.querySelectorAll<HTMLButtonElement>(`button[aria-label="${name}"]`);
      expect(buttons, `one ${name} on screen`).toHaveLength(1);
      return buttons[0]!;
    };
    const expectOn = async (label: string, pathname: string, images: boolean, at: string) => {
      await expect.poll(current, { message: `${at}: ${label} is current` }).toBe(label);
      await expect
        .poll(imagesShown, { message: `${at}: 图像 ${images ? "is shown" : "is gone"}` })
        .toBe(images);
      await expect
        .poll(() => mounted.router.state.location.pathname, { message: `${at}: address` })
        .toBe(pathname);
    };
    try {
      await waitForLayout();
      // The walker's steps: four rail pages in turn.
      const pages = [
        ["Scheduled", "/automations", false],
        ["Images", "/automations", true],
        ["Inbox", "/inbox", false],
        ["Code review", "/pull-requests", false],
      ] as const;
      for (const [label, pathname, images] of pages) {
        rail().querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)!.click();
        await expectOn(label, pathname, images, `open ${label}`);
      }
      // Back three times walks them in reverse, through 图像.
      for (const [label, pathname, images] of [pages[2], pages[1], pages[0]]) {
        expect(arrow("Back").disabled, `Back to ${label} is available`).toBe(false);
        arrow("Back").click();
        await expectOn(label, pathname, images, `Back to ${label}`);
      }
      // Forward goes to 图像 again.
      expect(arrow("Forward").disabled, "Forward is available").toBe(false);
      arrow("Forward").click();
      await expectOn("Images", "/automations", true, "Forward to Images");
    } finally {
      desktopTitleBar.on = false;
      await mounted.cleanup();
    }
  });

  it("WALK-13 N13-1: 首页 → 图像 or 资料空间, then one mouse click on 收信箱, 定时任务, Mossbot or 代码审查 opens that page", async () => {
    desktopTitleBar.on = true;
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1280 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("rail-one-click"),
        targetText: "Rail one click",
      }),
    });
    // The rail's English names: 首页 Home, 图像 Images, 收信箱 Inbox, 定时任务 Scheduled,
    // 代码审查 Code review; 资料空间 and Mossbot keep their names.
    const rail = () => document.querySelector<HTMLElement>('nav[aria-label="Primary"]')!;
    const current = () =>
      rail()
        .querySelector('button[aria-current="page"]')
        ?.getAttribute("aria-label")
        ?.split(" · ")[0] ?? null; // a badge adds " · <count>"
    const shown = () =>
      document.querySelector("[data-moss-images-destination]")
        ? "Images"
        : document.querySelector("[data-moss-data-spaces]")
          ? "资料空间"
          : null;
    const back = () => {
      const buttons = document.querySelectorAll<HTMLButtonElement>('button[aria-label="Back"]');
      expect(buttons, "one Back on screen").toHaveLength(1);
      return buttons[0]!;
    };
    // The walker clicked with the mouse: a real click, whose microtasks run while its event
    // is still current (an element.click() from the test would hide the race).
    const click = (label: string) =>
      page
        .getByRole("navigation", { name: "Primary", exact: true })
        .getByRole("button", { name: new RegExp(`^${label}(?: · |$)`) })
        .click();
    try {
      await waitForLayout();
      const targets = [
        ["Inbox", "/inbox"],
        ["Scheduled", "/automations"],
        ["Mossbot", "/mossbot"],
        ["Code review", "/pull-requests"],
      ] as const;
      for (const source of ["Images", "资料空间"] as const) {
        for (const [label, pathname] of targets) {
          const at = `${source} → ${label}`;
          await click("Home");
          await expect.poll(current, { message: `${at}: 首页 is current` }).toBe("Home");
          await click(source);
          await expect.poll(shown, { message: `${at}: ${source} is shown` }).toBe(source);
          // One click on the rail page.
          await click(label);
          const expectOnTarget = async (when: string) => {
            await expect.poll(shown, { message: `${at} ${when}: ${source} is gone` }).toBe(null);
            await expect
              .poll(() => mounted.router.state.location.pathname, {
                message: `${at} ${when}: the address is the clicked page`,
              })
              .toBe(pathname);
            await expect.poll(current, { message: `${at} ${when}: the rail shows it` }).toBe(label);
          };
          await expectOnTarget("after one click");
          // It stays there: no entry for the page under the destination lands on top.
          for (let frame = 0; frame < 5; frame += 1) await nextFrame();
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(mounted.router.state.location.pathname, `${at}: still the clicked page`).toBe(
            pathname,
          );
          expect(current(), `${at}: the rail still shows it`).toBe(label);
          // Back walks to what was seen before it: the destination.
          back().click();
          await expect.poll(shown, { message: `${at}: Back shows ${source}` }).toBe(source);
        }
      }
    } finally {
      desktopTitleBar.on = false;
      await mounted.cleanup();
    }
  });

  it("WALK-6 R-9 on 图像 with a result tab: one Back, one Forward, and the toggle takes the click at its centre", async () => {
    desktopTitleBar.on = true;
    // One past image, so 图像 can open it in a result tab.
    const account = { id: "acct_r9", realm: "moss" };
    const conversationId = `mossconv_${"a".repeat(32)}`;
    const pastJob = {
      jobId: "moss_r9_result",
      status: "failed_terminal",
      prompt: "山间日出",
      createdAt: "2026-11-24T08:00:00.000Z",
      modelId: "gpt-image-2-official",
      imageUrls: [],
      billingStatus: "released",
      conversationId,
      parentJobId: null,
    };
    worker.use(
      http.get("*/api/moss/media/history", () =>
        HttpResponse.json({ account, jobs: [pastJob], nextCursor: null }),
      ),
      http.get("*/api/moss/media/conversations/:conversationId", () =>
        HttpResponse.json({
          account,
          jobs: [pastJob],
          nextCursor: null,
          conversationId,
          kind: "image",
        }),
      ),
    );
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1280 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("images-result-cluster"),
        targetText: "Images result cluster",
      }),
    });
    try {
      await waitForLayout();
      // The walker's steps: rail → 图像, open the past image in its result tab.
      const rail = document.querySelector<HTMLElement>('nav[aria-label="Primary"]')!;
      rail.querySelector<HTMLButtonElement>('button[aria-label="Images"]')!.click();
      const card = () =>
        document.querySelector<HTMLButtonElement>('button[aria-label="打开图像：山间日出"]');
      await expect
        .poll(() => !!card() && !card()!.disabled, { message: "the past image is listed" })
        .toBe(true);
      card()!.click();
      await expect
        .poll(
          () =>
            document
              .querySelector("[data-moss-images-mode]")
              ?.getAttribute("data-moss-images-mode"),
          { message: "a result tab is open" },
        )
        .toBe("result");
      await expect
        .poll(() => document.querySelector("[data-moss-codex-top-tab-chrome]") !== null, {
          message: "the result tab's header is drawn",
        })
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 450)); // the panel's slide
      // One cluster: exactly one Back and one Forward on screen.
      for (const name of ["Back", "Forward"]) {
        expect(
          document.querySelectorAll(`button[aria-label="${name}"]`),
          `one ${name}`,
        ).toHaveLength(1);
      }
      const toggle = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Toggle thread sidebar"]',
      )!;
      const cluster = toggle.parentElement!;
      // Electron folds the page's drag and no-drag boxes in document order: the last one over a
      // point decides whether a click there drags the window.
      const regionAt = (x: number, y: number) =>
        Array.from(document.querySelectorAll<HTMLElement>("body *")).reduce((last, element) => {
          const rect = element.getBoundingClientRect();
          if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return last;
          const region = getComputedStyle(element).getPropertyValue("-webkit-app-region");
          return region === "drag" || region === "no-drag" ? region : last;
        }, "");
      for (const control of cluster.querySelectorAll<HTMLButtonElement>("button")) {
        const rect = control.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        // A disabled arrow (nowhere to go) takes no pointer: then nothing else may be on top.
        expect(
          (control.disabled ? cluster : control).contains(document.elementFromPoint(x, y)),
          `${control.ariaLabel} takes the click at its centre`,
        ).toBe(true);
        expect(regionAt(x, y), `${control.ariaLabel} does not drag the window`).toBe("no-drag");
      }
    } finally {
      worker.resetHandlers();
      desktopTitleBar.on = false;
      await mounted.cleanup();
    }
  });

  it("WALK-13 N13-8: 更多 → 任务 → 列表 shows all board tasks and 新建任务 opens the dialog", async () => {
    desktopTitleBar.on = true;
    const baseSnapshot = createSnapshotWithPendingApproval();
    const doneThreadId = ThreadId.makeUnsafe("thread-n13-8-done");
    const withSecond = addThreadToSnapshot(baseSnapshot, OTHER_THREAD_ID);
    const withThird = addThreadToSnapshot(withSecond, doneThreadId);
    const snapshot = {
      ...withThird,
      projects: withThird.projects.map((project) =>
        project.id === PROJECT_ID ? { ...project, title: "code" } : project,
      ),
      threads: withThird.threads.map((thread) => {
        if (thread.id === THREAD_ID) {
          return { ...thread, title: "Task awaiting approval" };
        }
        if (thread.id === OTHER_THREAD_ID) {
          return {
            ...thread,
            title: "Task failed",
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-n13-8-failed"),
              state: "error" as const,
              requestedAt: NOW_ISO,
              startedAt: NOW_ISO,
              completedAt: NOW_ISO,
              assistantMessageId: null,
            },
            session: {
              ...thread.session!,
              status: "error" as const,
              lastError: "Gateway 500",
            },
          };
        }
        if (thread.id === doneThreadId) {
          return {
            ...thread,
            title: "Task done",
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-n13-8-done"),
              state: "completed" as const,
              requestedAt: NOW_ISO,
              startedAt: NOW_ISO,
              completedAt: NOW_ISO,
              assistantMessageId: null,
            },
          };
        }
        return thread;
      }),
    };
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_100, height: 780 },
      snapshot,
    });
    try {
      await waitForLayout();
      const rail = page.getByRole("navigation", { name: "Primary", exact: true });
      await rail.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Tasks", exact: true }).click();
      await expect
        .poll(() => mounted.router.state.location.pathname, { message: "Tasks opens on List view" })
        .toBe("/tasks");

      // All 3 board tasks are rendered as visible list rows (not just the quick-add line).
      for (const title of ["Task awaiting approval", "Task failed", "Task done"]) {
        const rowButton = page.getByRole("button", { name: title, exact: true });
        await expect.element(rowButton).toBeVisible();
        const box = rowButton.element().getBoundingClientRect();
        expect(box.width, `${title} row has width`).toBeGreaterThan(0);
        expect(box.height, `${title} row has height`).toBeGreaterThan(0);
      }

      // Clicking 新建任务 in List opens the same New task dialog as Board.
      await page.getByRole("button", { name: "New task", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect.element(dialog).toBeVisible();
      await expect.element(dialog.getByText("code", { exact: true })).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(dialog).not.toBeInTheDocument();

      // Switch to Board and verify the same 3 tasks and dialog exist there too.
      await page.getByRole("radio", { name: "Kanban", exact: true }).click();
      await expect
        .poll(() => mounted.router.state.location.pathname, { message: "Board view is open" })
        .toBe("/kanban");
      for (const title of ["Task awaiting approval", "Task failed", "Task done"]) {
        await expect
          .element(page.getByRole("main").getByText(title, { exact: true }))
          .toBeVisible();
      }
      await page.getByRole("button", { name: "New task", exact: true }).click();
      await expect.element(page.getByRole("dialog")).toBeVisible();
    } finally {
      desktopTitleBar.on = false;
      await mounted.cleanup();
    }
  });

  it("keeps desktop More, Settings, customization, and project shortcuts connected", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("desktop-rail-actions"),
        targetText: "Desktop rail actions",
      }),
    });
    try {
      await waitForLayout();
      const rail = page.getByRole("navigation", { name: "Primary", exact: true });
      await expect.element(rail).toBeVisible();
      const initialPath = mounted.router.state.location.pathname;
      await expect
        .element(rail.getByRole("button", { name: "Scheduled", exact: true }))
        .toBeVisible();
      await rail.getByRole("button", { name: "More", exact: true }).click();
      for (const name of ["Plugins", "Settings"]) {
        await expect.element(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
      }
      // Like Codex, the menu lists every destination; ones already in the rail offer Unpin.
      await expect
        .element(page.getByRole("menuitem", { name: "Scheduled", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: "Unpin from sidebar: Scheduled", exact: true }))
        .toBeInTheDocument();
      await rail.getByRole("button", { name: "More", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Settings", exact: true }))
        .not.toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe(initialPath);
      await rail.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      // Settings is a dialog over the current screen, not a route.
      await expect.poll(() => settingsDialogStore.getState().isOpen).toBe(true);
      expect(mounted.router.state.location.pathname).toBe(initialPath);
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => settingsDialogStore.getState().isOpen).toBe(false);
      await expect.element(rail).toBeVisible();
      await rail.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Customize…", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
      await page.getByRole("checkbox", { name: "Show Tasks in the sidebar", exact: true }).click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await expect.element(rail.getByRole("button", { name: "Tasks", exact: true })).toBeVisible();
      expect(
        JSON.parse(localStorage.getItem("moss:app-settings:v1") ?? "{}").hiddenRailItems,
      ).not.toContain("tasks");
      await rail.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Projects in the sidebar", exact: true }).click();
      await page.getByRole("menuitemcheckbox", { name: "Project", exact: true }).click();
      // Escape steps out of the submenu first, then closes the menu.
      await userEvent.keyboard("{Escape}");
      if (document.querySelector('[role="menu"]')) await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("menuitem", { name: "Settings", exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(rail.getByRole("button", { name: "Project", exact: true }))
        .toBeVisible();
      expect(
        JSON.parse(localStorage.getItem("moss:app-settings:v1") ?? "{}").railShortcuts,
      ).toEqual([`project:${PROJECT_ID}`]);
      await rail.getByRole("button", { name: "Project", exact: true }).click();
      await expect.poll(() => useRailShellStore.getState().railProjectId).toBe(PROJECT_ID);
      await expect
        .element(rail.getByRole("button", { name: "Project", exact: true }))
        .toHaveAttribute("aria-current", "page");
    } finally {
      await mounted.cleanup();
      useRailShellStore.setState({ railProjectId: null });
      useRailShellStore.getState().selectPanelItem("home");
    }
  });

  it("preserves the hidden board slot when Tasks replaces Kanban in the rail", async () => {
    localStorage.setItem("moss:app-settings:v1", JSON.stringify({ hiddenRailItems: ["kanban"] }));
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("hidden-tasks-slot"),
        targetText: "Hidden Tasks slot",
      }),
    });
    try {
      await waitForLayout();
      const rail = await openPhonePrimaryRail(mounted);
      await expect
        .element(page.getByRole("button", { name: "Tasks", exact: true }))
        .not.toBeInTheDocument();
      // The Moss rail hides the upstream "…" menu; Customize opens from the rail's
      // right-click context menu instead.
      rail
        .element()
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 24, clientY: 24 }));
      await page.getByRole("menuitem", { name: "Customize", exact: true }).click();
      await page.getByRole("checkbox", { name: "Show Tasks in the sidebar", exact: true }).click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Tasks", exact: true })).toBeVisible();
      expect(
        JSON.parse(localStorage.getItem("moss:app-settings:v1") ?? "{}").hiddenRailItems,
      ).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the Codex-spec rail destinations and hides the upstream extras", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("rail-spec"),
        targetText: "Rail spec",
      }),
    });
    try {
      await waitForLayout();
      const rail = await openPhonePrimaryRail(mounted);
      for (const name of [
        "Home",
        "资料空间",
        "Scheduled",
        "Images",
        "Inbox",
        "Code review",
        "Plugins",
        "More",
      ]) {
        await expect.element(rail.getByRole("button", { name, exact: true })).toBeVisible();
      }
      // Images also supports users' own CLI accounts. Extra destinations stay
      // reachable through More instead of occupying the default inline rail.
      for (const name of ["History", "Library", "Spaces", "Kanban", "Tasks"]) {
        await expect
          .element(rail.getByRole("button", { name, exact: true }))
          .not.toBeInTheDocument();
      }
      await rail.getByRole("button", { name: "More", exact: true }).click();
      for (const name of ["Plugins", "Settings"]) {
        await expect.element(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
      }
      // Like Codex, the menu lists every destination; ones already in the rail offer Unpin.
      await expect
        .element(page.getByRole("menuitem", { name: "Scheduled", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: "Unpin from sidebar: Scheduled", exact: true }))
        .toBeInTheDocument();
      await rail.getByRole("button", { name: "More", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Settings", exact: true }))
        .not.toBeInTheDocument();
      // Codex bottom-left account entry: signed out, so the avatar opens a menu whose
      // account action is the sign-in entry.
      await rail.getByTestId("rail-account-menu-trigger").click();
      await vi.waitFor(() => {
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
      });
      await expect
        .element(page.getByRole("menuitem", { name: "Profile", exact: true }))
        .toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: /Settings/ })).toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: "Sign in", exact: true }))
        .toBeVisible();
      await page.getByRole("menuitem", { name: "Profile", exact: true }).click();
      await expect.poll(() => mounted.router.state.location.pathname).toBe("/profile");
      await expect.element(page.getByTestId("profile-sign-in")).toBeVisible();
      await page.getByTestId("moss-profile-back").click();
      await expect.poll(() => mounted.router.state.location.pathname).not.toBe("/profile");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the Images entry and real destination connected for a signed-in Moss account", async () => {
    setMossCloudAccountStateOverride({
      ...unconfiguredMossCloudAccountState,
      configured: true,
      authenticated: true,
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("rail-images-gate"),
        targetText: "Rail images gate",
      }),
    });
    try {
      await waitForLayout();
      const rail = await openPhonePrimaryRail(mounted);
      await expect.element(rail.getByRole("button", { name: "Images", exact: true })).toBeVisible();
      // The desktop text navigation shares the account guard and real handler.
      await mounted.setViewport(DEFAULT_VIEWPORT);
      await page.getByRole("button", { name: "Images", exact: true }).click();
      await expect.element(page.getByLabelText("Moss Images", { exact: true })).toBeVisible();
      // Codex destination pages take over the content area: the chat thread panel hides
      // until the Images workspace's own split-panel toggle brings it back.
      await expect
        .poll(() => document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state"))
        .toBe("collapsed");
      window.dispatchEvent(new Event("moss-sidebar-toggle"));
      await expect
        .poll(() => document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state"))
        .toBe("expanded");
      window.dispatchEvent(new Event("moss-sidebar-toggle"));
      await expect
        .poll(() => document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state"))
        .toBe("collapsed");
      useRailShellStore.getState().selectPanelItem("home");
      await expect
        .element(page.getByLabelText("Moss Images", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .poll(() => document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state"))
        .toBe("expanded");
    } finally {
      setMossCloudAccountStateOverride(null);
      await mounted.cleanup();
    }
  });

  it("opens data spaces with the existing Library files from the rail and closes them on leave", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("rail-library-surface"),
        targetText: "Rail library surface",
      }),
    });
    try {
      await waitForLayout();
      const rail = await openPhonePrimaryRail(mounted);
      await expect
        .element(rail.getByRole("button", { name: "资料空间", exact: true }))
        .toBeVisible();
      await mounted.setViewport(DEFAULT_VIEWPORT);
      await page.getByRole("button", { name: "资料空间", exact: true }).click();
      await expect
        .element(page.getByRole("complementary", { name: "资料空间导航", exact: true }))
        .toBeVisible();
      await expect
        .poll(() => wsRequests.some((request) => request._tag === WS_METHODS.pagesSpaces))
        .toBe(true);
      await expect
        .poll(() => wsRequests.some((request) => request._tag === WS_METHODS.pagesList))
        .toBe(true);
      // The existing Library files are items of 资料空间 itself (its 全部 view), not a
      // separate page behind a 资料库文件 button.
      await expect
        .poll(() => wsRequests.some((request) => request._tag === WS_METHODS.libraryList))
        .toBe(true);
      useRailShellStore.getState().selectPanelItem("home");
      await expect
        .element(page.getByRole("complementary", { name: "资料空间导航", exact: true }))
        .not.toBeInTheDocument();
      await expect
        .poll(() => document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state"))
        .toBe("expanded");
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves the Plugins destination when the rail Home item is selected", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("rail-home-leaves-destination"),
        targetText: "Rail home leaves destination",
      }),
    });
    try {
      await mounted.router.navigate({ to: "/skills" });
      await waitForLayout();
      const rail = await openPhonePrimaryRail(mounted);
      await expect
        .poll(() => document.querySelector("[data-moss-plugins-main]") !== null)
        .toBe(true);
      await expect
        .element(rail.getByRole("button", { name: "Plugins", exact: true }))
        .toHaveAttribute("aria-current", "page");
      // Home must navigate back to the chat surface, not just reopen the thread panel
      // over the destination.
      await rail.getByRole("button", { name: "Home", exact: true }).click();
      await expect.poll(() => mounted.router.state.location.pathname).not.toMatch(/^\/skills/);
      await expect.poll(() => document.querySelector("[data-moss-plugins-main]")).toBeNull();
      // Inbox is a navigated destination too: the rail enters and leaves it by route.
      // The rail's active state is optimistic, so wait for the page itself (the route
      // commit) before clicking Home — the leave handlers key off the committed pathname.
      await rail.getByRole("button", { name: "Inbox", exact: true }).click();
      // Any of the inbox's greetings: before 04:00 local time it says "Up late" (InboxView).
      await expect
        .element(page.getByText(/Good (morning|afternoon|evening)|Up late/))
        .toBeVisible();
      await rail.getByRole("button", { name: "Home", exact: true }).click();
      await expect.poll(() => mounted.router.state.location.pathname).not.toBe("/inbox");
    } finally {
      await mounted.cleanup();
      useRailShellStore.getState().selectPanelItem("home");
    }
  });

  it("carries the rail inside the sidebar sheet at phone width", async () => {
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 540 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("mobile-rail"),
        targetText: "Mobile rail",
      }),
    });
    try {
      await waitForLayout();
      // The shell keeps no left column on phones, so the rail is absent until the sheet opens.
      await expect
        .element(page.getByRole("navigation", { name: "Primary" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Toggle thread sidebar", exact: true }).click();
      const rail = page.getByRole("navigation", { name: "Primary" });
      await expect.element(rail.getByRole("button", { name: "Home", exact: true })).toBeVisible();
      const initialPath = mounted.router.state.location.pathname;
      const moreButton = rail.getByRole("button", { name: "More", exact: true });
      await moreButton.click();
      await expect
        .element(page.getByRole("menuitem", { name: "Settings", exact: true }))
        .toBeVisible();
      await moreButton.click();
      await expect
        .element(page.getByRole("menuitem", { name: "Settings", exact: true }))
        .not.toBeInTheDocument();
      await expect.element(rail.getByRole("button", { name: "Home", exact: true })).toBeVisible();
      expect(mounted.router.state.location.pathname).toBe(initialPath);
      // Customize has no shell slot to anchor to on phones; it opens beside the sheet's rail.
      rail
        .element()
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 24, clientY: 24 }));
      await page.getByRole("menuitem", { name: "Customize", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps absent project pins and drops Space pins saved by older builds", async () => {
    localStorage.setItem(
      "moss:app-settings:v1",
      JSON.stringify({ railShortcuts: ["project:temporarily-absent", "space:void"] }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("rail-pins"),
        targetText: "Rail pins",
      }),
    });
    try {
      await mounted.router.navigate({ to: "/settings" });
      // An old /settings link opens the Settings dialog over the previous screen; close it
      // so the phone rail underneath can be used.
      await expect.poll(() => settingsDialogStore.getState().isOpen).toBe(true);
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => settingsDialogStore.getState().isOpen).toBe(false);
      await waitForLayout();
      // The absent project pin drops out of the rail but stays in the saved list; Spaces
      // were removed, so the saved Space pin renders nothing and leaves no gap.
      const rail = await openPhonePrimaryRail(mounted);
      await expect.element(rail.getByRole("button", { name: "Home", exact: true })).toBeVisible();
      expect(rail.getByRole("button", { name: "Void", exact: true }).elements()).toHaveLength(0);
      expect(
        JSON.parse(localStorage.getItem("moss:app-settings:v1") ?? "{}").railShortcuts,
      ).toEqual(["project:temporarily-absent", "space:void"]);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([
    { destination: "Home", keepsActivity: true },
    { destination: "Project", keepsActivity: false },
  ])(
    "keeps Activity=$keepsActivity when selecting rail $destination",
    async ({ destination, keepsActivity }) => {
      localStorage.setItem(
        "moss:app-settings:v1",
        JSON.stringify({
          hiddenRailItems: [],
          railShortcuts: ["project:project-1"],
        }),
      );
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("rail-activity"),
          targetText: "Rail activity",
        }),
      });
      try {
        const rail = await openPhonePrimaryRail(mounted);
        await page.getByRole("button", { name: "Switch to activity view", exact: true }).click();
        await expect.element(page.getByRole("button", { name: "Activity options" })).toBeVisible();
        await rail.getByRole("button", { name: destination, exact: true }).click();
        if (keepsActivity) {
          await expect
            .element(page.getByRole("button", { name: "Switch to classic view", exact: true }))
            .toBeVisible();
          await expect
            .element(page.getByRole("button", { name: "Activity options" }))
            .toBeVisible();
        } else {
          await expect
            .element(page.getByRole("button", { name: "Switch to activity view", exact: true }))
            .toBeVisible();
          await expect
            .element(page.getByRole("button", { name: "Activity options" }))
            .not.toBeInTheDocument();
        }
      } finally {
        await mounted.cleanup();
        useRailShellStore.setState({ railProjectId: null });
        useRailShellStore.getState().selectPanelItem("home");
      }
    },
  );

  it("creates a new thread from the global chat.new shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
        targetText: "chat shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      useProjectEnvironmentStore.getState().setProjectEnvMode(PROJECT_ID, "worktree");
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const nextPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
      expect(
        useComposerDraftStore.getState().getDraftThread(nextPath.slice(1) as ThreadId),
      ).toMatchObject({ envMode: "worktree", worktreePath: null });
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes a worktree handoff dialog when navigating to a draft thread", async () => {
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        localeOverride: "en",
        environmentPanelDefaultOpen: true,
        showEnvironmentEditor: true,
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("handoff-owner"),
        targetText: "Saved thread handoff",
      }),
    });
    try {
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, OTHER_THREAD_ID, {});
      useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "Destination draft");
      const environmentPanel = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-environment-panel-variant]") ?? null,
        "Unable to find the actual Environment panel for the handoff source.",
      );
      await vi.waitFor(() => {
        expect(environmentPanel.isConnected).toBe(true);
        expect(environmentPanel.getAttribute("aria-hidden")).toBe("false");
        expect(environmentPanel.hasAttribute("inert")).toBe(false);
        const card = environmentPanel.firstElementChild as HTMLElement;
        expect(getComputedStyle(card).opacity).toBe("1");
        expect(card.getBoundingClientRect().width).toBeGreaterThan(0);
        expect(card.getBoundingClientRect().height).toBeGreaterThan(0);
      });
      await expect.element(page.getByRole("button", { name: "Local", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Local", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Hand off to new worktree" }))
        .toBeVisible();
      await page.getByRole("menuitem", { name: "Hand off to new worktree" }).click();
      await expect
        .element(page.getByRole("dialog", { name: "Hand off to worktree" }))
        .toBeVisible();
      await page.getByRole("textbox", { name: "Worktree name" }).fill("source-thread-worktree");
      // Browser/history navigation remains possible while the dialog makes background clicks inert.
      await mounted.router.navigate({ to: "/$threadId", params: { threadId: OTHER_THREAD_ID } });
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
        expect(document.querySelector('[contenteditable="true"]')?.textContent).toBe(
          "Destination draft",
        );
      });
      await expect
        .element(page.getByRole("dialog", { name: "Hand off to worktree" }), { timeout: 2_000 })
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens sidebar threads in place and adds a tab only on request", async () => {
    const thirdId = ThreadId.makeUnsafe("in-place-tab-third");
    let snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("in-place-tabs"),
      targetText: "In place tabs",
    });
    snapshot = addThreadToSnapshot(addThreadToSnapshot(snapshot, OTHER_THREAD_ID), thirdId);
    const titles: Record<string, string> = {
      [THREAD_ID]: "Multiply 31 by 4",
      [OTHER_THREAD_ID]: "Multiply 31 by 5",
      [thirdId]: "Multiply 31 by 6",
    };
    snapshot = {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        titles[thread.id] ? Object.assign({}, thread, { title: titles[thread.id] }) : thread,
      ),
    };
    // A strip saved by an older build (every visited thread kept a tab) still loads as is.
    localStorage.setItem(
      "moss:open-thread-tabs:v1",
      JSON.stringify({ state: { threadIds: [THREAD_ID] }, version: 0 }),
    );
    await useOpenThreadTabsStore.persist.rehydrate();
    useOpenThreadTabsStore.setState({ currentThreadId: null, newTabRequested: false });
    expect(useOpenThreadTabsStore.getState().threadIds).toEqual([THREAD_ID]);
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const strip = () => document.querySelector('nav[aria-label="Open threads"]');
    const sidebarRow = (title: string) =>
      [...document.querySelectorAll<HTMLElement>('[data-thread-item] [role="button"]')].find(
        (row) => row.textContent?.includes(title),
      )!;
    try {
      // One tab is no strip: the header reads as the thread's title.
      await vi.waitFor(() => {
        expect(document.querySelector("[data-open-thread-title]")).not.toBeNull();
        expect(strip()).toBeNull();
      });
      await page.screenshot({ path: "../../../../output/playwright/tabs-in-place-single.png" });

      // A plain sidebar click replaces the thread in the current tab.
      await vi.waitFor(() => expect(sidebarRow("Multiply 31 by 5")).toBeTruthy());
      await userEvent.click(sidebarRow("Multiply 31 by 5"));
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
        expect(useOpenThreadTabsStore.getState().threadIds).toEqual([OTHER_THREAD_ID]);
      });
      await userEvent.click(sidebarRow("Multiply 31 by 6"));
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(`/${thirdId}`);
        expect(useOpenThreadTabsStore.getState().threadIds).toEqual([thirdId]);
      });
      expect(strip()).toBeNull();
      expect(document.querySelector("[data-open-thread-title] h2")?.textContent).toBe(
        "Multiply 31 by 6",
      );

      // A middle click opens the thread in a tab of its own beside the current one.
      sidebarRow("Multiply 31 by 5").dispatchEvent(
        new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
      );
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
        expect(useOpenThreadTabsStore.getState().threadIds).toEqual([thirdId, OTHER_THREAD_ID]);
        expect(strip()?.querySelectorAll("[data-surface-tab]")).toHaveLength(2);
      });

      // Back in place: the active tab follows the next sidebar click; the other tab stays.
      await userEvent.click(sidebarRow("Multiply 31 by 4"));
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
        expect(useOpenThreadTabsStore.getState().threadIds).toEqual([thirdId, THREAD_ID]);
      });
      await page.screenshot({ path: "../../../../output/playwright/tabs-in-place-two.png" });

      // The strip's + opens the new chat in a new tab, shown as a tab before its first send.
      await userEvent.click(page.getByRole("button", { name: "New thread in this workspace" }));
      await vi.waitFor(() => {
        const threadIds = useOpenThreadTabsStore.getState().threadIds;
        expect(threadIds).toHaveLength(3);
        expect(threadIds.slice(0, 2)).toEqual([thirdId, THREAD_ID]);
        expect(mounted.router.state.location.pathname).toBe(`/${threadIds[2]}`);
        expect(strip()?.querySelectorAll("[data-surface-tab]")).toHaveLength(3);
      });
      expect(useOpenThreadTabsStore.getState().newTabRequested).toBe(false);
    } finally {
      useOpenThreadTabsStore.setState({ threadIds: [], currentThreadId: null });
      await mounted.cleanup();
    }
  });

  it.each(["saved", "promoted-draft", "terminal"] as const)(
    "reorders a background horizontal tab across navigation and persists the order (%s)",
    async (kind) => {
      const thirdId = ThreadId.makeUnsafe("drag-tab-third");
      let snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("drag-tabs"),
        targetText: "Drag tabs",
      });
      snapshot = addThreadToSnapshot(snapshot, thirdId);
      if (kind !== "promoted-draft") snapshot = addThreadToSnapshot(snapshot, OTHER_THREAD_ID);
      snapshot = {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === thirdId ? Object.assign({}, thread, { title: "Destination tab" }) : thread,
        ),
      };
      const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
      try {
        if (kind === "promoted-draft") {
          useComposerDraftStore.getState().registerDraftThread(OTHER_THREAD_ID, {
            projectId: PROJECT_ID,
          });
          useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID, thirdId] });
          await vi.waitFor(() =>
            expect(
              document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
            ).toHaveLength(2),
          );
          fixture.snapshot = addThreadToSnapshot(fixture.snapshot, OTHER_THREAD_ID);
          useStore.getState().syncServerReadModel(fixture.snapshot);
          useComposerDraftStore.getState().clearDraftThread(OTHER_THREAD_ID);
        } else if (kind === "terminal") {
          useTerminalStateStore.getState().openTerminalThreadPage(OTHER_THREAD_ID);
        }
        useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID, thirdId] });
        await vi.waitFor(() =>
          expect(
            document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
          ).toHaveLength(3),
        );
        await waitForLayout();
        const labels = document.querySelectorAll<HTMLButtonElement>(
          'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
        );
        const source = labels[1]!.getBoundingClientRect();
        const x = source.left + source.width / 2;
        const y = source.top + source.height / 2;
        labels[1]!.dispatchEvent(mousePointerEvent("pointerdown", x, y));
        document.dispatchEvent(mousePointerEvent("pointermove", x + 8, y));
        await waitForLayout();
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
        expect(labels[1]!.getAttribute("aria-current")).toBeNull();
        // Navigation may still arrive while dragging; it must preserve the sortable strip.
        await mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: OTHER_THREAD_ID },
        });
        await vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`),
        );
        const currentLabels = document.querySelectorAll<HTMLButtonElement>(
          'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
        );
        const target = currentLabels[2]!.getBoundingClientRect();
        const targetX = target.left + target.width / 2;
        document.dispatchEvent(mousePointerEvent("pointermove", targetX, y));
        await waitForLayout();
        document.dispatchEvent(mousePointerEvent("pointermove", targetX + 1, y));
        await nextFrame();
        document.dispatchEvent(mousePointerEvent("pointerup", targetX + 1, y));
        await vi.waitFor(() =>
          expect(useOpenThreadTabsStore.getState().threadIds).toEqual([
            THREAD_ID,
            thirdId,
            OTHER_THREAD_ID,
          ]),
        );
        expect(
          JSON.parse(localStorage.getItem("moss:open-thread-tabs:v1")!).state.threadIds,
        ).toEqual([THREAD_ID, thirdId, OTHER_THREAD_ID]);
        await vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`),
        );
        expect(
          document.querySelector('nav[aria-label="Open threads"] button[aria-current="page"]')
            ?.textContent,
        ).toBe("New thread");
        expect(
          [
            ...document.querySelectorAll(
              'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
            ),
          ].map((label) => label.textContent),
        ).toEqual([THREAD_TITLE, "Destination tab", "New thread"]);
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("keeps close-button pointer travel from starting a horizontal tab drag", async () => {
    const snapshot = addThreadToSnapshot(
      createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("drag-close"),
        targetText: "Close a tab",
      }),
      OTHER_THREAD_ID,
    );
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID] });
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
        ).toHaveLength(2),
      );
      const button = document.querySelectorAll<HTMLButtonElement>(
        'nav[aria-label="Open threads"] button[aria-label^="Close "]',
      )[0]!;
      await userEvent.hover(button);
      await userEvent.dragAndDrop(button, button, {
        sourcePosition: { x: 12, y: 12 },
        targetPosition: { x: 19, y: 12 },
      });
      await vi.waitFor(
        () => expect(useOpenThreadTabsStore.getState().threadIds).not.toContain(THREAD_ID),
        {
          timeout: 2_000,
        },
      );
      expect(useOpenThreadTabsStore.getState().threadIds).toEqual([OTHER_THREAD_ID]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the thread menu on a tab right-click and closes the tabs its close row names", async () => {
    const thirdId = ThreadId.makeUnsafe("tab-menu-third");
    const snapshot = addThreadToSnapshot(
      addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("tab-menu"),
          targetText: "Tab menu",
        }),
        OTHER_THREAD_ID,
      ),
      thirdId,
    );
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID, thirdId] });
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
        ).toHaveLength(3),
      );
      // The last tab, while the first one is on screen.
      document
        .querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]')[2]!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 320, clientY: 24 }));
      await vi.waitFor(() =>
        expect(contextMenuRows().map((row) => row.textContent)).toEqual(
          expect.arrayContaining(["Rename thread", "Pin thread", "Archive", "Delete"]),
        ),
      );
      // Nothing sits to the right of the last tab, so that row is left out.
      expect(
        contextMenuRows()
          .map((row) => row.textContent)
          .filter((label) => label?.startsWith("Close ")),
      ).toEqual(["Close Tabs to the Left", "Close Other Tabs"]);
      contextMenuRows()
        .find((row) => row.textContent === "Close Tabs to the Left")!
        .click();

      // The thread on screen was among the closed tabs, so the kept tab takes over.
      await vi.waitFor(() =>
        expect(useOpenThreadTabsStore.getState().threadIds).toEqual([thirdId]),
      );
      expect(mounted.router.state.location.pathname).toBe(`/${thirdId}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens an unsent editor draft in place and returns to the saved chat", async () => {
    const consoleError = vi.spyOn(console, "error");
    onTestFinished(() => consoleError.mockRestore());
    useOpenThreadTabsStore.setState({ threadIds: [] });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("editor-draft-return"),
        targetText: "Saved editor chat",
      }),
      initialEntry: `/${THREAD_ID}?view=editor`,
    });
    try {
      // A lone active saved chat still needs no redundant rail tab.
      expect(page.getByRole("button", { name: "Chat 1", exact: true }).elements()).toHaveLength(0);
      const emptyDraftId = ThreadId.makeUnsafe("019f88ab-cdea-7100-8b00-000000000021");
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, emptyDraftId, {});
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: emptyDraftId },
        search: () => ({ view: "editor" as const }),
      });
      await waitForURL(
        mounted.router,
        (path) => path === `/${emptyDraftId}`,
        "The empty editor draft should open in place.",
      );
      // An empty draft opened in place replaces the saved chat with no second tab.
      expect(useOpenThreadTabsStore.getState().threadIds).toEqual([emptyDraftId]);
      expect(page.getByRole("button", { name: "Chat 1", exact: true }).elements()).toHaveLength(0);
      // Returning from an empty/unedited draft drops it cleanly with no leftover tab.
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
        search: () => ({ view: "editor" as const }),
      });
      await waitForURL(
        mounted.router,
        (path) => path === `/${THREAD_ID}`,
        "The saved chat should open again from the empty draft.",
      );
      await vi.waitFor(() =>
        expect(useOpenThreadTabsStore.getState().threadIds).toEqual([THREAD_ID]),
      );
      expect(page.getByRole("button", { name: "Chat 1", exact: true }).elements()).toHaveLength(0);

      // An edited unsent draft opens in place, then keeps its tab when switching back.
      const draftId = ThreadId.makeUnsafe("019f88ab-cdea-7100-8b00-000000000022");
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, draftId, {});
      useComposerDraftStore.getState().setPrompt(draftId, "Keep this unsent prompt");
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: draftId },
        search: () => ({ view: "editor" as const }),
      });
      await vi.waitFor(() =>
        expect(document.querySelector('[contenteditable="true"]')?.textContent).toBe(
          "Keep this unsent prompt",
        ),
      );
      // The draft opened in place of the saved chat, so the rail has no second chat tab yet.
      expect(useOpenThreadTabsStore.getState().threadIds).toEqual([draftId]);
      expect(page.getByRole("button", { name: "Chat 1", exact: true }).elements()).toHaveLength(0);
      // Back to the saved chat the way the sidebar goes there; the edited draft keeps its tab and text.
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
        search: () => ({ view: "editor" as const }),
      });
      await waitForURL(
        mounted.router,
        (path) => path === `/${THREAD_ID}`,
        "The saved chat should open again from the draft.",
      );
      await vi.waitFor(() =>
        expect(useOpenThreadTabsStore.getState().threadIds).toEqual([draftId, THREAD_ID]),
      );
      await expect.element(page.getByRole("button", { name: "Chat 1", exact: true })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Chat 2", exact: true })).toBeVisible();
      expect(mounted.router.state.location.search.view).toBe("editor");
      expect(useComposerDraftStore.getState().draftsByThreadId[draftId]?.prompt).toBe(
        "Keep this unsent prompt",
      );
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
      await waitForLayout();
      expect(
        consoleError.mock.calls.filter((args) =>
          args.some((value) => String(value).includes("Maximum update depth exceeded")),
        ),
        "Opening and switching editor chats must not trigger a render feedback loop.",
      ).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["terminal", "close", "navigation", "navigation-back", "inflight"] as const)(
    "cancels a pending editor chat tab switch after %s",
    async (action) => {
      const laterThreadId = ThreadId.makeUnsafe("editor-tab-later-navigation");
      const snapshot = addThreadToSnapshot(
        addThreadToSnapshot(
          createSnapshotForTargetUser({
            targetMessageId: MessageId.makeUnsafe("editor-tab-cancel"),
            targetText: "Editor chat",
          }),
          OTHER_THREAD_ID,
        ),
        laterThreadId,
      );
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot,
        initialEntry: `/${THREAD_ID}?view=editor`,
      });
      try {
        const laterNavigation =
          action === "navigation" || action === "navigation-back" || action === "inflight";
        useOpenThreadTabsStore.setState({
          threadIds: [THREAD_ID, OTHER_THREAD_ID, ...(laterNavigation ? [laterThreadId] : [])],
        });
        useTerminalStateStore.getState().setTerminalOpen(THREAD_ID, true);
        await expect
          .element(page.getByRole("button", { name: "Terminal", exact: true }))
          .toBeVisible();
        await page.getByRole("button", { name: "Chat 1", exact: true }).click();
        await waitForLayout();
        // Hold deferred activation until the later terminal, close or navigation action.
        const frames: FrameRequestCallback[] = [];
        const animationFrame = vi
          .spyOn(window, "requestAnimationFrame")
          .mockImplementation((callback) => {
            frames.push(callback);
            return frames.length;
          });
        let pressedLaterTab = false;
        let firstNavigation: Promise<void> | null = null;
        if (action === "inflight") {
          const navigate = mounted.router.navigate;
          vi.spyOn(mounted.router, "navigate").mockImplementation((options) => {
            const result = navigate(options);
            if (
              !pressedLaterTab &&
              options.to === "/$threadId" &&
              options.params &&
              typeof options.params === "object" &&
              "threadId" in options.params &&
              (options.params as { threadId?: string }).threadId === OTHER_THREAD_ID
            ) {
              firstNavigation = result;
              // The second click happens after activate returns, before React commits
              // the first route. Use the actual router, without a synthetic loader.
              queueMicrotask(() => {
                pressedLaterTab = true;
                (
                  page
                    .getByRole("button", { name: "Chat 3", exact: true })
                    .element() as HTMLButtonElement
                ).click();
              });
            }
            return result;
          });
        }
        (
          page.getByRole("button", { name: "Chat 2", exact: true }).element() as HTMLButtonElement
        ).click();
        if (action === "terminal") {
          (
            page
              .getByRole("button", { name: "Terminal", exact: true })
              .element() as HTMLButtonElement
          ).click();
        } else if (action === "inflight") {
          const firstFrames = frames.slice();
          for (const callback of firstFrames) callback(performance.now());
          await vi.waitFor(() => expect(pressedLaterTab).toBe(true), { timeout: 2_000 });
          await firstNavigation;
          await new Promise((resolve) => window.setTimeout(resolve, 0));
          frames.splice(0, firstFrames.length);
        } else if (laterNavigation) {
          await mounted.router.navigate({
            to: "/$threadId",
            params: { threadId: laterThreadId },
            search: () => ({ view: "editor" as const }),
          });
          await expect
            .element(page.getByRole("button", { name: "Chat 3", exact: true }))
            .toHaveAttribute("aria-pressed", "true");
          if (action === "navigation-back") {
            await mounted.router.navigate({
              to: "/$threadId",
              params: { threadId: THREAD_ID },
              search: () => ({ view: "editor" as const }),
            });
            expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
            await new Promise((resolve) => window.setTimeout(resolve, 0));
          }
        } else {
          const targetTab = page.getByRole("button", { name: "Chat 2", exact: true }).element();
          const closeButton = targetTab
            .closest("[data-surface-tab]")!
            .querySelector<HTMLButtonElement>("button[aria-label^='Close ']")!;
          closeButton.click();
          await vi.waitFor(() => {
            expect(useOpenThreadTabsStore.getState().threadIds).not.toContain(OTHER_THREAD_ID);
          });
        }
        animationFrame.mockRestore();
        for (const callback of frames) callback(performance.now());
        await new Promise((resolve) => window.setTimeout(resolve, 550));
        expect(mounted.router.state.location.pathname).toBe(
          `/${action === "navigation" || action === "inflight" ? laterThreadId : THREAD_ID}`,
        );
        if (action === "terminal") {
          await expect
            .element(page.getByRole("button", { name: "Terminal", exact: true }))
            .toHaveAttribute("aria-pressed", "true");
        } else if (action === "inflight") {
          expect(
            page
              .getByRole("button", { name: "Chat 3", exact: true })
              .element()
              .getAttribute("aria-pressed"),
          ).toBe("true");
        } else if (action === "navigation-back") {
          expect(
            page
              .getByRole("button", { name: "Chat 1", exact: true })
              .element()
              .getAttribute("aria-pressed"),
          ).toBe("true");
        } else if (action === "close") {
          expect(useOpenThreadTabsStore.getState().threadIds).not.toContain(OTHER_THREAD_ID);
        }
      } finally {
        vi.restoreAllMocks();
        await mounted.cleanup();
      }
    },
  );

  it.each([false, true])(
    "keeps the trailing sidebar PR state accessible and clear of hover actions (pinned: %s)",
    async (pinned) => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("sidebar-pr-chip"),
        targetText: "Review the linked pull request",
      });
      const pr = {
        number: 841,
        title: "Fix session recovery",
        url: "https://github.com/acme/moss/pull/841",
        baseBranch: "main",
        headBranch: "fix/session-recovery",
        state: "open" as const,
        isDraft: false,
        mergeability: "mergeable" as const,
      };
      const previousPins = usePinnedThreadsStore.getState().pinnedThreadIds;
      usePinnedThreadsStore.setState({ pinnedThreadIds: pinned ? [THREAD_ID] : [] });
      onTestFinished(() => {
        usePinnedThreadsStore.setState({ pinnedThreadIds: previousPins });
      });
      const mounted = await mountChatView({
        viewport: { ...DEFAULT_VIEWPORT, width: 1280, height: 800 },
        snapshot: {
          ...snapshot,
          threads: snapshot.threads.map((thread) => ({ ...thread, lastKnownPr: pr })),
        },
      });
      try {
        const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
        // The Recent group renders a duplicate row for the same thread; assert
        // against the canonical (first) instance.
        const row = page.getByRole("button", { name: `Open ${THREAD_TITLE}`, exact: true }).first();
        await vi.waitFor(() =>
          expect(useStore.getState().sidebarThreadSummaryById[THREAD_ID]?.lastKnownPr?.number).toBe(
            841,
          ),
        );
        await expect
          .element(row, { timeout: 2_000 })
          .toHaveAccessibleDescription("#841 PR open: Fix session recovery");
        const rowElement = row.element() as HTMLElement;
        expect(rowElement.querySelector('button[aria-label*="#841"]')).toBeNull();
        const wrapper = sidebar.closest<HTMLElement>('[data-slot="sidebar-wrapper"]')!;
        for (const fontSize of [13, 18]) {
          const scale = getAppTypographyScale(fontSize);
          for (const [token, value] of Object.entries({
            ui: scale.uiPx,
            "ui-lg": scale.uiLgPx,
            "ui-sm": scale.uiSmPx,
            "ui-xs": scale.uiXsPx,
            "ui-meta": scale.uiMetaPx,
          })) {
            document.documentElement.style.setProperty(`--app-font-size-${token}`, `${value}px`);
          }
          for (const width of [208, 320]) {
            wrapper.style.setProperty("--sidebar-width", `${width}px`);
            await vi.waitFor(() =>
              expect(sidebar.getBoundingClientRect().width).toBeCloseTo(width, 0),
            );
            await userEvent.hover(rowElement);
            const actions = rowElement.querySelector<HTMLElement>(
              `[data-testid="thread-hover-actions-${THREAD_ID}"]`,
            )!;
            await vi.waitFor(() => {
              expect(Number(getComputedStyle(actions).opacity)).toBe(1);
              const title = rowElement.querySelector<HTMLElement>(".truncate-fade")!;
              expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(
                actions.getBoundingClientRect().left,
              );
            });
            await userEvent.unhover(rowElement);
          }
        }
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("steps through horizontal tabs with the previous/next tab shortcuts, wrapping at the ends", async () => {
    useOpenThreadTabsStore.setState({ threadIds: [] });
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("tab-shortcuts"),
      targetText: "Tab shortcuts conversation",
    });
    const thirdId = ThreadId.makeUnsafe("tab-shortcuts-third");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(addThreadToSnapshot(snapshot, OTHER_THREAD_ID), thirdId),
    });
    const pressTabShortcut = async (direction: "next" | "previous") => {
      const key = isMacNavigatorPlatform()
        ? direction === "next"
          ? "ArrowRight"
          : "ArrowLeft"
        : direction === "next"
          ? "PageDown"
          : "PageUp";
      await userEvent.keyboard(
        isMacNavigatorPlatform()
          ? `{Meta>}{Control>}{${key}}{/Control}{/Meta}`
          : `{Control>}{${key}}{/Control}`,
      );
    };
    const expectRoute = (threadId: ThreadId) =>
      vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe(`/${threadId}`));
    try {
      useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID, thirdId] });
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll('nav[aria-label="Open threads"] [data-surface-tab]'),
        ).toHaveLength(3),
      );

      document.querySelector<HTMLElement>('[contenteditable="true"]')!.focus();
      await userEvent.keyboard("Unsent source draft");
      await pressTabShortcut("next");
      await expectRoute(OTHER_THREAD_ID);
      await pressTabShortcut("next");
      await expectRoute(thirdId);
      await pressTabShortcut("next");
      await expectRoute(THREAD_ID);
      expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
        "Unsent source draft",
      );
      await pressTabShortcut("previous");
      await expectRoute(thirdId);
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["saved"] as const)(
    "switches horizontal tabs without blanking the header or composer (%s)",
    async (targetKind) => {
      onTestFinished(skipReactDevOwnerStacks());
      useOpenThreadTabsStore.setState({ threadIds: [] });
      let snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("horizontal-tabs"),
        targetText: "Horizontal tabs conversation",
      });
      {
        const source = snapshot.threads[0]!;
        snapshot = {
          ...snapshot,
          threads: [
            ...snapshot.threads,
            {
              ...source,
              id: OTHER_THREAD_ID,
              title: "Other tab",
              session: source.session ? { ...source.session, threadId: OTHER_THREAD_ID } : null,
              messages: source.messages.map((message) => ({
                ...message,
                id: MessageId.makeUnsafe(`other-${message.id}`),
              })),
            },
          ],
        };
      }
      const commits: number[] = [];
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot,
        onRender: (_id, _phase, duration) => commits.push(duration),
      });
      try {
        useComposerDraftStore.getState().setPrompt(THREAD_ID, "Draft in first tab");
        useComposerDraftStore.getState().setPrompt(OTHER_THREAD_ID, "Draft in second tab");
        useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID] });
        await vi.waitFor(() =>
          expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain(
            "Draft in first tab",
          ),
        );
        await waitForLayout();

        const samples = [];
        const storageWrites = vi.spyOn(Storage.prototype, "setItem");
        onTestFinished(() => storageWrites.mockRestore());
        // The opt-in runs the same correctness path for longer; do not add a
        // wall-clock threshold to CI. The first round trip warms both targets.
        const rounds = import.meta.env.VITE_TAB_SWITCH_BENCHMARK === "1" ? 12 : 2;
        for (let index = 0; index < rounds * 2; index += 1) {
          const toSecond = index % 2 === 0;
          const targetId = toSecond ? OTHER_THREAD_ID : THREAD_ID;
          const expectedPrompt = toSecond ? "Draft in second tab" : "Draft in first tab";
          const tabButtons = document.querySelectorAll<HTMLButtonElement>(
            'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
          );
          expect(tabButtons).toHaveLength(2);
          commits.length = 0;
          storageWrites.mockClear();
          const startedAt = performance.now();
          let missingHeaderFrames = 0;
          let missingComposerFrames = 0;
          tabButtons[toSecond ? 1 : 0]!.click();
          let ready = false;
          let domReadyMs: number | null = null;
          while (performance.now() - startedAt < 5_000) {
            await nextFrame();
            const activeTab = document.querySelector(
              'nav[aria-label="Open threads"] button[aria-current="page"]',
            );
            const editor = document.querySelector(
              '[data-chat-composer-form="true"] [contenteditable="true"]',
            );
            if (!activeTab) missingHeaderFrames += 1;
            if (!editor) missingComposerFrames += 1;
            if (
              mounted.router.state.location.pathname === `/${targetId}` &&
              activeTab &&
              editor?.textContent === expectedPrompt &&
              document.querySelector(
                `[data-assistant-message-id="${toSecond ? "other-" : ""}msg-assistant-21"]`,
              )
            ) {
              domReadyMs ??= performance.now() - startedAt;
              const scrollContainer = document.querySelector<HTMLElement>(
                '[data-chat-scroll-container="true"]',
              );
              // A row in the DOM can still be transparent while LegendList
              // settles its initial scroll. Include that work in opening time.
              if (scrollContainer && isTranscriptContentVisible(scrollContainer)) {
                ready = true;
                break;
              }
            }
          }
          expect(ready, "Target tab must show its own composer and transcript").toBe(true);
          samples.push({
            target: targetKind,
            ms: performance.now() - startedAt,
            domReadyMs,
            reactMs: commits.reduce((sum, duration) => sum + duration, 0),
            commits: commits.length,
            tabWrites: storageWrites.mock.calls.filter(
              ([key]) => key === "moss:open-thread-tabs:v1",
            ).length,
            missingHeaderFrames,
            missingComposerFrames,
          });
          await waitForLayout();
        }
        if (import.meta.env.VITE_TAB_SWITCH_BENCHMARK === "1") {
          console.info(`TAB_SWITCH_BENCHMARK ${JSON.stringify({ targetKind, samples })}`);
        }
        expect(samples.every((sample) => sample.missingHeaderFrames === 0)).toBe(true);
        expect(samples.every((sample) => sample.missingComposerFrames === 0)).toBe(true);
        expect(samples.every((sample) => sample.tabWrites === 0)).toBe(true);
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          "Draft in first tab",
        );
        expect(useComposerDraftStore.getState().draftsByThreadId[OTHER_THREAD_ID]?.prompt).toBe(
          "Draft in second tab",
        );
        // Retaining the surrounding composer must not retain another chat's
        // Lexical undo history or route its edits into the destination draft.
        const firstEditor = await waitForComposerEditor();
        await userEvent.click(firstEditor);
        await userEvent.keyboard("{End} private text");
        await vi.waitFor(() =>
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toContain(
            "private text",
          ),
        );
        const secondTab = document.querySelectorAll<HTMLButtonElement>(
          'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
        )[1]!;
        secondTab.click();
        await vi.waitFor(() =>
          expect(document.querySelector('[contenteditable="true"]')?.textContent).toBe(
            "Draft in second tab",
          ),
        );
        const secondEditor = await waitForComposerEditor();
        await userEvent.click(secondEditor);
        await userEvent.keyboard(
          isMacNavigatorPlatform() ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
        );
        await waitForLayout();
        expect(secondEditor.textContent).toBe("Draft in second tab");
        expect(useComposerDraftStore.getState().draftsByThreadId[OTHER_THREAD_ID]?.prompt).toBe(
          "Draft in second tab",
        );
      } finally {
        await mounted.cleanup();
        useOpenThreadTabsStore.setState({ threadIds: [] });
      }
    },
  );

  it("closing the last visible tab returns to an unsent draft hidden from the strip", async () => {
    useOpenThreadTabsStore.setState({ threadIds: [] });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("last-tab-hidden-draft"),
        targetText: "Completed conversation",
      }),
    });
    try {
      await waitForLayout();
      const draftId = ThreadId.makeUnsafe("hidden-unsent-draft");
      useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, draftId, {});
      useComposerDraftStore.getState().setPrompt(draftId, "Unsent text behind the only tab");
      // The draft is open but has no tab, so the saved chat is the last one in the strip.
      useOpenThreadTabsStore.setState({ threadIds: [draftId, THREAD_ID] });
      // A lone tab shows no strip (so no X); the close-tab shortcut still closes it.
      await waitForElement(
        () => document.querySelector("[data-open-thread-title]"),
        "The lone tab should read as the thread's title.",
      );
      await userEvent.keyboard(
        isMacNavigatorPlatform() ? "{Meta>}w{/Meta}" : "{Control>}w{/Control}",
      );
      await waitForURL(
        mounted.router,
        (path) => path === `/${draftId}`,
        "Closing the last visible tab should return to the open draft.",
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[draftId]?.prompt).toBe(
        "Unsent text behind the only tab",
      );
      expect(useOpenThreadTabsStore.getState().threadIds).not.toContain(THREAD_ID);
    } finally {
      await mounted.cleanup();
      useOpenThreadTabsStore.setState({ threadIds: [] });
    }
  });

  it.each(["home", "project"] as const)(
    "closing the last %s tab opens a fresh draft in the same project",
    async (surface) => {
      useOpenThreadTabsStore.setState({ threadIds: [] });
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("last-tab-close"),
        targetText: "Completed conversation",
      });
      const projectId = surface === "home" ? HOME_PROJECT_ID : PROJECT_ID;
      const staleDraftId = ThreadId.makeUnsafe("closed-unsent-draft");
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot:
          surface === "home" ? withActiveHomeChatThread(snapshot) : withHomeChatProject(snapshot),
        configureFixture: (nextFixture) => {
          nextFixture.welcome = {
            ...nextFixture.welcome,
            homeDir: "/Users/tester",
            chatWorkspaceRoot: "/Users/tester/Documents/Moss",
          };
        },
      });
      try {
        await waitForLayout();
        useComposerDraftStore.getState().setProjectDraftThreadId(projectId, staleDraftId, {});
        useComposerDraftStore.getState().setPrompt(staleDraftId, "Unsent text from a closed tab");
        useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID] });
        useProjectEnvironmentStore.getState().setProjectEnvMode(projectId, "worktree");
        // A lone tab shows no strip (so no X); the close-tab shortcut still closes it.
        await waitForElement(
          () => document.querySelector("[data-open-thread-title]"),
          "The lone tab should read as the thread's title.",
        );
        await userEvent.keyboard(
          isMacNavigatorPlatform() ? "{Meta>}w{/Meta}" : "{Control>}w{/Control}",
        );
        await vi.waitFor(() => {
          const nextId = mounted.router.state.location.pathname.slice(1) as ThreadId;
          expect(nextId).not.toBe(THREAD_ID);
          expect(nextId).not.toBe(staleDraftId);
          const state = useComposerDraftStore.getState();
          expect(state.getDraftThread(nextId)?.projectId).toBe(projectId);
          expect(state.getDraftThread(nextId)?.envMode).toBe(
            surface === "home" ? "local" : "worktree",
          );
          expect(state.draftsByThreadId[nextId]?.prompt ?? "").toBe("");
          expect(useOpenThreadTabsStore.getState().threadIds).not.toContain(THREAD_ID);
        });
      } finally {
        await mounted.cleanup();
        useOpenThreadTabsStore.setState({ threadIds: [] });
      }
    },
  );

  it("waits for a completed click before switching tabs without remounting the strip", async () => {
    useOpenThreadTabsStore.setState({ threadIds: [] });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(
        createSnapshotForTargetUser({
          targetMessageId: MessageId.makeUnsafe("tab-switch-target"),
          targetText: "Conversation behind the first tab",
        }),
        OTHER_THREAD_ID,
      ),
    });
    try {
      await waitForLayout();
      // The first visit to a saved chat must keep the header mounted.
      useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID] });
      const strip = await waitForElement<HTMLElement>(
        () => document.querySelector('nav[aria-label="Open threads"]'),
        "The rail chat header should show the open-thread strip.",
      );
      const targetTab = await waitForElement<HTMLButtonElement>(
        () => strip.querySelector('button[title="New thread"]'),
        "The saved thread should have a tab.",
      );
      let stripLeftDocument = false;
      const observer = new MutationObserver(() => {
        if (!strip.isConnected) stripLeftDocument = true;
      });
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        targetTab.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }),
        );
        await waitForLayout();
        expect(targetTab.getAttribute("aria-current")).toBeNull();
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);

        targetTab.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
        targetTab.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }),
        );
        await waitForLayout();
        expect(targetTab.getAttribute("aria-current")).toBeNull();
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);

        await userEvent.click(targetTab);
        await Promise.resolve();
        expect(targetTab.getAttribute("aria-current")).toBe("page");

        await vi.waitFor(() =>
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`),
        );
        await waitForElement(
          () => document.querySelector('[data-testid="empty-landing-heading"]'),
          "The empty thread's landing should render.",
        );
        await waitForLayout();
        expect(stripLeftDocument).toBe(false);
        expect(targetTab.getAttribute("aria-current")).toBe("page");
      } finally {
        observer.disconnect();
      }
    } finally {
      await mounted.cleanup();
      useOpenThreadTabsStore.setState({ threadIds: [] });
    }
  });

  it("reveals an opened transcript once its end scroll lands, not after the list's fallback delay", async () => {
    onTestFinished(skipReactDevOwnerStacks());
    useOpenThreadTabsStore.setState({ threadIds: [] });
    const base = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("transcript-reveal"),
      targetText: "Transcript reveal conversation",
    });
    const source = base.threads[0]!;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...base,
        threads: [
          source,
          {
            ...source,
            id: OTHER_THREAD_ID,
            title: "Other tab",
            session: source.session ? { ...source.session, threadId: OTHER_THREAD_ID } : null,
            messages: source.messages.map((message) =>
              Object.assign({}, message, { id: MessageId.makeUnsafe(`other-${message.id}`) }),
            ),
          },
        ],
      },
    });
    try {
      useOpenThreadTabsStore.setState({ threadIds: [THREAD_ID, OTHER_THREAD_ID] });
      await waitForLayout();
      const scrollToVisibleMs: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const toSecond = index % 2 === 0;
        const targetId = toSecond ? OTHER_THREAD_ID : THREAD_ID;
        const tabButtons = document.querySelectorAll<HTMLButtonElement>(
          'nav[aria-label="Open threads"] [data-surface-tab] > button:not([aria-label])',
        );
        let scrolledAt: number | null = null;
        const onScroll = (event: Event) => {
          if ((event.target as HTMLElement | null)?.dataset?.chatScrollContainer === "true") {
            scrolledAt ??= performance.now();
          }
        };
        document.addEventListener("scroll", onScroll, { capture: true });
        const startedAt = performance.now();
        tabButtons[toSecond ? 1 : 0]!.click();
        let visibleAt: number | null = null;
        let distanceFromBottomPx: number | null = null;
        while (performance.now() - startedAt < 5_000) {
          await nextFrame();
          const scrollContainer = document.querySelector<HTMLElement>(
            '[data-chat-scroll-container="true"]',
          );
          if (
            mounted.router.state.location.pathname === `/${targetId}` &&
            scrollContainer?.querySelector(
              `[data-assistant-message-id="${toSecond ? "other-" : ""}msg-assistant-21"]`,
            ) &&
            isTranscriptContentVisible(scrollContainer)
          ) {
            visibleAt = performance.now();
            distanceFromBottomPx =
              scrollContainer.scrollHeight -
              scrollContainer.clientHeight -
              scrollContainer.scrollTop;
            break;
          }
        }
        document.removeEventListener("scroll", onScroll, { capture: true });
        expect(visibleAt, "The opened transcript must become visible").not.toBeNull();
        // Revealing early must not expose a transcript that is not at its end yet.
        expect(distanceFromBottomPx).toBeLessThanOrEqual(1);
        expect(scrolledAt, "Opening a transcript scrolls it to its end").not.toBeNull();
        scrollToVisibleMs.push(visibleAt! - scrolledAt!);
        await waitForLayout();
      }
      // The list hides its rows until its initial end scroll counts as finished. Its target
      // sits past what the scroller can reach (footer and bottom padding), so without the
      // native-end check in the @legendapp/list patch that only happens on a fixed 100 ms
      // fallback: about 80 ms here, against one frame with it. The median keeps one slow
      // frame on a busy worker from deciding.
      const median = scrollToVisibleMs.toSorted((left, right) => left - right)[2]!;
      expect(median, JSON.stringify(scrollToVisibleMs)).toBeLessThan(50);
    } finally {
      await mounted.cleanup();
      useOpenThreadTabsStore.setState({ threadIds: [] });
    }
  });

  it("parks a home-chat draft and opens an empty one when chat.newChat is reused after a thread switch", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withActiveHomeChatThread(
        addThreadToSnapshot(
          createSnapshotForTargetUser({
            targetMessageId: "msg-user-home-draft-shortcut-switch" as MessageId,
            targetText: "home draft shortcut switch target",
          }),
          OTHER_THREAD_ID,
        ),
      ),
      configureFixture: (nextFixture) => {
        nextFixture.welcome = {
          ...nextFixture.welcome,
          homeDir: "/Users/tester",
          chatWorkspaceRoot: "/Users/tester/Documents/Moss",
          studioWorkspaceRoot: "/Users/tester/Documents/Moss/Studio",
        };
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.newChat",
              shortcut: {
                key: "n",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: true,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      const dispatchNewChatShortcut = () => {
        const useMetaForMod = isMacNavigatorPlatform();
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "n",
            metaKey: useMetaForMod,
            ctrlKey: !useMetaForMod,
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      const newThreadPath = await triggerThreadShortcutUntilPath(
        mounted.router,
        dispatchNewChatShortcut,
        (path) => UUID_ROUTE_RE.test(path),
        "chat.newChat should route to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      // Type a draft in the new home chat
      const prompt = "draft typed via chat.newChat";
      useComposerDraftStore.getState().setPrompt(newThreadId, prompt);
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(
            prompt,
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      // Switch to another thread and come back via the same shortcut
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: OTHER_THREAD_ID },
      });
      await waitForLayout();
      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname).toBe(`/${OTHER_THREAD_ID}`);
        },
        { timeout: 8_000, interval: 16 },
      );

      const returnedPath = await triggerThreadShortcutUntilPath(
        mounted.router,
        dispatchNewChatShortcut,
        (path) => UUID_ROUTE_RE.test(path) && path !== newThreadPath,
        "chat.newChat should open a fresh draft thread UUID, not the unsent one.",
      );
      const freshThreadId = returnedPath.slice(1) as ThreadId;
      await waitForLayout();
      expect(useComposerDraftStore.getState().draftsByThreadId[freshThreadId]?.prompt ?? "").toBe(
        "",
      );
      expect((await waitForComposerEditor()).textContent ?? "").not.toContain(prompt);

      // The unsent draft is parked on its own thread with its text.
      expect(useComposerDraftStore.getState().getDraftThread(newThreadId)).not.toBeNull();
      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]?.prompt).toBe(prompt);
    } finally {
      await mounted.cleanup();
    }
  });

  it("localizes zh-CN sidebar empty-state and toggle accessible names", async () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
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
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      await expect.element(page.getByText("暂无对话", { exact: true })).toBeInTheDocument();
      expect(
        Array.from(document.querySelectorAll<HTMLElement>('[data-translation-skip="true"]')).some(
          (element) => element.textContent?.trim() === "Project",
        ),
      ).toBe(true);
      const activityToggle = page.getByRole("button", { name: "切换到活动视图" });
      await expect.element(activityToggle).toHaveAttribute("aria-pressed", "false");
      await expect
        .element(page.getByRole("button", { name: "仅保留当前项目展开" }))
        .toBeInTheDocument();

      await activityToggle.click();
      await expect
        .element(page.getByRole("button", { name: "切换到经典视图" }))
        .toHaveAttribute("aria-pressed", "true");
    } finally {
      await mounted.cleanup();
    }
  });

  it("names zh-CN rail destinations with the Codex terms, not the 已定时 status", async () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("zh-cn-scheduled-rail"),
        targetText: "zh-CN scheduled rail",
      }),
    });
    // Production installs the DOM localizer from main.tsx, which is what maps a
    // bare "Scheduled" to the snoozed/lifecycle status 已定时.
    installZhCnUiLocalization();

    try {
      const rail = page.getByRole("navigation", { name: "主导航", exact: true });
      await expect.element(rail).toBeVisible();
      for (const name of ["首页", "资料空间", "定时任务", "图像", "收信箱"]) {
        await expect.element(rail.getByRole("button", { name, exact: true })).toBeVisible();
      }
      await expect
        .element(rail.getByRole("button", { name: "已定时", exact: true }))
        .not.toBeInTheDocument();
      await rail.getByRole("button", { name: "定时任务", exact: true }).click();
      await expect.poll(() => mounted.router.state.location.pathname).toBe("/automations");
    } finally {
      uninstallZhCnUiLocalization();
      await mounted.cleanup();
    }
  });

  it("names a Codex chat's sidebar row in Chinese whatever its title says (walk N12-5)", async () => {
    // The walk's Codex chat: its title is the first prompt, a sentence with file names in it,
    // which the page's translation never caught, so a screen reader heard 「Open 帮我看看…」.
    const title =
      "帮我看看这个项目，读一下说明，给 index.js 加减法和乘法，再看看 missing.txt [[WALK:FULL]]";
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("zh-cn-sidebar-row-name"),
      targetText: title,
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: { ...snapshot, threads: snapshot.threads.map((thread) => ({ ...thread, title })) },
    });
    installZhCnUiLocalization();

    try {
      await expect
        .element(page.getByRole("button", { name: `打开 ${title}`, exact: true }).first())
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: `Open ${title}`, exact: true }))
        .not.toBeInTheDocument();
    } finally {
      uninstallZhCnUiLocalization();
      await mounted.cleanup();
    }
  });

  it("keeps the zh-CN rail More menu, pinned plugin shortcuts and Help wired to the sidebar", async () => {
    // Regression guard: a rebase once dropped this wiring from Sidebar while the
    // AppRailMoreMenu component tests stayed green.
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
    localStorage.setItem(
      "moss:rail-plugins:v1",
      JSON.stringify({
        anonymous: {
          pinned: [{ id: "figma@local", name: "Figma", description: "Design files" }],
          recent: [],
        },
      }),
    );
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.makeUnsafe("zh-cn-rail-more"),
        targetText: "zh-CN rail More",
      }),
    });
    installZhCnUiLocalization();

    try {
      const rail = page.getByRole("navigation", { name: "主导航", exact: true });
      await expect.element(rail).toBeVisible();
      await expect
        .element(rail.getByRole("button", { name: "代码审查", exact: true }))
        .toBeVisible();
      await expect.element(rail.getByRole("button", { name: "插件", exact: true })).toBeVisible();
      await expect.element(rail.getByRole("button", { name: "Figma", exact: true })).toBeVisible();
      for (const name of ["Pull requests", "Images", "Plugins"]) {
        await expect
          .element(rail.getByRole("button", { name, exact: true }))
          .not.toBeInTheDocument();
      }

      await rail.getByRole("button", { name: "更多", exact: true }).click();
      for (const name of ["项目", "图像", "插件", "代码审查"]) {
        await expect.element(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
      }
      await expect.element(page.getByText("常用插件", { exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: "从侧边栏取消固定: 定时任务", exact: true }))
        .toBeInTheDocument();

      await page.getByRole("menuitem", { name: "帮助", exact: true }).click();
      for (const name of ["按键绑定", "发送反馈", "完整发行说明"]) {
        await expect.element(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
      }
      // Docs wait for Moss's help site (MOSS_HELP_SITE_URL), so Help leaves the entry out.
      expect(page.getByRole("menuitem", { name: "文档", exact: true }).elements()).toHaveLength(0);
      await page.getByRole("menuitem", { name: "按键绑定", exact: true }).click();
      await expect.poll(() => settingsDialogStore.getState().isOpen).toBe(true);
      expect(settingsDialogStore.getState().request).toMatchObject({ section: "shortcuts" });
      closeSettings();
    } finally {
      uninstallZhCnUiLocalization();
      localStorage.removeItem("moss:rail-plugins:v1");
      await mounted.cleanup();
    }
  });

  it("exposes Moss visible composer and session-control parity selectors", async () => {
    const readyMounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-moss-visible-composer-parity" as MessageId,
        targetText: "moss visible composer parity target",
      }),
    });

    try {
      const composerForm = await waitForElement(
        () =>
          document.querySelector<HTMLFormElement>(
            'form[data-chat-composer-form="true"][data-moss-visible-composer-shell="true"][data-moss-visible-session-scope="true"]',
          ),
        "Unable to find Moss visible composer shell.",
      );
      expect(composerForm.dataset.mossVisibleThreadId).toBe(String(THREAD_ID));
      expect(composerForm.dataset.mossVisibleProvider).toBe("codex");
      expect(composerForm.dataset.mossVisibleProviderInstance).toBe("codex");
      expect(composerForm.dataset.mossVisibleModel).toBe("gpt-5");
      expect(composerForm.dataset.mossVisibleSessionStatus).toBe("ready");
      expect(composerForm.dataset.mossVisibleSendPhase).toBe("idle");
      expect(composerForm.dataset.mossVisibleSendOutcome).toBe("idle");

      expect(document.querySelector("[data-moss-visible-composer-controls='true']")).toBeTruthy();
      expect(document.querySelector("[data-moss-visible-composer-leading='true']")).toBeTruthy();
      expect(document.querySelector("[data-moss-visible-composer-actions='true']")).toBeTruthy();
      // MERGE-ADAPT(2026-10-08): upstream replaced Moss's ComposerExtrasMenu with the
      // trigger + lazy ComposerExtrasPanel, so the hidden attachment input only exists
      // once the extras panel is open; the control marker lives on the trigger itself.
      const attachmentControl = document.querySelector<HTMLButtonElement>(
        "[data-moss-visible-attachment-control='true']",
      );
      expect(attachmentControl).toBeTruthy();
      attachmentControl!.click();
      await waitForElement(
        () => document.querySelector<HTMLElement>("[data-moss-visible-attachment-input='true']"),
        "Unable to find Moss visible attachment input in the extras panel.",
      );

      const modelControl = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-moss-visible-model-reasoning-control]"),
        "Unable to find Moss visible model or reasoning control.",
      );
      expect(modelControl.dataset.mossVisibleModelReasoningControl).toMatch(
        /^(combined|model|reasoning)$/u,
      );

      const sendControl = await waitForElement(
        () => document.querySelector<HTMLButtonElement>("[data-moss-visible-send-control='true']"),
        "Unable to find Moss visible send control.",
      );
      expect(sendControl.disabled).toBe(true);
      expect(sendControl.dataset.mossVisibleSendState).toBe("empty");
      expect(document.querySelector("[data-moss-visible-stop-control='true']")).toBeNull();
    } finally {
      await readyMounted.cleanup();
    }
  });

  it("exposes Moss visible native shell access affordances outside the control-plane tab set", async () => {
    setFeatureFlagEnabled("show-moss-control-plane", true);

    const readyMounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-moss-visible-native-shell-access" as MessageId,
        targetText: "moss visible native shell access target",
      }),
    });

    try {
      const strip = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-moss-native-shell-access='true']"),
        "Unable to find Moss native shell access strip.",
      );
      expect(strip.dataset.mossNativeShellThreadId).toBe(String(THREAD_ID));
      expect(strip.dataset.mossNativeShellProvider).toBe("codex");
      expect(strip.dataset.mossNativeShellSessionStatus).toBe("ready");
      expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
      expect(document.querySelector("[data-moss-control-plane]")).toBeTruthy();

      const sessionsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "[data-moss-native-session-list-access='true'][data-moss-native-shell-surface='sessions']",
          ),
        "Unable to find Moss native sessions access.",
      );
      const eventsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "[data-moss-native-normalized-event-timeline-access='true'][data-moss-native-shell-surface='events']",
          ),
        "Unable to find Moss native normalized event access.",
      );
      const launchButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "[data-moss-native-launch-plan-access='true'][data-moss-native-shell-surface='launch-plan']",
          ),
        "Unable to find Moss native launch-plan access.",
      );
      const ledgerButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "[data-moss-native-loop-ledger-access='true'][data-moss-native-shell-surface='ledger']",
          ),
        "Unable to find Moss native ledger access.",
      );

      sessionsButton.click();
      await vi.waitFor(() => {
        expect(document.querySelector("[data-moss-control-plane-sessions]")).toBeTruthy();
        expect(sessionsButton.dataset.activeSurface).toBe("true");
        expect(strip.dataset.mossNativeActiveSurface).toBe("sessions");
        expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
      });

      launchButton.click();
      await vi.waitFor(() => {
        expect(document.querySelector("[data-moss-control-plane-launch-plan]")).toBeTruthy();
        expect(launchButton.dataset.activeSurface).toBe("true");
        expect(strip.dataset.mossNativeActiveSurface).toBe("launch-plan");
        expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
      });

      ledgerButton.click();
      await vi.waitFor(() => {
        expect(document.querySelector("[data-moss-control-plane-ledger]")).toBeTruthy();
        expect(ledgerButton.dataset.activeSurface).toBe("true");
        expect(strip.dataset.mossNativeActiveSurface).toBe("ledger");
        expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
      });

      eventsButton.click();
      await vi.waitFor(() => {
        expect(document.querySelector("[data-moss-control-plane-events]")).toBeTruthy();
        expect(eventsButton.dataset.activeSurface).toBe("true");
        expect(strip.dataset.mossNativeActiveSurface).toBe("events");
        expect(document.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
      });
    } finally {
      await readyMounted.cleanup();
    }
  });

  it("enables the Moss product shell from an explicit route toggle", async () => {
    setFeatureFlagEnabled("show-moss-control-plane", false);
    setFeatureFlagEnabled("moss-product-shell-default", false);

    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      initialEntry: `/${THREAD_ID}?mossShell=1`,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-moss-product-route-toggle" as MessageId,
        targetText: "moss product route toggle target",
      }),
    });

    try {
      const strip = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-moss-native-shell-access='true']"),
        "Unable to find Moss native shell access strip from route toggle.",
      );
      expect(strip.dataset.mossShellProductizationSource).toBe("route-toggle");
      expect(strip.dataset.mossShellProductizationMode).toBe("explicit-toggle");
      expect(strip.dataset.mossNativeShellThreadId).toBe(String(THREAD_ID));
      expect(document.querySelector("[data-moss-product-shell='true']")).toBeTruthy();
      expect(
        document.querySelector(
          "[data-chat-composer-form='true'][data-moss-product-shell-composer='true']",
        ),
      ).toBeTruthy();
      expect(
        document.querySelector(
          "[data-moss-control-plane][data-moss-product-shell-control-plane='true']",
        ),
      ).toBeTruthy();
      expect(
        document.querySelector(
          "[data-moss-control-plane-events][data-moss-product-shell-events-viewport='true']",
        ),
      ).toBeTruthy();
      expect(
        document.querySelector("[data-moss-native-normalized-event-timeline-access='true']"),
      ).toBeTruthy();
      expect(document.querySelector("[data-moss-native-launch-plan-access='true']")).toBeTruthy();
      expect(document.querySelector("[data-moss-native-loop-ledger-access='true']")).toBeTruthy();
    } finally {
      await mounted.cleanup();
    }
  });

  it("enables the Moss product shell from the product-default placement switch", async () => {
    setFeatureFlagEnabled("show-moss-control-plane", false);
    setFeatureFlagEnabled("moss-product-shell-default", true);

    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      initialEntry: `/${THREAD_ID}`,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-moss-product-default" as MessageId,
        targetText: "moss product default placement target",
      }),
    });

    try {
      const strip = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-moss-native-shell-access='true']"),
        "Unable to find Moss native shell access strip from product-default placement.",
      );
      expect(strip.dataset.mossShellProductizationSource).toBe("product-default");
      expect(strip.dataset.mossShellProductizationMode).toBe("product-default");
      expect(strip.dataset.mossNativeShellThreadId).toBe(String(THREAD_ID));
      expect(window.location.href).not.toContain("mossShell=1");
      expect(document.querySelector("[data-moss-product-shell='true']")).toBeTruthy();
      expect(
        document.querySelector(
          "[data-chat-composer-form='true'][data-moss-product-shell-composer='true']",
        ),
      ).toBeTruthy();
      expect(
        document.querySelector(
          "[data-moss-control-plane][data-moss-product-shell-control-plane='true']",
        ),
      ).toBeTruthy();
      expect(
        document.querySelector(
          "[data-moss-control-plane-events][data-moss-product-shell-events-viewport='true']",
        ),
      ).toBeTruthy();
      expect(
        document.querySelector("[data-moss-native-normalized-event-timeline-access='true']"),
      ).toBeTruthy();
      expect(document.querySelector("[data-moss-native-launch-plan-access='true']")).toBeTruthy();
      expect(document.querySelector("[data-moss-native-loop-ledger-access='true']")).toBeTruthy();
    } finally {
      setFeatureFlagEnabled("moss-product-shell-default", false);
      await mounted.cleanup();
    }
  });
  it("runs Moss visible real-provider style shell interaction sequencing", async () => {
    setFeatureFlagEnabled("show-moss-control-plane", true);
    const nativeApi = installMossVisibleSequenceNativeApi();
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-moss-visible-sequence" as MessageId,
        targetText: "moss visible provider sequence target",
        sessionStatus: "running",
      }),
    });

    const expectActiveThreadShell = () => {
      const composer = document.querySelector<HTMLFormElement>(
        `form[data-chat-composer-form="true"][data-moss-visible-thread-id="${String(THREAD_ID)}"]`,
      );
      expect(composer).toBeTruthy();
      const strip = document.querySelector<HTMLElement>("[data-moss-native-shell-access='true']");
      expect(strip?.dataset.mossNativeShellThreadId).toBe(String(THREAD_ID));
      expect(strip?.dataset.mossNativeShellProvider).toBe("codex");
    };

    try {
      const strip = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-moss-native-shell-access='true']"),
        "Unable to find Moss native shell access strip for sequence test.",
      );
      expect(strip.dataset.mossNativeShellSessionStatus).toBe("running");
      expectActiveThreadShell();

      await vi.waitFor(
        () => {
          expect(nativeApi.listSessions).toHaveBeenCalled();
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='active-thread'][data-subscription-thread-id='${String(
                THREAD_ID,
              )}'][data-subscription-event-count='6']`,
            ),
          ).toBeTruthy();
          expect(document.querySelectorAll("[data-moss-normalized-row]")).toHaveLength(6);
          expect(
            document.querySelector(
              "[data-moss-normalized-row][data-event-type='text'][data-text-stream-kind='assistant_text']",
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              "[data-moss-normalized-row][data-event-type='tool-result'][data-tool-lifecycle-id='moss-visible-sequence-tool'][data-tool-lifecycle-state='succeeded'][data-tool-lifecycle-has-call='true'][data-tool-lifecycle-has-result='true']",
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              "[data-event-id='moss-visible-sequence-normalized-4'] [data-moss-normalized-permission-action-shell][data-permission-action-status='ready'][data-permission-action-enabled='true']",
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              "[data-moss-normalized-row][data-event-type='usage'][data-usage-model='gpt-5.3-codex'][data-usage-used-tokens='1468']",
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              "[data-moss-normalized-row][data-event-type='finish'][data-finish-state='completed'][data-finish-stop-reason='stop']",
            ),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(document.body.textContent ?? "").not.toContain("codex.raw.sequence");
      expect(nativeApi.subscribeNormalizedSessionEvents).toHaveBeenCalledWith(
        { threadId: THREAD_ID },
        expect.any(Function),
      );
      expect(nativeApi.normalizedEventSubscriptions).toHaveLength(1);

      nativeApi.emitNormalizedEvent(
        createMossVisibleSequenceEvent(
          "text",
          {
            text: "moss visible sequence live normalized update",
            streamKind: "assistant_text",
            launchPlanHash: "sha256:moss-visible-sequence-primary",
            rawSource: "codex.raw.sequence.live-text",
          },
          8,
        ),
      );
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='active-thread'][data-subscription-thread-id='${String(
                THREAD_ID,
              )}'][data-subscription-event-count='7']`,
            ),
          ).toBeTruthy();
          expect(document.querySelectorAll("[data-moss-normalized-row]")).toHaveLength(7);
          expect(document.body.textContent ?? "").toContain(
            "moss visible sequence live normalized update",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.body.textContent ?? "").not.toContain("codex.raw.sequence.live-text");

      const approveButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "[data-event-id='moss-visible-sequence-normalized-4'] [data-permission-action-intent='approve']",
          ),
        "Unable to find Moss sequence approve action.",
      );
      approveButton.click();
      await vi.waitFor(
        () => {
          expect(nativeApi.submitPermissionAction).toHaveBeenCalledWith({
            threadId: THREAD_ID,
            sessionId: MOSS_SEQUENCE_SESSION_ID,
            normalizedEventId: EventId.makeUnsafe("moss-visible-sequence-normalized-4"),
            intent: "approve",
          });
          expect(
            document.querySelector(
              "[data-event-id='moss-visible-sequence-normalized-4'] [data-moss-normalized-permission-action-shell][data-permission-action-status='accepted'][data-permission-action-enabled='false']",
            ),
          ).toBeTruthy();
          expect(document.body.textContent ?? "").toContain("Moss sequence permission accepted.");
        },
        { timeout: 8_000, interval: 16 },
      );
      expectActiveThreadShell();

      const sessionsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>("[data-moss-native-shell-surface='sessions']"),
        "Unable to find Moss native sessions button.",
      );
      sessionsButton.click();
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-moss-control-plane-sessions]")).toBeTruthy();
          expect(
            document.querySelector(
              "[data-moss-control-plane-session-list][data-source='runtime'][data-status='ready']",
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              `[data-moss-session-list-row][data-thread-id='${String(
                OTHER_THREAD_ID,
              )}'][data-provider='Claude'][data-session-status='ready']`,
            ),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      expectActiveThreadShell();

      const secondarySessionRow = document.querySelector<HTMLButtonElement>(
        `[data-moss-session-list-row][data-thread-id='${String(OTHER_THREAD_ID)}']`,
      );
      expect(secondarySessionRow).toBeTruthy();
      secondarySessionRow!.click();
      await vi.waitFor(
        () => {
          expect(
            document.querySelector(
              `[data-moss-session-list-row][data-thread-id='${String(
                OTHER_THREAD_ID,
              )}'][data-selected-session='true']`,
            ),
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      expectActiveThreadShell();

      const eventsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>("[data-moss-native-shell-surface='events']"),
        "Unable to find Moss native events button.",
      );
      eventsButton.click();
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-moss-control-plane-events]")).toBeTruthy();
          expect(
            document.querySelector(
              `[data-moss-normalized-session-scope][data-scope-thread-id='${String(
                OTHER_THREAD_ID,
              )}'][data-scope-active-thread='false']`,
            ),
          ).toBeTruthy();
          expect(
            document.querySelector(
              `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='selected-session'][data-subscription-thread-id='${String(
                OTHER_THREAD_ID,
              )}'][data-subscription-event-count='1']`,
            ),
          ).toBeTruthy();
          expect(document.querySelectorAll("[data-moss-normalized-row]")).toHaveLength(1);
          expect(document.body.textContent ?? "").toContain(
            "moss visible sequence secondary session text",
          );
          expect(document.body.textContent ?? "").not.toContain(
            "moss visible sequence live normalized update",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.body.textContent ?? "").not.toContain("claude.raw.sequence");
      expect(nativeApi.subscribeNormalizedSessionEvents).toHaveBeenCalledWith(
        { threadId: OTHER_THREAD_ID },
        expect.any(Function),
      );
      expectActiveThreadShell();

      const launchButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            "[data-moss-native-shell-surface='launch-plan']",
          ),
        "Unable to find Moss native launch-plan button.",
      );
      launchButton.click();
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-moss-control-plane-launch-plan]")).toBeTruthy();
          expect(nativeApi.getLaunchPlan).toHaveBeenCalledWith({ threadId: OTHER_THREAD_ID });
          expect(document.body.textContent ?? "").toContain(
            "sha256:moss-visible-sequence-secondary",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      expectActiveThreadShell();

      const ledgerButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>("[data-moss-native-shell-surface='ledger']"),
        "Unable to find Moss native ledger button.",
      );
      ledgerButton.click();
      await vi.waitFor(
        () => {
          expect(document.querySelector("[data-moss-control-plane-ledger]")).toBeTruthy();
          expect(nativeApi.getLoopLedgerDashboardSnapshot).toHaveBeenCalledWith({
            threadId: THREAD_ID,
          });
          expect(document.body.textContent ?? "").toContain("moss-task-0080");
          expect(document.body.textContent ?? "").toContain(
            "Gate real-provider shell interaction sequencing",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      expectActiveThreadShell();
    } finally {
      nativeApi.restore();
      await mounted.cleanup();
    }
  });

  it("exposes Moss visible stop control parity selector", async () => {
    setFeatureFlagEnabled("show-moss-control-plane", true);

    const runningMounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1_400 },
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-moss-visible-stop-parity" as MessageId,
        targetText: "moss visible stop parity target",
        sessionStatus: "running",
      }),
    });

    try {
      const stopControl = await waitForElement(
        () => document.querySelector<HTMLButtonElement>("[data-moss-visible-stop-control='true']"),
        "Unable to find Moss visible stop control.",
      );
      expect(stopControl.getAttribute("aria-label")).toBe("Stop generation");
      const strip = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-moss-native-shell-access='true']"),
        "Unable to find Moss native shell access strip for running session.",
      );
      expect(strip.dataset.mossNativeShellSessionStatus).toBe("running");
      expect(
        document.querySelector(
          "[data-moss-native-shell-surface='events'][data-active-surface='true']",
        ),
      ).toBeTruthy();
    } finally {
      await runningMounted.cleanup();
    }
  });
});
