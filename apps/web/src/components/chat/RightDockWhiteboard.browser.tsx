import "../../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, ThreadId } from "@moss/contracts";
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
import { useTheme, type ThemeMode } from "~/hooks/useTheme";
import { getConversationImageComposer } from "~/lib/conversationImageComposer";
import { resetEmbeddedBundleChecks } from "~/lib/embeddedBundleCheck";
import { reloadMossCanvas } from "~/lib/mossCanvasBridge";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { MossLocalizationProvider, useTranslation } from "~/localization";
import {
  createDefaultRightDockState,
  openPaneInState,
  type RightDockThreadState,
} from "~/rightDockStore.logic";
import { ConversationImageWorkspace } from "./ConversationImageWorkspace";
import { RightDock } from "./RightDock";
import { RIGHT_DOCK_ADD_MENU_KINDS, resolveRightDockLauncherItems } from "./rightDockPaneMeta";

const SHOTS = import.meta.env.VITE_MOSS_PAGE_EDITOR_SHOTS as string | undefined;
const THREAD_ID = ThreadId.makeUnsafe("right-dock-whiteboard-thread");

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
        <div className="space-y-2">
          <div className="text-ui-sm font-medium text-foreground">打开右栏白板演示</div>
          <div className="rounded-card border border-border/70 bg-muted/40 p-3 text-ui-xs text-muted-foreground">
            右侧白板可从空面板或 + 菜单直接打开，AI 可通过 MCP 读写并实时同步。
          </div>
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
        onClosePane={(paneId) =>
          setDockState((s) => {
            const panes = s.panes.filter((p) => p.id !== paneId);
            return {
              ...s,
              panes,
              activePaneId: panes[0]?.id ?? null,
            };
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

async function mountDock(themeMode: ThemeMode = "light") {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    session: {
      user: { id: "account-a", phoneNumber: "+8613800000000", displayName: "Moss" },
    },
    activeRealm: "cn",
  });
  client.setQueryData(mossServerQueryKeys.mossCloudAccountState(), {
    authenticated: false,
    account: null,
    activeRealm: "cn",
  });
  client.setQueryData(mossServerQueryKeys.mossEnterpriseKeyState(), {
    active: false,
    keyPrefix: null,
  });

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

async function seedRightDockMcpBoard() {
  const res = await fetch("/api/moss/media/canvas/storage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "test.mossCanvasMutate",
      input: {
        title: "右侧协作白板",
        ops: [
          { op: "clear" },
          { op: "addFrame", key: "f1", name: "方案规划", x: 60, y: 80, w: 720, h: 380 },
          { op: "addNote", key: "n1", text: "接入右侧白板", frame: "f1", color: "yellow" },
          {
            op: "addShape",
            key: "s1",
            geo: "rectangle",
            text: "支持 MCP",
            frame: "f1",
            color: "blue",
          },
          { op: "connect", key: "c1", from: "n1", to: "s1", text: "实时同步" },
        ],
      },
    }),
  });
  expect(res.ok).toBe(true);
  const { result } = (await res.json()) as { result: { revision: string } };
  return result;
}

async function waitForCanvasReady() {
  await expect
    .poll(
      () =>
        document
          .querySelector<HTMLIFrameElement>('iframe[title="Moss Canvas"]')
          ?.contentDocument?.querySelector(".tl-canvas") !== null,
      { timeout: 20_000 },
    )
    .toBe(true);
}

describe("Right-Dock Whiteboard direct open + real Canvas bundle + MCP mutation", () => {
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

  it("exposes Whiteboard in RightDock launcher & + menu, opens side-by-side without blocking chat, and renders MCP shapes in the real Canvas", async () => {
    await mountDock("light");

    // 1. Launcher exposes 白板 alongside terminal, browser, files, sidechat, source control.
    const canvasLauncher = page.getByTestId("right-dock-empty-action-canvas");
    await expect.element(canvasLauncher).toBeVisible();
    await expect.element(canvasLauncher).toHaveTextContent("白板");
    await shot("right-dock-launcher-light");

    // 2. Click 白板 -> opens side-by-side in right dock (chat stays visible, no duplicate top bar).
    await userEvent.click(canvasLauncher);
    const canvasFrame = page.getByTitle("Moss Canvas", { exact: true });
    await expect.element(canvasFrame).toBeVisible();
    await expect.element(page.getByTestId("chat-column")).toBeVisible();
    const chatRect = document
      .querySelector<HTMLElement>("[data-testid='chat-column']")!
      .getBoundingClientRect();
    expect(chatRect.width).toBeGreaterThan(300);
    // Embedded right-dock mode hides MossCanvasWebSurface's standalone "关闭画布" header.
    expect(document.querySelector("button[aria-label='关闭画布']")).toBeNull();

    // 3. Wait for real built open-hoola-canvas iframe ready handshake and check no errors.
    await waitForCanvasReady();
    await expect.element(page.getByText("画布启动失败")).not.toBeInTheDocument();

    // 4. Ordinary chat sends are never blocked while the Whiteboard is open.
    const composerBinding = getConversationImageComposer(THREAD_ID);
    expect(composerBinding).toBeDefined();
    expect(composerBinding?.target).toBeNull();
    expect(await composerBinding!.beforeSend()).toBe(true);

    // 5. "+" menu also exposes 白板.
    await userEvent.click(page.getByRole("button", { name: "添加面板", exact: true }));
    await expect.element(page.getByRole("menuitem", { name: "白板", exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    // 6. Simulate MCP moss_canvas_mutate via server mossCanvasMutate engine and trigger reloadMossCanvas.
    const iframeBeforeReload = document.querySelector('iframe[title="Moss Canvas"]');
    const result = await seedRightDockMcpBoard();
    reloadMossCanvas(THREAD_ID, result.revision);
    await expect
      .poll(() => document.querySelector('iframe[title="Moss Canvas"]') !== iframeBeforeReload)
      .toBe(true);

    // Real Canvas iframe reloads from hosted storage and renders the MCP-drawn shapes.
    const reloadedFrameLocator = page.frameLocator(page.getByTitle("Moss Canvas", { exact: true }));
    await waitForCanvasReady();
    await expect
      .element(reloadedFrameLocator.getByText("方案规划"), { timeout: 15_000 })
      .toBeVisible();
    await expect
      .element(reloadedFrameLocator.getByText("接入右侧白板"), { timeout: 15_000 })
      .toBeVisible();
    await expect
      .element(reloadedFrameLocator.getByText("支持 MCP"), { timeout: 15_000 })
      .toBeVisible();
    await expect.element(page.getByText("画布启动失败")).not.toBeInTheDocument();

    await shot("right-dock-whiteboard-mcp-light");
  });

  it("renders the side-by-side Right-Dock Whiteboard cleanly in dark mode", async () => {
    await mountDock("dark");
    await seedRightDockMcpBoard();
    await userEvent.click(page.getByTestId("right-dock-empty-action-canvas"));
    const canvasFrame = page.getByTitle("Moss Canvas", { exact: true });
    await expect.element(canvasFrame).toBeVisible();
    const frameLocator = page.frameLocator(canvasFrame);
    await waitForCanvasReady();
    await expect.element(frameLocator.getByText("接入右侧白板"), { timeout: 15_000 }).toBeVisible();
    await shot("right-dock-whiteboard-mcp-dark");
  });
});
