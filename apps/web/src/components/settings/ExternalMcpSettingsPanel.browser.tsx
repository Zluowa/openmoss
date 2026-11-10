// "Let another agent use Moss": with "Access all of Moss" off, the picker offers projects only,
// never chat containers (Home, standalone chats), studios or groups (acceptance 2026-11-11).
import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ExternalMcpSettingsPanel } from "./ExternalMcpSettingsPanel";

const api = vi.hoisted(() => ({
  server: { listExternalMcpIntegrations: vi.fn() },
  orchestration: { getShellSnapshot: vi.fn() },
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => api,
}));

afterEach(() => {
  vi.clearAllMocks();
});

const NOW = "2026-11-11T00:00:00.000Z";

function container(id: string, kind: string, title: string) {
  return {
    id,
    kind,
    title,
    workspaceRoot: `/work/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

it("lists only real projects when access is limited to selected projects", async () => {
  api.server.listExternalMcpIntegrations.mockResolvedValue([]);
  api.orchestration.getShellSnapshot.mockResolvedValue({
    snapshotSequence: 1,
    spaces: [],
    projects: [
      container("home", "chat", "主页"),
      container("kitten-chat", "chat", "生成一个小猫咪"),
      container("studio", "studio", "Studio"),
      container("group", "group", "Group"),
      container("moss-app", "project", "moss-app"),
      container("site", "project", "site"),
    ],
    threads: [],
    updatedAt: NOW,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ExternalMcpSettingsPanel active />
    </QueryClientProvider>,
  );
  try {
    await expect.element(page.getByText("Access all of Moss")).toBeVisible();
    // The row's switch is the panel's first one (Name has a text field).
    await page.getByRole("switch").first().click();
    await expect.element(page.getByText("moss-app", { exact: true })).toBeVisible();
    await expect.element(page.getByText("site", { exact: true })).toBeVisible();
    for (const notAProject of ["主页", "生成一个小猫咪", "Studio", "Group"]) {
      expect(page.getByText(notAProject, { exact: true }).query()).toBeNull();
    }
  } finally {
    await screen.unmount();
  }
});
