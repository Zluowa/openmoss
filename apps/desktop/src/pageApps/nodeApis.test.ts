import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { dock: undefined },
  BrowserWindow: vi.fn(),
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    isRegistered: vi.fn(() => false),
  },
  Menu: { buildFromTemplate: vi.fn((t: unknown) => t), setApplicationMenu: vi.fn() },
  nativeImage: {
    createFromBuffer: vi.fn(),
    createFromDataURL: vi.fn(),
    createFromPath: vi.fn(),
    createEmpty: vi.fn(),
  },
  nativeTheme: { shouldUseDarkColors: false },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
  powerMonitor: { getSystemIdleState: vi.fn(() => "active") },
  powerSaveBlocker: { start: vi.fn(() => 1), isStarted: vi.fn(() => false), stop: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => []),
    getPrimaryDisplay: vi.fn(),
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    getDisplayNearestPoint: vi.fn(),
    getDisplayMatching: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(),
    openExternal: vi.fn(),
  },
  Tray: vi.fn(),
  WebContentsView: vi.fn(),
}));

import type { PageAppDialogHost } from "./dialogs";
import {
  clampBoundsToWorkArea,
  createGestureTracker,
  hasShadowingExecutableSibling,
  isForbiddenShellOpenTarget,
  normalizeDraggableRegions,
  PageAppNodeApiError,
  PageAppNodeApiExecutor,
  resolveSafeFsPath,
  sanitizeNotificationBody,
  sanitizePageAppMenuTemplate,
  teardownOverlayForSession,
  teardownProcessesForSession,
  teardownShortcutsForSession,
  teardownTrayForSession,
  validateGlobalShortcutAccelerator,
  type NodeApiWindowSession,
} from "./nodeApis";
import { DesktopPageAppPermissionEngine } from "./permissions";
import { DesktopPageAppStore } from "./store";
import { buildFileAppsMenuItem, shouldStandInForQuit } from "./windowManager";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-page-apps-api-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

const dummyDialogs: PageAppDialogHost = {
  confirmInstall: async () => true,
  showInstallComplete: async () => "ok",
  showAlreadyInstalled: async () => "open",
  confirmPermission: async () => false,
  managePermissions: async () => ({ saved: false, grants: {} }),
  confirmReload: async () => true,
  showUnavailable: async () => "keep",
  confirmUninstall: async () => true,
  showAbout: async () => undefined,
};

describe("nodeApis & windowManager policies", () => {
  it("validates global shortcuts and rejects forbidden combos", () => {
    expect(validateGlobalShortcutAccelerator("Control+Shift+K", "win32").ok).toBe(true);
    expect(validateGlobalShortcutAccelerator("Shift+Alt+P", "win32").ok).toBe(true);
    expect(validateGlobalShortcutAccelerator("Control+K", "win32").ok).toBe(false);
    expect(validateGlobalShortcutAccelerator("Control+Alt+K", "win32").ok).toBe(false);
    expect(validateGlobalShortcutAccelerator("Super+Shift+K", "win32").ok).toBe(false);
    expect(validateGlobalShortcutAccelerator("Cmd+Shift+K", "win32").ok).toBe(false);
    expect(validateGlobalShortcutAccelerator("Cmd+Shift+K", "darwin").ok).toBe(true);
    expect(validateGlobalShortcutAccelerator("Control+Shift+Escape", "win32").ok).toBe(false);
    expect(validateGlobalShortcutAccelerator("Control+Shift+Tab", "win32").ok).toBe(false);
    expect(validateGlobalShortcutAccelerator("Control+Shift+PrintScreen", "win32").ok).toBe(false);
    expect(validateGlobalShortcutAccelerator("Control+Shift+" + "A".repeat(60), "win32").ok).toBe(
      false,
    );
  });

  it("sanitizes notification bodies by Unicode code points and rejects > 2000 raw chars", () => {
    expect(sanitizeNotificationBody("  hello\n\tworld  ")).toBe("hello world");
    expect(sanitizeNotificationBody("a".repeat(350))).toHaveLength(300);
    expect(Array.from(sanitizeNotificationBody("🚀".repeat(320)))).toHaveLength(300);
    expect(() => sanitizeNotificationBody("a".repeat(2001))).toThrow(PageAppNodeApiError);
    expect(() => sanitizeNotificationBody("   \n  ")).toThrow(PageAppNodeApiError);
  });

  it("clamps window bounds to work area and prioritizes no-drag regions up to 64", () => {
    const clamped = clampBoundsToWorkArea({ x: 1900, y: 1200, width: 10, height: 10 }, 40, 40, [
      { x: 0, y: 0, width: 1920, height: 1080 },
    ]);
    expect(clamped).toEqual({ x: 1880, y: 1040, width: 40, height: 40 });

    const rawRegions = [
      ...Array.from({ length: 70 }, (_, i) => ({ x: i, y: 0, width: 10, height: 10, drag: true })),
      { x: 5, y: 5, width: 20, height: 20, drag: false },
    ];
    const normalized = normalizeDraggableRegions(rawRegions);
    expect(normalized).toHaveLength(64);
    expect(normalized[0]?.drag).toBe(false);
  });

  it("rejects menu roles, Cmd+Q, deep nesting > 4, and > 500 items", () => {
    expect(() =>
      sanitizePageAppMenuTemplate([{ label: "Copy", role: "copy" }], () => undefined),
    ).toThrow(PageAppNodeApiError);
    expect(() =>
      sanitizePageAppMenuTemplate([{ label: "Quit", accelerator: "Cmd+Q" }], () => undefined),
    ).toThrow(PageAppNodeApiError);
    expect(() =>
      sanitizePageAppMenuTemplate(
        [{ label: "Force Quit", accelerator: "Opt+Cmd+Esc" }],
        () => undefined,
      ),
    ).toThrow(PageAppNodeApiError);

    const deep = {
      label: "1",
      submenu: [
        {
          label: "2",
          submenu: [{ label: "3", submenu: [{ label: "4", submenu: [{ label: "5" }] }] }],
        },
      ],
    };
    expect(() => sanitizePageAppMenuTemplate([deep], () => undefined)).toThrow(PageAppNodeApiError);

    const tooMany = Array.from({ length: 501 }, (_, i) => ({ label: `Item ${i}` }));
    expect(() => sanitizePageAppMenuTemplate(tooMany, () => undefined)).toThrow(
      PageAppNodeApiError,
    );
  });

  it("blocks dangerous executables and extensionless files in shell.openPath", () => {
    expect(isForbiddenShellOpenTarget("/tmp/payload.exe", true)).toBe(true);
    expect(isForbiddenShellOpenTarget("/tmp/script.ps1", true)).toBe(true);
    expect(isForbiddenShellOpenTarget("/tmp/shadowbin", true)).toBe(true);
    expect(isForbiddenShellOpenTarget("/tmp/folder", false)).toBe(false);
    expect(isForbiddenShellOpenTarget("/tmp/report.pdf", true)).toBe(false);
  });

  it("enforces direct-child iframe origin and kills processes on mixed versions", () => {
    const store = new DesktopPageAppStore(createTempDir());
    const permissions = new DesktopPageAppPermissionEngine(store);
    const executor = new PageAppNodeApiExecutor({
      store,
      permissions,
      dialogs: dummyDialogs,
    });

    const killSpy = vi.fn();
    const mainFrame = { id: 1 } as unknown as Electron.WebFrameMain;
    const childFrame = {
      id: 2,
      parent: mainFrame,
      origin: "http://app-1.moss-app.localhost:3000",
    } as unknown as Electron.WebFrameMain;
    const grandchildFrame = {
      id: 3,
      parent: childFrame,
      origin: "http://app-1.moss-app.localhost:3000",
    } as unknown as Electron.WebFrameMain;

    const session: NodeApiWindowSession = {
      appId: "app-1",
      installId: null,
      accountId: "acc",
      orgId: "org",
      appName: "Test App",
      isInstalled: false,
      revision: 1,
      contentHash: "h1",
      declaredPermissions: ["notifications"],
      trustKind: "owner",
      hasMixedVersions: false,
      expectedFrameOrigin: "http://app-1.moss-app.localhost:3000",
      browserWindow: { isDestroyed: () => false } as unknown as Electron.BrowserWindow,
      contentWebContents: { id: 42, mainFrame } as unknown as Electron.WebContents,
      iconPath: null,
      referenceText: "moss://apps/app-1",
      registeredShortcuts: new Set(),
      childProcesses: new Map([["p1", { kill: killSpy } as never]]),
      ptyProcesses: new Map(),
      lastShellOpenAt: 0,
      draggableRegions: [],
    };
    executor.registerSession(session);

    // Reject main frame
    expect(() =>
      executor.verifyCaller({
        sender: session.contentWebContents,
        senderFrame: mainFrame,
      } as unknown as Electron.IpcMainInvokeEvent),
    ).toThrow(PageAppNodeApiError);

    // Reject grandchild frame
    expect(() =>
      executor.verifyCaller({
        sender: session.contentWebContents,
        senderFrame: grandchildFrame,
      } as unknown as Electron.IpcMainInvokeEvent),
    ).toThrow(PageAppNodeApiError);

    // Accept direct child frame
    expect(
      executor.verifyCaller({
        sender: session.contentWebContents,
        senderFrame: childFrame,
      } as unknown as Electron.IpcMainInvokeEvent).appId,
    ).toBe("app-1");

    // Mixed versions -> SIGKILL and throw
    (session as { hasMixedVersions: boolean }).hasMixedVersions = true;
    expect(() =>
      executor.verifyCaller({
        sender: session.contentWebContents,
        senderFrame: childFrame,
      } as unknown as Electron.IpcMainInvokeEvent),
    ).toThrow(PageAppNodeApiError);
    expect(killSpy).toHaveBeenCalledWith("SIGKILL");
  });

  it("evaluates standInForQuit and File -> 应用 menu", () => {
    expect(
      shouldStandInForQuit({
        openStandaloneCount: 1,
        updaterQuitAndInstall: false,
        desktopShutdownComplete: false,
      }),
    ).toBe(true);
    expect(
      shouldStandInForQuit({
        openStandaloneCount: 1,
        updaterQuitAndInstall: true,
        desktopShutdownComplete: false,
      }),
    ).toBe(false);

    expect(
      buildFileAppsMenuItem([], {
        onOpen: () => undefined,
        onShowInFolder: () => undefined,
        onAbout: () => undefined,
        onPermissions: () => undefined,
        onReport: () => undefined,
        onUninstall: () => undefined,
      }),
    ).toBeNull();

    const menu = buildFileAppsMenuItem(
      [
        {
          installId: "0123456789abcdef0123456789abcdef",
          appId: "app-x" as never,
          name: "Orbit",
          revision: 1,
          places: ["start-menu"],
          installedAt: "2026-11-26T00:00:00.000Z",
        },
      ],
      {
        onOpen: () => undefined,
        onShowInFolder: () => undefined,
        onAbout: () => undefined,
        onPermissions: () => undefined,
        onReport: () => undefined,
        onUninstall: () => undefined,
      },
      "zh-CN",
    );
    expect(menu?.label).toBe("应用");
    expect(Array.isArray(menu?.submenu)).toBe(true);
  });

  it("detects sibling executable shadowing for extensionless directories and validates fs paths", async () => {
    const dir = createTempDir();
    const targetDir = Path.join(dir, "tools");
    FS.mkdirSync(targetDir);
    expect(await hasShadowingExecutableSibling(targetDir)).toBe(false);
    FS.writeFileSync(Path.join(dir, "tools.exe"), "stub");
    expect(await hasShadowingExecutableSibling(targetDir)).toBe(true);

    expect(() => resolveSafeFsPath("bad\u0000path.txt")).toThrow(PageAppNodeApiError);
    expect(resolveSafeFsPath("~/notes.txt")).toBe(Path.join(OS.homedir(), "notes.txt"));
  });

  it("rejects destroyed/detached/null-origin callers, enforces screen/os tiers, and gates gesture actions", async () => {
    const store = new DesktopPageAppStore(createTempDir());
    const permissions = new DesktopPageAppPermissionEngine(store, () => ({
      enabled: true,
      permissionsEnabled: true,
      fullAccessEnabled: true,
    }));
    const confirmPermission = vi.fn(async () => true);
    const triggerInstall = vi.fn(async () => ({ installed: true }));
    const openPermissions = vi.fn(async () => undefined);
    const executor = new PageAppNodeApiExecutor({
      store,
      permissions,
      dialogs: { ...dummyDialogs, confirmPermission },
    });

    const mainFrame = {
      id: 1,
      send: vi.fn(),
      isDestroyed: () => false,
    } as unknown as Electron.WebFrameMain;
    const childFrame = {
      id: 2,
      parent: mainFrame,
      origin: "http://app-sec.moss-app.localhost:3000",
      detached: false,
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as Electron.WebFrameMain;

    const gesture = createGestureTracker(5_000);
    const session: NodeApiWindowSession = {
      appId: "app-sec",
      installId: null,
      accountId: "acc",
      orgId: "org",
      appName: "Sec App",
      isInstalled: false,
      revision: 1,
      contentHash: "h1",
      declaredPermissions: ["overlay", "notifications", "full-access"],
      trustKind: "owner",
      hasMixedVersions: false,
      expectedFrameOrigin: "null",
      browserWindow: {
        isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        setBounds: vi.fn(),
        isResizable: () => true,
        setResizable: vi.fn(),
        isAlwaysOnTop: () => false,
        setAlwaysOnTop: vi.fn(),
        getTitle: () => "Sec App",
        setTitle: vi.fn(),
        setIgnoreMouseEvents: vi.fn(),
        setVisibleOnAllWorkspaces: vi.fn(),
        webContents: { mainFrame },
      } as unknown as Electron.BrowserWindow,
      contentWebContents: {
        id: 77,
        mainFrame,
        isDestroyed: () => false,
      } as unknown as Electron.WebContents,
      iconPath: null,
      referenceText: "moss://apps/app-sec",
      registeredShortcuts: new Set(),
      childProcesses: new Map(),
      ptyProcesses: new Map(),
      lastShellOpenAt: 0,
      draggableRegions: [],
      takeGesture: gesture.takeGesture,
      onTriggerInstall: triggerInstall,
      onOpenPermissionsWindow: openPermissions,
    };
    executor.registerSession(session);

    // Reject "null" expectedFrameOrigin wildcard
    expect(() =>
      executor.verifyCaller({
        sender: session.contentWebContents,
        senderFrame: childFrame,
      } as unknown as Electron.IpcMainInvokeEvent),
    ).toThrow(PageAppNodeApiError);

    (session as { expectedFrameOrigin: string }).expectedFrameOrigin =
      "http://app-sec.moss-app.localhost:3000";

    // Reject detached frame
    (childFrame as unknown as { detached: boolean }).detached = true;
    expect(() =>
      executor.verifyCaller({
        sender: session.contentWebContents,
        senderFrame: childFrame,
      } as unknown as Electron.IpcMainInvokeEvent),
    ).toThrow(PageAppNodeApiError);
    (childFrame as unknown as { detached: boolean }).detached = false;

    const call = (namespace: string, method: string, args: unknown = null) =>
      executor.execute(
        {
          sender: session.contentWebContents,
          senderFrame: childFrame,
        } as unknown as Electron.IpcMainInvokeEvent,
        { namespace, method, args },
      );

    // os.platform & os.arch succeed at Tier 1 without prompting
    expect(await call("os", "platform")).toBe(process.platform);
    expect(await call("os", "arch")).toBe(process.arch);
    expect(confirmPermission).not.toHaveBeenCalled();

    // screen.getCursorScreenPoint requires overlay (Tier 2) -> prompts once
    const electronMod = await import("electron");
    vi.mocked(electronMod.screen.getCursorScreenPoint).mockReturnValueOnce({ x: 12, y: 34 });
    expect(await call("screen", "getCursorScreenPoint")).toEqual({ x: 12, y: 34 });
    expect(confirmPermission).toHaveBeenCalledTimes(1);

    // install.request & permissions.manage require 5s single-use gesture
    await expect(call("install", "request")).rejects.toThrow(PageAppNodeApiError);
    gesture.recordGesture();
    await call("install", "request");
    expect(triggerInstall).toHaveBeenCalledTimes(1);
    // Consumed on first use -> second call without new gesture fails
    await expect(call("permissions", "manage")).rejects.toThrow(PageAppNodeApiError);
    gesture.recordGesture();
    await call("permissions", "manage");
    expect(openPermissions).toHaveBeenCalledTimes(1);

    // Fail-closed: missing session.takeGesture also rejects install.request & permissions.manage
    const prevTakeGesture = session.takeGesture;
    session.takeGesture = undefined;
    await expect(call("install", "request")).rejects.toThrow(PageAppNodeApiError);
    await expect(call("permissions", "manage")).rejects.toThrow(PageAppNodeApiError);
    session.takeGesture = prevTakeGesture;

    // permissions.request sorts full-access first so Tier 2 cascades without extra prompts
    confirmPermission.mockClear();
    const permResult = (await call("permissions", "request", [
      "notifications",
      "full-access",
    ])) as Record<string, string>;
    expect(permResult["full-access"]).toBe("granted");
    expect(permResult.notifications).toBe("granted");
    expect(confirmPermission).toHaveBeenCalledTimes(1);

    // os.info requires full-access (now granted) and includes username & uptime
    const osInfo = (await call("os", "info")) as Record<string, unknown>;
    expect(typeof osInfo.username).toBe("string");
    expect(typeof osInfo.uptime).toBe("number");

    // install.state returns unified schema
    expect(await call("install", "state")).toEqual({
      installed: false,
      available: true,
      installId: null,
      name: "Sec App",
      places: [],
      app: null,
      policy: {
        enabled: true,
        permissionsEnabled: true,
        fullAccessEnabled: true,
      },
    });

    // window.setOptions rejects transparent without frame:false and returns unified result shape
    await expect(call("window", "setOptions", { transparent: true })).rejects.toThrow(
      PageAppNodeApiError,
    );
    const setRes = (await call("window", "setOptions", { alwaysOnTop: true })) as {
      applied: string;
      reloading: boolean;
    };
    expect(setRes.applied).toBe("now");
    expect(setRes.reloading).toBe(false);

    // Standalone teardown helpers work cleanly
    teardownShortcutsForSession(session);
    teardownTrayForSession(session);
    teardownProcessesForSession(session);
    teardownOverlayForSession(session);
  });

  it("maintains persistent main-bridge sessions and routes desktopApiEvent to mainWindow", async () => {
    const store = new DesktopPageAppStore(createTempDir());
    const permissions = new DesktopPageAppPermissionEngine(store, () => ({
      enabled: true,
      permissionsEnabled: true,
      fullAccessEnabled: true,
    }));
    const executor = new PageAppNodeApiExecutor({
      store,
      permissions,
      dialogs: dummyDialogs,
    });

    permissions.setPermission({
      accountId: "acc",
      orgId: "org",
      appId: "main-app",
      permission: "full-access",
      answer: "granted",
      revision: 1,
      contentHash: "h1",
      declaredPermissions: ["full-access"],
    });

    const sentEvents: unknown[] = [];
    const mainWin = {
      isDestroyed: () => false,
      webContents: {
        id: 501,
        isDestroyed: () => false,
        once: vi.fn(),
        send: (_channel: string, payload: unknown) => {
          sentEvents.push(payload);
        },
      },
    } as unknown as Electron.BrowserWindow;

    const defaults = {
      accountId: "acc",
      orgId: "org",
      appName: "Main App",
      declaredPermissions: ["full-access"] as const,
      trustKind: "owner" as const,
    };

    const execRes = (await executor.executeFromMainBridge(
      {
        appId: "main-app" as never,
        revision: 1,
        contentHash: "h1",
        namespace: "childProcess",
        method: "exec",
        args: { command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"` },
      },
      mainWin,
      defaults,
    )) as { stdout: string; exitCode: number; truncated: boolean };
    expect(execRes.stdout).toBe("ok");
    expect(execRes.exitCode).toBe(0);
    expect(execRes.truncated).toBe(false);

    // Spawn and verify output event arrives on mainWindow.webContents via desktopApiEvent
    await executor.executeFromMainBridge(
      {
        appId: "main-app" as never,
        revision: 1,
        contentHash: "h1",
        namespace: "childProcess",
        method: "spawn",
        args: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('streamed')"],
          clientId: "cp-main-1",
        },
      },
      mainWin,
      defaults,
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      sentEvents.some(
        (ev) =>
          typeof ev === "object" &&
          ev !== null &&
          (ev as { event?: string; targetId?: string }).targetId === "cp-main-1",
      ),
    ).toBe(true);
  });
});
