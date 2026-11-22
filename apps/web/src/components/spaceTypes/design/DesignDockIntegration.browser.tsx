// FILE: DesignDockIntegration.browser.tsx
// Purpose: Verifies Design bottom floating pill, host chrome hiding, dock.ask routing, live
//          artboard shimmer, gliding blue Moss caret, and standalone ask fallback.
// Layer: Web design browser tests

import "../../../index.css";

import { ProjectId, ThreadId, type NativeApi, type PageTypedItem } from "@moss/contracts";
import { parseDesignCanvas } from "@moss/shared/spaceItems/designCanvas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import type { SpaceCanvasDockController } from "~/components/space/spaceCanvasDockContract";
import { MossLocalizationProvider } from "~/localization";
import { useStore } from "~/store";
import { createDataSpaceFixture, pageDocument } from "~/test/mossDataSpaceFixture";
import { TooltipProvider } from "../../ui/tooltip";
import { DesignEditor } from "./DesignEditor";

const fixtureCanvas = parseDesignCanvas({
  version: 1,
  pages: [{ id: "page-1", name: "页面 1" }],
  boards: [
    {
      id: "home",
      name: "首页",
      x: 0,
      y: 0,
      w: 390,
      h: 844,
      html: '<div style="width:390px;height:844px"><h1>设计</h1></div>',
    },
  ],
  notes: [],
});

function createDock(busy = false): SpaceCanvasDockController {
  return {
    state: "collapsed",
    setState: vi.fn(),
    activeThreadId: ThreadId.makeUnsafe("design-thread-1"),
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
        <MossLocalizationProvider localeOverride="zh-CN">
          <TooltipProvider>{node}</TooltipProvider>
        </MossLocalizationProvider>
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

describe("DesignEditor dock & floating pill", () => {
  it("hides top bar under hostChrome, routes bottom pill 问 Moss to dock.ask, and draws presence caret", async () => {
    await page.viewport(1360, 840);
    const fixture = createDataSpaceFixture();
    window.nativeApi = fixture.api;
    const doc = pageDocument("design-page-1", "移动端设计", "");
    const item: PageTypedItem = {
      page: { ...doc.page, kind: "design" },
      kind: "design",
      data: JSON.stringify(fixtureCanvas),
      dataRevision: 1,
    };
    const dock = createDock(false);
    const onHostActionsChange = vi.fn();

    const mounted = await mountWithProviders(
      <div style={{ width: 1200, height: 760, display: "flex" }}>
        <DesignEditor
          account={fixture.state.account}
          scopeSpaceId={null}
          item={item}
          canvas={fixtureCanvas}
          title="移动端设计"
          readOnly={false}
          epoch={0}
          onChange={() => {}}
          flush={async () => true}
          revision={() => 1}
          dock={dock}
          hostChrome={{ hideTopBar: true }}
          onHostActionsChange={onHostActionsChange}
        />
      </div>,
    );

    expect(document.querySelector("[data-design-topbar]")).toBeNull();
    expect(onHostActionsChange).toHaveBeenCalled();
    await expect.element(page.getByTestId("design-tool-select")).toBeVisible();
    await expect.element(page.getByTestId("design-tool-frame")).toBeVisible();
    expect(document.querySelector("[data-design-bottom-pill]")).not.toBeNull();

    await page.getByTestId("design-ask").click();
    expect(dock.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "bottom-pill",
        prefillOnly: true,
        keepItemOpen: true,
        selection: expect.objectContaining({
          kind: "design",
          itemId: "design-page-1",
        }),
      }),
    );
    expect(document.querySelector("[data-design-ask]")).toBeNull();

    await mounted.unmount();

    await mountWithProviders(
      <div style={{ width: 1200, height: 760, display: "flex" }}>
        <DesignEditor
          account={fixture.state.account}
          scopeSpaceId={null}
          item={item}
          canvas={fixtureCanvas}
          title="移动端设计"
          readOnly={false}
          epoch={0}
          onChange={() => {}}
          flush={async () => true}
          revision={() => 1}
          dock={createDock(true)}
          hostChrome={{ hideTopBar: true }}
        />
      </div>,
    );
    await vi.waitFor(() => {
      const el = document.querySelector("[data-design-moss-presence='true']");
      expect(el?.textContent).toContain("Moss · 正在思考...");
      expect(document.querySelector("[data-design-artboard-shimmer='true']")).not.toBeNull();
    });
  });

  it("falls back to compact standalone ask popover when dock is null", async () => {
    await page.viewport(1360, 840);
    const fixture = createDataSpaceFixture();
    window.nativeApi = fixture.api;
    const projectId = ProjectId.makeUnsafe("design-standalone-proj");
    const threadId = ThreadId.makeUnsafe("design-standalone-thread");
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
          title: "Design AI",
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
    const doc = pageDocument("design-page-2", "独立设计", "");
    const item: PageTypedItem = {
      page: { ...doc.page, kind: "design", sourceThreadId: threadId },
      kind: "design",
      data: JSON.stringify(fixtureCanvas),
      dataRevision: 1,
    };

    await mountWithProviders(
      <div style={{ width: 1200, height: 760, display: "flex" }}>
        <DesignEditor
          account={fixture.state.account}
          scopeSpaceId={null}
          item={item}
          canvas={fixtureCanvas}
          title="独立设计"
          readOnly={false}
          epoch={0}
          onChange={() => {}}
          flush={async () => true}
          revision={() => 1}
          dock={null}
        />
      </div>,
    );

    expect(document.querySelector("[data-design-topbar]")).not.toBeNull();
    await page.getByTestId("design-ask").click();
    expect(document.querySelector("[data-design-ask]")).not.toBeNull();
  });
});
