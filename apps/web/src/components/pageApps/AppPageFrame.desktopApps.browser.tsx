// FILE: AppPageFrame.desktopApps.browser.tsx
// Purpose: Browser component tests for Desktop Page Apps integration in
//          AppPageFrame (unified title dropdown pill, capsule install/open
//          button + `···` overflow menu, permissions & uninstall actions,
//          menu offer/pick, standalone chrome="none" full-height layout,
//          deduplicated attribution pill, version sync, app-gone reporting)
//          and desktopShellPlugin.
// Layer: Web browser tests

import "../../index.css";

import type {
  DesktopPageAppsBridge,
  InstalledDesktopPageApp,
  PageAppId,
  PageAppsOpenFrameResult,
} from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { isStandaloneAppPageSearch, isTransparentAppPageSearch } from "~/routes/_chat.apps.$appId";
import { MossLocaleScope } from "~/localization";
import { SidebarProvider } from "../ui/sidebar";
import { AppPageFrame, formatStandaloneAttributionLabel } from "./AppPageFrame";
import { desktopShellPlugin } from "./capabilities/desktop";
import { pageAppsClient } from "./pageAppsClient";

vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/hooks/useDesktopCustomTitleBar", () => ({
  useDesktopCustomTitleBarActive: () => true,
}));

const APP_ID = "app-desktop-1" as PageAppId;
const WINDOW_BUTTONS_WIDTH = 3 * 46;

function makeFrameResult(
  revision = 2,
  title = "桌面计时器",
  options: { readonly isOwner?: boolean } = {},
): PageAppsOpenFrameResult {
  const now = new Date().toISOString();
  const isOwner = options.isOwner ?? true;
  return {
    app: {
      id: APP_ID,
      scopeSpaceId: null,
      spaceId: null,
      title,
      description: "桌面悬浮计时器",
      revision,
      capabilities: {
        desktop: {
          permissions: ["notifications", "overlay"],
        },
      },
      favorite: false,
      thumbnail: null,
      sourceThreadId: null,
      htmlChars: 512,
      trashedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    revision,
    capabilities: {
      desktop: {
        permissions: ["notifications", "overlay"],
      },
    },
    frameUrl: "about:blank",
    frameOrigin: "null",
    ownOrigin: false,
    offlineReady: true,
    expiresAt: "2026-11-26T12:00:00.000Z",
    viewer: {
      id: "viewer-1",
      name: isOwner ? "我" : "协作者",
      level: isOwner ? "owner" : "interact",
      isOwner,
    },
    consent: {},
  };
}

function makeInstalledRecord(revision = 2): InstalledDesktopPageApp {
  return {
    installId: "0123456789abcdef0123456789abcdef",
    appId: APP_ID,
    name: "桌面计时器",
    revision,
    places: ["start-menu", "desktop"],
    installedAt: "2026-11-26T00:00:00.000Z",
  };
}

function createMockDesktopBridge(initialInstalled: InstalledDesktopPageApp | null = null) {
  let installed = initialInstalled;
  const installedListeners = new Set<(apps: readonly InstalledDesktopPageApp[]) => void>();
  const pickedListeners = new Set<
    (event: { appId: PageAppId; action?: "install" | "open" }) => void
  >();
  const apiListeners = new Set<
    (event: { appId?: string; namespace: string; event: string; payload: unknown }) => void
  >();

  const emitInstalled = (next: InstalledDesktopPageApp | null) => {
    installed = next;
    const list = next ? [next] : [];
    for (const listener of installedListeners) listener(list);
  };

  const bridge: DesktopPageAppsBridge = {
    isAvailable: vi.fn(async () => true),
    getPolicyState: vi.fn(async () => ({
      enabled: true,
      permissionsEnabled: true,
      fullAccessEnabled: true,
    })),
    installFromPage: vi.fn<DesktopPageAppsBridge["installFromPage"]>(async () => {
      const record = makeInstalledRecord();
      emitInstalled(record);
      return { status: "installed", app: record, opened: true };
    }),
    requestInstall: vi.fn<DesktopPageAppsBridge["requestInstall"]>(async () => {
      const record = makeInstalledRecord();
      emitInstalled(record);
      return { status: "installed", app: record, opened: true };
    }),
    isInstalled: vi.fn<DesktopPageAppsBridge["isInstalled"]>(async () => installed !== null),
    getInstalled: vi.fn<DesktopPageAppsBridge["getInstalled"]>(async () => installed),
    listInstalled: vi.fn<DesktopPageAppsBridge["listInstalled"]>(async () =>
      installed ? [installed] : [],
    ),
    openInstalled: vi.fn<DesktopPageAppsBridge["openInstalled"]>(async () => ({
      opened: true,
      windowId: 7,
      ...(installed?.installId ? { installId: installed.installId } : {}),
    })),
    uninstall: vi.fn<DesktopPageAppsBridge["uninstall"]>(async () => {
      emitInstalled(null);
      return { uninstalled: true, removedAppIds: [APP_ID], removedInstallIds: [] };
    }),
    showInFolder: vi.fn<DesktopPageAppsBridge["showInFolder"]>(async () => true),
    openPermissions: vi.fn<DesktopPageAppsBridge["openPermissions"]>(async () => undefined),
    getPermissions: vi.fn<DesktopPageAppsBridge["getPermissions"]>(async () => ({
      appId: APP_ID,
      revision: 2,
      contentHash: null,
      declared: ["notifications", "overlay"],
      states: { notifications: "granted", overlay: "prompt" },
      details: {},
    })),
    requestPermissions: vi.fn<DesktopPageAppsBridge["requestPermissions"]>(async () => ({
      notifications: "granted",
      overlay: "granted",
    })),
    setPermission: vi.fn<DesktopPageAppsBridge["setPermission"]>(async () => ({
      appId: APP_ID,
      revision: 2,
      contentHash: null,
      declared: ["notifications", "overlay"],
      states: { notifications: "granted", overlay: "granted" },
      details: {},
    })),
    syncAppVersion: vi.fn(async () => ({ invalidated: false, reloaded: false })),
    reportAppGone: vi.fn(async () => undefined),
    offerInMenu: vi.fn(async () => undefined),
    onPickedInMenu: vi.fn((listener) => {
      pickedListeners.add(listener);
      return () => pickedListeners.delete(listener);
    }),
    onInstalledChanged: vi.fn((listener) => {
      installedListeners.add(listener);
      return () => installedListeners.delete(listener);
    }),
    invokeDesktopApi: vi.fn(async () => ({ ok: true })),
    onDesktopApiEvent: vi.fn((listener) => {
      apiListeners.add(listener);
      return () => apiListeners.delete(listener);
    }),
  };

  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    writable: true,
    value: { pageApps: bridge },
  });

  return {
    bridge,
    emitInstalled,
    emitPickedInMenu: (event: { appId: PageAppId; action?: "install" | "open" }) => {
      for (const listener of pickedListeners) listener(event);
    },
    emitApiEvent: (event: {
      appId?: string;
      namespace: string;
      event: string;
      payload: unknown;
    }) => {
      for (const listener of apiListeners) listener(event);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "desktopBridge");
  Reflect.deleteProperty(window, "mossDesktop");
});

describe("AppPageFrame Desktop Page Apps", () => {
  it("renders clean Claude-aligned title dropdown with Beta badge, quiet top-right icon actions, and inline rename", async () => {
    await page.viewport(1280, 800);
    const mock = createMockDesktopBridge(null);
    vi.spyOn(pageAppsClient, "openFrame").mockResolvedValue(makeFrameResult(2));
    vi.spyOn(pageAppsClient, "read").mockResolvedValue({
      app: makeFrameResult(2).app,
      revision: 2,
      html: "<!doctype html><html><body>OK</body></html>",
      capabilities: {},
    });
    const mutateSpy = vi.spyOn(pageAppsClient, "mutate").mockResolvedValue({
      app: { ...makeFrameResult(2).app, title: "重命名计时器", revision: 3 },
    });

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <SidebarProvider open>
          <div style={{ position: "fixed", inset: 0, display: "flex" }}>
            <AppPageFrame appPageId={APP_ID} mode="full" topBar />
          </div>
        </SidebarProvider>
      </MossLocaleScope>,
    );

    try {
      const titleTrigger = page.getByTestId("page-app-title-menu-trigger");
      const moreTrigger = page.getByTestId("page-app-more-menu-trigger");
      const actionsCluster = page.getByTestId("page-app-header-actions");

      await expect.element(titleTrigger).toBeVisible();
      await expect.element(moreTrigger).toBeVisible();
      await expect.element(titleTrigger).toHaveTextContent("桌面计时器");

      // Top-right bar has NO bordered "安装为应用" text capsule — only the `···` icon button while uninstalled.
      expect(page.getByTestId("page-app-desktop-install-btn").query()).toBeNull();
      expect(actionsCluster.element().querySelectorAll("button").length).toBe(1);

      const header = titleTrigger.element().closest("header")!;
      expect(header.getBoundingClientRect().height).toBeLessThanOrEqual(46);
      expect(header.textContent).not.toContain("AI 生成的内容");

      const titleRect = titleTrigger.element().getBoundingClientRect();
      const moreRect = moreTrigger.element().getBoundingClientRect();
      expect(titleRect.height).toBe(28);
      expect(moreRect.width).toBe(28);
      expect(moreRect.height).toBe(28);
      expect(moreRect.right).toBeLessThanOrEqual(window.innerWidth - WINDOW_BUTTONS_WIDTH);

      await vi.waitFor(() => {
        expect(mock.bridge.offerInMenu).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              appId: APP_ID,
              title: "桌面计时器",
              revision: 2,
              isInstalled: false,
            }),
          ]),
        );
      });

      // Title dropdown menu shows timestamp header + Export + grouped actions + "安装为应用 [测试版]" badge.
      await userEvent.click(titleTrigger);
      await expect
        .element(page.getByTestId("page-app-title-menu-about"))
        .toHaveTextContent("刚刚编辑");
      await expect
        .element(page.getByTestId("page-app-title-menu-export-item"))
        .toHaveTextContent("导出 HTML");
      const installMenuItem = page.getByTestId("page-app-title-menu-install-item");
      await expect.element(installMenuItem).toBeVisible();
      await expect.element(installMenuItem).toHaveTextContent("安装为应用");
      await expect.element(installMenuItem).toHaveTextContent("测试版");
      await expect.element(page.getByTestId("page-app-title-menu-rename-item")).toBeVisible();
      await expect
        .element(page.getByTestId("page-app-title-menu-desktop-perms-item"))
        .toBeVisible();

      // Clicking "安装为应用" inside the title menu triggers desktop install.
      await userEvent.click(installMenuItem);
      await vi.waitFor(() => {
        expect(mock.bridge.installFromPage).toHaveBeenCalledWith(
          expect.objectContaining({
            appId: APP_ID,
            title: "桌面计时器",
            revision: 2,
          }),
        );
      });

      // Once installed, top-right shows quiet PopOut icon button + `···` (2 icon buttons).
      const openStandaloneBtn = page.getByTestId("page-app-open-standalone-btn");
      await expect.element(openStandaloneBtn).toBeVisible();
      expect(actionsCluster.element().querySelectorAll("button").length).toBe(2);

      await userEvent.click(openStandaloneBtn);
      await vi.waitFor(() => {
        expect(mock.bridge.openInstalled).toHaveBeenCalledWith(
          expect.objectContaining({
            appId: APP_ID,
            installId: "0123456789abcdef0123456789abcdef",
          }),
        );
      });

      // Title dropdown menu now shows installed items (open, show in folder, permissions, uninstall).
      await userEvent.click(titleTrigger);
      await expect.element(page.getByTestId("page-app-title-menu-open-item")).toBeVisible();
      await expect.element(page.getByTestId("page-app-title-menu-folder-item")).toBeVisible();
      await expect.element(page.getByTestId("page-app-title-menu-uninstall-item")).toBeVisible();
      await userEvent.click(page.getByTestId("page-app-title-menu-rename-item"));

      // Inline rename works right in place.
      const renameInput = page.getByLabelText("应用页名称");
      await expect.element(renameInput).toBeVisible();
      await userEvent.fill(renameInput, "重命名计时器");
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(mutateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            op: "rename",
            appId: APP_ID,
            title: "重命名计时器",
          }),
        );
      });
      await expect.element(titleTrigger).toHaveTextContent("重命名计时器");

      // `···` overflow menu also exposes "在文件夹中显示" & "桌面权限" when installed.
      await userEvent.click(moreTrigger);
      const showInFolderBtn = page.getByTestId("page-app-desktop-show-in-folder-btn");
      await expect.element(showInFolderBtn).toBeVisible();
      await userEvent.click(showInFolderBtn);
      expect(mock.bridge.showInFolder).toHaveBeenCalledWith({
        appId: APP_ID,
        installId: "0123456789abcdef0123456789abcdef",
      });

      await userEvent.click(moreTrigger);
      const desktopPermsItem = page.getByTestId("page-app-desktop-permissions-btn");
      await expect.element(desktopPermsItem).toBeVisible();
      await userEvent.click(desktopPermsItem);
      expect(mock.bridge.openPermissions).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: APP_ID,
          title: "重命名计时器",
          revision: 2,
          permissions: ["notifications", "overlay"],
        }),
      );

      mock.emitInstalled(null);
      await expect.element(openStandaloneBtn).not.toBeInTheDocument();

      mock.emitPickedInMenu({ appId: APP_ID, action: "install" });
      await vi.waitFor(() => {
        expect(mock.bridge.installFromPage).toHaveBeenCalledTimes(2);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("hides attribution pill for owner standalone windows and renders deduplicated pill for guest viewers", async () => {
    await page.viewport(1024, 720);
    expect(formatStandaloneAttributionLabel("Moss 桌面计时器", "应用页", "Moss")).toBe(
      "Moss 桌面计时器",
    );
    expect(formatStandaloneAttributionLabel("轨道追踪器", "应用页", "Moss")).toBe(
      "Moss · 轨道追踪器",
    );

    const mock = createMockDesktopBridge(makeInstalledRecord(2));
    let currentRevision = 2;
    let isOwner = true;
    vi.spyOn(pageAppsClient, "openFrame").mockImplementation(async () =>
      makeFrameResult(currentRevision, "Moss 桌面计时器", { isOwner }),
    );

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <SidebarProvider open>
          <div style={{ position: "fixed", inset: 0, display: "flex" }}>
            <AppPageFrame appPageId={APP_ID} mode="full" standalone chrome="none" />
          </div>
        </SidebarProvider>
      </MossLocaleScope>,
    );

    try {
      const iframe = page.getByTitle("Moss 桌面计时器");
      await expect.element(iframe).toBeVisible();
      expect(document.querySelector("header")).toBeNull();

      const iframeRect = iframe.element().getBoundingClientRect();
      expect(iframeRect.width).toBeGreaterThanOrEqual(window.innerWidth - 2);
      expect(iframeRect.height).toBeGreaterThanOrEqual(window.innerHeight - 2);

      // Owner standalone windows run completely full-bleed with no bottom attribution pill.
      await expect.element(page.getByTestId("standalone-attribution-pill")).not.toBeInTheDocument();

      await vi.waitFor(() => {
        expect(mock.bridge.syncAppVersion).toHaveBeenCalledWith(
          expect.objectContaining({
            appId: APP_ID,
            revision: 2,
          }),
        );
      });

      // Guest viewer sees deduplicated attribution pill with dismiss button.
      isOwner = false;
      currentRevision = 3;
      await screen.rerender(
        <MossLocaleScope locale="zh-CN">
          <SidebarProvider open>
            <div style={{ position: "fixed", inset: 0, display: "flex" }}>
              <AppPageFrame appPageId={APP_ID} mode="full" standalone chrome="none" key="rev-3" />
            </div>
          </SidebarProvider>
        </MossLocaleScope>,
      );

      const pill = page.getByTestId("standalone-attribution-pill");
      await expect.element(pill).toBeVisible();
      expect(pill.element().textContent).toBe("Moss 桌面计时器");
      expect(pill.element().textContent).not.toContain("Moss · Moss");
      expect(pill.element().getBoundingClientRect().height).toBeGreaterThan(20);
      expect(pill.element().textContent).not.toContain("返回");

      await vi.waitFor(() => {
        expect(mock.bridge.syncAppVersion).toHaveBeenCalledWith(
          expect.objectContaining({
            appId: APP_ID,
            revision: 3,
          }),
        );
      });

      const dismissBtn = page.getByRole("button", { name: "隐藏标识" });
      await userEvent.click(dismissBtn);
      await expect.element(pill).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("reports app gone (gone: true) and clears (gone: false) when recovered in standalone mode", async () => {
    const mock = createMockDesktopBridge(makeInstalledRecord(2));
    const openSpy = vi
      .spyOn(pageAppsClient, "openFrame")
      .mockRejectedValueOnce({ message: "应用页已删除" })
      .mockResolvedValue(makeFrameResult(2));
    const recovered = makeFrameResult(2);
    const readSpy = vi.spyOn(pageAppsClient, "read").mockResolvedValue({
      app: recovered.app,
      revision: recovered.revision,
      html: "<!doctype html><html></html>",
      capabilities: recovered.capabilities,
    });

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <SidebarProvider open>
          <div style={{ position: "fixed", inset: 0, display: "flex" }}>
            <AppPageFrame appPageId={APP_ID} mode="full" standalone chrome="none" />
          </div>
        </SidebarProvider>
      </MossLocaleScope>,
    );

    try {
      await expect.element(page.getByText("应用页已删除")).toBeVisible();
      await vi.waitFor(() => {
        expect(mock.bridge.reportAppGone).toHaveBeenCalledWith(
          expect.objectContaining({
            appId: APP_ID,
            gone: true,
            reason: "应用页已删除",
          }),
        );
      });

      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() => {
        expect(readSpy).toHaveBeenCalled();
        expect(openSpy).toHaveBeenCalledTimes(2);
        expect(mock.bridge.reportAppGone).toHaveBeenCalledWith(
          expect.objectContaining({
            appId: APP_ID,
            gone: false,
          }),
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("supports transparent standalone backgrounds and multi-embed offerInMenu", async () => {
    expect(isTransparentAppPageSearch({ transparent: "1" })).toBe(true);
    expect(isTransparentAppPageSearch({ transparent: true })).toBe(true);
    expect(isTransparentAppPageSearch({})).toBe(false);

    const APP_2 = "app-embed-2" as PageAppId;
    const mock = createMockDesktopBridge(null);
    vi.spyOn(pageAppsClient, "openFrame").mockImplementation(async (input) => {
      const base = makeFrameResult(2, input.appId === APP_2 ? "嵌入式日历" : "悬浮组件");
      return {
        ...base,
        app: { ...base.app, id: input.appId },
      };
    });

    const transparentScreen = await render(
      <MossLocaleScope locale="zh-CN">
        <SidebarProvider open>
          <div style={{ position: "fixed", inset: 0, display: "flex" }}>
            <AppPageFrame appPageId={APP_ID} mode="full" standalone chrome="none" />
          </div>
        </SidebarProvider>
      </MossLocaleScope>,
    );
    try {
      const frameEl = page.getByTestId("app-page-frame").element();
      const iframe = page.getByTitle("悬浮组件").element();
      expect(frameEl.getAttribute("data-page-app-transparent")).toBeNull();
      expect(iframe.classList.contains("bg-white")).toBe(true);

      mock.emitApiEvent({
        appId: APP_ID,
        namespace: "window",
        event: "optionsChanged",
        payload: {
          options: { transparent: true },
          applied: { transparent: true },
        },
      });

      await vi.waitFor(() => {
        expect(frameEl.getAttribute("data-page-app-transparent")).toBe("true");
        expect(frameEl.classList.contains("bg-transparent")).toBe(true);
        expect(iframe.classList.contains("bg-transparent")).toBe(true);
        expect(iframe.classList.contains("bg-white")).toBe(false);
      });
    } finally {
      await transparentScreen.unmount();
    }

    const embedScreen = await render(
      <MossLocaleScope locale="zh-CN">
        <SidebarProvider open>
          <div>
            <AppPageFrame appPageId={APP_ID} mode="embed" />
            <AppPageFrame appPageId={APP_2} mode="embed" />
          </div>
        </SidebarProvider>
      </MossLocaleScope>,
    );
    try {
      await vi.waitFor(() => {
        expect(mock.bridge.offerInMenu).toHaveBeenLastCalledWith(
          expect.arrayContaining([
            expect.objectContaining({ appId: APP_ID }),
            expect.objectContaining({ appId: APP_2 }),
          ]),
        );
      });
    } finally {
      await embedScreen.unmount();
    }
  });

  it("relays desktopShellPlugin calls and events and parses standalone route search flags", async () => {
    expect(isStandaloneAppPageSearch({ standalone: "1" })).toBe(true);
    expect(isStandaloneAppPageSearch({ chrome: "none" })).toBe(true);
    expect(isStandaloneAppPageSearch({})).toBe(false);

    const mock = createMockDesktopBridge(null);
    const controller = new AbortController();
    const ctx = {
      appId: APP_ID,
      revision: 2,
      title: "桌面计时器",
      mode: "full" as const,
      viewer: { id: "v1", name: "我", level: "owner" as const, isOwner: true },
      capabilities: { desktop: { permissions: ["notifications"] } },
      config: { permissions: ["notifications"] },
      serverCall: vi.fn(),
      serverWatch: vi.fn(),
      confirm: vi.fn(),
      confirmChoice: vi.fn(),
      frameElement: () => null,
      permissionStates: vi.fn(() => ({})),
      requestPermissions: vi.fn(),
      managePermissions: vi.fn(),
      signal: controller.signal,
    };

    const state = await desktopShellPlugin.call!(ctx, "invoke", {
      namespace: "install",
      method: "state",
      args: null,
    });
    expect(state).toEqual({
      installed: false,
      available: true,
      installId: null,
      places: [],
      app: null,
      policy: { enabled: true, permissionsEnabled: true, fullAccessEnabled: true },
    });

    mock.emitInstalled(makeInstalledRecord(2));
    const installedState = await desktopShellPlugin.call!(ctx, "invoke", {
      namespace: "install",
      method: "state",
      args: null,
    });
    expect(installedState).toMatchObject({
      installed: true,
      available: true,
      installId: "0123456789abcdef0123456789abcdef",
      name: "桌面计时器",
      places: ["start-menu", "desktop"],
    });

    const declaredPerms = await desktopShellPlugin.call!(ctx, "invoke", {
      namespace: "permissions",
      method: "declare",
      args: { permissions: ["notifications"] },
    });
    expect(declaredPerms).toEqual(["notifications"]);

    await desktopShellPlugin.call!(ctx, "invoke", {
      namespace: "notification",
      method: "show",
      args: { body: "Hi" },
    });
    expect(mock.bridge.invokeDesktopApi).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: APP_ID,
        revision: 2,
        namespace: "notification",
        method: "show",
        args: { body: "Hi" },
      }),
    );

    const received: unknown[] = [];
    const cancelWatch = desktopShellPlugin.watch!(ctx, "events", null, {
      next: (ev) => received.push(ev),
      end: () => undefined,
    });
    mock.emitApiEvent({ appId: APP_ID, namespace: "tray", event: "click", payload: {} });
    mock.emitApiEvent({ appId: "other-app", namespace: "tray", event: "click", payload: {} });
    expect(received).toHaveLength(1);
    cancelWatch();

    // Standalone native fallback normalizes install.state() to the unified contract shape.
    Reflect.deleteProperty(window, "desktopBridge");
    Object.defineProperty(window, "mossDesktop", {
      configurable: true,
      writable: true,
      value: {
        invoke: vi.fn(async (ns: string, method: string) => {
          if (ns === "install" && method === "state") {
            return { installed: true, app: makeInstalledRecord(2) };
          }
          return null;
        }),
      },
    });
    const nativeState = await desktopShellPlugin.call!(ctx, "invoke", {
      namespace: "install",
      method: "state",
      args: null,
    });
    expect(nativeState).toMatchObject({
      installed: true,
      available: true,
      installId: "0123456789abcdef0123456789abcdef",
      name: "桌面计时器",
      places: ["start-menu", "desktop"],
    });
  });

  it("ignores stale installFromPage resolution and resets installed state when switching appPageId", async () => {
    const APP_2 = "app-desktop-2" as PageAppId;
    const mock = createMockDesktopBridge(null);

    let resolveInstall1!: (value: {
      status: "installed";
      app: InstalledDesktopPageApp;
      opened: boolean;
    }) => void;
    vi.spyOn(mock.bridge, "installFromPage").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInstall1 = resolve;
        }),
    );

    vi.spyOn(pageAppsClient, "openFrame").mockImplementation(async (input) => {
      const base = makeFrameResult(2, input.appId === APP_2 ? "未安装新应用" : "桌面计时器");
      return {
        ...base,
        app: { ...base.app, id: input.appId },
      };
    });

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <SidebarProvider open>
          <div style={{ position: "fixed", inset: 0, display: "flex" }}>
            <AppPageFrame appPageId={APP_ID} mode="full" topBar />
          </div>
        </SidebarProvider>
      </MossLocaleScope>,
    );

    try {
      const titleTrigger = page.getByTestId("page-app-title-menu-trigger");
      const moreTrigger = page.getByTestId("page-app-more-menu-trigger");
      await expect.element(titleTrigger).toBeVisible();

      await userEvent.click(titleTrigger);
      const installItem = page.getByTestId("page-app-title-menu-install-item");
      await expect.element(installItem).toHaveTextContent("安装为应用");
      await userEvent.click(installItem);

      // Switch to APP_2 without unmounting/re-keying while APP_1's install animation is still pending.
      await screen.rerender(
        <MossLocaleScope locale="zh-CN">
          <SidebarProvider open>
            <div style={{ position: "fixed", inset: 0, display: "flex" }}>
              <AppPageFrame appPageId={APP_2} mode="full" topBar />
            </div>
          </SidebarProvider>
        </MossLocaleScope>,
      );

      await expect
        .element(page.getByTestId("page-app-title-menu-trigger"))
        .toHaveTextContent("未安装新应用");
      await userEvent.click(moreTrigger);
      await expect.element(page.getByTestId("page-app-more-install-item")).toBeEnabled();
      await userEvent.keyboard("{Escape}");

      // Now APP_1's install resolves late; APP_2 must remain uninstalled and unpolluted.
      resolveInstall1({
        status: "installed",
        app: makeInstalledRecord(2),
        opened: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(page.getByTestId("page-app-open-standalone-btn").query()).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("supports dock subheader mode with Close tab and synced title changes", async () => {
    createMockDesktopBridge(null);
    vi.spyOn(pageAppsClient, "openFrame").mockResolvedValue(makeFrameResult(2, "微信阅读"));

    const onTitleChange = vi.fn();
    const onCloseTab = vi.fn();
    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <div style={{ position: "fixed", inset: 0, display: "flex" }}>
          <AppPageFrame
            appPageId={APP_ID}
            mode="full"
            topBar={false}
            onTitleChange={onTitleChange}
            onCloseTab={onCloseTab}
          />
        </div>
      </MossLocaleScope>,
    );

    try {
      await expect.element(page.getByTestId("page-app-dock-subheader")).toBeVisible();
      expect(onTitleChange).toHaveBeenCalledWith("微信阅读");
      await userEvent.click(page.getByTestId("page-app-title-menu-trigger"));
      const closeTabItem = page.getByTestId("page-app-title-menu-close-tab-item");
      await expect.element(closeTabItem).toHaveTextContent("关闭标签页");
      await userEvent.click(closeTabItem);
      expect(onCloseTab).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
