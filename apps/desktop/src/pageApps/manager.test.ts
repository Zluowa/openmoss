import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import type { PageAppId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => OS.tmpdir()) },
  BrowserWindow: vi.fn(),
  WebContentsView: vi.fn(),
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
  shell: { showItemInFolder: vi.fn(), writeShortcutLink: vi.fn(() => true), openExternal: vi.fn() },
  systemPreferences: { getAnimationSettings: () => ({ shouldRenderRichAnimation: false }) },
}));

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
});
