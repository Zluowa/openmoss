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
import {
  flushConversationImageEditors,
  getConversationImageComposer,
} from "~/lib/conversationImageComposer";
import { resetEmbeddedBundleChecks } from "~/lib/embeddedBundleCheck";
import { getMossCanvasLiveEditor } from "~/lib/mossCanvasLiveEditors";
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
    const editor = await vi.waitFor(() => {
      const ready = getMossCanvasLiveEditor(THREAD_ID);
      expect(ready).not.toBeNull();
      return ready!;
    });

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
