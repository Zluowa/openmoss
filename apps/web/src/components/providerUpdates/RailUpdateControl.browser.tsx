// FILE: RailUpdateControl.browser.tsx
// Purpose: The rail's update flow as a person meets it: tooltip, confirm dialog, the running
//          animation, then the success or failure pill.
// Layer: Web shell navigation test.

import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type DesktopUpdateState,
  type ServerProviderStatus,
} from "@synara/contracts";
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
    useProviderUpdateRunStore.setState({ liveVersionCheckCompleted: true, run: null });
  });

  afterEach(() => {
    useProviderUpdateRunStore.setState({ liveVersionCheckCompleted: false, run: null });
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

  it("offers the update again after a failure, with the reason and the manual command", async () => {
    const finishedAt = new Date(Date.now() + 1_000).toISOString();
    const failed = provider({
      updateState: {
        status: "failed",
        startedAt: CHECKED_AT,
        finishedAt,
        message: "Update command exited with code 1.",
        output: null,
      },
    });
    const { client } = await renderControl([provider()]);
    setProviders(client, [failed]);

    await vi.waitFor(() => expect(pillTone()).toBe("error"));
    await expect
      .element(page.getByRole("button", { name: "Update command exited with code 1." }))
      .toHaveTextContent("OpenCode v1.1.0 更新失败");
    expect(railState()).toBe("update");

    await userEvent.click(page.getByRole("button", { name: "关闭智能体更新提示" }));
    await vi.waitFor(() => expect(pillTone()).toBeNull());

    await userEvent.click(updateButton());
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog).toHaveTextContent("Update command exited with code 1.");
    await expect.element(page.getByRole("button", { name: "复制命令" })).toBeInTheDocument();
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

    await userEvent.click(page.getByRole("button", { name: "boom" }));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/settings",
        search: expect.objectContaining({ section: "providers" }),
      }),
    );
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
});
