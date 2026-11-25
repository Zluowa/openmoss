// FILE: DashboardAppDockIntegration.browser.tsx
// Purpose: Verifies AppItemView duplicate-bar removal + dock integration and DashboardItemView
//          compact floating pill, dock.ask routing, chart shimmer, live auto-apply and undo.
// Layer: Web dashboard & app browser tests

import "../../../index.css";

import { ProjectId, ThreadId, type NativeApi, type PageTypedItem } from "@moss/contracts";
import {
  createDashboard,
  DASHBOARD_PAGE_FILE,
  type DashboardItem,
} from "@moss/shared/spaceItems/dashboard";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import type { SpaceCanvasDockController } from "~/components/space/spaceCanvasDockContract";
import { MossLocaleScope } from "~/localization";
import { useStore } from "~/store";
import { createDataSpaceFixture, pageDocument } from "~/test/mossDataSpaceFixture";
import { TooltipProvider } from "../../ui/tooltip";
import { AppItemView } from "../app/AppItemView";
import { DashboardItemView } from "./DashboardItemView";

function createDock(busy = false): SpaceCanvasDockController {
  return {
    state: "collapsed",
    setState: vi.fn(),
    activeThreadId: ThreadId.makeUnsafe("dash-thread-1"),
    busy,
    elapsedSeconds: 0,
    statusLabel: null,
    ask: vi.fn(async () => undefined),
    openSideChatTab: vi.fn(),
    selection: null,
    setSelection: vi.fn(),
  };
}

async function mountWithProviders(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const route = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MossLocaleScope locale="zh-CN">
          <TooltipProvider>{node}</TooltipProvider>
        </MossLocaleScope>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

let previousApi: NativeApi | undefined;
const initialStoreSnapshot = useStore.getState();

beforeEach(() => {
  previousApi = window.nativeApi;
});

afterEach(async () => {
  await cleanup();
  useStore.setState(initialStoreSnapshot);
  (window as { nativeApi?: NativeApi | undefined }).nativeApi = previousApi;
});

describe("Dashboard & App dock integration", () => {
  it("renders AppItemView without duplicate inner header bar and lifts host badge + floating ask pill", async () => {
    const dock = createDock(false);
    const onHostActionsChange = vi.fn();
    await mountWithProviders(
      <div style={{ width: 800, height: 480, display: "flex" }}>
        <AppItemView
          pageId="app-1"
          revision={1}
          dataRevision={1}
          title="应用看板"
          data={JSON.stringify({ version: 1, html: "<main>App</main>", capabilities: ["db"] })}
          dock={dock}
          onHostActionsChange={onHostActionsChange}
        />
      </div>,
    );
    expect(onHostActionsChange).toHaveBeenCalled();
    // Old h-10 inner bar is gone; readonly frame fills container.
    expect(document.querySelector("[data-app-item] .border-b")).toBeNull();
    // With a dock, 问 Moss is the one entry in the header; no second one floats over the work.
    await expect.element(page.getByTestId("app-ask-moss")).not.toBeInTheDocument();
  });

  it("auto-applies generated Dashboard draft with one-click undo, shimmer overlay, and dock.ask pill", async () => {
    await page.viewport(1280, 800);
    const fixture = createDataSpaceFixture();
    window.nativeApi = fixture.api;
    const doc = pageDocument("dash-1", "营收看板", "");
    const item: PageTypedItem = {
      page: { ...doc.page, kind: "app" },
      kind: "app",
      data: "",
      dataRevision: 1,
    };
    const base = createDashboard("营收看板");
    const withDraft: DashboardItem = {
      ...base,
      files: {
        [DASHBOARD_PAGE_FILE]: {
          text: "<div><h1>旧看板</h1></div>",
          edit: { via: "person", at: "2026-11-22T00:00:00.000Z" },
        },
      },
      draft: {
        shape: "dashboard",
        at: "2026-11-22T00:01:00.000Z",
        files: {
          [DASHBOARD_PAGE_FILE]: {
            text: "<div><h1>Moss 新看板</h1></div>",
            edit: { via: "moss", at: "2026-11-22T00:01:00.000Z" },
          },
        },
        datasets: {},
      },
    };
    const dock = createDock(false);
    let latestDash: DashboardItem = withDraft;
    const setBusyRef: { current: ((b: boolean) => void) | null } = { current: null };

    function DashHarness() {
      const [dashboard, setDashboard] = useState<DashboardItem>(withDraft);
      const [busy, setBusy] = useState(false);
      setBusyRef.current = setBusy;
      latestDash = dashboard;
      return (
        <DashboardItemView
          account={fixture.state.account}
          scopeSpaceId={null}
          item={item}
          dashboard={dashboard}
          title="营收看板"
          readOnly={false}
          header={<span>营收看板</span>}
          onChange={(next) => {
            latestDash = next;
            setDashboard(next);
          }}
          flush={async () => true}
          revision={() => 1}
          reloadIfChanged={async () => false}
          dock={{ ...dock, busy }}
          hostChrome={{ hideTopBar: true }}
        />
      );
    }

    await mountWithProviders(
      <div style={{ width: 1100, height: 700, display: "flex" }}>
        <DashHarness />
      </div>,
    );

    expect(document.querySelector('[data-testid="dashboard-toolbar"]')).toBeNull();
    // Auto-applied draft immediately onto files & cleared draft.
    await vi.waitFor(() => {
      expect(latestDash.draft).toBeUndefined();
      expect(latestDash.files[DASHBOARD_PAGE_FILE]?.text).toContain("Moss 新看板");
    });

    await expect.element(page.getByTestId("dashboard-undo-moss")).toBeVisible();
    // With a dock, 问 Moss is the one entry in the header; no second one floats over the work.
    await expect.element(page.getByTestId("dashboard-ask-trigger")).not.toBeInTheDocument();

    await page.getByTestId("dashboard-undo-moss").click();
    await vi.waitFor(() => {
      expect(latestDash.files[DASHBOARD_PAGE_FILE]?.text).toContain("旧看板");
    });

    setBusyRef.current?.(true);
    await expect.element(page.getByTestId("dashboard-shimmer")).toBeVisible();
  });

  it("renders dashboard empty prompt, standalone ask composer, and style slider with ui primitives", async () => {
    await page.viewport(1280, 800);
    const fixture = createDataSpaceFixture();
    window.nativeApi = fixture.api;
    const projectId = ProjectId.makeUnsafe("dash-standalone-proj");
    const threadId = ThreadId.makeUnsafe("dash-standalone-thread");
    useStore.setState({
      threadsHydrated: true,
      threadIds: [threadId],
      projects: [
        {
          id: projectId,
          kind: "project",
          name: "Standalone",
          remoteName: "Standalone",
          folderName: "Standalone",
          localName: "Standalone",
          cwd: "/tmp/standalone",
          defaultModelSelection: { provider: "codex", model: "gpt-5.4" },
          expanded: false,
          spaceId: null,
          scripts: [],
        },
      ],
      threadShellById: {
        [threadId]: {
          id: threadId,
          codexThreadId: null,
          projectId,
          title: "Dashboard AI",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          error: null,
          branch: null,
          worktreePath: null,
          createdAt: "2026-11-22T00:00:00.000Z",
          archivedAt: null,
        },
      },
    });
    const doc = pageDocument("dash-empty-1", "空白看板", "");
    const item: PageTypedItem = {
      page: { ...doc.page, kind: "app", sourceThreadId: threadId },
      kind: "app",
      data: "",
      dataRevision: 1,
    };
    const empty = createDashboard("空白看板");

    const mounted = await mountWithProviders(
      <div style={{ width: 1100, height: 700, display: "flex" }}>
        <DashboardItemView
          account={fixture.state.account}
          scopeSpaceId={null}
          item={item}
          dashboard={empty}
          title="空白看板"
          readOnly={false}
          header={<span>空白看板</span>}
          onChange={() => {}}
          flush={async () => true}
          revision={() => 1}
          reloadIfChanged={async () => false}
          dock={null}
        />
      </div>,
    );

    const emptyPrompt = page.getByRole("textbox", { name: "让 Moss 修改这个看板…", exact: true });
    await expect.element(emptyPrompt).toBeVisible();
    expect(emptyPrompt.element().closest('[data-slot="textarea-control"]')).not.toBeNull();

    await page.getByTestId("dashboard-design").click();
    await expect.element(page.getByTestId("dashboard-design-panel")).toBeVisible();
    await page.getByTestId("dashboard-style").getByRole("button").first().click();
    await expect.element(page.getByRole("slider", { name: "文字大小", exact: true })).toBeVisible();

    await mounted.unmount();

    const populated: DashboardItem = {
      ...empty,
      files: {
        [DASHBOARD_PAGE_FILE]: {
          text: "<div><h1>营收</h1></div>",
          edit: { via: "person", at: "2026-11-22T00:00:00.000Z" },
        },
      },
    };
    await mountWithProviders(
      <div style={{ width: 1100, height: 700, display: "flex" }}>
        <DashboardItemView
          account={fixture.state.account}
          scopeSpaceId={null}
          item={item}
          dashboard={populated}
          title="营收看板"
          readOnly={false}
          header={<span>营收看板</span>}
          onChange={() => {}}
          flush={async () => true}
          revision={() => 1}
          reloadIfChanged={async () => false}
          dock={null}
        />
      </div>,
    );

    await page.getByTestId("dashboard-ask-trigger").click();
    const askField = page.getByRole("textbox", { name: "让 Moss 修改这个看板…", exact: true });
    await expect.element(askField).toBeVisible();
    expect(askField.element().closest('[data-slot="textarea-control"]')).not.toBeNull();
  });
});
