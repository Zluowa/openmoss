// FILE: scheduledTasksRedesign.browser.tsx
// Purpose: Browser verification for the redesigned Scheduled Tasks (定时任务) page and
//          creation dialog: Yours | Templates tabs, + 新建任务 dropdown (让 Moss 帮你建 / 手动设置),
//          empty state (安排任务 + quick-start cards + local hint), 8 linear-icon templates,
//          template prefill, and collapsible 高级设置.
// Layer: Web route browser regression

import "../../index.css";

import { ProjectId, ThreadId } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { ReactNode } from "react";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  handleNewChat: vi.fn(async () => ({ ok: true, threadId: "t-guided" as ThreadId })),
  handleNewThread: vi.fn(async () => "t-guided" as ThreadId),
  definitions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
}));

vi.mock("~/hooks/useHandleNewChat", () => ({
  useHandleNewChat: () => ({ handleNewChat: fixture.handleNewChat }),
}));

vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: fixture.handleNewThread }),
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  ensureNativeApi: () => ({
    automation: {
      list: async () => ({
        definitions: fixture.definitions,
        runs: [],
        memories: [],
      }),
      create: async (input: Record<string, unknown>) => input,
      update: async (input: Record<string, unknown>) => input,
      delete: async () => ({}),
      runNow: async () => ({ run: { id: "r1", threadId: null } }),
    },
    server: {
      getConfig: async () => ({ cwd: "/tmp/project" }),
    },
  }),
}));

vi.mock("~/components/RouteInsetSurface", () => ({
  RouteInsetSurface: ({ children }: { children: ReactNode }) => (
    <div className="flex h-[780px] w-[1120px]">{children}</div>
  ),
}));

vi.mock("~/components/RouteSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/RouteSurface")>()),
  RouteSurfaceHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));

vi.mock("~/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/store")>()),
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      projects: [
        {
          id: ProjectId.makeUnsafe("proj-1"),
          name: "moss-synara",
          cwd: "/tmp/moss-synara",
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        },
      ],
      threads: [],
      threadIds: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    }),
}));

vi.mock("~/appSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/appSettings")>()),
  useAppSettings: () => ({
    settings: {
      locale: "zh-CN",
      hiddenProviders: [],
      providerOrder: [],
    },
  }),
  getProviderStartOptions: () => undefined,
  getProviderInstanceOptions: () => [],
  resolveSelectableProviderInstanceId: () => undefined,
}));

vi.mock("~/localization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/localization")>()),
  useTranslation: () => ({
    locale: "zh-CN",
    t: (key: string) => key,
  }),
}));

vi.mock("~/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    modelOptionsByProvider: {
      codex: [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }],
      claudeAgent: [],
      pi: [],
    },
    modelOptionsByProviderInstance: {},
    loadingModelProviders: {},
    discoveryErrorsByProvider: {},
    runtimeModelsByProvider: {},
    selectedRuntimeModel: undefined,
  }),
}));

vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => [],
}));

import { AutomationsPage } from "~/routes/_chat.automations.index";

beforeEach(() => {
  fixture.definitions = [];
  fixture.navigate.mockReset();
  fixture.handleNewChat.mockClear();
});

afterEach(async () => {
  await cleanup();
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AutomationsPage />
    </QueryClientProvider>,
  );
}

it("renders empty state, switches to 8 linear-icon templates, opens prefilled modal with collapsible advanced settings", async () => {
  await page.viewport(1200, 820);
  await renderPage();

  // Empty state + quiet footer hint
  await expect.element(page.getByRole("heading", { name: "定时任务" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "安排任务" })).toBeVisible();
  await expect.element(page.getByText("本地定时任务仅在电脑开机并联网时运行。")).toBeVisible();

  // New task dropdown exposes both creation modes
  await page.getByRole("button", { name: /新建任务/ }).click();
  await expect.element(page.getByRole("menuitem", { name: "让 Moss 帮你建" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "手动设置" })).toBeVisible();

  // Guided chat creation action
  await page.getByRole("menuitem", { name: "让 Moss 帮你建" }).click();
  expect(fixture.handleNewChat).toHaveBeenCalledWith({ fresh: true });

  // Switch to Templates tab and verify 8 curated work + life cards
  await page.getByRole("tab", { name: "模板" }).click();
  for (const title of [
    "每日简报",
    "邮件分拣",
    "系统健康检查",
    "PR 评审摘要",
    "依赖安全检查",
    "发布说明草稿",
    "价格提醒",
    "周末本地活动安排",
  ]) {
    await expect.element(page.getByRole("button", { name: new RegExp(title) })).toBeVisible();
  }

  // Clicking a template opens the creation modal pre-filled, with Advanced collapsed by default
  await page.getByRole("button", { name: /每日简报/ }).click();
  const dialog = page.getByRole("dialog");
  const titleInput = dialog.getByRole("textbox", { name: "Automation title" });
  await expect.element(titleInput).toHaveValue("每日简报");
  await expect.element(dialog.getByText("项目", { exact: true })).not.toBeInTheDocument();

  // Expanding 高级设置 reveals Project and Model rows
  await dialog.getByRole("button", { name: /高级设置/ }).click();
  await expect.element(dialog.getByText("项目", { exact: true })).toBeVisible();
});
