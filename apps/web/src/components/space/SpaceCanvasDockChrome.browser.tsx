import "../../index.css";

import { PageId, type Page, type PagesReadResult } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossLocalizationProvider } from "~/localization";
import { initialState } from "~/storeState";
import { useStore } from "~/store";
import { RightDock } from "../chat/RightDock";
import { Button } from "../ui/button";
import { TooltipProvider } from "../ui/tooltip";
import { createDefaultRightDockState } from "~/rightDockStore.logic";
import { PageTopBar } from "../pages/chrome/PageTopBar";
import { BottomComposer } from "../pages/chrome/BottomComposer";
import type { PageChromeContext, PageSidePanel } from "../pages/chrome/pageChromeContext";
import { PageTitleMenu } from "../pages/chrome/PageTitleMenu";
import { SpaceUnifiedTopChrome } from "../spaceTypes/shared/SpaceEditorChrome";
import { PageTextIcon, SlidesIcon } from "~/lib/icons";
import {
  SPACE_DOCK_PERSIST_KEYS,
  type SpaceCanvasDockController,
  type SpaceCanvasDockState,
  type SpaceCanvasSelectionContext,
} from "./spaceCanvasDockContract";
import { SpaceCanvasChatDockHost } from "./SpaceCanvasChatDock";

function makePage(overrides: Partial<Page> = {}): Page {
  return {
    id: PageId.makeUnsafe("page-test-1"),
    title: "产品需求评审",
    kind: "page",
    pinned: false,
    trashedAt: null,
    parentPageId: null,
    spaceId: null,
    scopeSpaceId: null,
    sourceThreadId: null,
    revision: 1,
    assetIds: [],
    automationIds: [],
    icon: null,
    cover: null,
    appearance: null,
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    ...overrides,
  } as Page;
}

async function mountWithProviders(ui: () => React.JSX.Element) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await render(
    <QueryClientProvider client={client}>
      <MossLocalizationProvider localeOverride="zh-CN">
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
  return { client, router };
}

describe("SpaceCanvasDock & Unified Chrome", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    useStore.setState(initialState);
    await page.viewport(1280, 800);
  });

  afterEach(async () => {
    window.localStorage.clear();
    await cleanup();
  });

  it("renders unified 44px PageTopBar (TOC + 问 Moss) and centered Docs BottomComposer floating pill without navigating", async () => {
    const askSpy = vi.fn<(_req?: unknown) => Promise<void>>(async () => undefined);
    const docStyleCalls: Array<Record<string, unknown>> = [];

    function Harness() {
      const [activePanel, setActivePanel] = useState<PageSidePanel | null>(null);
      const [dockState, setDockState] = useState<SpaceCanvasDockState>("collapsed");
      const [selection, setSelection] = useState<SpaceCanvasSelectionContext | null>(null);
      const pageObj = makePage();
      const dock: SpaceCanvasDockController = {
        state: dockState,
        setState: setDockState,
        activeThreadId: null,
        busy: false,
        elapsedSeconds: 0,
        statusLabel: "问 Moss",
        ask: async (req) => {
          setDockState("pip");
          await askSpy(req);
        },
        openSideChatTab: () => setDockState("docked"),
        selection,
        setSelection,
      };
      const doc: PagesReadResult = {
        page: pageObj,
        content: "# 概述",
      };
      const context: PageChromeContext = {
        account: "test-acct",
        scopeSpaceId: null,
        page: pageObj,
        document: doc,
        readOnly: false,
        isCurrent: () => true,
        flush: async () => true,
        refresh: async () => undefined,
        activePanel,
        openPanel: setActivePanel,
        createChildPage: () => undefined,
        dock,
        tocOpen: activePanel === "navigation",
        onToggleToc: () => setActivePanel((p) => (p === "navigation" ? null : "navigation")),
      };

      return (
        <div className="flex h-screen flex-col">
          <PageTopBar
            context={context}
            saveState="saved"
            titleMenu={
              <PageTitleMenu
                title={pageObj.title}
                icon={PageTextIcon}
                pinned={false}
                trashed={false}
                sourceEditing={false}
                onNavigation={() => undefined}
                onShare={() => undefined}
                onTogglePin={() => undefined}
                onRename={() => undefined}
                onDuplicate={() => undefined}
                onDownload={() => undefined}
                onOpenInNewWindow={() => undefined}
                onActivity={() => undefined}
                onFiles={() => undefined}
                onContinueInChat={() => undefined}
                onBackupDrafts={() => undefined}
                onTrash={() => undefined}
              />
            }
          />
          <div
            className="flex-1"
            data-panel-state={activePanel ?? "none"}
            data-dock-state={dockState}
          />
          <BottomComposer
            context={context}
            docStyle={{ width: "default", headingFont: "sans", textFont: "sans" }}
            onDocStyle={(patch) => docStyleCalls.push(patch)}
          />
        </div>
      );
    }

    const { router } = await mountWithProviders(() => <Harness />);

    const topBar = page.getByRole("toolbar", { name: "页面工具栏", exact: true });
    await expect.element(topBar).toBeVisible();
    const topBarRect = (topBar.element() as HTMLElement).getBoundingClientRect();
    expect(Math.round(topBarRect.height)).toBe(44);

    // Toggle TOC (`目录大纲`)
    await topBar.getByRole("button", { name: "目录大纲", exact: true }).click();
    expect(document.querySelector("[data-panel-state]")?.getAttribute("data-panel-state")).toBe(
      "navigation",
    );

    // Bottom floating pill toolbar controls (`字体`, `更多操作`, `评论`, `问 Moss`)
    const bottomToolbar = page.getByRole("toolbar", { name: "文档底部工具栏", exact: true });
    await expect.element(bottomToolbar).toBeVisible();
    await bottomToolbar.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "加宽页面", exact: true }).click();
    expect(docStyleCalls).toEqual([{ width: "wide" }]);

    // One 问 Moss per screen: the top bar's. It opens the dock in place, without navigating.
    await expect
      .element(bottomToolbar.getByRole("button", { name: "问 Moss", exact: true }))
      .not.toBeInTheDocument();
    await topBar.getByRole("button", { name: "问 Moss", exact: true }).click();
    expect(askSpy).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe("/");
  });

  it("renders unified 44px SpaceUnifiedTopChrome with host actions and Dock toggle", async () => {
    const askSpy = vi.fn();
    function Harness() {
      const dock: SpaceCanvasDockController = {
        state: "collapsed",
        setState: () => undefined,
        activeThreadId: null,
        busy: true,
        elapsedSeconds: 4,
        statusLabel: "已处理 4秒",
        ask: () => askSpy(),
        openSideChatTab: () => undefined,
        selection: null,
        setSelection: () => undefined,
      };
      return (
        <SpaceUnifiedTopChrome
          icon={SlidesIcon}
          onBack={() => undefined}
          titleSlot={<span>Q4 季度规划</span>}
          hostActions={<span data-testid="lifted-actions">演练工具</span>}
          dock={dock}
        />
      );
    }

    await mountWithProviders(() => <Harness />);
    const bar = page.getByRole("toolbar", { name: "画布工具栏", exact: true });
    await expect.element(bar).toBeVisible();
    expect(Math.round((bar.element() as HTMLElement).getBoundingClientRect().height)).toBe(44);
    await expect.element(page.getByTestId("lifted-actions")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "问 Moss", exact: true }))
      .toHaveTextContent("已处理 4秒");
  });

  it("preserves single-instance Portal DOM subtree across collapsed -> pip -> docked transitions and snaps on right edge", async () => {
    function PortalHarness() {
      const containerRef = useRef<HTMLDivElement | null>(null);
      return (
        <div ref={containerRef} style={{ width: 1200, height: 800, position: "relative" }}>
          <SpaceCanvasChatDockHost
            artifact={{
              kind: "slides",
              itemId: "deck-1",
              title: "年度汇报",
              scopeSpaceId: null,
              account: "acct-1",
            }}
            containerRef={containerRef}
            keepItemOpen
          >
            {(dock) => (
              <div className="flex flex-1 flex-col items-start gap-2 p-4">
                <span data-testid="dock-mode">{dock.state}</span>
                <Button
                  size="xs"
                  variant="outline"
                  data-testid="open-pip"
                  onClick={() => dock.setState("pip")}
                >
                  Open PiP
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  data-testid="open-docked"
                  onClick={() => dock.setState("docked")}
                >
                  Open Docked
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  data-testid="collapse-dock"
                  onClick={() => dock.setState("collapsed")}
                >
                  Collapse
                </Button>
              </div>
            )}
          </SpaceCanvasChatDockHost>
        </div>
      );
    }

    await mountWithProviders(() => <PortalHarness />);

    const portalHost = document.querySelector<HTMLElement>(
      "[data-space-canvas-portal-host='true']",
    );
    expect(portalHost).not.toBeNull();
    // Switch collapsed -> pip -> docked -> collapsed and assert the EXACT same DOM node moves without remount.
    await userEvent.click(page.getByTestId("open-pip"));
    await expect.element(page.getByTestId("dock-mode")).toHaveTextContent("pip");
    const pipHost = document.querySelector<HTMLElement>("[data-space-canvas-portal-host='true']");
    expect(pipHost).toBe(portalHost);
    const pipPanel = document.querySelector<HTMLElement>("[data-space-canvas-dock='pip']");
    expect(pipPanel).not.toBeNull();
    expect(pipPanel!.parentElement).not.toBeNull();

    // Verify starter textarea inside Portal keeps draft across PiP <-> Docked <-> Collapsed!
    const starterInput = page.getByRole("textbox", { name: "向 Moss 提问", exact: true });
    await starterInput.fill("生成三页产品规划摘要");

    await userEvent.click(page.getByTestId("open-docked"));
    await expect.element(page.getByTestId("dock-mode")).toHaveTextContent("docked");
    const dockedHost = document.querySelector<HTMLElement>(
      "[data-space-canvas-portal-host='true']",
    );
    expect(dockedHost).toBe(portalHost);
    await expect
      .element(page.getByRole("textbox", { name: "向 Moss 提问", exact: true }))
      .toHaveValue("生成三页产品规划摘要");

    // Drag PiP header to right edge (`<= 80px`) to inspect SVG snap indicator and snap into docked.
    await userEvent.click(page.getByTestId("open-pip"));
    const header = document.querySelector<HTMLElement>("[data-space-dock-pip-header]")!;
    const headerRect = header.getBoundingClientRect();
    header.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientX: headerRect.left + 20,
        clientY: headerRect.top + 10,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: 1185,
        clientY: headerRect.top + 10,
      }),
    );
    await expect
      .poll(() =>
        document
          .querySelector("[data-floating-chat-drop-indicator='right-pane'] svg")
          ?.getAttribute("viewBox"),
      )
      .toBe("0 0 32 184");
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 1,
        clientX: 1185,
        clientY: headerRect.top + 10,
      }),
    );
    await expect.element(page.getByTestId("dock-mode")).toHaveTextContent("docked");

    // Persist dock mode under Stage-0 key
    expect(window.localStorage.getItem(SPACE_DOCK_PERSIST_KEYS.mode)).toBe("docked");
  });

  it("supports RightDock parent split containerMode, pinned unclosable tab, 300ms close-lock, and <320px auto-collapse", async () => {
    const collapsedSpy = vi.fn();
    function RightDockHarness() {
      const [panes, setPanes] = useState([
        {
          id: "primary",
          kind: "file" as const,
          filePath: "primary.md",
          threadId: null,
          diffTurnId: null,
          diffFilePath: null,
          pullRequestProjectId: null,
          pullRequestRepository: null,
          pullRequestNumber: null,
          pullRequestInitialTab: null,
        },
        {
          id: "extra-1",
          kind: "file" as const,
          filePath: "extra-1.md",
          threadId: null,
          diffTurnId: null,
          diffFilePath: null,
          pullRequestProjectId: null,
          pullRequestRepository: null,
          pullRequestNumber: null,
          pullRequestInitialTab: null,
        },
        {
          id: "extra-2",
          kind: "file" as const,
          filePath: "extra-2.md",
          threadId: null,
          diffTurnId: null,
          diffFilePath: null,
          pullRequestProjectId: null,
          pullRequestRepository: null,
          pullRequestNumber: null,
          pullRequestInitialTab: null,
        },
      ]);
      const [open, setOpen] = useState(true);
      const hostRef = useRef<HTMLDivElement | null>(null);
      const state = {
        ...createDefaultRightDockState(),
        open,
        activePaneId: panes[0]?.id ?? null,
        panes,
      };
      return (
        <div ref={hostRef} className="relative flex" style={{ width: 1000, height: 600 }}>
          <div className="flex-1">Main</div>
          <RightDock
            state={state}
            minWidth={320}
            defaultWidth={400}
            shouldAcceptWidth={() => true}
            containerMode="parent"
            layoutHostRef={hostRef}
            windowControlsGutterClassName=""
            paneLabelOverrides={{ primary: "主文档", "extra-1": "临时 1", "extra-2": "临时 2" }}
            addMenuKinds={[]}
            pinnedPaneIds={new Set(["primary"])}
            tabCloseLockMs={300}
            collapseBelowMinWidthPx={320}
            onSelectPane={() => undefined}
            onClosePane={(id) => setPanes((list) => list.filter((entry) => entry.id !== id))}
            onCollapse={() => {
              setOpen(false);
              collapsedSpy();
            }}
            onOpenChange={setOpen}
            onAddPane={() => undefined}
            renderPane={(pane) => <div data-testid={`pane-${pane.id}`}>{pane.id}</div>}
          />
        </div>
      );
    }

    await mountWithProviders(() => <RightDockHarness />);
    // Pinned primary tab must not render a close button, while extra-1 has one.
    const primaryChip = document.querySelector("[data-right-dock-tab-id='primary']");
    const extraChip = document.querySelector("[data-right-dock-tab-id='extra-1']");
    expect(primaryChip?.querySelectorAll("button").length).toBe(1);
    const extraClose = extraChip?.querySelector<HTMLButtonElement>("button[aria-label]");
    expect(extraClose).not.toBeNull();
    extraClose!.click();
    await expect.element(page.getByText("临时 2")).toBeVisible();
    expect(document.querySelector("[data-right-dock-tab-id='extra-1']")).toBeNull();
    expect(document.querySelector("[data-right-dock-tab-id='extra-2']")).not.toBeNull();
    expect(document.querySelector("[data-tab-close-locked='true']")).not.toBeNull();

    // Drag seam rightwards past <320px to trigger auto-collapse callback.
    const rail = document.querySelector<HTMLElement>("[data-slot='sidebar-rail']")!;
    rail.setPointerCapture = () => undefined;
    rail.releasePointerCapture = () => undefined;
    rail.hasPointerCapture = () => false;
    const railRect = rail.getBoundingClientRect();
    rail.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 2,
        clientX: railRect.left,
        clientY: railRect.top + 40,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 2,
        clientX: railRect.left + 400,
        clientY: railRect.top + 40,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 2,
        clientX: railRect.left + 400,
        clientY: railRect.top + 40,
      }),
    );
    await expect.poll(() => collapsedSpy.mock.calls.length).toBe(1);
  });

  it("closes the floating 问 Moss panel with × and with Esc, and leaves no pill behind", async () => {
    function CloseHarness() {
      const containerRef = useRef<HTMLDivElement | null>(null);
      return (
        <div ref={containerRef} style={{ width: 1200, height: 800, position: "relative" }}>
          <SpaceCanvasChatDockHost
            artifact={{
              kind: "sheet",
              itemId: "sheet-1",
              title: "预算表",
              scopeSpaceId: null,
              account: "acct-1",
            }}
            containerRef={containerRef}
            keepItemOpen
          >
            {(dock) => (
              <div className="flex flex-1 flex-col items-start gap-2 p-4">
                <span data-testid="dock-mode">{dock.state}</span>
                <Button size="xs" data-space-dock-toggle onClick={() => dock.setState("pip")}>
                  问 Moss
                </Button>
              </div>
            )}
          </SpaceCanvasChatDockHost>
        </div>
      );
    }
    await mountWithProviders(() => <CloseHarness />);
    const panel = () => document.querySelector<HTMLElement>("[data-space-canvas-dock='pip']");
    const pill = () => document.querySelector<HTMLElement>("[data-space-canvas-dock='collapsed']");
    // Opened and closed with ×.
    await userEvent.click(page.getByRole("button", { name: "问 Moss", exact: true }));
    await expect.poll(() => panel()?.getBoundingClientRect().width ?? 0).toBeGreaterThan(200);
    await userEvent.click(page.getByRole("button", { name: "关闭", exact: true }));
    await expect.element(page.getByTestId("dock-mode")).toHaveTextContent("collapsed");
    expect(panel()).toBeNull();
    expect(pill(), "nothing is left floating over the item").toBeNull();
    // Opened again and closed with Esc while focus stays on the toggle.
    await userEvent.click(page.getByRole("button", { name: "问 Moss", exact: true }));
    await expect.poll(() => panel()?.getBoundingClientRect().width ?? 0).toBeGreaterThan(200);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByTestId("dock-mode")).toHaveTextContent("collapsed");
    expect(panel()).toBeNull();
    expect(pill()).toBeNull();
  });

  it("opens every item with the 问 Moss panel closed, even after it was open on the last one", async () => {
    localStorage.setItem(SPACE_DOCK_PERSIST_KEYS.mode, "pip");
    function SwitchHarness() {
      const containerRef = useRef<HTMLDivElement | null>(null);
      const [itemId, setItemId] = useState("deck-1");
      return (
        <div ref={containerRef} style={{ width: 1200, height: 800, position: "relative" }}>
          <SpaceCanvasChatDockHost
            artifact={{
              kind: "slides",
              itemId,
              title: itemId,
              scopeSpaceId: null,
              account: "acct-1",
            }}
            containerRef={containerRef}
            keepItemOpen
          >
            {(dock) => (
              <div className="flex flex-1 flex-col items-start gap-2 p-4">
                <Button size="xs" data-space-dock-toggle onClick={() => dock.setState("pip")}>
                  问 Moss
                </Button>
                <Button size="xs" onClick={() => setItemId("deck-2")}>
                  下一个
                </Button>
              </div>
            )}
          </SpaceCanvasChatDockHost>
        </div>
      );
    }
    await mountWithProviders(() => <SwitchHarness />);
    const panel = () => document.querySelector<HTMLElement>("[data-space-canvas-dock='pip']");
    // Not opened by the mode used last time.
    expect(panel()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "问 Moss", exact: true }));
    await expect.poll(() => panel()?.getBoundingClientRect().width ?? 0).toBeGreaterThan(200);
    await userEvent.click(page.getByRole("button", { name: "下一个", exact: true }));
    await expect.poll(() => panel()).toBeNull();
    expect(document.querySelector("[data-space-canvas-dock='collapsed']")).toBeNull();
  });

  it("keeps dock.setSelection and registerHostInsets idempotent across child useEffect([dock]) re-renders", async () => {
    let effectRuns = 0;

    function LoopGuardChild({ dock }: { readonly dock: SpaceCanvasDockController }) {
      const [insets, setInsets] = useState({ bottomInsetPx: 0, rightInsetPx: 0 });
      useEffect(() => {
        effectRuns += 1;
        dock.setSelection({
          kind: "page",
          itemId: "p1",
          title: "Loop Guard",
        });
      }, [dock]);

      useEffect(() => {
        if (!dock.registerHostInsets) return undefined;
        return dock.registerHostInsets((next) => setInsets(next));
      }, [dock]);

      return (
        <div data-testid="loop-guard-child">
          <span data-testid="loop-guard-title">{dock.selection?.title ?? "none"}</span>
          <span data-testid="loop-guard-insets">
            {insets.bottomInsetPx},{insets.rightInsetPx}
          </span>
        </div>
      );
    }

    function HostHarness() {
      const containerRef = useRef<HTMLDivElement | null>(null);
      return (
        <div ref={containerRef} style={{ width: 1000, height: 700 }} className="relative flex">
          <SpaceCanvasChatDockHost
            artifact={{
              kind: "page",
              itemId: "p1",
              title: "Loop Guard",
              scopeSpaceId: null,
              account: "local",
            }}
            containerRef={containerRef}
          >
            {(dock) => <LoopGuardChild dock={dock} />}
          </SpaceCanvasChatDockHost>
        </div>
      );
    }

    await mountWithProviders(() => <HostHarness />);
    await expect.element(page.getByTestId("loop-guard-title")).toHaveTextContent("Loop Guard");
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(effectRuns).toBeLessThanOrEqual(4);
  });
});
