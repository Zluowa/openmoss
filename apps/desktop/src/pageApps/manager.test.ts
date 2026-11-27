import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import type { PageAppId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => {
  const { EventEmitter: NodeEventEmitter } = await import("node:events");
  class MockBrowserWindow extends NodeEventEmitter {
    id = 9;
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    setMenuBarVisibility = vi.fn();
    setAppDetails = vi.fn();
    setTitle = vi.fn();
    setIcon = vi.fn();
    getContentBounds = vi.fn(() => ({ x: 0, y: 0, width: 960, height: 700 }));
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 960, height: 700 }));
    isDestroyed = vi.fn(() => false);
    isVisible = vi.fn(() => true);
    isMinimized = vi.fn(() => false);
    isMaximized = vi.fn(() => false);
    isFocused = vi.fn(() => true);
    isMaximizable = vi.fn(() => true);
    isMinimizable = vi.fn(() => true);
    show = vi.fn();
    focus = vi.fn();
    close = vi.fn();
    destroy = vi.fn();
  }
  class MockWebContentsView {
    webContents = Object.assign(new NodeEventEmitter(), {
      id: 42,
      isDestroyed: vi.fn(() => false),
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      getTitle: vi.fn(() => "Test App"),
      insertCSS: vi.fn(() => Promise.resolve()),
      send: vi.fn(),
    });
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
  }
  return {
    app: { getPath: vi.fn(() => OS.tmpdir()) },
    BrowserWindow: MockBrowserWindow,
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
    WebContentsView: MockWebContentsView,
    globalShortcut: { unregister: vi.fn() },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    nativeImage: { createFromDataURL: vi.fn(() => ({ isEmpty: () => true })) },
    nativeTheme: { shouldUseDarkColors: false },
    powerSaveBlocker: { isStarted: vi.fn(() => false), stop: vi.fn() },
    screen: {
      getAllDisplays: vi.fn(() => []),
      getDisplayMatching: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1280, height: 800 },
        scaleFactor: 1,
      })),
    },
    shell: {
      showItemInFolder: vi.fn(),
      writeShortcutLink: vi.fn(() => true),
      openExternal: vi.fn(),
    },
    systemPreferences: { getAnimationSettings: () => ({ shouldRenderRichAnimation: false }) },
  };
});

import { type PageAppDialogHost } from "./dialogs";
import { DesktopPageAppsManager } from "./manager";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-page-apps-mgr-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    FS.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("DesktopPageAppsManager", () => {
  it("defaults declaredPermissions to [] (never PAGE_APP_DESKTOP_PERMISSIONS) and enforces fail-closed trust", () => {
    const dir = createTempDir();
    const dialogs: PageAppDialogHost = {
      confirmInstall: vi.fn(async () => false),
      showInstallComplete: vi.fn(async () => "ok" as const),
      showAlreadyInstalled: vi.fn(async () => "close" as const),
      confirmPermission: vi.fn(async () => false),
      managePermissions: vi.fn(async () => ({ saved: false, grants: {} })),
      confirmReload: vi.fn(async () => false),
      showUnavailable: vi.fn(async () => "keep" as const),
      confirmUninstall: vi.fn(async () => false),
      showAbout: vi.fn(async () => undefined),
    };

    const manager = new DesktopPageAppsManager({
      userDataDir: dir,
      stateDir: dir,
      executablePath: "C:\\Moss.exe",
      resolveAppRouteUrl: (id) => `http://127.0.0.1:3000/#/apps/${id}`,
      resolveFrameOrigin: (id) => `http://${id}.moss-app.localhost:3000`,
      getMainWindow: () => null,
      dialogs,
    });

    const summary = manager.getPermissionsSummary({
      appId: "11111111-2222-3333-4444-555555555666" as PageAppId,
    });
    expect(summary.declared).toEqual([]);
    expect(summary.states.notifications).toBe("unavailable");
    expect(summary.states["full-access"]).toBe("unavailable");
  });

  it("requires secondary Tier 3 confirmation in openPermissionsDialog and tears down only the target app", async () => {
    const dir = createTempDir();
    const appId = "11111111-2222-3333-4444-555555555666" as PageAppId;
    const confirmPermission = vi.fn(async () => false);
    const dialogs: PageAppDialogHost = {
      confirmInstall: vi.fn(async () => false),
      showInstallComplete: vi.fn(async () => "ok" as const),
      showAlreadyInstalled: vi.fn(async () => "close" as const),
      confirmPermission,
      managePermissions: vi.fn(async () => ({
        saved: true,
        grants: { "full-access": true },
      })),
      confirmReload: vi.fn(async () => false),
      showUnavailable: vi.fn(async () => "keep" as const),
      confirmUninstall: vi.fn(async () => false),
      showAbout: vi.fn(async () => undefined),
    };

    const manager = new DesktopPageAppsManager({
      userDataDir: dir,
      stateDir: dir,
      executablePath: "C:\\Moss.exe",
      resolveAppRouteUrl: (id) => `http://127.0.0.1:3000/#/apps/${id}`,
      resolveFrameOrigin: (id) => `http://${id}.moss-app.localhost:3000`,
      getMainWindow: () => null,
      dialogs,
    });

    await manager.openPermissionsDialog({
      appId,
      permissions: ["full-access"],
      sourceTrust: "external",
    });

    expect(confirmPermission).toHaveBeenCalledTimes(1);
    // Secondary confirmation declined -> full-access stays unavailable under fail-closed untrusted
    const afterFailClosed = manager.getPermissionsSummary({
      appId,
      declared: ["full-access"],
    });
    expect(afterFailClosed.states["full-access"]).toBe("unavailable");

    // Directly evaluating with external trust keeps it at "prompt" (not granted)
    expect(
      manager.permissions.evaluate({
        accountId: "local",
        orgId: "local",
        appId,
        permission: "full-access",
        declaredPermissions: ["full-access"],
        currentRevision: 1,
        currentContentHash: null,
        trustKind: "external",
      }).state,
    ).toBe("prompt");
  });

  it("debounces reportAppGone for 3s and aborts cleanly when gone: false arrives", async () => {
    vi.useFakeTimers();
    try {
      const dir = createTempDir();
      const showUnavailable = vi.fn(async () => "keep" as const);
      const dialogs: PageAppDialogHost = {
        confirmInstall: vi.fn(async () => false),
        showInstallComplete: vi.fn(async () => "ok" as const),
        showAlreadyInstalled: vi.fn(async () => "close" as const),
        confirmPermission: vi.fn(async () => false),
        managePermissions: vi.fn(async () => ({ saved: false, grants: {} })),
        confirmReload: vi.fn(async () => false),
        showUnavailable,
        confirmUninstall: vi.fn(async () => false),
        showAbout: vi.fn(async () => undefined),
      };

      const manager = new DesktopPageAppsManager({
        userDataDir: dir,
        stateDir: dir,
        executablePath: "C:\\Moss.exe",
        resolveAppRouteUrl: (id) => `http://127.0.0.1:3000/#/apps/${id}`,
        resolveFrameOrigin: (id) => `http://${id}.moss-app.localhost:3000`,
        getMainWindow: () => null,
        dialogs,
      });

      const appId = "11111111-2222-3333-4444-555555555666" as PageAppId;
      const gonePromise = manager.reportAppGone({ appId, gone: true });
      await vi.advanceTimersByTimeAsync(1500);
      await manager.reportAppGone({ appId, gone: false });
      await vi.advanceTimersByTimeAsync(3000);
      await gonePromise;
      expect(showUnavailable).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets desktop shortcuts and renames installed OS shortcuts on syncAppVersion", async () => {
    const dir = createTempDir();
    const shortcutRoot = createTempDir();
    const prevEnv = process.env.MOSS_APPS_SHORTCUT_DIR;
    const prevNoIconSync = process.env.MOSS_DISABLE_SHORTCUT_ICON_SYNC;
    process.env.MOSS_APPS_SHORTCUT_DIR = shortcutRoot;
    process.env.MOSS_DISABLE_SHORTCUT_ICON_SYNC = "1";
    try {
      const dialogs: PageAppDialogHost = {
        confirmInstall: vi.fn(async () => true),
        showInstallComplete: vi.fn(async () => "ok" as const),
        showAlreadyInstalled: vi.fn(async () => "close" as const),
        confirmPermission: vi.fn(async () => false),
        managePermissions: vi.fn(async () => ({ saved: false, grants: {} })),
        confirmReload: vi.fn(async () => false),
        showUnavailable: vi.fn(async () => "keep" as const),
        confirmUninstall: vi.fn(async () => false),
        showAbout: vi.fn(async () => undefined),
      };
      const manager = new DesktopPageAppsManager({
        userDataDir: dir,
        stateDir: dir,
        executablePath: "C:\\Moss.exe",
        resolveAppRouteUrl: (id) => `http://127.0.0.1:3000/#/apps/${id}`,
        resolveFrameOrigin: (id) => `http://${id}.moss-app.localhost:3000`,
        getMainWindow: () => null,
        dialogs,
      });

      const appId = "11111111-2222-3333-4444-555555555666" as PageAppId;
      const installResult = await manager.requestInstall({
        appId,
        title: "初版阅读器",
        revision: 1,
      });
      expect(installResult.status).toBe("installed");
      expect(installResult.app?.name).toBe("初版阅读器");

      await manager.syncAppVersion({
        appId,
        revision: 2,
        title: "静读小说",
      });
      const renamed = manager.store.findInstalledByAppId(appId);
      expect(renamed?.name).toBe("静读小说");
      expect(renamed?.rawTitle).toBe("静读小说");

      const removedShortcut = manager.setDesktopShortcut({ appId, enabled: false });
      expect(removedShortcut.updated).toBe(true);
      expect(removedShortcut.desktopShortcutEnabled).toBe(false);
      expect(removedShortcut.app?.places).not.toContain("desktop");

      const readded = manager.setDesktopShortcut({ appId, enabled: true });
      expect(readded.desktopShortcutEnabled).toBe(true);
      expect(readded.app?.places).toContain("desktop");
    } finally {
      if (prevEnv === undefined) delete process.env.MOSS_APPS_SHORTCUT_DIR;
      else process.env.MOSS_APPS_SHORTCUT_DIR = prevEnv;
      if (prevNoIconSync === undefined) delete process.env.MOSS_DISABLE_SHORTCUT_ICON_SYNC;
      else process.env.MOSS_DISABLE_SHORTCUT_ICON_SYNC = prevNoIconSync;
    }
  });
});
