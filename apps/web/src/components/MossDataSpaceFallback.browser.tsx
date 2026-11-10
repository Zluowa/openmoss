import "../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, ProjectId, type NativeApi } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossDataSpaceDestination } from "./MossDataSpaceDestination";
import { TooltipProvider } from "./ui/tooltip";
import { MossLocalizationProvider } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { mossServerQueryKeys } from "./auth/mossServerReactQuery";
import { useStore } from "~/store";
import { initialState } from "~/storeState";
import { createDataSpaceFixture, pageDocument } from "~/test/mossDataSpaceFixture";

let fixture: ReturnType<typeof createDataSpaceFixture>;
let client: QueryClient;
let previousApi: NativeApi | undefined;

function account(id: string) {
  client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    session: { user: { id } },
    activeRealm: "cn",
  });
}

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  account(fixture.state.account);
  const route = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MossLocalizationProvider>
          <TooltipProvider>
            <div style={{ height: "100vh", display: "flex" }}>
              <MossDataSpaceDestination
                onClose={() => undefined}
                onStartConversation={async () => undefined}
                onStartPageConversation={async () => undefined}
              />
            </div>
          </TooltipProvider>
        </MossLocalizationProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await render(<RouterProvider router={router} />);
  await expect
    .element(page.getByRole("navigation").getByRole("button", { name: "全部", exact: true }))
    .toBeVisible();
}

describe("Page recovery when the Canvas bundle cannot connect", () => {
  beforeEach(async () => {
    previousApi = window.nativeApi;
    vi.stubEnv("VITE_WS_URL", "ws://127.0.0.1:1");
    fixture = createDataSpaceFixture();
    window.nativeApi = fixture.api;
    localStorage.clear();
    localStorage.setItem("moss:server-settings-migrated:v1", "1");
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
    await page.viewport(1440, 1000);
  });
  afterEach(async () => {
    await cleanup();
    await client?.cancelQueries();
    client?.clear();
    useStore.setState(initialState);
    if (previousApi) window.nativeApi = previousApi;
    else delete window.nativeApi;
    localStorage.clear();
    vi.unstubAllEnvs();
  });

  it("keeps metadata operations, Markdown fallback and closing available", async () => {
    fixture.put(pageDocument());
    await mount();
    const titleMenu = async (entry: string) => {
      await page.getByRole("button", { name: "Research page 页面菜单", exact: true }).click();
      await page.getByRole("menuitem", { name: entry, exact: true }).click();
    };
    await page
      .getByRole("region", { name: "最近", exact: true })
      .getByRole("button", { name: "Research page", exact: true })
      .click();
    await expect.element(page.getByRole("alert")).toHaveTextContent(/页面编辑器尚未连接/);
    await page.screenshot({ path: "__screenshots__/qa-editor-unavailable.png" });
    await titleMenu("编辑 Markdown 源码");
    await page.getByRole("button", { name: "Research page 页面菜单", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "返回文档编辑", exact: true }))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    await page.screenshot({ path: "__screenshots__/qa-editor-markdown-recovery.png" });
    await titleMenu("置顶");
    await page.getByRole("button", { name: "Research page 页面菜单", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "取消置顶", exact: true }))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(fixture.mutate).toHaveBeenCalled();
    await page.getByRole("button", { name: "全部", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "页面标题", exact: true }))
      .not.toBeInTheDocument();
  });
});
