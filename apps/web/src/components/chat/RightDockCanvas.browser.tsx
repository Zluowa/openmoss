import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SERVER_SETTINGS_VIEW,
  ProjectId,
  SidebarOrderRevision,
  ThreadId,
  type NativeApi,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { mossServerQueryKeys } from "~/components/auth/mossServerReactQuery";
import { TooltipProvider } from "~/components/ui/tooltip";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useTheme, type ThemeMode } from "~/hooks/useTheme";
import { DEFAULT_SHORTCUT_FALLBACKS } from "~/keybindings";
import {
  flushConversationImageEditors,
  getConversationImageComposer,
} from "~/lib/conversationImageComposer";
import { resetEmbeddedBundleChecks } from "~/lib/embeddedBundleCheck";
import { getMossCanvasLiveEditor } from "~/lib/mossCanvasLiveEditors";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { MossLocalizationProvider, useTranslation } from "~/localization";
import { useRightDockStore } from "~/rightDockStore";
import {
  createDefaultRightDockState,
  openPaneInState,
  type RightDockThreadState,
} from "~/rightDockStore.logic";
import { StoreProvider, useStore } from "~/store";
import { createShellSnapshotFromReadModel } from "~/test/effectRpcWebSocketMock";
import { AppRailSlotProvider } from "../AppRail";
import ThreadSidebar from "../Sidebar";
import { Button } from "../ui/button";
import { SidebarProvider } from "../ui/sidebar";
import { ToastProvider } from "../ui/toast";
import { ConversationImageWorkspace } from "./ConversationImageWorkspace";
import { RealtimeVoiceControllerProvider } from "./RealtimeVoiceControllerProvider";
import { RightDock } from "./RightDock";
import { RIGHT_DOCK_ADD_MENU_KINDS, resolveRightDockLauncherItems } from "./rightDockPaneMeta";
import { SingleChatSurface } from "./SingleChatSurface";

// The chat surface's chat column and its desktop-only bridges are stand-ins, as in
// SingleChatSurface.browser.tsx; the dock, its 画布, the Canvas and the Sidebar are real.
const ChatColumnStub = vi.hoisted(() => () => <div data-testid="chat-column-stub" />);

vi.mock("./ChatThreadSurfacePrimitives", async () => {
  const actual = await vi.importActual<typeof import("./ChatThreadSurfacePrimitives")>(
    "./ChatThreadSurfacePrimitives",
  );
  return { ...actual, ChatMountLoader: ChatColumnStub, DeferredChatView: ChatColumnStub };
});

vi.mock("../../hooks/useBrowserPanelDesktopBridge", () => ({
  useBrowserPanelDesktopBridge: () => undefined,
}));

vi.mock("../../hooks/useDeviceEventBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useDeviceEventBridge")>()),
  useDeviceEventBridge: () => undefined,
}));

vi.mock("../../hooks/useDeviceSupport", () => ({
  useDeviceSupport: () => false,
}));

vi.mock("../../hooks/useDockPaneRuntimeActivation", () => ({
  useDockPaneRuntimeActivation: () => ({
    activePaneRuntimeMode: "live",
    requestActivePaneLive: () => undefined,
    requestImmediateHydration: () => undefined,
  }),
}));

vi.mock("../../hooks/useRepoDiffTotals", () => ({
  useRepoDiffTotals: () => ({ additions: 0, deletions: 0, fileCount: 0, hasChanges: false }),
}));

vi.mock("../pullRequest/usePullRequestPaneStateIcon", () => ({
  usePullRequestPaneStateIcon: () => null,
}));

const SHOTS = import.meta.env.VITE_MOSS_PAGE_EDITOR_SHOTS as string | undefined;
const THREAD_ID = ThreadId.makeUnsafe("right-dock-canvas-thread");

function ThemeSync({ mode }: { readonly mode: ThemeMode }) {
  const { setTheme } = useTheme();
  useEffect(() => {
    setTheme(mode);
  }, [mode, setTheme]);
  return null;
}

function DockHarness({ initialOpen = true }: { readonly initialOpen?: boolean }) {
  const { t } = useTranslation();
  const [fullWidth, setFullWidth] = useState(false);
  const [dockState, setDockState] = useState<RightDockThreadState>(() => ({
    ...createDefaultRightDockState(),
    open: initialOpen,
  }));

  const launcherItems = resolveRightDockLauncherItems(
    {
      hasWorkspace: true,
      hasGitRepository: true,
      hasReview: false,
      hasDeviceSupport: false,
    },
    t,
  );

  return (
    <div className="flex h-screen w-screen bg-background text-foreground">
      <main
        className={
          fullWidth
            ? "w-0 flex-none overflow-hidden"
            : "flex min-w-0 flex-1 flex-col justify-between border-r border-border/60 p-6"
        }
        data-testid="chat-column"
      >
        <div className="text-ui-sm text-foreground" data-testid="chat-message">
          打开 Moss 画布
        </div>
        <div className="rounded-card border border-border/70 bg-background p-3 text-ui-xs text-muted-foreground">
          在 Moss 里问任何事
        </div>
      </main>
      <RightDock
        state={dockState}
        minWidth={320}
        defaultWidth={600}
        shouldAcceptWidth={() => true}
        addMenuKinds={RIGHT_DOCK_ADD_MENU_KINDS}
        launcherItems={launcherItems}
        fullWidth={fullWidth}
        onFullWidthChange={setFullWidth}
        onSelectPane={(paneId) => setDockState((s) => ({ ...s, activePaneId: paneId }))}
        // Like SingleChatSurface: the Canvas saves before its pane closes.
        onClosePane={(paneId) =>
          void flushConversationImageEditors(THREAD_ID, paneId).then((saved) => {
            if (!saved) return;
            setDockState((s) => {
              const panes = s.panes.filter((p) => p.id !== paneId);
              return {
                ...s,
                panes,
                activePaneId: panes[0]?.id ?? null,
              };
            });
          })
        }
        onCollapse={() => setDockState((s) => ({ ...s, open: false }))}
        onOpenChange={(open) => setDockState((s) => ({ ...s, open }))}
        onAddPane={(kind) =>
          setDockState((s) => openPaneInState(s, { paneId: `pane-${kind}`, kind }))
        }
        renderPane={(pane, context) =>
          pane.kind === "canvas" ? (
            <ConversationImageWorkspace
              canvasOnly
              threadId={THREAD_ID}
              pane={pane}
              fullWidth={fullWidth}
              visible={context.isVisible}
              onClose={() =>
                setDockState((s) => ({
                  ...s,
                  panes: s.panes.filter((p) => p.id !== pane.id),
                  activePaneId: null,
                }))
              }
              onViewChange={() => {}}
              onActiveImageChange={() => {}}
              onRequestFullWidth={setFullWidth}
            />
          ) : (
            <div className="p-4 text-ui-sm">{pane.kind}</div>
          )
        }
      />
    </div>
  );
}

let client: QueryClient;

/** Signed in to Moss, as the 画布 needs. */
function seedSignedInAccount(queryClient: QueryClient) {
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    session: {
      user: { id: "account-a", phoneNumber: "+8613800000000", displayName: "Moss" },
    },
    activeRealm: "cn",
  });
  queryClient.setQueryData(mossServerQueryKeys.mossCloudAccountState(), {
    authenticated: false,
    account: null,
    activeRealm: "cn",
  });
  queryClient.setQueryData(mossServerQueryKeys.mossEnterpriseKeyState(), {
    active: false,
    keyPrefix: null,
  });
}

async function mountDock(themeMode: ThemeMode = "light") {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  seedSignedInAccount(client);

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <TooltipProvider>
            <ThemeSync mode={themeMode} />
            <Outlet />
          </TooltipProvider>
        </MossLocalizationProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <DockHarness />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await render(<RouterProvider router={router} />);
}

async function shot(name: string) {
  if (SHOTS) {
    const dir = SHOTS.replace(/\/+$/u, "");
    await page.screenshot({ path: `${dir}/${name}.png` });
  }
}

async function waitForCanvasReady() {
  // The frame is there, its board is drawn, and the host's loading overlay is gone
  // (moss-canvas-ready committed readyFrameKey).
  await expect
    .poll(
      () =>
        document
          .querySelector<HTMLIFrameElement>('iframe[title="Moss Canvas"]')
          ?.contentDocument?.querySelector(".tl-canvas") != null &&
        !Array.from(document.querySelectorAll('[role="status"]')).some((element) =>
          element.textContent?.includes("正在加载画布"),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
}

function canvasDocument(): Document | null {
  return (
    document.querySelector<HTMLIFrameElement>('iframe[title="Moss Canvas"]')?.contentDocument ??
    null
  );
}

// The text tool in the Canvas toolbar, one click on the board, then typing: what a person does.
async function placeText(y: number) {
  const frame = page.frameLocator(page.getByTitle("Moss Canvas", { exact: true }));
  await frame.getByRole("button", { name: "文字（T）", exact: true }).click();
  await frame.getByTestId("canvas").click({ position: { x: 260, y } });
}

describe("右栏 画布: one click, usable, and kept", () => {
  beforeEach(async () => {
    resetEmbeddedBundleChecks();
    localStorage.clear();
    const editorServer = import.meta.env.VITE_MOSS_PAGE_EDITOR_TEST_WS_URL as string | undefined;
    if (!editorServer) {
      throw new Error("The real Canvas editor static server is required.");
    }
    vi.stubEnv("VITE_WS_URL", editorServer);
    await page.viewport(1440, 900);
  });

  afterEach(async () => {
    await cleanup();
    client?.clear();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    vi.unstubAllEnvs();
  });

  for (const theme of ["light", "dark"] as const) {
    it(`opens the real Canvas beside the chat, keeps what was written across close and reopen (${theme})`, async () => {
      await mountDock(theme);
      const launcherCanvas = page.getByTestId("right-dock-empty-action-canvas");
      await expect.element(launcherCanvas).toBeVisible();
      await expect.element(launcherCanvas).toHaveTextContent("画布");
      await shot(`right-dock-canvas-launcher-${theme}`);

      await userEvent.click(launcherCanvas);
      await expect.element(page.getByTitle("Moss Canvas", { exact: true })).toBeVisible();
      await waitForCanvasReady();
      const chatRect = document
        .querySelector<HTMLElement>("[data-testid='chat-column']")!
        .getBoundingClientRect();
      const frameRect = document
        .querySelector<HTMLIFrameElement>('iframe[title="Moss Canvas"]')!
        .getBoundingClientRect();
      expect(chatRect.width).toBeGreaterThan(300);
      expect(frameRect.width).toBeGreaterThan(400);
      expect(frameRect.left).toBeGreaterThanOrEqual(chatRect.right - 1);

      const note = `画布便签 ${theme}`;
      // Each run writes on an empty spot of the same conversation board.
      await placeText(theme === "light" ? 220 : 420);
      await userEvent.keyboard(note);
      await userEvent.keyboard("{Escape}");
      const frame = page.frameLocator(page.getByTitle("Moss Canvas", { exact: true }));
      await expect
        .element(frame.getByTestId("canvas").getByText(note, { exact: true }), { timeout: 10_000 })
        .toBeVisible();
      await shot(`right-dock-canvas-note-${theme}`);

      // Close the pane from its tab, then open 画布 again from the launcher.
      await userEvent.click(page.getByRole("button", { name: "关闭 画布", exact: true }));
      await expect.poll(() => document.querySelector('iframe[title="Moss Canvas"]')).toBeNull();
      await userEvent.click(page.getByTestId("right-dock-empty-action-canvas"));
      await waitForCanvasReady();
      await expect
        .element(
          page
            .frameLocator(page.getByTitle("Moss Canvas", { exact: true }))
            .getByTestId("canvas")
            .getByText(note, { exact: true }),
          { timeout: 15_000 },
        )
        .toBeVisible();
      await shot(`right-dock-canvas-reopened-${theme}`);
    });
  }

  it("组件 in the hosted bar shows its glyph, turns 内容创作 off and on, keeps the board, and the choice survives reopening", async () => {
    await mountDock("light");
    await userEvent.click(page.getByTestId("right-dock-empty-action-canvas"));
    await waitForCanvasReady();
    const frame = () => page.frameLocator(page.getByTitle("Moss Canvas", { exact: true }));
    const kitsButton = () => frame().getByRole("button", { name: "组件", exact: true });
    const imageCard = () => frame().getByRole("button", { name: "图片卡", exact: true });
    const contentKit = () => frame().getByRole("menuitemcheckbox", { name: "内容创作" });

    // The button sits right before 问 Moss, and its glyph is served by Moss (canvasHostGlyphs.ts).
    await expect.element(kitsButton()).toBeVisible();
    const glyph = await vi.waitFor(() => {
      const button = canvasDocument()?.querySelector<HTMLElement>('[data-moss-bar-tool="kits"]');
      const span = button?.querySelector<HTMLElement>("span");
      expect(span).toBeTruthy();
      const rect = span!.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(10);
      return {
        mask: span!.style.mask || span!.style.webkitMask,
        origin: canvasDocument()!.location.origin,
      };
    });
    expect(glyph.mask).toContain("/central-icons-reversed/blocks.svg");
    const icon = await fetch(`${glyph.origin}/central-icons-reversed/blocks.svg`);
    expect(icon.ok).toBe(true);
    expect(await icon.text()).toContain("<svg");

    await placeText(520);
    await userEvent.keyboard("组件开关时留下的字");
    await userEvent.keyboard("{Escape}");
    await expect.element(imageCard()).toBeVisible();

    // Turn 内容创作 off: the cards leave the bar, the board keeps what it holds.
    await userEvent.click(kitsButton());
    await expect.element(contentKit()).toHaveAttribute("aria-checked", "true");
    await userEvent.click(contentKit());
    await expect.element(contentKit()).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(() => canvasDocument()?.querySelector('[data-moss-bar-tool="image-card"]') ?? null)
      .toBeNull();
    await expect
      .element(frame().getByTestId("canvas").getByText("组件开关时留下的字", { exact: true }))
      .toBeVisible();
    await shot("right-dock-canvas-kits-content-off-light");

    // Close and reopen the 画布: the choice is kept with the board.
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "关闭 画布", exact: true }));
    await expect.poll(() => document.querySelector('iframe[title="Moss Canvas"]')).toBeNull();
    await userEvent.click(page.getByTestId("right-dock-empty-action-canvas"));
    await waitForCanvasReady();
    await expect.element(kitsButton()).toBeVisible();
    expect(canvasDocument()?.querySelector('[data-moss-bar-tool="image-card"]') ?? null).toBeNull();
    await expect
      .element(frame().getByTestId("canvas").getByText("组件开关时留下的字", { exact: true }), {
        timeout: 15_000,
      })
      .toBeVisible();

    // Turn it on again: the cards are back.
    await userEvent.click(kitsButton());
    await userEvent.click(contentKit());
    await expect.element(contentKit()).toHaveAttribute("aria-checked", "true");
    await expect.element(imageCard()).toBeVisible();
    await shot("right-dock-canvas-kits-content-on-light");
  });

  it("shows an agent's edit on the open 画布 without a reload, and keeps what the person wrote meanwhile", async () => {
    await mountDock("light");
    await userEvent.click(page.getByTestId("right-dock-empty-action-canvas"));
    await waitForCanvasReady();
    const board = () =>
      page.frameLocator(page.getByTitle("Moss Canvas", { exact: true })).getByTestId("canvas");
    const iframeBefore = document.querySelector('iframe[title="Moss Canvas"]');
    const editor = await vi.waitFor(
      () => {
        const ready = getMossCanvasLiveEditor(THREAD_ID);
        expect(ready).not.toBeNull();
        return ready!;
      },
      { timeout: 10_000 },
    );

    // The agent's edit starts; the person keeps writing while it is applied and saved.
    const agentEdit = editor.apply("canvas-ops:browser-1", [
      { op: "addFrame", key: "f", name: "代理画的框", x: 40, y: 360, w: 420, h: 220 },
      { op: "addNote", key: "n", text: "代理写的便签", frame: "f" },
    ]);
    await placeText(120);
    await userEvent.keyboard("人在同时写字");
    await userEvent.keyboard("{Escape}");
    const result = await agentEdit;
    expect(result.ok).toBe(true);

    // On the open board, without a reload: the same frame element, both writings visible.
    expect(document.querySelector('iframe[title="Moss Canvas"]')).toBe(iframeBefore);
    await expect.element(board().getByText("代理写的便签", { exact: true })).toBeVisible();
    await expect.element(board().getByText("人在同时写字", { exact: true })).toBeVisible();
    await shot("right-dock-canvas-agent-edit-light");

    // Saved together: close the 画布 and open it again.
    await userEvent.click(page.getByRole("button", { name: "关闭 画布", exact: true }));
    await expect.poll(() => document.querySelector('iframe[title="Moss Canvas"]')).toBeNull();
    await userEvent.click(page.getByTestId("right-dock-empty-action-canvas"));
    await waitForCanvasReady();
    await expect
      .element(board().getByText("代理写的便签", { exact: true }), { timeout: 15_000 })
      .toBeVisible();
    await expect.element(board().getByText("人在同时写字", { exact: true })).toBeVisible();
  });
  it("keeps an edit written underneath the open 画布 and the stroke drawn meanwhile, on the board and in the saved file", async () => {
    // The test server's Canvas storage, as the bridge reaches it.
    const storage = async (method: string, input: Record<string, unknown> = {}) => {
      const response = await fetch("/api/moss/media/canvas/storage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, input }),
      });
      expect(response.ok).toBe(true);
      return ((await response.json()) as { result: unknown }).result;
    };
    const savedBoard = async () => {
      const active = (await storage("projects.active")) as { relativePath?: string } | null;
      if (!active?.relativePath) return "";
      const read = (await storage("projects.read", { relativePath: active.relativePath })) as {
        snapshot?: unknown;
      };
      return JSON.stringify(read.snapshot ?? null);
    };
    await mountDock("light");
    await userEvent.click(page.getByTestId("right-dock-empty-action-canvas"));
    await waitForCanvasReady();
    const board = () =>
      page.frameLocator(page.getByTitle("Moss Canvas", { exact: true })).getByTestId("canvas");
    const iframeBefore = document.querySelector('iframe[title="Moss Canvas"]');

    // The person writes; the editor saves it and holds that revision.
    await placeText(160);
    await userEvent.keyboard("先写的一行");
    await userEvent.keyboard("{Escape}");
    await expect.poll(savedBoard, { timeout: 10_000 }).toContain("先写的一行");

    // Another writer changes the saved board underneath the open editor (Moss writing an agent's
    // edit while no editor answered).
    await storage("test.mossCanvasMutate", {
      ops: [{ op: "addNote", key: "u", text: "写在下面的便签", x: 520, y: 420 }],
    });
    expect(await savedBoard()).toContain("写在下面的便签");

    // The person draws meanwhile: that save is refused, the editor merges the newer board in.
    await placeText(300);
    await userEvent.keyboard("同时写的一行");
    await userEvent.keyboard("{Escape}");

    // On the open board, without a reload: all three.
    expect(document.querySelector('iframe[title="Moss Canvas"]')).toBe(iframeBefore);
    await expect
      .element(board().getByText("写在下面的便签", { exact: true }), { timeout: 15_000 })
      .toBeVisible();
    await expect.element(board().getByText("先写的一行", { exact: true })).toBeVisible();
    await expect.element(board().getByText("同时写的一行", { exact: true })).toBeVisible();
    await shot("right-dock-canvas-merged-underneath-light");
    // And in the saved file: the edit underneath was not written over.
    await expect
      .poll(
        async () => {
          const saved = await savedBoard();
          return ["先写的一行", "写在下面的便签", "同时写的一行"].every((text) =>
            saved.includes(text),
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });
});

// WALK-7 N7-1. The walker opened a new chat, sent nothing, opened 画布 from the right dock and got
// 「画布启动失败」: the server knew no conversation for the chat yet. Here the chat surface a person
// uses (SingleChatSurface, the real useHandleNewThread) opens 画布 in such a chat, and the real
// Sidebar is read before and after drawing. The server's own command schema, decider and projector
// run in the test server (vitest.browser.page-editor.config.ts), and its Canvas storage route
// records a save holding a shape with the server's own recordMossCanvasEdited; the window gets the
// server's projection as the shell stream delivers it (a snapshot, then thread upserts).

const N7_PROJECT_ID = ProjectId.makeUnsafe("project-n7-1");
const N7_CREATED_AT = "2026-11-24T08:00:00.000Z";
const N7_EXISTING_CHAT = "周报";

/** The Moss server's orchestration, in the test server. */
async function serverOrchestration<T>(
  method: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch("/api/moss/test/orchestration", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, input }),
  });
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `orchestration ${method} failed`);
  return body.result as T;
}

const resolveNothing = () => Promise.resolve(undefined);

/**
 * Any API neither the lists nor the chat surface read resolves to nothing; a subscription
 * (`on…`) hears nothing and unsubscribes.
 */
function withFallback<T extends object>(namespace: T): T {
  return new Proxy(namespace, {
    get: (target, property) =>
      Reflect.get(target, property) ??
      (typeof property === "string" && property.startsWith("on")
        ? () => () => undefined
        : property === "then"
          ? undefined
          : resolveNothing),
  });
}

class NewChatServer {
  /** What the window sent, in order. */
  readonly commands: Array<Record<string, unknown>> = [];
  private cursor = 0;
  private delivering: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  async start() {
    await serverOrchestration("reset");
    await serverOrchestration("dispatch", {
      command: {
        type: "project.create",
        commandId: "cmd-n7-project",
        projectId: N7_PROJECT_ID,
        title: "Moss",
        workspaceRoot: "/Users/moss/Moss",
        createdAt: N7_CREATED_AT,
      },
    });
    // A chat the person already has, so the lists are not empty.
    await serverOrchestration("dispatch", {
      command: {
        type: "thread.create",
        commandId: "cmd-n7-existing",
        threadId: "thread-n7-existing",
        projectId: N7_PROJECT_ID,
        title: N7_EXISTING_CHAT,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: N7_CREATED_AT,
      },
    });
  }

  creates() {
    return this.commands.filter((command) => command.type === "thread.create");
  }

  async shell(): Promise<OrchestrationShellSnapshot> {
    const readModel = await serverOrchestration<OrchestrationReadModel>("readModel");
    this.cursor = Math.max(this.cursor, readModel.snapshotSequence);
    return {
      ...createShellSnapshotFromReadModel(readModel),
      sidebarSections: [],
      sidebarOrderRevision: SidebarOrderRevision.makeUnsafe(1),
      sidebarOrderMigrationState: "ready",
      sidebarOrderItems: [],
    } as OrchestrationShellSnapshot;
  }

  /** The shell stream: every new event's thread, as the server's projection has it now. */
  deliver(): Promise<void> {
    this.delivering = this.delivering.then(async () => {
      const after = this.cursor;
      const events = await serverOrchestration<
        Array<{ sequence: number; payload?: { threadId?: string } }>
      >("events", { after });
      if (events.length === 0) return;
      const shell = await this.shell();
      for (const event of events) {
        const thread = shell.threads.find((entry) => entry.id === event.payload?.threadId);
        if (thread) {
          useStore
            .getState()
            .applyShellEvent({ kind: "thread-upserted", sequence: event.sequence, thread });
        }
      }
    });
    return this.delivering;
  }

  listen() {
    this.timer = setInterval(() => void this.deliver(), 100);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  nativeApi(): NativeApi {
    const session = {
      authenticated: true,
      session: { user: { id: "account-a", phoneNumber: "+8613800000000", displayName: "Moss" } },
      activeRealm: "cn",
    };
    const api = {
      orchestration: {
        getShellSnapshot: () => this.shell(),
        dispatchCommand: async (command: Record<string, unknown>) => {
          this.commands.push(command);
          const result = await serverOrchestration("dispatch", { command });
          await this.deliver();
          return result;
        },
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
        getMossAccountSession: async () => session,
        getMossCloudAccountState: async () => ({
          authenticated: false,
          account: null,
          activeRealm: "cn",
        }),
        getMossEnterpriseKeyState: async () => ({ active: false, keyPrefix: null }),
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
      projects: {
        discoverScripts: async () => ({ targets: [] }),
        searchEntries: async () => ({ entries: [] }),
      },
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
    const namespaces = Object.fromEntries(
      Object.entries(api).map(([name, namespace]) => [name, withFallback(namespace)]),
    );
    return new Proxy(namespaces, {
      get: (target, property) => Reflect.get(target, property) ?? withFallback({}),
    }) as unknown as NativeApi;
  }
}

/** What _chat.tsx hands 图像 and 资料空间 as `prepareThread`; 图像 calls it bare to generate. */
function ImagesGenerate() {
  const { prepareActiveThreadForCanvas: prepareThread } = useHandleNewThread();
  return (
    <Button size="sm" onClick={() => void prepareThread()}>
      生成
    </Button>
  );
}

/** A new chat nothing was sent in, as 新对话 leaves it: a draft in the project, then its route. */
async function mountNewChat(
  server: NewChatServer,
  options: { readonly entry: "chat" | "images" },
): Promise<{ readonly threadId: ThreadId; readonly cleanup: () => Promise<void> }> {
  await server.start();
  const threadId = ThreadId.makeUnsafe(`draft-n7-1-${options.entry}-${Date.now()}`);
  useComposerDraftStore.getState().setProjectDraftThreadId(N7_PROJECT_ID, threadId, {
    createdAt: new Date().toISOString(),
    envMode: "local",
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  window.nativeApi = server.nativeApi();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  seedSignedInAccount(client);
  const rootRoute = createRootRoute({ component: Outlet });
  const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$threadId",
    component: () => (
      <SidebarProvider defaultOpen>
        <AppRailSlotProvider value={null}>
          <RealtimeVoiceControllerProvider>
            <ToastProvider>
              <TooltipProvider>
                <div style={{ display: "flex", width: "100vw", height: "100vh" }}>
                  <div
                    data-testid="thread-sidebar"
                    style={{ width: 300, height: "100vh", flexShrink: 0 }}
                  >
                    <ThreadSidebar />
                  </div>
                  <div style={{ display: "flex", flex: 1, minWidth: 0, height: "100vh" }}>
                    {options.entry === "chat" ? (
                      <SingleChatSurface
                        threadId={threadId}
                        search={{}}
                        projectId={N7_PROJECT_ID}
                      />
                    ) : (
                      <ImagesGenerate />
                    )}
                  </div>
                </div>
              </TooltipProvider>
            </ToastProvider>
          </RealtimeVoiceControllerProvider>
        </AppRailSlotProvider>
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([chatRoute]),
    history: createMemoryHistory({ initialEntries: [`/${threadId}`] }),
    defaultPreload: false,
    Wrap: ({ children }) => (
      <QueryClientProvider client={client}>
        <StoreProvider>
          <MossLocalizationProvider localeOverride="zh-CN">{children}</MossLocalizationProvider>
        </StoreProvider>
      </QueryClientProvider>
    ),
  });
  await router.load();
  useStore.getState().syncServerShellSnapshot(await server.shell());
  useStore.getState().setAllProjectsExpanded(true);
  server.listen();
  const screen = await render(<RouterProvider router={router} />);
  return {
    threadId,
    async cleanup() {
      server.stop();
      await screen.unmount();
      router.cancelMatches();
    },
  };
}

/** The chat titles the sidebar shows, with a box a person can see. */
function sidebarChatTitles(): string[] {
  const sidebar = document.querySelector<HTMLElement>('[data-testid="thread-sidebar"]');
  return [...(sidebar?.querySelectorAll<HTMLElement>("[data-sidebar-thread-title]") ?? [])]
    .filter((title) => {
      const box = title.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })
    .map((title) => title.textContent?.trim() ?? "");
}

describe("WALK-7 N7-1: 画布 in a new chat nothing was sent in", () => {
  beforeEach(async () => {
    resetEmbeddedBundleChecks();
    localStorage.clear();
    // The project tree, as the walker's sidebar showed it.
    localStorage.setItem(
      "moss:app-settings:v1",
      JSON.stringify({
        showChatsSection: false,
        showStudioSection: false,
        sidebarProjectSortOrder: "updated_at",
        sidebarThreadSortOrder: "updated_at",
      }),
    );
    const editorServer = import.meta.env.VITE_MOSS_PAGE_EDITOR_TEST_WS_URL as string | undefined;
    if (!editorServer) throw new Error("The real Canvas editor static server is required.");
    vi.stubEnv("VITE_WS_URL", editorServer);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useRightDockStore.setState({ dockStateByThreadId: {} });
    await page.viewport(1440, 900);
  });

  afterEach(async () => {
    await cleanup();
    client?.clear();
    useRightDockStore.setState({ dockStateByThreadId: {} });
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    // The next test starts from a window that knows no chat, as SingleChatSurface.browser.tsx does.
    useStore.setState({
      shellSnapshotSequence: 0,
      spaces: [],
      projects: [],
      threadIds: [],
      threadShellById: {},
      threadSessionById: {},
      threadTurnStateById: {},
      sidebarThreadSummaryById: {},
      threadDetailSyncById: {},
      deletedProjectIdsById: {},
      deletedThreadIdsById: {},
      threadsHydrated: false,
    });
    delete window.nativeApi;
    localStorage.clear();
    vi.unstubAllEnvs();
  });

  it("WALK-7 N7-1: in a new chat nothing was sent in, 画布 opens at once; a drawing is kept and lists the chat", async () => {
    const server = new NewChatServer();
    const mounted = await mountNewChat(server, { entry: "chat" });
    try {
      await vi.waitFor(() => expect(sidebarChatTitles()).toEqual([N7_EXISTING_CHAT]), {
        timeout: 10_000,
      });

      // The walker's steps: the dock of the new chat, then 画布 in its launcher.
      useRightDockStore.getState().setDockOpen(mounted.threadId, true);
      await userEvent.click(page.getByTestId("right-dock-empty-action-canvas"));
      // The board opens; on main the Canvas finds no conversation: 「画布启动失败」.
      await expect
        .poll(
          () =>
            document.body.textContent?.includes("画布启动失败") === true ||
            canvasDocument()?.querySelector(".tl-canvas") != null,
          { timeout: 20_000 },
        )
        .toBe(true);
      expect(document.body.textContent).not.toContain("画布启动失败");
      await waitForCanvasReady();
      const frame = document.querySelector('iframe[title="Moss Canvas"]');

      // Opening 画布 made the chat on the server, marked, and sent nothing.
      expect(server.creates()).toHaveLength(1);
      const create = server.creates()[0]!;
      expect(create).toMatchObject({
        threadId: mounted.threadId,
        projectId: N7_PROJECT_ID,
        listedAfterFirstSend: true,
      });
      expect(server.commands.map((command) => command.type)).not.toContain("thread.turn.start");
      // Opened, nothing drawn: the chat is in no list yet.
      await vi.waitFor(() =>
        expect(useStore.getState().threadShellById?.[mounted.threadId]).toBeDefined(),
      );
      expect(sidebarChatTitles(), "opened, nothing drawn").toEqual([N7_EXISTING_CHAT]);

      await placeText(200);
      await userEvent.keyboard("新对话里画的");
      await userEvent.keyboard("{Escape}");
      const board = () =>
        page.frameLocator(page.getByTitle("Moss Canvas", { exact: true })).getByTestId("canvas");
      await expect.element(board().getByText("新对话里画的", { exact: true })).toBeVisible();
      // Drawn and saved: the server recorded it and the sidebar lists the chat.
      await vi.waitFor(
        () => expect(sidebarChatTitles()).toEqual(expect.arrayContaining([create.title])),
        { timeout: 15_000 },
      );
      expect(sidebarChatTitles()).toContain(N7_EXISTING_CHAT);
      // The board was never loaded again meanwhile.
      expect(document.querySelector('iframe[title="Moss Canvas"]')).toBe(frame);
      expect(document.body.textContent).not.toContain("正在加载画布…");

      // Close the pane from its tab, then open 画布 again: the drawing is there.
      await userEvent.click(page.getByRole("button", { name: "关闭 画布", exact: true }));
      await expect.poll(() => document.querySelector('iframe[title="Moss Canvas"]')).toBeNull();
      // Closing its last pane closes the dock; the person opens the dock again, then 画布.
      await vi.waitFor(() =>
        expect(useRightDockStore.getState().dockStateByThreadId[mounted.threadId]?.open).toBe(
          false,
        ),
      );
      useRightDockStore.getState().setDockOpen(mounted.threadId, true);
      await userEvent.click(page.getByTestId("right-dock-empty-action-canvas"));
      await expect.poll(() => document.querySelector('iframe[title="Moss Canvas"]')).not.toBeNull();
      await waitForCanvasReady();
      await expect
        .element(board().getByText("新对话里画的", { exact: true }), { timeout: 15_000 })
        .toBeVisible();
      expect(server.creates()).toHaveLength(1);
      expect(sidebarChatTitles()).toContain(create.title);
    } finally {
      await mounted.cleanup();
    }
  });

  it("WALK-7 N7-1 scope: 图像 in a new chat makes a chat that is listed at once, as on main", async () => {
    const server = new NewChatServer();
    const mounted = await mountNewChat(server, { entry: "images" });
    try {
      await vi.waitFor(() => expect(sidebarChatTitles()).toEqual([N7_EXISTING_CHAT]), {
        timeout: 10_000,
      });
      await userEvent.click(page.getByRole("button", { name: "生成", exact: true }));
      await vi.waitFor(() => expect(server.creates()).toHaveLength(1), { timeout: 8_000 });
      const create = server.creates()[0]!;
      expect(create.threadId).toBe(mounted.threadId);
      expect(create).not.toHaveProperty("listedAfterFirstSend");
      await vi.waitFor(
        () => expect(sidebarChatTitles()).toEqual(expect.arrayContaining([create.title])),
        { timeout: 10_000 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
