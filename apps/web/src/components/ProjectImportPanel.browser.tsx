import "../index.css";

import { ProjectId, ThreadId, type ListProjectImportsResult } from "@moss/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({
  listProjectImports: vi.fn(),
  importProject: vi.fn(),
  getShellSnapshot: vi.fn(),
  syncSnapshot: vi.fn(),
}));

// 裸挂载下 localization context 默认 locale=zh-CN（dialog 关闭按钮为「关闭」），
// 本套件断言英文可访问名，统一钉到 en。
vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "en" as const,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("en", key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation("en", key, values),
    }),
  };
});

vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ orchestration: api }) }));
vi.mock("../store", () => ({
  useStore: (select: (state: { syncServerShellSnapshot: typeof api.syncSnapshot }) => unknown) =>
    select({ syncServerShellSnapshot: api.syncSnapshot }),
}));

import { ProjectImportPanel } from "../projectImport/ProjectImportPanel";

const catalog: ListProjectImportsResult = {
  sources: [
    { provider: "codex", error: null },
    { provider: "claudeAgent", error: null },
  ],
  projects: [
    {
      key: "project",
      title: "Moss",
      workspaceRoot: "/code/moss",
      directoryExists: true,
      existingProjectId: ProjectId.makeUnsafe("moss"),
      providers: ["codex", "claudeAgent"],
      threads: [
        {
          key: "first",
          title: "First conversation",
          provider: "codex",
          cwd: "/code/moss",
          archived: false,
          alreadyImported: false,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          key: "second",
          title: "Second conversation",
          provider: "claudeAgent",
          cwd: "/code/moss",
          archived: false,
          alreadyImported: false,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          key: "existing",
          title: "Existing conversation",
          provider: "codex",
          cwd: "/code/moss",
          archived: false,
          alreadyImported: true,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    },
  ],
};
const imported = {
  projectId: ProjectId.makeUnsafe("moss"),
  threadId: ThreadId.makeUnsafe("copy"),
  status: "imported",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listProjectImports.mockResolvedValue(catalog);
  api.importProject.mockReset().mockResolvedValue(imported);
  api.getShellSnapshot.mockResolvedValue({});
});

describe("project import panel", () => {
  it("scans every agent on open and retries only failures without reimporting successful or existing conversations", async () => {
    const onResult = vi.fn();
    const onScanComplete = vi.fn();
    await render(
      <ProjectImportPanel
        onBusyChange={vi.fn()}
        onResult={onResult}
        onScanComplete={onScanComplete}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Import 2 conversations" }))
      .toBeVisible();
    await page.getByRole("button", { name: /Choose projects/ }).click();
    await expect.element(page.getByRole("checkbox", { name: "Select Moss" })).toBeChecked();
    expect(api.listProjectImports).toHaveBeenCalledTimes(1);
    expect(api.listProjectImports).toHaveBeenCalledWith({
      providers: [
        "codex",
        "claudeAgent",
        "cursor",
        "gemini",
        "antigravity",
        "grok",
        "opencode",
        "pi",
        "hermes",
        "devin",
        "omp",
        "zcode",
      ],
    });
    expect(onScanComplete).toHaveBeenCalledWith(true);
    await expect
      .element(
        page.getByText(
          "Not found: Cursor, Gemini, Antigravity, Grok, OpenCode, Pi, Hermes, Devin, Oh My Pi, ZCode.",
        ),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Remove all" }).click();
    await expect
      .element(page.getByRole("button", { name: /^Import \d+ conversations?$/ }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Select all" }).click();
    api.importProject
      .mockResolvedValueOnce(imported)
      .mockRejectedValueOnce(new Error("Temporary provider failure"));
    await page.getByRole("button", { name: "Import 2 conversations" }).click();
    await expect.element(page.getByRole("button", { name: "Retry 1 failed" })).toBeVisible();
    expect(api.importProject.mock.calls.map(([input]) => input.threadKey)).toEqual([
      "first",
      "second",
    ]);
    await page.getByRole("button", { name: "Retry 1 failed" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("2 imported or already present");
    expect(api.importProject.mock.calls.map(([input]) => input.threadKey)).toEqual([
      "first",
      "second",
      "second",
    ]);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("stops starting new imports when asked and offers the rest again", async () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      ...catalog.projects[0]!.threads[0]!,
      key: `thread-${index}`,
      title: `Conversation ${index}`,
    }));
    api.listProjectImports.mockResolvedValue({
      ...catalog,
      projects: [{ ...catalog.projects[0]!, threads: many }],
    });
    const releases: Array<() => void> = [];
    api.importProject.mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve(imported))),
    );
    const onBusyChange = vi.fn();
    await render(<ProjectImportPanel onBusyChange={onBusyChange} />);
    await page.getByRole("button", { name: "Import 20 conversations" }).click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    // The few already in flight finish; nothing new starts.
    for (const release of releases.splice(0)) release();
    await expect.element(page.getByRole("status")).toHaveTextContent("Import stopped");
    const started = api.importProject.mock.calls.length;
    expect(started).toBeLessThan(20);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    api.importProject.mockResolvedValue(imported);
    await page.getByRole("button", { name: `Import ${20 - started} conversations` }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("20 imported or already present");
    expect(new Set(api.importProject.mock.calls.map(([input]) => input.threadKey)).size).toBe(20);
  });

  it("submits a relink path while preserving the original project identity", async () => {
    api.listProjectImports.mockResolvedValue({
      ...catalog,
      projects: [{ ...catalog.projects[0], directoryExists: false }],
    });
    await render(<ProjectImportPanel onBusyChange={vi.fn()} />);
    await page.getByRole("button", { name: /Choose projects/ }).click();
    await page.getByLabelText("New folder for Moss").fill("/code/moved");
    await page.getByRole("button", { name: "Import 2 conversations" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("2 imported or already present");
    expect(
      api.importProject.mock.calls
        .map(([input]) => input)
        .toSorted((a, b) => a.threadKey.localeCompare(b.threadKey)),
    ).toEqual([
      { projectKey: "project", threadKey: "first", workspaceRoot: "/code/moved", spaceId: null },
      { projectKey: "project", threadKey: "second", workspaceRoot: "/code/moved", spaceId: null },
    ]);
  });

  it("skips a conversation that can't be imported with one quiet line and no retry", async () => {
    const longTitle =
      `Investigate the import pipeline ${"with a very long prompt tail ".repeat(20)}`.trim();
    api.importProject.mockResolvedValueOnce(imported).mockRejectedValueOnce({
      _tag: "WsRpcError",
      message: "Moss couldn't read this conversation's files.",
      code: "PROJECT_IMPORT_FAILED",
      retryable: false,
    });
    api.listProjectImports.mockResolvedValue({
      ...catalog,
      projects: [
        {
          ...catalog.projects[0]!,
          threads: [
            catalog.projects[0]!.threads[0]!,
            { ...catalog.projects[0]!.threads[1]!, title: longTitle },
          ],
        },
      ],
    });
    await render(<ProjectImportPanel onBusyChange={vi.fn()} />);
    await page.getByRole("button", { name: "Import 2 conversations" }).click();

    const summary = page.getByRole("button", { name: "1 conversation couldn't be imported" });
    await expect.element(summary).toBeVisible();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("1 imported or already present");
    // Trying again can't help, so nothing offers to; the raw error never shows.
    await expect.element(page.getByRole("button", { name: /^Retry/ })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /^Import \d+ conversations?$/ }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText(/EISDIR|stat 'E:'/)).not.toBeInTheDocument();

    await summary.click();
    const failures = page.getByRole("list", { name: "Import failures" });
    const failureTitle = `Moss · ${longTitle}`;
    const title = failures.getByText(failureTitle, { exact: true });
    await expect.element(title).toHaveClass("line-clamp-1");
    await expect.element(title).toHaveAttribute("title", failureTitle);
    await expect
      .element(failures.getByText("Moss couldn't read this conversation's files."))
      .toBeVisible();
  });

  it("offers a retry only for failures that trying again can fix", async () => {
    api.importProject.mockRejectedValueOnce(new Error("socket closed")).mockRejectedValueOnce({
      _tag: "WsRpcError",
      message: "The conversation file is no longer on this computer.",
      code: "PROJECT_IMPORT_FAILED",
      retryable: false,
    });
    await render(<ProjectImportPanel onBusyChange={vi.fn()} />);
    await page.getByRole("button", { name: "Import 2 conversations" }).click();
    await expect.element(page.getByRole("button", { name: "Retry 1 failed" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "2 conversations couldn't be imported" }))
      .toBeVisible();
    api.importProject.mockResolvedValue(imported);
    await page.getByRole("button", { name: "Retry 1 failed" }).click();
    await expect.element(page.getByRole("button", { name: /^Retry/ })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "1 conversation couldn't be imported" }))
      .toBeVisible();
    expect(api.importProject).toHaveBeenCalledTimes(3);
  });

  it("leaves projects in a temp folder unticked and doesn't ask about missing folders in onboarding", async () => {
    api.listProjectImports.mockResolvedValue({
      ...catalog,
      projects: [
        catalog.projects[0]!,
        {
          ...catalog.projects[0]!,
          key: "temp",
          title: "omb-acp-memory-wE8Uer",
          workspaceRoot: "C:\\Users\\me\\AppData\\Local\\Temp\\omb-acp-memory-wE8Uer",
          directoryExists: false,
          temporary: true,
          existingProjectId: null,
          threads: [{ ...catalog.projects[0]!.threads[0]!, key: "temp-check" }],
        },
      ],
    });
    await render(<ProjectImportPanel onBusyChange={vi.fn()} relinkMissingFolders={false} />);
    await expect
      .element(page.getByRole("button", { name: "Import 2 conversations" }))
      .toBeVisible();
    await page.getByRole("button", { name: /Choose projects/ }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "Select omb-acp-memory-wE8Uer" }))
      .not.toBeChecked();
    await expect.element(page.getByText("History only")).toBeVisible();
    await expect.element(page.getByText("Folder unavailable")).not.toBeInTheDocument();
    await expect
      .element(page.getByLabelText("New folder for omb-acp-memory-wE8Uer"))
      .not.toBeInTheDocument();
  });
});

describe("agents found on this computer", () => {
  it("ticks every agent that has conversations and leaves out an agent the person unticks", async () => {
    await render(<ProjectImportPanel onBusyChange={vi.fn()} />);
    const group = page.getByRole("group", { name: "Agents found on this computer" });
    await expect.element(group.getByRole("checkbox", { name: "Codex" })).toBeChecked();
    await expect.element(group.getByRole("checkbox", { name: "Claude Code" })).toBeChecked();
    await expect.element(group).toHaveTextContent("Codex2");
    await group.getByRole("checkbox", { name: "Claude Code" }).click();
    await page.getByRole("button", { name: "Import 1 conversation" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("1 imported or already present");
    expect(api.importProject.mock.calls.map(([input]) => input.threadKey)).toEqual(["first"]);
  });

  it("names conversations it found but can't copy, instead of calling the agent missing", async () => {
    api.listProjectImports.mockResolvedValue({
      ...catalog,
      unreadable: [{ provider: "antigravity", conversationCount: 2, reason: "encrypted" }],
    });
    await render(<ProjectImportPanel onBusyChange={vi.fn()} />);
    const note = page.getByText(
      "Not found: Cursor, Gemini, Grok, OpenCode, Pi, Hermes, Devin, Oh My Pi, ZCode · 2 can't be copied (Antigravity).",
    );
    await expect.element(note).toBeVisible();
    await expect
      .element(note)
      .toHaveAttribute(
        "title",
        "Found 2 Antigravity conversations that can't be copied: Antigravity keeps them encrypted.",
      );
  });

  it("says plainly when no agent on this computer has conversations", async () => {
    api.listProjectImports.mockResolvedValue({
      sources: [{ provider: "codex", error: null }],
      projects: [],
    });
    const onScanComplete = vi.fn();
    await render(<ProjectImportPanel onBusyChange={vi.fn()} onScanComplete={onScanComplete} />);
    await expect
      .element(page.getByText("No conversations from other agents were found on this computer."))
      .toBeVisible();
    expect(onScanComplete).toHaveBeenCalledWith(false);
  });

  it("says plainly that a scan failed, without the raw error", async () => {
    api.listProjectImports.mockRejectedValue(new Error("disk unavailable"));
    await render(<ProjectImportPanel onBusyChange={vi.fn()} />);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not look for conversations on this computer.");
    await expect.element(page.getByRole("button", { name: "Scan again" })).toBeEnabled();
  });
});

describe("hosted primary action", () => {
  it("hands the import action to the host instead of drawing its own button", async () => {
    const onPrimaryActionChange = vi.fn();
    await render(
      <ProjectImportPanel onBusyChange={vi.fn()} onPrimaryActionChange={onPrimaryActionChange} />,
    );
    await expect
      .poll(() => onPrimaryActionChange.mock.calls.at(-1)?.[0]?.label)
      .toBe("Import 2 conversations");
    await expect
      .element(page.getByRole("button", { name: "Import 2 conversations" }))
      .not.toBeInTheDocument();
    onPrimaryActionChange.mock.calls.at(-1)?.[0]?.run();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("2 imported or already present");
    expect(onPrimaryActionChange.mock.calls.at(-1)?.[0]).toBeNull();
  });
});

describe("project import dialog dismissal", () => {
  it("keeps the dialog open during a durable import and permits closing afterwards", async () => {
    const { ProjectImportDialog } = await import("../projectImport/ProjectImportDialog");
    const { useProjectImportDialogStore } =
      await import("../projectImport/projectImportDialogStore");
    let finishImport: ((value: typeof imported) => void) | undefined;
    api.importProject.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        }),
    );
    useProjectImportDialogStore.getState().openDialog();
    await page.viewport(1100, 850);
    // The dialog reads agent detection, as it does inside the app's query provider.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    await render(
      <QueryClientProvider client={queryClient}>
        <ProjectImportDialog />
      </QueryClientProvider>,
    );
    await page.getByRole("button", { name: /Choose projects/ }).click();
    await page.getByRole("button", { name: "Conversations in Moss" }).click();
    await page.getByRole("button", { name: "Import 2 conversations" }).click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(useProjectImportDialogStore.getState().isOpen).toBe(true);
    finishImport?.(imported);
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("2 imported or already present");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(useProjectImportDialogStore.getState().isOpen).toBe(false);
  });
});
