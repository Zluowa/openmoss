// FILE: RailUpdateControl.browser.tsx
// Purpose: The rail's update flow as a person meets it: tooltip, confirm dialog with each
//          agent's progress and result, the running animation, then the success or failure pill.
// Layer: Web shell navigation test.

import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type DesktopBridge,
  type DesktopUpdateState,
  type ServerProviderStatus,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const updateProvider = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock("~/appSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/appSettings")>()),
  useAppSettings: () => ({
    settings: { hiddenProviders: [], enableProviderUpdateChecks: true, locale: "en" },
    updateSettings: vi.fn(),
  }),
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { updateProvider } }),
  readNativeApi: () => ({ server: { updateProvider } }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { MossLocaleScope } from "~/localization";

import { AppRail } from "../AppRail";
import { useProviderUpdateRunStore } from "./providerUpdateRunStore";
import { RailUpdateControl } from "./RailUpdateControl";
import { closeSettings, settingsDialogStore } from "~/settingsDialogStore";

const CHECKED_AT = new Date(Date.now() - 60_000).toISOString();

function provider(
  overrides: Partial<ServerProviderStatus> = {},
  advisory: Partial<NonNullable<ServerProviderStatus["versionAdvisory"]>> = {},
): ServerProviderStatus {
  return {
    provider: "opencode",
    driver: "opencode",
    instanceId: "opencode",
    enabled: true,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: CHECKED_AT,
    version: "1.0.0",
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g opencode-ai@latest",
      canUpdate: true,
      checkedAt: CHECKED_AT,
      message: null,
      ...advisory,
    },
    ...overrides,
  } as unknown as ServerProviderStatus;
}

function setProviders(client: QueryClient, providers: ReadonlyArray<ServerProviderStatus>) {
  client.setQueryData(serverQueryKeys.config(), { providers });
}

const DOWNLOADED_APP: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "1.2.3",
  downloadedVersion: "1.2.3",
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  installFailureCount: 0,
  flavor: "production",
  releaseUrl: null,
  manualDownloadUrl: null,
};

// A Mac build without a Developer ID: the main process only announces the version.
const MAC_NOTICE_APP: DesktopUpdateState = {
  ...DOWNLOADED_APP,
  status: "available",
  currentVersion: "1.0.8",
  availableVersion: "1.0.9",
  downloadedVersion: null,
  manualDownloadUrl: "https://mossbotai.com/download",
};

async function renderControl(
  providers: ReadonlyArray<ServerProviderStatus>,
  desktop: { readonly state: DesktopUpdateState; readonly onClick: () => void } | null = null,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  setProviders(client, providers);
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  const screen = await render(
    <QueryClientProvider client={client}>
      <MossLocaleScope locale="zh-CN">
        <div style={{ position: "fixed", top: 0, bottom: 0, left: 0, display: "flex" }}>
          <AppRail
            items={[]}
            shortcuts={[]}
            bottomItems={[]}
            bottomSlot={
              <RailUpdateControl
                desktopUpdate={{
                  state: desktop?.state ?? null,
                  visible: desktop !== null,
                  installing: false,
                  onClick: desktop?.onClick ?? vi.fn(),
                }}
              />
            }
            bottomTrailingSlot={<div data-testid="rail-avatar" className="size-7" />}
          />
        </div>
      </MossLocaleScope>
    </QueryClientProvider>,
  );
  return { client, screen };
}

function visibleBox(element: Element): DOMRect {
  const box = element.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(getComputedStyle(element).visibility).toBe("visible");
  return box;
}

const updateButton = () => page.getByRole("button", { name: "更新 1 个智能体" });

function railState(): string | null {
  return (
    document.querySelector("[data-rail-update-state]")?.getAttribute("data-rail-update-state") ??
    null
  );
}

function pillTone(): string | null {
  return (
    document
      .querySelector("[data-provider-update-pill]")
      ?.getAttribute("data-provider-update-pill") ?? null
  );
}

function pillText(): string | null | undefined {
  return document.querySelector("[data-provider-update-main]")?.textContent;
}

describe("RailUpdateControl", () => {
  beforeEach(() => {
    updateProvider.mockReset();
    navigate.mockReset();
    useProviderUpdateRunStore.setState({
      liveVersionCheckCompleted: true,
      run: null,
      outcomes: {},
    });
  });

  afterEach(() => {
    useProviderUpdateRunStore.setState({
      liveVersionCheckCompleted: false,
      run: null,
      outcomes: {},
    });
  });

  it("updates Codex in use inside the dialog: progress per agent, then the switch note", async () => {
    let finish!: (result: { providers: ServerProviderStatus[] }) => void;
    updateProvider.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const codex = (overrides: Partial<ServerProviderStatus> = {}) =>
      provider({ provider: "codex", driver: "codex", instanceId: "codex", ...overrides } as never, {
        currentVersion: "0.170.0",
        latestVersion: "0.171.0",
        updateCommand: "npm install -g @openai/codex@latest",
      });
    const { client } = await renderControl([codex()]);
    await userEvent.click(updateButton());
    const dialog = page.getByRole("alertdialog");
    // Nothing asks the person to stop work or restart Moss.
    await expect.element(dialog).toHaveTextContent("更新时智能体照常可用");
    await expect.element(dialog).not.toHaveTextContent("关闭由它启动的 Codex");
    await expect.element(dialog).not.toHaveTextContent("重启 Moss");

    await userEvent.click(page.getByRole("button", { name: "更新", exact: true }));
    expect(updateProvider).toHaveBeenCalledWith({ provider: "codex", instanceId: "codex" });
    // The dialog stays and shows the agent updating, like a progress row.
    await expect.element(dialog).toBeVisible();
    const row = () => document.querySelector('[data-provider-update-row="codex"]');
    await vi.waitFor(() =>
      expect(row()?.getAttribute("data-provider-update-row-state")).toBe("updating"),
    );
    expect(row()?.textContent).toContain("更新中…");
    await expect.element(page.getByRole("button", { name: "更新中…" })).toBeDisabled();

    const finishedAt = new Date(Date.now() + 1_000).toISOString();
    const updated = codex({
      version: "0.171.0",
      updateState: {
        status: "succeeded",
        startedAt: CHECKED_AT,
        finishedAt,
        message:
          "Updated. Conversations in progress switch to the new version after their current turn.",
        output: null,
      },
    } as never);
    setProviders(client, [
      { ...updated, versionAdvisory: { ...updated.versionAdvisory!, status: "current" } },
    ]);
    finish({ providers: [updated] });

    await vi.waitFor(() =>
      expect(row()?.getAttribute("data-provider-update-row-state")).toBe("updated"),
    );
    // The row stays listed with its versions after the agent left the "needs update" list.
    expect(row()?.textContent).toContain("已更新");
    expect(row()?.textContent).toContain("0.171.0");
    await expect.element(dialog).toHaveTextContent("智能体已更新");
    await expect
      .element(dialog)
      .toHaveTextContent("已更新，进行中的对话会在本轮结束后切换到新版本。");
    await userEvent.click(page.getByRole("button", { name: "完成" }));
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
  });

  it("says why an update failed in the dialog and retries it from there", async () => {
    const finishedAt = new Date(Date.now() + 1_000).toISOString();
    const failure = "Moss could not download the update. Check your network, then try again.";
    const failed = provider({
      updateState: {
        status: "failed",
        startedAt: CHECKED_AT,
        finishedAt,
        message: failure,
        output: null,
      },
    });
    updateProvider.mockResolvedValueOnce({ providers: [failed] });
    await renderControl([provider()]);
    await userEvent.click(updateButton());
    await userEvent.click(page.getByRole("button", { name: "更新", exact: true }));

    const row = () => document.querySelector('[data-provider-update-row="opencode"]');
    await vi.waitFor(() =>
      expect(row()?.getAttribute("data-provider-update-row-state")).toBe("failed"),
    );
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog).toHaveTextContent(/没能下载更新|could not download the update/);
    await expect.element(dialog).not.toHaveTextContent("重启 Moss");

    updateProvider.mockResolvedValueOnce({ providers: [] });
    await userEvent.click(page.getByRole("button", { name: "重试", exact: true }));
    await vi.waitFor(() => expect(updateProvider).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(row()?.getAttribute("data-provider-update-row-state")).toBe("updated"),
    );
  });

  it("takes no room in the rail when nothing needs updating", async () => {
    await renderControl([provider({}, { status: "current" })]);
    await expect.element(page.getByTestId("rail-avatar")).toBeInTheDocument();
    expect(railState()).toBeNull();
  });

  it("sits directly above the account avatar", async () => {
    await renderControl([provider()]);
    await expect.element(updateButton()).toBeInTheDocument();
    // Measured once the entrance scale settles; it shrinks the box while it plays.
    await vi.waitFor(() => {
      const button = updateButton().element().getBoundingClientRect();
      const avatar = page.getByTestId("rail-avatar").element().getBoundingClientRect();
      expect(button.bottom).toBeLessThanOrEqual(avatar.top);
      expect(avatar.top - button.bottom).toBeLessThanOrEqual(8);
    });
  });

  it("waits for this session's live version check before prompting", async () => {
    useProviderUpdateRunStore.setState({ liveVersionCheckCompleted: false });
    await renderControl([provider()]);
    await expect.element(page.getByTestId("rail-avatar")).toBeInTheDocument();
    expect(railState()).toBeNull();
  });

  it("leaves agents it cannot update in one click to Settings", async () => {
    await renderControl([provider({}, { canUpdate: false, updateCommand: null })]);
    await expect.element(page.getByTestId("rail-avatar")).toBeInTheDocument();
    expect(railState()).toBeNull();
  });

  it("runs the whole flow: tooltip, confirm, animation, success", async () => {
    let finish!: (result: { providers: ServerProviderStatus[] }) => void;
    updateProvider.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { client } = await renderControl([provider({}, { packageChannel: "cn-mirror" })]);

    await expect.element(updateButton()).toBeInTheDocument();
    expect(railState()).toBe("update");

    await userEvent.hover(updateButton());
    await vi.waitFor(
      () =>
        expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
          "更新 1 个智能体",
        ),
      { timeout: 3_000 },
    );

    await userEvent.click(updateButton());
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog).toHaveTextContent("更新 1 个智能体？");
    await expect.element(dialog).toHaveTextContent("OpenCode");
    await expect.element(dialog).toHaveTextContent("1.0.0");
    await expect.element(dialog).toHaveTextContent("1.1.0");
    await expect.element(dialog).toHaveTextContent("通过国内镜像下载");
    expect(updateProvider).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "更新", exact: true }));
    expect(updateProvider).toHaveBeenCalledWith({ provider: "opencode", instanceId: "opencode" });
    await vi.waitFor(() => expect(railState()).toBe("updating"));
    await vi.waitFor(() => expect(pillTone()).toBe("loading"));
    expect(pillText()).toBe("正在更新 OpenCode");

    // The server's own state takes over from the run without the pill or the ring blinking.
    setProviders(client, [
      provider({
        updateState: {
          status: "running",
          startedAt: CHECKED_AT,
          finishedAt: null,
          message: "Updating provider.",
          output: null,
        },
      }),
    ]);
    for (let frame = 0; frame < 15; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(railState()).toBe("updating");
      expect(document.querySelector("[data-provider-update-pill]")?.className).not.toContain(
        "opacity-0 translate-y-1.5",
      );
      expect(pillTone()).toBe("loading");
    }

    const finishedAt = new Date(Date.now() + 1_000).toISOString();
    setProviders(client, [
      provider(
        {
          version: "1.1.0",
          updateState: {
            status: "succeeded",
            startedAt: CHECKED_AT,
            finishedAt,
            message: "Provider updated.",
            output: null,
          },
        },
        { status: "current", currentVersion: "1.1.0" },
      ),
    ]);
    finish({ providers: [] });

    await vi.waitFor(() => expect(pillTone()).toBe("success"));
    expect(pillText()).toBe("OpenCode 已更新到 v1.1.0");
    await vi.waitFor(() => expect(railState()).toBe("success"));

    // The success pill leaves on its own, and the button goes with it.
    await vi.waitFor(() => expect(pillTone()).toBeNull(), { timeout: 5_000 });
    await vi.waitFor(() => expect(railState()).toBeNull());
  });

  it("offers a retry after a failure, with the details kept in the update dialog", async () => {
    const finishedAt = new Date(Date.now() + 1_000).toISOString();
    const failed = provider({
      updateState: {
        status: "failed",
        startedAt: CHECKED_AT,
        finishedAt,
        message: "Update command exited with code 1: npm error code EACCES",
        output: null,
      },
    });
    const { client } = await renderControl([provider()]);
    setProviders(client, [failed]);

    await vi.waitFor(() => expect(pillTone()).toBe("error"));
    // One short sentence: the agent still works on its current version, and it can retry.
    await expect
      .element(page.getByRole("button", { name: "OpenCode 仍可用当前版本，稍后可重试。" }))
      .toHaveTextContent("OpenCode v1.1.0 更新失败");
    await expect
      .element(page.getByRole("button", { name: "重试", exact: true }))
      .toBeInTheDocument();
    expect(railState()).toBe("update");

    await userEvent.click(page.getByRole("button", { name: "关闭智能体更新提示" }));
    await vi.waitFor(() => expect(pillTone()).toBeNull());

    await userEvent.click(updateButton());
    const dialog = page.getByRole("alertdialog");
    await expect
      .element(dialog)
      .toHaveTextContent("Update command exited with code 1: npm error code EACCES");
    await expect.element(page.getByRole("button", { name: "复制命令" })).toBeInTheDocument();
  });

  it("runs the same update again from the failure pill's retry", async () => {
    const finishedAt = new Date(Date.now() + 1_000).toISOString();
    updateProvider.mockResolvedValue({ providers: [] });
    const { client } = await renderControl([provider()]);
    setProviders(client, [
      provider({
        updateState: {
          status: "failed",
          startedAt: CHECKED_AT,
          finishedAt,
          message: "Update command exited with code 1: npm error code ETIMEDOUT",
          output: null,
        },
      }),
    ]);

    await vi.waitFor(() => expect(pillTone()).toBe("error"));
    await userEvent.click(page.getByRole("button", { name: "重试", exact: true }));
    await vi.waitFor(() =>
      expect(updateProvider).toHaveBeenCalledWith({ provider: "opencode", instanceId: "opencode" }),
    );
  });

  it("opens agent settings from the status pill", async () => {
    const finishedAt = new Date(Date.now() + 1_000).toISOString();
    const { client } = await renderControl([provider()]);
    setProviders(client, [
      provider({
        updateState: {
          status: "failed",
          startedAt: CHECKED_AT,
          finishedAt,
          message: "boom",
          output: null,
        },
      }),
    ]);

    await userEvent.click(
      page.getByRole("button", { name: "OpenCode 仍可用当前版本，稍后可重试。" }),
    );
    expect(settingsDialogStore.getState()).toMatchObject({
      isOpen: true,
      request: { section: "providers" },
    });
    closeSettings();
  });

  it("updates agents one at a time and shows the position", async () => {
    const resolvers: Array<(result: { providers: ServerProviderStatus[] }) => void> = [];
    updateProvider.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const pi = {
      ...provider({ provider: "pi", driver: "pi", instanceId: "pi" } as never),
    };
    await renderControl([provider(), pi]);

    await userEvent.click(page.getByRole("button", { name: "更新 2 个智能体" }));
    await userEvent.click(page.getByRole("button", { name: "更新", exact: true }));

    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    await vi.waitFor(() => expect(pillText()).toBe("正在更新 OpenCode（1/2）"));
    resolvers[0]?.({ providers: [] });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    await vi.waitFor(() => expect(pillText()).toBe("正在更新 Pi（2/2）"));
    resolvers[1]?.({ providers: [] });
    await vi.waitFor(() => expect(useProviderUpdateRunStore.getState().run).toBeNull());
  });

  it("holds a ready app restart until the agents are done, and says so", async () => {
    const onClick = vi.fn();
    const { client } = await renderControl([provider()], { state: DOWNLOADED_APP, onClick });

    await userEvent.click(updateButton());
    await expect.element(page.getByRole("alertdialog")).toHaveTextContent("Moss 1.2.3 也已准备好");
    await userEvent.click(page.getByRole("button", { name: "取消" }));

    setProviders(client, [provider({}, { status: "current" })]);
    await vi.waitFor(() => expect(railState()).toBe("desktop"));
    await userEvent.click(
      page.getByRole("button", { name: "Update 1.2.3 is ready. Click to restart and install." }),
    );
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("shows the app download's progress on the same button", async () => {
    const onClick = vi.fn();
    await renderControl([provider()], {
      state: {
        ...DOWNLOADED_APP,
        status: "downloading",
        downloadedVersion: null,
        downloadPercent: 42,
      },
      onClick,
    });
    await vi.waitFor(() => expect(railState()).toBe("desktop"));
    const button = document.querySelector<HTMLButtonElement>("[data-rail-update-state]");
    expect(button?.getAttribute("aria-label")).toBe("Preparing update (42%)");
    expect(button?.querySelector("[data-rail-progress-ring]")).not.toBeNull();
    button?.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  describe("on a Mac build that cannot install updates itself", () => {
    const openExternal = vi.fn(async () => true);
    const originalBridge = window.desktopBridge;

    beforeEach(() => {
      localStorage.clear();
      openExternal.mockClear();
      window.desktopBridge = { openExternal } as unknown as DesktopBridge;
    });

    afterEach(() => {
      localStorage.clear();
      if (originalBridge) window.desktopBridge = originalBridge;
      else Reflect.deleteProperty(window, "desktopBridge");
    });

    const noticeButton = (version = "1.0.9") =>
      page.getByRole("button", { name: `Moss ${version} 已发布` });

    it("announces the version and opens the download page, never an install", async () => {
      // A desktop window, so the dialog footer lays out in one row as it does in the app.
      await page.viewport(1280, 800);
      const onClick = vi.fn();
      await renderControl([], { state: MAC_NOTICE_APP, onClick });

      await vi.waitFor(() => expect(railState()).toBe("desktop"));
      await expect.element(noticeButton()).toBeEnabled();
      visibleBox(noticeButton().element());

      await userEvent.click(noticeButton());
      const dialog = page.getByRole("alertdialog");
      await expect.element(dialog).toHaveTextContent("Moss 1.0.9 已发布");
      await expect.element(dialog).toHaveTextContent("当前版本不支持在应用内更新");
      const download = page.getByRole("button", { name: "前往下载" });
      const later = page.getByRole("button", { name: "稍后" });
      const downloadBox = visibleBox(download.element());
      const laterBox = visibleBox(later.element());
      // One footer row, the main action last, as in every Moss dialog.
      expect(Math.abs(downloadBox.top - laterBox.top)).toBeLessThanOrEqual(1);
      expect(downloadBox.left).toBeGreaterThan(laterBox.left);
      expect(dialog.element().textContent).not.toMatch(/安装|重启|Install|Restart/u);

      await userEvent.click(download);
      expect(openExternal).toHaveBeenCalledWith("https://mossbotai.com/download");
      // The updater's own click (download or install) is never reached.
      expect(onClick).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
      // The entry stays until the new version is installed.
      expect(railState()).toBe("desktop");
    });

    it("「稍后」 hides this version's notice, and the next version shows again", async () => {
      const first = await renderControl([], { state: MAC_NOTICE_APP, onClick: vi.fn() });
      await userEvent.click(noticeButton());
      await userEvent.click(page.getByRole("button", { name: "稍后" }));
      await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
      await vi.waitFor(() => expect(railState()).toBeNull());
      expect(openExternal).not.toHaveBeenCalled();

      // Snoozed across restarts of the window for the same version.
      await first.screen.unmount();
      const again = await renderControl([], { state: MAC_NOTICE_APP, onClick: vi.fn() });
      await expect.element(page.getByTestId("rail-avatar")).toBeInTheDocument();
      expect(railState()).toBeNull();

      await again.screen.unmount();
      await renderControl([], {
        state: { ...MAC_NOTICE_APP, availableVersion: "1.0.10" },
        onClick: vi.fn(),
      });
      await expect.element(noticeButton("1.0.10")).toBeInTheDocument();
      expect(railState()).toBe("desktop");
    });
  });
});
