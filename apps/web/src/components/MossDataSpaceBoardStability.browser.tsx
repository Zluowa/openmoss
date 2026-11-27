import "../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  PageId,
  ProjectId,
  type NativeApi,
  type PageTypedItem,
} from "@moss/contracts";
import { emptyItemData, type TypedItemKind } from "@moss/shared/spaceItems/itemData";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useTheme, type ThemeMode } from "~/hooks/useTheme";
import { MossLocalizationProvider } from "~/localization";
import { resetEmbeddedBundleChecks } from "~/lib/embeddedBundleCheck";
import { readMossImagesAccountIdentity } from "~/lib/mossImagesAccountBoundary";
import { artifactAssistantThreadKey, pageAssistantThreads } from "~/lib/pageAi/pageAssistantThread";
import { pagesQueryKeys } from "~/lib/pagesReactQuery";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { useStore } from "~/store";
import { initialState } from "~/storeState";
import { createDataSpaceFixture, pageDocument } from "~/test/mossDataSpaceFixture";
import { mossServerQueryKeys } from "./auth/mossServerReactQuery";
import { MossDataSpaceDestination } from "./MossDataSpaceDestination";
import { SPACE_DOCK_PERSIST_KEYS } from "./space/spaceCanvasDockContract";
import { markWelcomeOffered } from "./space/welcome/spaceWelcome";
import { TooltipProvider } from "./ui/tooltip";

const SHOTS = import.meta.env.VITE_MOSS_PAGE_EDITOR_SHOTS as string | undefined;

let fixture: ReturnType<typeof createDataSpaceFixture>;
let client: QueryClient;
let previousApi: NativeApi | undefined;
let originalFetch: typeof window.fetch;
let assistantThreadGetCount = 0;
let threadCreateDispatchCount = 0;
let typedItems: Map<PageId, PageTypedItem>;

function seedTypedItem(id: string, kind: TypedItemKind, title: string) {
  const doc = pageDocument(id, title, title);
  const pageWithKind = { ...doc.page, kind };
  fixture.put({ ...doc, page: pageWithKind });
  const item: PageTypedItem = {
    page: pageWithKind,
    kind,
    data: emptyItemData(kind, { pageKey: id, title }),
    dataRevision: 1,
  };
  typedItems.set(pageWithKind.id, item);
  return item;
}

function buildBoardTestApi(): NativeApi {
  const base = fixture.api as unknown as Record<string, unknown>;
  const baseServer = (base.server ?? {}) as Record<string, unknown>;
  const api = {
    ...base,
    pageTypes: {
      read: vi.fn(async ({ pageId }: { pageId: PageId }) => {
        const found = typedItems.get(pageId);
        if (!found) throw new Error(`Missing typed item: ${pageId}`);
        return structuredClone(found);
      }),
      create: vi.fn(async () => {
        throw new Error("Unexpected create");
      }),
      save: vi.fn(async ({ pageId, data }: { pageId: PageId; data: string }) => {
        const existing = typedItems.get(pageId);
        if (!existing) throw new Error(`Missing typed item: ${pageId}`);
        const updated: PageTypedItem = {
          ...existing,
          data,
          dataRevision: (existing.dataRevision ?? 0) + 1,
          page: { ...existing.page, revision: existing.page.revision + 1 },
        };
        typedItems.set(pageId, updated);
        return structuredClone(updated);
      }),
      dashboard: {
        query: vi.fn(async () => ({ rows: [], columns: [], total: 0 })),
        report: vi.fn(async () => ({ ok: true })),
      },
      templates: {
        list: vi.fn(async () => ({ templates: [] })),
        save: vi.fn(async () => {
          throw new Error("Unexpected template save");
        }),
      },
    },
    orchestration: {
      getSnapshot: vi.fn(async () => ({ snapshotSequence: 0, projects: [], threads: [] })),
      getShellSnapshot: vi.fn(async () => ({
        snapshotSequence: 0,
        projects: [],
        threadShells: [],
      })),
      getThreadDetailSnapshot: vi.fn(async () => ({ thread: null })),
      searchThreads: vi.fn(async () => ({ threads: [] })),
      dispatchCommand: vi.fn(async (command: { type?: string }) => {
        if (command?.type === "thread.create") {
          await new Promise((resolve) => setTimeout(resolve, 15));
          threadCreateDispatchCount += 1;
        }
        return { sequence: threadCreateDispatchCount + 1 };
      }),
      importThread: vi.fn(async () => {
        throw new Error("Unexpected importThread");
      }),
      replayEvents: vi.fn(async () => []),
      onDomainEvent: vi.fn(() => () => undefined),
    },
    projects: {
      searchEntries: vi.fn(async () => ({ entries: [], truncated: false })),
      writeFile: vi.fn(async () => ({ relativePath: "" })),
      readFile: vi.fn(async () => ({ contents: "" })),
    },
    terminal: {
      list: vi.fn(async () => ({ sessions: [] })),
      open: vi.fn(async () => ({})),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      restart: vi.fn(async () => ({})),
      onEvent: vi.fn(() => () => undefined),
    },
    server: {
      ...baseServer,
      getProviderStatuses: vi.fn(async () => ({
        providers: [],
      })),
    },
  };
  return api as unknown as NativeApi;
}

function ThemeSync({ mode }: { readonly mode: ThemeMode }) {
  const { setTheme } = useTheme();
  useEffect(() => {
    setTheme(mode);
  }, [mode, setTheme]);
  return null;
}

async function mountSpace(themeMode: ThemeMode = "light") {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    session: {
      user: { id: fixture.state.account, phoneNumber: "+8613800000000", displayName: null },
    },
    activeRealm: "cn",
  });
  markWelcomeOffered(readMossImagesAccountIdentity(client));
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <TooltipProvider>
            <ThemeSync mode={themeMode} />
            <div style={{ height: "100vh", display: "flex" }}>
              <Outlet />
            </div>
          </TooltipProvider>
        </MossLocalizationProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <MossDataSpaceDestination
        onClose={() => undefined}
        onStartConversation={async () => undefined}
        onStartPageConversation={async () => undefined}
      />
    ),
  });
  const otherRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills",
    component: () => <div data-testid="other-route">Other Destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, otherRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await render(<RouterProvider router={router} />);
  await expect
    .element(page.getByRole("navigation").getByRole("button", { name: "全部", exact: true }))
    .toBeVisible();
  return router;
}

async function openSpaceItemByTitle(title: string) {
  await page
    .getByRole("region", { name: "最近", exact: true })
    .getByRole("button", { name: title, exact: true })
    .click();
}

async function shot(name: string) {
  if (SHOTS) {
    const dir = SHOTS.replace(/\/+$/u, "");
    await page.screenshot({ path: `${dir}/${name}.png` });
  }
}

function clearAssistantBindings() {
  for (const kind of ["board", "sheet", "page"] as const) {
    for (const id of ["board-1", "sheet-1", "page-one"]) {
      pageAssistantThreads.forget(artifactAssistantThreadKey("account-a", null, kind, id));
    }
  }
}

describe("Data Space Whiteboard + Dock stability in real Chromium", () => {
  beforeEach(async () => {
    resetEmbeddedBundleChecks();
    previousApi = window.nativeApi;
    originalFetch = window.fetch.bind(window);
    assistantThreadGetCount = 0;
    threadCreateDispatchCount = 0;
    typedItems = new Map();

    const editorServer = import.meta.env.VITE_MOSS_PAGE_EDITOR_TEST_WS_URL as string | undefined;
    if (!editorServer) {
      throw new Error("The real Canvas editor static server is required for Board browser checks.");
    }
    vi.stubEnv("VITE_WS_URL", editorServer);

    localStorage.clear();
    localStorage.setItem("moss:server-settings-migrated:v1", "1");
    clearAssistantBindings();
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });

    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.includes("/api/moss/pages/") && url.includes("/assistant-thread")) {
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        if (method === "GET") {
          assistantThreadGetCount += 1;
          return new Response(JSON.stringify({ defaultAssistantThreadId: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;

    fixture = createDataSpaceFixture();
    seedTypedItem("board-1", "board", "架构白板");
    seedTypedItem("sheet-1", "sheet", "预算表");
    fixture.put(pageDocument("page-one", "Research page", "Saved page content"));
    window.nativeApi = buildBoardTestApi();

    useStore.setState({
      ...initialState,
      projects: [
        {
          id: ProjectId.makeUnsafe("project-a"),
          kind: "project",
          name: "Project A",
          cwd: "D:/fixture",
          remoteName: "Project A",
          folderName: "fixture",
          localName: null,
          expanded: true,
          scripts: [],
          spaceId: null,
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        },
      ],
    });
    await page.viewport(1440, 960);
  });

  afterEach(async () => {
    await cleanup();
    await client?.cancelQueries();
    client?.clear();
    window.fetch = originalFetch;
    clearAssistantBindings();
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState(initialState);
    if (previousApi) window.nativeApi = previousApi;
    else delete window.nativeApi;
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    vi.unstubAllEnvs();
  });

  it("opens Whiteboard with PiP Dock without thread-creation storm and toggles smoothly", async () => {
    localStorage.setItem(SPACE_DOCK_PERSIST_KEYS.mode, "pip");
    await mountSpace();
    await openSpaceItemByTitle("架构白板");

    const canvasIframe = page.getByTitle("Moss Canvas", { exact: true });
    await expect.element(canvasIframe).toBeVisible();
    await expect.element(page.getByText("画布启动失败")).not.toBeInTheDocument();
    // The panel stays closed until asked, whatever mode was used last.
    expect(document.querySelector("[data-space-canvas-dock='pip']")).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "问 Moss", exact: true }));
    await expect
      .element(page.getByRole("complementary", { name: "Moss 画布助手浮窗", exact: true }))
      .toBeVisible();

    const frameEl = document.querySelector<HTMLIFrameElement>('iframe[title="Moss Canvas"]');
    expect(frameEl?.src).toContain("moss_board=board-1");

    // Let timers, ResizeObserver, Canvas bootstrap, and auto-prepare settle to prove zero infinite storm.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect.element(page.getByText("画布启动失败")).not.toBeInTheDocument();

    expect(assistantThreadGetCount).toBeLessThanOrEqual(1);
    expect(threadCreateDispatchCount).toBeLessThanOrEqual(1);
    expect(
      Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId).length,
    ).toBeLessThanOrEqual(1);

    await shot("whiteboard-dock-pip-light");

    // Confirm controls stay responsive across PiP -> Docked -> Collapsed -> PiP.
    await userEvent.click(page.getByRole("button", { name: "停靠到右侧分栏", exact: true }));
    await expect
      .poll(() => document.querySelector("[data-space-canvas-dock='docked']") !== null)
      .toBe(true);

    // Closed: nothing is left floating over the board.
    await userEvent.click(page.getByRole("button", { name: "问 Moss", exact: true }));
    await expect
      .poll(() => document.querySelector("[data-space-canvas-dock='docked']") === null)
      .toBe(true);
    expect(document.querySelector("[data-space-canvas-dock='collapsed']")).toBeNull();

    await userEvent.click(page.getByRole("button", { name: "问 Moss", exact: true }));
    await expect
      .element(page.getByRole("complementary", { name: "Moss 画布助手浮窗", exact: true }))
      .toBeVisible();
  });

  it("keeps Docked Whiteboard iframe mounted without churn across 5s poll refetches (dark mode)", async () => {
    localStorage.setItem(SPACE_DOCK_PERSIST_KEYS.mode, "docked");

    await mountSpace("dark");
    await openSpaceItemByTitle("架构白板");

    const canvasIframe = page.getByTitle("Moss Canvas", { exact: true });
    await expect.element(canvasIframe).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "问 Moss", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "停靠到右侧分栏", exact: true }));
    await expect
      .poll(() => document.querySelector("[data-space-canvas-dock='docked']") !== null)
      .toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect.element(page.getByText("画布启动失败")).not.toBeInTheDocument();
    const iframeBefore = document.querySelector<HTMLIFrameElement>('iframe[title="Moss Canvas"]');
    expect(iframeBefore).not.toBeNull();
    const getsBefore = assistantThreadGetCount;
    const dispatchesBefore = threadCreateDispatchCount;

    await shot("whiteboard-dock-docked-dark");

    // Simulate two background list poll cycles.
    await client.invalidateQueries({ queryKey: pagesQueryKeys.list("account-a", null) });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await client.invalidateQueries({ queryKey: pagesQueryKeys.list("account-a", null) });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const iframeAfter = document.querySelector<HTMLIFrameElement>('iframe[title="Moss Canvas"]');
    expect(iframeAfter).toBe(iframeBefore);
    expect(assistantThreadGetCount).toBe(getsBefore);
    expect(threadCreateDispatchCount).toBe(dispatchesBefore);
  });

  it("navigates away from Whiteboard and switches artifacts rapidly without blocking 100s", async () => {
    localStorage.setItem(SPACE_DOCK_PERSIST_KEYS.mode, "pip");
    const router = await mountSpace();

    await openSpaceItemByTitle("架构白板");
    await expect.element(page.getByTitle("Moss Canvas", { exact: true })).toBeVisible();

    const backStart = performance.now();
    await userEvent.click(page.getByRole("button", { name: "返回资料空间", exact: true }));
    await expect
      .element(page.getByRole("main", { name: "资料空间内容", exact: true }))
      .toBeVisible();
    await expect.poll(() => document.querySelector('iframe[title="Moss Canvas"]')).toBeNull();
    expect(performance.now() - backStart).toBeLessThan(2_000);

    // Re-open Whiteboard then switch to Sheet without hanging.
    await openSpaceItemByTitle("架构白板");
    await expect.element(page.getByTitle("Moss Canvas", { exact: true })).toBeVisible();
    const switchStart = performance.now();
    await openSpaceItemByTitle("预算表");
    await expect.poll(() => document.querySelector('iframe[title="Moss Canvas"]')).toBeNull();
    expect(performance.now() - switchStart).toBeLessThan(2_000);

    // Re-open Whiteboard then leave via TanStack Router (exercises useBlocker requestFlush).
    await openSpaceItemByTitle("架构白板");
    await expect.element(page.getByTitle("Moss Canvas", { exact: true })).toBeVisible();
    const routeStart = performance.now();
    await router.navigate({ to: "/skills" });
    await expect.element(page.getByTestId("other-route")).toBeVisible();
    expect(performance.now() - routeStart).toBeLessThan(2_000);
  });
});
