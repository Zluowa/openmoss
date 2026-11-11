// CLI-native skills and MCP servers found on this computer are adopted into Moss: per item
// into the open project's canonical source (which the server accepts only with the
// project's registered id), and, in Settings, skills user-wide through the same scan and
// import Settings > Import uses, with no project at all (acceptance 2026-11-11).
import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { toastManager } from "./ui/toast";
import {
  MossDetectedResourcesSection,
  MossDetectedResourcesSettingsList,
} from "./MossDetectedResourcesSection";

const api = vi.hoisted(() => ({
  resourceImportInventory: vi.fn(),
  resourceImportPlan: vi.fn(),
  resourceImportApply: vi.fn(),
}));
const serverApi = vi.hoisted(() => ({
  probeWorkspaceImport: vi.fn(),
  applyWorkspaceImport: vi.fn(),
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  ensureNativeApi: () => ({ provider: api, server: serverApi }),
}));

// A registered project: the server needs its id, not only its folder.
const WORKSPACE = { cwd: "/work", workspaceId: "project-1" };

afterEach(() => {
  vi.clearAllMocks();
});

function renderWithQuery(children: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

it("adopts a skill found in several CLIs into the canonical source", async () => {
  const sha = "a".repeat(64);
  api.resourceImportInventory.mockResolvedValue({
    inventoryId: "inv",
    cwd: "/work",
    generatedAt: "2026-10-28T00:00:00.000Z",
    roots: [],
    issues: [],
    resources: ["codex", "grok"].map((provider, index) => ({
      id: `skill-${index}`,
      kind: "skill",
      provider,
      scope: "user",
      name: "dst-atlas",
      description: "Atlas of things",
      sourcePath: `/home/u/.${provider}/skills/dst-atlas/SKILL.md`,
      sourceSha256: sha,
      sizeBytes: 10,
      format: "markdown",
      secretFields: [],
      warnings: [],
    })),
  });
  const plan = { operations: [{ action: "copy" }] };
  api.resourceImportPlan.mockResolvedValue({ plan });
  api.resourceImportApply.mockResolvedValue({ status: "applied" });

  const screen = await renderWithQuery(
    <MossDetectedResourcesSection workspace={WORKSPACE} search="" />,
  );
  await expect.element(screen.getByText("On this computer")).toBeVisible();
  await expect.element(screen.getByText("Codex", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Grok", { exact: true })).toBeVisible();

  await screen.getByRole("button", { name: "Use dst-atlas in every agent" }).click();
  await expect
    .poll(() => api.resourceImportPlan.mock.calls[0]?.[0])
    .toEqual({
      cwd: "/work",
      workspaceId: "project-1",
      resourceIds: ["skill-0"],
      kinds: ["skill"],
    });
  await expect
    .poll(() => api.resourceImportApply.mock.calls[0]?.[0])
    .toEqual({ cwd: "/work", workspaceId: "project-1", plan });
  expect(api.resourceImportInventory.mock.calls[0]?.[0]).toMatchObject({
    cwd: "/work",
    workspaceId: "project-1",
  });
});

function mixedInventory() {
  const sha = "b".repeat(64);
  const base = {
    scope: "user",
    sourceSha256: sha,
    sizeBytes: 10,
    secretFields: [],
    warnings: [],
  };
  return {
    inventoryId: "inv",
    cwd: "/work",
    generatedAt: "2026-11-10T00:00:00.000Z",
    roots: [],
    issues: [],
    resources: [
      {
        ...base,
        id: "mcp-claude",
        kind: "mcp",
        provider: "claude",
        name: "linear",
        description: "",
        sourcePath: "/home/u/.claude.json",
        format: "json",
      },
      {
        ...base,
        id: "mcp-cursor",
        kind: "mcp",
        provider: "cursor",
        name: "linear",
        description: "",
        sourcePath: "/home/u/.cursor/mcp.json",
        format: "json",
      },
      {
        ...base,
        id: "skill-gemini",
        kind: "skill",
        provider: "gemini",
        name: "release-notes",
        description: "Write release notes",
        sourcePath: "/home/u/.gemini/skills/release-notes/SKILL.md",
        format: "markdown",
      },
    ],
  };
}

it("Settings lists only the tab's kind, without paths, and imports only on Import", async () => {
  api.resourceImportInventory.mockResolvedValue(mixedInventory());
  const plan = { operations: [{ action: "copy" }] };
  api.resourceImportPlan.mockResolvedValue({ plan });
  api.resourceImportApply.mockResolvedValue({ status: "applied" });

  const screen = await renderWithQuery(
    <MossDetectedResourcesSettingsList workspace={WORKSPACE} search="" kind="mcp" />,
  );
  await expect.element(screen.getByText("MCP servers on this computer")).toBeVisible();
  await expect.element(screen.getByText("linear", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Claude", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Cursor", { exact: true })).toBeVisible();
  expect(document.body.textContent).not.toContain("release-notes");
  expect(document.body.textContent).not.toContain("/home/u");
  // Detection is read-only: listing and clicking a row import nothing.
  await screen.getByText("linear", { exact: true }).click();
  expect(api.resourceImportPlan).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Import linear" }).click();
  await expect
    .poll(() => api.resourceImportPlan.mock.calls[0]?.[0])
    .toEqual({
      cwd: "/work",
      workspaceId: "project-1",
      resourceIds: ["mcp-claude"],
      kinds: ["mcp"],
    });
  await expect
    .poll(() => api.resourceImportApply.mock.calls[0]?.[0])
    .toEqual({ cwd: "/work", workspaceId: "project-1", plan });
  await screen.unmount();
});

function skillProbe() {
  const source = (name: string, skillCount: number, present = true) => ({
    source: name,
    present,
    skillCount,
    honorAbleSettingCount: 0,
    chatCount: 0,
    olderChatCount: 0,
  });
  return {
    requiresSourceChoice: false,
    // The owner's machine on 2026-11-11: Claude 3, Cursor 28, Codex 20, Grok 2.
    sources: [
      source("claude", 3),
      source("cursor", 28),
      source("codex", 20),
      source("grok", 2),
      source("opencode", 0, false),
    ],
  };
}

it("Settings lists other apps' skills with no project and imports them user-wide", async () => {
  serverApi.probeWorkspaceImport.mockResolvedValue(skillProbe());
  serverApi.applyWorkspaceImport.mockResolvedValue({
    skills: [
      { name: "a", source: "claude", action: "copied" },
      { name: "b", source: "claude", action: "copied" },
      { name: "c", source: "claude", action: "unchanged" },
    ],
    settings: [],
    clientPreferences: {},
    chats: [],
    connectors: [],
    skippedOlderChatCount: 0,
  });
  const onImported = vi.fn();
  const add = vi.spyOn(toastManager, "add");
  const screen = await renderWithQuery(
    <MossDetectedResourcesSettingsList
      workspace={null}
      search=""
      kind="skill"
      onImported={onImported}
    />,
  );
  await expect.element(screen.getByText("Skills from your other CLIs")).toBeVisible();
  for (const [label, count] of [
    ["Claude Code", 3],
    ["Cursor", 28],
    ["Codex", 20],
    ["Grok", 2],
  ] as const) {
    await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
    await expect.element(screen.getByText(`${count} skills`, { exact: true })).toBeVisible();
  }
  expect(document.body.textContent).not.toContain("OpenCode");
  // The per-project inventory is not involved.
  expect(api.resourceImportInventory).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("button", { name: "Import all 53" })).toBeVisible();

  await screen.getByRole("button", { name: "Import Claude Code" }).click();
  await expect
    .poll(() => serverApi.applyWorkspaceImport.mock.calls[0]?.[0])
    .toEqual({ sources: ["claude"], categories: ["skills"] });
  await expect.poll(() => onImported.mock.calls.length).toBe(1);
  expect(add.mock.calls.at(-1)?.[0]).toMatchObject({
    type: "success",
    title: "Imported 2 skills into Moss for every agent",
  });
  await expect.element(screen.getByText("Imported", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Import all 50" })).toBeVisible();

  await screen.getByRole("button", { name: "Import all 50" }).click();
  await expect
    .poll(() => serverApi.applyWorkspaceImport.mock.calls[1]?.[0])
    .toEqual({ sources: ["cursor", "codex", "grok"], categories: ["skills"] });
  await expect.poll(() => screen.getByText("Imported", { exact: true }).all().length).toBe(4);
  await screen.unmount();
  add.mockRestore();
});

it("Settings MCP tab says in one line that servers import into a project when none is open", async () => {
  const screen = await renderWithQuery(
    <MossDetectedResourcesSettingsList workspace={null} search="" kind="mcp" />,
  );
  await expect
    .element(screen.getByTestId("moss-detected-settings-mcp-needs-project"))
    .toHaveTextContent("Moss keeps MCP servers per project.");
  expect(api.resourceImportInventory).not.toHaveBeenCalled();
  await screen.unmount();
});

it("a failed import shows a plain line, never the raw error", async () => {
  api.resourceImportInventory.mockResolvedValue(mixedInventory());
  api.resourceImportPlan.mockRejectedValue(new Error("EACCES: /home/u/.claude.json plan-7f3"));
  const add = vi.spyOn(toastManager, "add");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const screen = await renderWithQuery(
    <MossDetectedResourcesSettingsList workspace={WORKSPACE} search="" kind="mcp" />,
  );
  await screen.getByRole("button", { name: "Import linear" }).click();
  await expect.poll(() => add.mock.calls.length).toBe(1);
  expect(add.mock.calls[0]?.[0]).toMatchObject({
    type: "error",
    title: "Couldn't add linear to Moss",
    description: "Nothing was changed. Try again in a moment.",
  });
  expect(JSON.stringify(add.mock.calls[0]?.[0])).not.toContain("EACCES");
  await screen.unmount();
  add.mockRestore();
});

it("Settings imports every item at once with Import all, then marks them imported", async () => {
  api.resourceImportInventory.mockResolvedValue({
    ...mixedInventory(),
    resources: [
      ...mixedInventory().resources,
      {
        ...mixedInventory().resources[0]!,
        id: "mcp-codex-github",
        provider: "codex",
        name: "github",
        sourcePath: "/home/u/.codex/config.toml",
        format: "toml",
      },
    ],
  });
  const plan = { operations: [{ action: "copy" }, { action: "copy" }] };
  api.resourceImportPlan.mockResolvedValue({ plan });
  api.resourceImportApply.mockResolvedValue({ status: "applied" });

  const screen = await renderWithQuery(
    <MossDetectedResourcesSettingsList workspace={WORKSPACE} search="" kind="mcp" />,
  );
  await screen.getByRole("button", { name: "Import all 2" }).click();
  await expect
    .poll(() => api.resourceImportPlan.mock.calls[0]?.[0])
    .toEqual({
      cwd: "/work",
      workspaceId: "project-1",
      resourceIds: ["mcp-codex-github", "mcp-claude"],
      kinds: ["mcp"],
    });
  await expect
    .poll(() => api.resourceImportApply.mock.calls[0]?.[0])
    .toEqual({ cwd: "/work", workspaceId: "project-1", plan });
  await expect.element(screen.getByText("Imported", { exact: true }).first()).toBeVisible();
  expect(screen.getByRole("button", { name: "Import linear" }).query()).toBeNull();
  expect(screen.getByRole("button", { name: /Import all/u }).query()).toBeNull();
  await screen.unmount();
});

it("Settings marks an item Moss already has as imported", async () => {
  api.resourceImportInventory.mockResolvedValue(mixedInventory());
  api.resourceImportPlan.mockResolvedValue({ plan: { operations: [{ action: "skip" }] } });
  const screen = await renderWithQuery(
    <MossDetectedResourcesSettingsList workspace={WORKSPACE} search="" kind="mcp" />,
  );
  await screen.getByRole("button", { name: "Import linear" }).click();
  await expect.element(screen.getByText("Imported", { exact: true })).toBeVisible();
  expect(api.resourceImportApply).not.toHaveBeenCalled();
  await screen.unmount();
});
