// FILE: SpaceItemChatListing.browser.tsx
// Purpose: WALK-1 S-6. The walker made a 资料空间 item, clicked its 问 Moss and found the item's chat
//          「未命名文档」 in the sidebar before sending anything. Here the item's 问 Moss panel makes
//          its chat through the product path (SpaceCanvasChatDockHost → prepareArtifactAssistant →
//          createDraftThreadWithoutTurn), a stand-in server answers the thread.create the way the
//          real one projects it, and the real Sidebar (project tree, 最近, activity, search) is checked
//          before and after the first send.
// Layer: Web component browser tests
// Why the stand-ins: the panel's real pane is a full ChatView with app-wide providers; here a light
//      pane shows which chat the panel holds. The server is the shell snapshot the Sidebar reads,
//      updated from each command as the server's projection would.

import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  SidebarOrderRevision,
  ThreadId,
  TurnId,
  type NativeApi,
  type OrchestrationShellSnapshot,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { DEFAULT_SHORTCUT_FALLBACKS } from "~/keybindings";
import { artifactAssistantThreadKey, pageAssistantThreads } from "~/lib/pageAi/pageAssistantThread";
import { MossLocalizationProvider } from "~/localization";
import { StoreProvider, useStore } from "~/store";
import { AppRailSlotProvider } from "../AppRail";
import ThreadSidebar from "../Sidebar";
import { RealtimeVoiceControllerProvider } from "../chat/RealtimeVoiceControllerProvider";
import { Button } from "../ui/button";
import { SidebarProvider } from "../ui/sidebar";
import { ToastProvider } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { SpaceCanvasChatDockHost } from "./SpaceCanvasChatDock";

vi.mock("../chat/SidechatDockPane", () => ({
  // Which chat the panel holds; the real pane is a ChatView of that chat.
  SidechatDockPane: (props: { pane: { threadId?: string | null } }) => (
    <div data-testid="panel-conversation" data-thread-id={props.pane.threadId ?? ""}>
      对话
    </div>
  ),
}));

const NOW = "2026-11-24T08:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-s6-home");
const STARTED_CHAT = ThreadId.makeUnsafe("thread-s6-started");
const ACCOUNT = "acct-s6";
const ITEM_ID = "page-s6-untitled";
const ITEM_TITLE = "未命名文档";
const ITEM_KEY = artifactAssistantThreadKey(ACCOUNT, null, "page", ITEM_ID);

type ShellThread = OrchestrationShellSnapshot["threads"][number];

function shellThread(id: ThreadId, title: string, patch: Partial<ShellThread> = {}): ShellThread {
  return {
    id,
    projectId: PROJECT_ID,
    title,
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    creationSource: null,
    sourceThreadId: null,
    sourceTurnId: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledAt: null,
    handoff: null,
    session: null,
    ...patch,
  } as ShellThread;
}

function runningTurn(turnId: string, at: string) {
  return {
    turnId: TurnId.makeUnsafe(turnId),
    state: "running" as const,
    requestedAt: at,
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
  };
}

const resolveNothing = () => Promise.resolve(undefined);

/** Any API the lists do not read resolves to nothing. */
function createFallback(): object {
  let proxy: object;
  proxy = new Proxy(resolveNothing, {
    apply: () => Promise.resolve(undefined),
    get: (_target, property) => (property === "then" ? undefined : proxy),
  });
  return proxy;
}

/** The server: the shell snapshot the Sidebar reads, changed by each command as it projects it. */
class ItemChatServer {
  snapshot: OrchestrationShellSnapshot;
  readonly commands: Array<Record<string, unknown>> = [];

  constructor() {
    this.snapshot = {
      snapshotSequence: 1,
      spaces: [],
      projects: [
        {
          id: PROJECT_ID,
          kind: "project",
          title: "Moss",
          workspaceRoot: "/Users/moss/Moss",
          defaultModelSelection: null,
          scripts: [],
          isPinned: false,
          spaceId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      // A chat the person already used, so the lists are not empty.
      threads: [
        shellThread(STARTED_CHAT, "周报", {
          latestTurn: runningTurn("turn-s6-started", NOW),
          latestUserMessageAt: NOW,
        }),
      ],
      sidebarSections: [],
      sidebarOrderRevision: SidebarOrderRevision.makeUnsafe(1),
      sidebarOrderMigrationState: "ready",
      sidebarOrderItems: [],
      updatedAt: NOW,
    } as OrchestrationShellSnapshot;
  }

  createCommands() {
    return this.commands.filter((command) => command.type === "thread.create");
  }

  private publish(threads: OrchestrationShellSnapshot["threads"]) {
    const sequence = this.snapshot.snapshotSequence + 1;
    this.snapshot = { ...this.snapshot, snapshotSequence: sequence, threads };
    useStore.getState().syncServerShellSnapshot(this.snapshot);
    return { sequence };
  }

  dispatch(command: Record<string, unknown>) {
    this.commands.push(command);
    const at = new Date().toISOString();
    if (command.type === "thread.create") {
      const threadId = command.threadId as ThreadId;
      return this.publish([
        ...this.snapshot.threads,
        shellThread(threadId, command.title as string, {
          projectId: command.projectId as ProjectId,
          modelSelection: command.modelSelection as ShellThread["modelSelection"],
          runtimeMode: command.runtimeMode as ShellThread["runtimeMode"],
          interactionMode: command.interactionMode as ShellThread["interactionMode"],
          createdAt: (command.createdAt as string | undefined) ?? at,
          updatedAt: (command.createdAt as string | undefined) ?? at,
          // The decider copies the mark to thread.created only when it is true; the projection
          // keeps it on the thread.
          ...(command.listedAfterFirstSend === true ? { listedAfterFirstSend: true } : {}),
        }),
      ]);
    }
    if (command.type === "thread.turn.start") {
      return this.publish(
        this.snapshot.threads.map((thread) =>
          thread.id === command.threadId
            ? {
                ...thread,
                latestTurn: runningTurn("turn-s6-first-send", at),
                latestUserMessageAt: at,
                updatedAt: at,
              }
            : thread,
        ),
      );
    }
    return { sequence: this.snapshot.snapshotSequence };
  }

  nativeApi(): NativeApi {
    const fallback = createFallback();
    const api = {
      orchestration: {
        getShellSnapshot: async () => this.snapshot,
        dispatchCommand: async (command: Record<string, unknown>) => this.dispatch(command),
        // Search by message text: nothing was written in the item's chat.
        searchThreads: async () => ({ matches: [] }),
      },
      automation: {
        list: async () => ({ definitions: [], runs: [] }),
        onEvent: () => () => undefined,
      },
      todo: { list: async () => ({ todos: [] }), onEvent: () => () => undefined },
      projectAgent: {
        listSummaries: async () => ({ summaries: [] }),
        onEvent: () => () => undefined,
      },
      githubInbox: {
        list: async () => ({
          viewer: null,
          items: [],
          errors: [],
          repositoryBatches: [],
          rateLimit: null,
          reviewRequestedCount: 0,
          reviewRequestedCountIncomplete: false,
        }),
      },
      server: {
        getMossAccountSession: async () => ({
          configured: true,
          authenticated: false,
          session: null,
        }),
        getMossCloudAccountState: async () => ({ configured: false, signedIn: false }),
        listMossCloudAccounts: async () => ({ accounts: [] }),
        getConfig: async () => ({
          cwd: "/Users/moss/Moss",
          homeDir: "/Users/moss",
          chatWorkspaceRoot: "/Users/moss/Moss",
          studioWorkspaceRoot: "/Users/moss/Studio",
          worktreesDir: "/Users/moss/.moss/worktrees",
          keybindingsConfigPath: "/Users/moss/.moss/keybindings.json",
          keybindings: DEFAULT_SHORTCUT_FALLBACKS,
          issues: [],
          providers: [],
          availableEditors: [],
        }),
        getSettings: async () => DEFAULT_SERVER_SETTINGS,
      },
      provider: {
        getComposerCapabilities: async ({ provider }: { provider: string }) => ({
          provider,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: false,
        }),
        listModels: async () => ({ models: [], source: "empty", cached: false }),
        listAgents: async () => ({ agents: [], source: "empty", cached: false }),
      },
      pullRequests: { reviewRequestCount: async () => ({ count: 0, incomplete: false }) },
      projects: { discoverScripts: async () => ({ targets: [] }) },
      realtimeVoice: {
        onEvent: () => () => undefined,
        listVoices: async () => ({
          voices: [],
          defaultVoice: "",
          preferredTransport: "websocket-pcm16",
        }),
        getState: async () => ({
          phase: "inactive",
          sessionId: null,
          threadId: null,
          ownerClaimId: null,
          source: null,
          voice: null,
          requestedModel: null,
          actualModel: null,
          activity: null,
          barrier: {
            requestAccepted: false,
            backendStarted: false,
            webRtcConnected: false,
            dataSessionInitialized: false,
          },
          inputMuted: false,
          outputMuted: false,
          error: null,
        }),
      },
      dialogs: { confirm: async () => true },
      shell: { openExternal: async () => undefined },
    };
    return new Proxy(api, {
      get: (target, property) => Reflect.get(target, property) ?? fallback,
    }) as unknown as NativeApi;
  }
}

/** An opened 资料空间 document: its header's 问 Moss, and the panel's first send. */
function OpenedItem() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={containerRef} style={{ flex: 1, height: "100vh", position: "relative" }}>
      <SpaceCanvasChatDockHost
        artifact={{
          kind: "page",
          itemId: ITEM_ID,
          title: ITEM_TITLE,
          scopeSpaceId: null,
          account: ACCOUNT,
        }}
        containerRef={containerRef}
        keepItemOpen
      >
        {(dock) => (
          <div>
            <Button size="xs" data-space-dock-toggle onClick={() => dock.setState("pip")}>
              问 Moss
            </Button>
            <Button size="xs" onClick={() => void dock.ask({ prompt: "把这页整理成提纲" })}>
              发送
            </Button>
          </div>
        )}
      </SpaceCanvasChatDockHost>
    </div>
  );
}

async function mount(server: ItemChatServer) {
  window.nativeApi = server.nativeApi();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <SidebarProvider defaultOpen>
        <AppRailSlotProvider value={null}>
          <RealtimeVoiceControllerProvider>
            <ToastProvider>
              <TooltipProvider>
                <div
                  data-testid="thread-sidebar"
                  style={{ width: 300, height: "100vh", flexShrink: 0 }}
                >
                  <ThreadSidebar />
                </div>
                <OpenedItem />
              </TooltipProvider>
            </ToastProvider>
          </RealtimeVoiceControllerProvider>
        </AppRailSlotProvider>
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <StoreProvider>
          <MossLocalizationProvider localeOverride="zh-CN">{children}</MossLocalizationProvider>
        </StoreProvider>
      </QueryClientProvider>
    ),
  });
  await router.load();
  useStore.getState().syncServerShellSnapshot(server.snapshot);
  useStore.getState().setAllProjectsExpanded(true);
  const screen = await render(<RouterProvider router={router} />);
  return {
    async cleanup() {
      await screen.unmount();
      router.cancelMatches();
      queryClient.clear();
    },
  };
}

/** The thread sidebar's text: its project tree, 最近 or activity, whichever it shows. */
const sidebarText = () =>
  document.querySelector<HTMLElement>('[data-testid="thread-sidebar"]')?.textContent ?? "";

/** What the sidebar's search finds for the item's title, as the person types it. */
async function searchFinds(title: string): Promise<boolean> {
  await userEvent.click(page.getByRole("button", { name: "Search", exact: true }));
  const field = page.getByRole("combobox");
  await expect.element(field).toBeVisible();
  await field.fill(title);
  // Past the palette's server-search debounce.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const found = page.getByRole("option", { name: new RegExp(title) }).elements().length > 0;
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
  return found;
}

describe("WALK-1 S-6: an item's 问 Moss chat in the lists", () => {
  const originalFetch = window.fetch;
  let previousNativeApi: NativeApi | undefined;

  beforeEach(async () => {
    previousNativeApi = window.nativeApi;
    localStorage.clear();
    localStorage.setItem(
      "moss:app-settings:v1",
      JSON.stringify({
        showChatsSection: false,
        showStudioSection: false,
        sidebarProjectSortOrder: "updated_at",
        sidebarThreadSortOrder: "updated_at",
      }),
    );
    pageAssistantThreads.forget(ITEM_KEY);
    pageAssistantThreads.resetForTests();
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    // The item's server-side default chat: none yet.
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.includes("/assistant-thread")) {
        return new Response(JSON.stringify({ defaultAssistantThreadId: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
    await page.viewport(1440, 900);
  });

  afterEach(() => {
    window.fetch = originalFetch;
    pageAssistantThreads.forget(ITEM_KEY);
    localStorage.clear();
    if (previousNativeApi) window.nativeApi = previousNativeApi;
    else delete window.nativeApi;
  });

  it("WALK-1 S-6: an item's 问 Moss chat is in no list until its first send", async () => {
    const server = new ItemChatServer();
    const mounted = await mount(server);
    try {
      await vi.waitFor(() => expect(sidebarText()).toContain("周报"), { timeout: 10_000 });

      // The walker's step: the item is open, the person clicks its 问 Moss.
      await userEvent.click(page.getByRole("button", { name: "问 Moss", exact: true }));
      await expect
        .element(page.getByRole("complementary", { name: "Moss 画布助手浮窗", exact: true }))
        .toBeVisible();

      // The panel makes the item's chat on the server before anything is sent, marked.
      await vi.waitFor(() => expect(server.createCommands()).toHaveLength(1), { timeout: 8_000 });
      const create = server.createCommands()[0]!;
      const itemChatId = create.threadId as ThreadId;
      expect(create.title).toBe(ITEM_TITLE);
      expect
        .soft(create.listedAfterFirstSend, "the panel's thread.create carries the mark")
        .toBe(true);
      // The server's answer reached the app: the panel holds the chat the server made.
      await vi.waitFor(() =>
        expect(useStore.getState().sidebarThreadSummaryById[itemChatId]?.title).toBe(ITEM_TITLE),
      );
      await expect
        .element(page.getByTestId("panel-conversation"))
        .toHaveAttribute("data-thread-id", itemChatId);

      // Project tree: the started chat is a row, the item's chat is not.
      await expect
        .element(page.getByTestId("thread-sidebar").getByText("周报", { exact: true }).first())
        .toBeVisible();
      expect(sidebarText(), "project tree").not.toContain(ITEM_TITLE);

      // 最近 (the project closed).
      useStore.getState().setProjectExpanded(PROJECT_ID, false);
      await vi.waitFor(() => expect(sidebarText()).toContain("最近"));
      expect(sidebarText(), "最近").not.toContain(ITEM_TITLE);
      useStore.getState().setProjectExpanded(PROJECT_ID, true);

      // Activity.
      await userEvent.click(page.getByRole("button", { name: "切换到活动视图", exact: true }));
      await expect
        .element(page.getByRole("button", { name: "切换到经典视图", exact: true }))
        .toBeVisible();
      await vi.waitFor(() => expect(sidebarText()).toContain("周报"));
      expect(sidebarText(), "activity").not.toContain(ITEM_TITLE);
      await userEvent.click(page.getByRole("button", { name: "切换到经典视图", exact: true }));

      // Search (on main it lists the item's chat here).
      expect(await searchFinds(ITEM_TITLE), "search before the first send").toBe(false);

      // The first send from the item's panel: the chat is listed from now on.
      await userEvent.click(page.getByRole("button", { name: "发送", exact: true }));
      await vi.waitFor(
        () =>
          expect(
            server.commands.some(
              (command) => command.type === "thread.turn.start" && command.threadId === itemChatId,
            ),
          ).toBe(true),
        { timeout: 8_000 },
      );
      await vi.waitFor(() =>
        expect(
          useStore.getState().sidebarThreadSummaryById[itemChatId]?.latestUserMessageAt,
        ).not.toBeNull(),
      );
      expect(await searchFinds(ITEM_TITLE), "search after the first send").toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });
});
