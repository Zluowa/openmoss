// CLI-native skills found on this computer are adopted into the canonical Moss
// source through the reversible resource-import plan.
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
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  ensureNativeApi: () => ({ provider: api }),
}));

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

  const screen = await renderWithQuery(<MossDetectedResourcesSection cwd="/work" search="" />);
  await expect.element(screen.getByText("On this computer")).toBeVisible();
  await expect.element(screen.getByText("Codex", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Grok", { exact: true })).toBeVisible();

  await screen.getByRole("button", { name: "Use dst-atlas in every agent" }).click();
  await expect
    .poll(() => api.resourceImportPlan.mock.calls[0]?.[0])
    .toEqual({
      cwd: "/work",
      resourceIds: ["skill-0"],
      kinds: ["skill"],
    });
  await expect
    .poll(() => api.resourceImportApply.mock.calls[0]?.[0])
    .toEqual({ cwd: "/work", plan });
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
    <MossDetectedResourcesSettingsList cwd="/work" search="" kind="mcp" />,
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
    .toEqual({ cwd: "/work", resourceIds: ["mcp-claude"], kinds: ["mcp"] });
  await expect
    .poll(() => api.resourceImportApply.mock.calls[0]?.[0])
    .toEqual({ cwd: "/work", plan });
  await screen.unmount();
});

it("Settings shows other CLIs' skills on the Skills tab", async () => {
  api.resourceImportInventory.mockResolvedValue(mixedInventory());
  const screen = await renderWithQuery(
    <MossDetectedResourcesSettingsList cwd="/work" search="" kind="skill" />,
  );
  await expect.element(screen.getByText("Skills from your other CLIs")).toBeVisible();
  await expect.element(screen.getByText("release-notes", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Gemini", { exact: true })).toBeVisible();
  expect(document.body.textContent).not.toContain("linear");
  await screen.unmount();
});

it("a failed import shows a plain line, never the raw error", async () => {
  api.resourceImportInventory.mockResolvedValue(mixedInventory());
  api.resourceImportPlan.mockRejectedValue(new Error("EACCES: /home/u/.claude.json plan-7f3"));
  const add = vi.spyOn(toastManager, "add");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const screen = await renderWithQuery(
    <MossDetectedResourcesSettingsList cwd="/work" search="" kind="mcp" />,
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
    <MossDetectedResourcesSettingsList cwd="/home/u/Documents/Moss" search="" kind="mcp" />,
  );
  await screen.getByRole("button", { name: "Import all 2" }).click();
  await expect
    .poll(() => api.resourceImportPlan.mock.calls[0]?.[0])
    .toEqual({
      cwd: "/home/u/Documents/Moss",
      resourceIds: ["mcp-codex-github", "mcp-claude"],
      kinds: ["mcp"],
    });
  await expect
    .poll(() => api.resourceImportApply.mock.calls[0]?.[0])
    .toEqual({ cwd: "/home/u/Documents/Moss", plan });
  await expect.element(screen.getByText("Imported", { exact: true }).first()).toBeVisible();
  expect(screen.getByRole("button", { name: "Import linear" }).query()).toBeNull();
  expect(screen.getByRole("button", { name: /Import all/u }).query()).toBeNull();
  await screen.unmount();
});

it("Settings marks an item Moss already has as imported", async () => {
  api.resourceImportInventory.mockResolvedValue(mixedInventory());
  api.resourceImportPlan.mockResolvedValue({ plan: { operations: [{ action: "skip" }] } });
  const screen = await renderWithQuery(
    <MossDetectedResourcesSettingsList cwd="/work" search="" kind="mcp" />,
  );
  await screen.getByRole("button", { name: "Import linear" }).click();
  await expect.element(screen.getByText("Imported", { exact: true })).toBeVisible();
  expect(api.resourceImportApply).not.toHaveBeenCalled();
  await screen.unmount();
});
