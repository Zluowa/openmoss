import "../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, type WorkspaceImportProbeResult } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { MossLocalizationProvider } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { APP_SETTINGS_STORAGE_KEY } from "~/uiLocale";

const nativeApi = vi.hoisted(() => ({
  probeWorkspaceImport: vi.fn<() => Promise<WorkspaceImportProbeResult>>(),
}));

vi.mock("../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => ({
    server: { probeWorkspaceImport: nativeApi.probeWorkspaceImport },
  }),
}));

import { WorkspaceImportFlow } from "./WorkspaceImportFlow";

const RAW_TIMEOUT =
  "WebSocket RPC server.workspaceImport.probe 等待 60000 毫秒后超时。服务器没有及时完成这个请求。";

function source(
  overrides: Partial<WorkspaceImportProbeResult["sources"][number]>,
): WorkspaceImportProbeResult["sources"][number] {
  return {
    source: "claude",
    present: true,
    displayName: "Claude Code",
    skillCount: 1,
    honorAbleSettingCount: 0,
    chatCount: 12,
    olderChatCount: 0,
    projectCount: 2,
    ...overrides,
  };
}

async function renderFlow() {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  return render(
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>
        <WorkspaceImportFlow variant="panel" />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
}

describe("WorkspaceImportFlow probe errors", () => {
  afterEach(async () => {
    await cleanup();
    nativeApi.probeWorkspaceImport.mockReset();
    localStorage.clear();
  });

  it("shows a short message instead of the RPC timeout, and 重试 probes again", async () => {
    // The first look and its automatic second look both fail; 重试 then succeeds.
    nativeApi.probeWorkspaceImport
      .mockRejectedValueOnce(new Error(RAW_TIMEOUT))
      .mockRejectedValueOnce(new Error(RAW_TIMEOUT))
      .mockResolvedValueOnce({ sources: [source({})], requiresSourceChoice: false });

    await renderFlow();

    await expect.element(page.getByText("没能读取本地 AI 应用的数据。")).toBeVisible();
    expect(document.body.textContent).not.toContain("server.workspaceImport.probe");
    expect(document.body.textContent).not.toContain("毫秒后超时");

    await page.getByRole("button", { name: "重试" }).click();

    await expect.element(page.getByText("Claude Code").first()).toBeVisible();
    expect(nativeApi.probeWorkspaceImport).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).not.toContain("没能读取本地 AI 应用的数据。");
  });

  it("lists finished sources and says which ones were not read in full", async () => {
    nativeApi.probeWorkspaceImport.mockResolvedValue({
      sources: [
        source({}),
        source({ source: "codex", displayName: "Codex", chatCount: 0, incomplete: true }),
      ],
      requiresSourceChoice: true,
    });

    await renderFlow();

    await expect.element(page.getByText("Codex 的数据没来得及读完，数量可能偏少。")).toBeVisible();
    await expect.element(page.getByText("Claude Code").first()).toBeVisible();
    await expect.element(page.getByRole("button", { name: "重试" })).toBeVisible();
    // It looked once more on its own before saying so.
    expect(nativeApi.probeWorkspaceImport).toHaveBeenCalledTimes(2);
  });

  it("looks again once on its own when the first read could not finish", async () => {
    nativeApi.probeWorkspaceImport
      .mockResolvedValueOnce({
        sources: [source({ skillCount: 0, chatCount: 0, incomplete: true })],
        requiresSourceChoice: false,
      })
      .mockResolvedValueOnce({ sources: [source({ skillCount: 3 })], requiresSourceChoice: false });

    await renderFlow();

    await expect.element(page.getByText("3 个技能", { exact: false }).first()).toBeVisible();
    expect(nativeApi.probeWorkspaceImport).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("没来得及读完");
  });
});
