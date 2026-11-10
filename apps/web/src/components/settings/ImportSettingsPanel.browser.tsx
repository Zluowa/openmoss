import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ListProjectImportsResult,
  type WorkspaceImportProbeResult,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { MossLocalizationProvider } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { APP_SETTINGS_STORAGE_KEY } from "~/uiLocale";

const api = vi.hoisted(() => ({
  probeWorkspaceImport: vi.fn<(input?: unknown) => Promise<WorkspaceImportProbeResult>>(),
  listProjectImports: vi.fn<(input?: unknown) => Promise<ListProjectImportsResult>>(),
  importProject: vi.fn(),
  getShellSnapshot: vi.fn(),
  syncSnapshot: vi.fn(),
}));

vi.mock("../../nativeApi", async (importOriginal) => {
  const native = () => ({
    server: { probeWorkspaceImport: api.probeWorkspaceImport },
    orchestration: {
      listProjectImports: api.listProjectImports,
      importProject: api.importProject,
      getShellSnapshot: api.getShellSnapshot,
    },
  });
  return {
    ...(await importOriginal<typeof import("../../nativeApi")>()),
    readNativeApi: native,
    ensureNativeApi: native,
  };
});

vi.mock("../../store", () => ({
  useStore: (select: (state: { syncServerShellSnapshot: typeof api.syncSnapshot }) => unknown) =>
    select({ syncServerShellSnapshot: api.syncSnapshot }),
}));

import { ImportSettingsPanel } from "./ImportSettingsPanel";

const thread = (key: string, provider: "pi" | "hermes" | "codex") => ({
  key,
  title: `${provider} conversation`,
  provider,
  cwd: "/code/moss",
  archived: false,
  alreadyImported: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const catalog: ListProjectImportsResult = {
  sources: [
    { provider: "codex", error: null },
    { provider: "pi", error: null },
    { provider: "hermes", error: null },
  ],
  projects: [
    {
      key: "project",
      title: "Moss",
      workspaceRoot: "/code/moss",
      directoryExists: true,
      existingProjectId: null,
      providers: ["codex", "pi", "hermes"],
      threads: [thread("a", "codex"), thread("b", "pi"), thread("c", "hermes")],
    },
  ],
};

const tools: WorkspaceImportProbeResult = {
  sources: [
    {
      source: "claude",
      present: true,
      displayName: "Claude Code",
      skillCount: 3,
      honorAbleSettingCount: 1,
      chatCount: 0,
      olderChatCount: 0,
    },
  ],
  requiresSourceChoice: false,
};

async function renderPanel() {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  return render(
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>
        <ImportSettingsPanel />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
}

describe("Settings → Import", () => {
  afterEach(async () => {
    await cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("lists conversations from the same agents as onboarding and probes only tools", async () => {
    api.listProjectImports.mockResolvedValue(catalog);
    api.probeWorkspaceImport.mockResolvedValue(tools);
    api.getShellSnapshot.mockResolvedValue({});

    await renderPanel();

    await expect.element(page.getByText("对话和项目")).toBeVisible();
    // Agents only the project import scan knows about (onboarding's list).
    await expect.element(page.getByText("Pi", { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText("Hermes", { exact: true }).first()).toBeVisible();
    expect(api.listProjectImports).toHaveBeenCalled();

    // The configuration import below asks for tools only and offers no chats.
    await expect.element(page.getByText("3 个技能 · 1 项设置")).toBeVisible();
    expect(api.probeWorkspaceImport).toHaveBeenCalledWith({ scope: "tools" });
    expect(document.body.textContent).not.toContain("个最近对话");
  });

  it("names what was not read: settings in one section, conversations in the other", async () => {
    api.listProjectImports.mockResolvedValue({
      ...catalog,
      sources: [...catalog.sources, { provider: "cursor", error: null }],
    });
    // Cursor's settings folder could not be read in time, twice.
    api.probeWorkspaceImport.mockResolvedValue({
      sources: [
        ...tools.sources,
        {
          source: "cursor",
          present: true,
          displayName: "Cursor",
          incomplete: true,
          skillCount: 0,
          honorAbleSettingCount: 0,
          chatCount: 0,
          olderChatCount: 0,
        },
      ],
      requiresSourceChoice: true,
    });
    api.getShellSnapshot.mockResolvedValue({});

    await renderPanel();

    await expect
      .element(page.getByText("Cursor 的技能和设置没来得及读完，数量可能偏少。"))
      .toBeVisible();
    // The conversation panel says Cursor was not found (zh: 没有找到); the config note names its settings.
    await expect.element(page.getByText(/^(Not found|没有找到)/u)).toBeVisible();
    expect(api.probeWorkspaceImport).toHaveBeenCalledTimes(2);
  });
});
