// FILE: SpaceCanvasDockSync.browser.tsx
// Purpose: WALK-1 S-3. The 问 Moss panel of an opened 资料空间 item shows its conversation, not
//          「正在加载对话」 forever. A conversation's detail syncs only when the app root selects it
//          (resolveThreadDetailSubscriptionLeaseIds, as routes/__root.tsx does); the panel must make
//          the root select its conversation.
// Layer: Web component tests
// Why the stand-in: the panel's real pane is a full ChatView with app-wide providers; here a light
//      pane shows the same loading state from the same store field, and a small "root" syncs exactly
//      the threads the real lease rule selects.

import "../../index.css";

import { ProjectId, ThreadId } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { artifactAssistantThreadKey, pageAssistantThreads } from "~/lib/pageAi/pageAssistantThread";
import { MossLocalizationProvider } from "~/localization";
import { useStore } from "~/store";
import { initialState } from "~/storeState";
import {
  getRetainedThreadDetailIdsSnapshot,
  resolveThreadDetailSubscriptionLeaseIds,
  subscribeRetainedThreadDetailIds,
} from "~/threadDetailSubscriptionRetention";
import { Button } from "../ui/button";
import { TooltipProvider } from "../ui/tooltip";
import { SpaceCanvasChatDockHost } from "./SpaceCanvasChatDock";

const THREAD = ThreadId.makeUnsafe("thread-sheet-panel");
const PROJECT = ProjectId.makeUnsafe("project-home");

vi.mock("../chat/SidechatDockPane", () => ({
  // Same loading state as the real pane's ChatView: shown until the thread's detail has synced.
  SidechatDockPane: (props: { pane: { threadId?: string | null } }) => {
    const synced = useStore(
      (state) => state.threadDetailSyncById?.[props.pane.threadId as ThreadId] === "synced",
    );
    return synced ? (
      <div data-testid="panel-conversation">对话</div>
    ) : (
      <div aria-label="Loading conversation" role="status">
        正在加载对话
      </div>
    );
  },
}));

/** The app root's part: open a detail stream (here: mark synced) for each thread it selects. */
function FakeRoot() {
  useEffect(() => {
    const sync = () => {
      const selected = resolveThreadDetailSubscriptionLeaseIds({
        visibleThreadIds: [],
        retainedThreadIds: getRetainedThreadDetailIdsSnapshot(),
        serverThreadIds: new Set([THREAD]),
        draftThreadIds: new Set(),
      });
      if (!selected.includes(THREAD)) return;
      useStore.setState((state) => ({
        threadDetailSyncById: { ...state.threadDetailSyncById, [THREAD]: "synced" },
      }));
    };
    sync();
    return subscribeRetainedThreadDetailIds(sync);
  }, []);
  return null;
}

function Harness() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={containerRef} style={{ width: 1200, height: 800, position: "relative" }}>
      <FakeRoot />
      <SpaceCanvasChatDockHost
        artifact={{
          kind: "sheet",
          itemId: "sheet-9",
          title: "预算表",
          scopeSpaceId: null,
          account: "acct-1",
        }}
        containerRef={containerRef}
        keepItemOpen
      >
        {(dock) => (
          <Button size="xs" data-space-dock-toggle onClick={() => dock.setState("pip")}>
            问 Moss
          </Button>
        )}
      </SpaceCanvasChatDockHost>
    </div>
  );
}

describe("问 Moss panel conversation sync", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await page.viewport(1280, 800);
    useStore.setState({
      ...initialState,
      projects: [{ id: PROJECT, spaceId: null, name: "Moss", cwd: "/home" } as never],
      sidebarThreadSummaryById: {
        [THREAD]: { id: THREAD, projectId: PROJECT, title: "预算表", archivedAt: null } as never,
      },
    });
    pageAssistantThreads.set(
      artifactAssistantThreadKey("acct-1", null, "sheet", "sheet-9"),
      THREAD,
    );
  });

  afterEach(async () => {
    window.localStorage.clear();
    await cleanup();
  });

  it("shows the item's conversation in the panel, not 正在加载对话", async () => {
    const router = createRouter({
      routeTree: createRootRoute({ component: Harness }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(page.getByRole("button", { name: "问 Moss", exact: true }));
    const panel = page.getByRole("complementary", { name: "Moss 画布助手浮窗", exact: true });
    await expect.element(panel).toBeVisible();
    await expect.element(panel.getByTestId("panel-conversation")).toBeVisible();
    await expect.element(panel.getByText("正在加载对话")).not.toBeInTheDocument();
  });
});
