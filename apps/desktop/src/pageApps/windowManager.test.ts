import type { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => {
  const { EventEmitter: NodeEventEmitter } = await import("node:events");

  class MockBrowserWindow extends NodeEventEmitter {
    setMenuBarVisibility = vi.fn();
    setAppDetails = vi.fn();
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    getContentBounds = vi.fn(() => ({ x: 0, y: 0, width: 980, height: 720 }));
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 980, height: 720 }));
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
    setAlwaysOnTop = vi.fn();
    setIgnoreMouseEvents = vi.fn();
  }

  class MockWebContents extends NodeEventEmitter {
    id = 42;
    isDestroyed = vi.fn(() => false);
    setBackgroundThrottling = vi.fn();
    setWindowOpenHandler = vi.fn();
    loadURL = vi.fn(() => Promise.resolve());
    getTitle = vi.fn(() => "Test App");
    insertCSS = vi.fn(() => Promise.resolve());
    copyImageAt = vi.fn();
  }

  class MockWebContentsView {
    webContents = new MockWebContents();
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
  }

  return {
    BrowserWindow: MockBrowserWindow,
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
    WebContentsView: MockWebContentsView,
    globalShortcut: { unregister: vi.fn() },
    nativeTheme: { shouldUseDarkColors: false },
    powerSaveBlocker: { isStarted: vi.fn(() => false), stop: vi.fn() },
    screen: {
      getAllDisplays: vi.fn(() => []),
      getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    },
    shell: { showItemInFolder: vi.fn(), openExternal: vi.fn() },
  };
});

import {
  StandalonePageAppWindowManager,
  applyPageAppPermissionsPolicyHeaders,
  buildFileAppsMenuItem,
  isSuspiciousNavigationUrl,
  registerPageAppHeaderPolicy,
  shouldStandInForQuit,
  unregisterPageAppHeaderPolicy,
} from "./windowManager";

describe("windowManager", () => {
  it("routes per-webContentsId Permissions-Policy headers while preserving upstream directives", () => {
    registerPageAppHeaderPolicy(101, { transparent: true });
    registerPageAppHeaderPolicy(102, { transparent: false });

    const unmodified = applyPageAppPermissionsPolicyHeaders({
      webContentsId: 999,
      responseHeaders: { "Permissions-Policy": ["fullscreen=(self)"] },
    });
    expect(unmodified).toBeNull();

    const transparentHeaders = applyPageAppPermissionsPolicyHeaders({
      webContentsId: 101,
      responseHeaders: {
        "Permissions-Policy": ["usb=(), fullscreen=(self)"],
      },
    });
    const policy101 = transparentHeaders?.["Permissions-Policy"]?.[0] ?? "";
    expect(policy101).toContain("usb=()");
    expect(policy101).toContain("fullscreen=(self)");
    expect(policy101).toContain("camera=()");
    expect(policy101).toContain("microphone=()");
    expect(policy101).toContain("geolocation=()");

    const opaqueHeaders = applyPageAppPermissionsPolicyHeaders({
      webContentsId: 102,
      responseHeaders: {
        "permissions-policy": ["midi=()"],
      },
    });
    const policy102 = opaqueHeaders?.["Permissions-Policy"]?.[0] ?? "";
    expect(policy102).toContain("midi=()");
    expect(policy102).toContain("geolocation=()");
    expect(policy102).not.toContain("camera=()");

    unregisterPageAppHeaderPolicy(101);
    unregisterPageAppHeaderPolicy(102);
  });

  it("evaluates standInForQuit, suspicious FQDN URLs, and File -> 应用 menu construction", () => {
    expect(
      shouldStandInForQuit({
        openStandaloneCount: 1,
        updaterQuitAndInstall: false,
        desktopShutdownComplete: false,
      }),
    ).toBe(true);
    expect(
      shouldStandInForQuit({
        openStandaloneCount: 0,
        updaterQuitAndInstall: false,
        desktopShutdownComplete: false,
      }),
    ).toBe(false);
    expect(isSuspiciousNavigationUrl("https://evil.example./frame")).toBe(true);
    expect(isSuspiciousNavigationUrl("http://127.0.0.1:3000/apps/1")).toBe(false);

    const menu = buildFileAppsMenuItem(
      [
        {
          installId: "0123456789abcdef0123456789abcdef",
          appId: "app-1" as never,
          name: "微信阅读",
          revision: 1,
          places: ["desktop"],
          installedAt: "2026-11-26T00:00:00.000Z",
        },
      ],
      {
        onOpen: vi.fn(),
        onShowInFolder: vi.fn(),
        onAbout: vi.fn(),
        onPermissions: vi.fn(),
        onReport: vi.fn(),
        onUninstall: vi.fn(),
      },
    );
    expect(menu?.label).toBe("应用");
    expect((menu?.submenu as Array<{ label?: string }>)?.[0]?.label).toBe("微信阅读");
  });

  it("wires session.takeGesture to entry.takeGesture and requires a fresh unconsumed input event", () => {
    vi.useFakeTimers();
    try {
      const manager = new StandalonePageAppWindowManager({
        store: {
          getWindowStyle: vi.fn(() => undefined),
          setWindowStyle: vi.fn(),
          findInstalledByInstallId: vi.fn(() => undefined),
          findInstalledByAppId: vi.fn(() => undefined),
        } as never,
        permissions: {
          evaluate: vi.fn(() => ({ state: "prompt", effectiveSource: "none" })),
        } as never,
        dialogs: {} as never,
        executor: {
          registerSession: vi.fn(),
          unregisterSession: vi.fn(),
        } as never,
        preloadPath: "D:/fake/windowPreload.mjs",
      });

      const entry = manager.openOrFocus({
        appId: "app-gesture" as never,
        installId: null,
        accountId: "acct-1",
        orgId: "org-1",
        appName: "Gesture Guard App",
        isInstalled: false,
        revision: 1,
        contentHash: "hash-1",
        declaredPermissions: [],
        trustKind: "owner",
        targetUrl: "http://127.0.0.1:3000/apps/app-gesture",
        expectedFrameOrigin: "http://127.0.0.1:3000",
        iconPath: null,
        referenceText: "http://127.0.0.1:3000/apps/app-gesture",
        executablePath: "D:/fake/Moss.exe",
        hidden: true,
      });

      expect(typeof entry.session.takeGesture).toBe("function");
      expect(entry.session.takeGesture?.()).toBe(false);

      vi.advanceTimersByTime(10);
      (entry.view.webContents as unknown as EventEmitter).emit(
        "before-mouse-event",
        {},
        {
          type: "mouseDown",
        },
      );
      expect(entry.session.takeGesture?.()).toBe(true);
      expect(entry.session.takeGesture?.()).toBe(false);

      vi.advanceTimersByTime(10);
      (entry.view.webContents as unknown as EventEmitter).emit(
        "before-input-event",
        { preventDefault: vi.fn() },
        { type: "keyDown", key: "Enter", isAutoRepeat: false, alt: false, control: false },
      );
      manager.suppressHostForDialogs(true, entry.browserWindow);
      expect(entry.session.takeGesture?.()).toBe(false);
      manager.suppressHostForDialogs(false, entry.browserWindow);
      expect(entry.session.takeGesture?.()).toBe(true);
      expect(entry.session.takeGesture?.()).toBe(false);

      vi.advanceTimersByTime(10);
      (entry.view.webContents as unknown as EventEmitter).emit(
        "before-mouse-event",
        {},
        {
          type: "mouseDown",
        },
      );
      vi.advanceTimersByTime(5_000);
      expect(entry.session.takeGesture?.()).toBe(false);

      // Resize persists bounds after debounce and close flushes immediately.
      const setWindowStyle = vi.fn();
      const boundsManager = new StandalonePageAppWindowManager({
        store: {
          getWindowStyle: vi.fn(() => undefined),
          setWindowStyle,
          findInstalledByInstallId: vi.fn(() => undefined),
          findInstalledByAppId: vi.fn(() => undefined),
        } as never,
        permissions: {
          evaluate: vi.fn(() => ({ state: "prompt", effectiveSource: "none" })),
        } as never,
        dialogs: {} as never,
        executor: {
          registerSession: vi.fn(),
          unregisterSession: vi.fn(),
        } as never,
        preloadPath: "D:/fake/windowPreload.mjs",
      });
      const boundsEntry = boundsManager.openOrFocus({
        appId: "app-bounds" as never,
        installId: null,
        accountId: "acct-1",
        orgId: "org-1",
        appName: "Bounds App",
        isInstalled: false,
        revision: 1,
        contentHash: "hash-1",
        declaredPermissions: [],
        trustKind: "owner",
        targetUrl: "http://127.0.0.1:3000/apps/app-bounds",
        expectedFrameOrigin: "http://127.0.0.1:3000",
        iconPath: null,
        referenceText: "http://127.0.0.1:3000/apps/app-bounds",
        executablePath: "D:/fake/Moss.exe",
        hidden: true,
      });
      (boundsEntry.browserWindow as unknown as EventEmitter).emit("resize");
      expect(setWindowStyle).not.toHaveBeenCalled();
      vi.advanceTimersByTime(160);
      expect(setWindowStyle).toHaveBeenCalledTimes(1);

      (boundsEntry.browserWindow as unknown as EventEmitter).emit("close", {
        preventDefault: vi.fn(),
      });
      expect(setWindowStyle).toHaveBeenCalledTimes(2);

      (boundsEntry.browserWindow as unknown as EventEmitter).emit("closed");
      (entry.browserWindow as unknown as EventEmitter).emit("closed");
    } finally {
      vi.useRealTimers();
    }
  });
});
