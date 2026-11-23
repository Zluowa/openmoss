import Path from "node:path";
import type { Menu, MenuItemConstructorOptions, NativeImage } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  buildDesktopTrayMenuTemplate,
  createDesktopTrayController,
  formatDesktopTrayTooltip,
  normalizeTrayRunningTaskCount,
  resolveDesktopTrayIcon,
  shouldHideWindowToTrayOnClose,
  type DesktopTrayNativeImageApi,
} from "./desktopTray";

const RESOURCES_DIR = Path.resolve(import.meta.dirname, "../resources");

describe("shouldHideWindowToTrayOnClose", () => {
  it("hides only on Windows and Linux when closeToTray is true and no quit/updater override is active", () => {
    expect(
      shouldHideWindowToTrayOnClose({
        platform: "win32",
        closeToTray: true,
        explicitQuitRequested: false,
        shutdownComplete: false,
        updaterHandoffActive: false,
      }),
    ).toBe(true);

    expect(
      shouldHideWindowToTrayOnClose({
        platform: "linux",
        closeToTray: true,
        explicitQuitRequested: false,
        shutdownComplete: false,
        updaterHandoffActive: false,
      }),
    ).toBe(true);
  });

  it("never hides on macOS, when closeToTray is false, or during explicit quit/shutdown/updater handoff", () => {
    expect(
      shouldHideWindowToTrayOnClose({
        platform: "darwin",
        closeToTray: true,
        explicitQuitRequested: false,
        shutdownComplete: false,
        updaterHandoffActive: false,
      }),
    ).toBe(false);

    expect(
      shouldHideWindowToTrayOnClose({
        platform: "win32",
        closeToTray: false,
        explicitQuitRequested: false,
        shutdownComplete: false,
        updaterHandoffActive: false,
      }),
    ).toBe(false);

    expect(
      shouldHideWindowToTrayOnClose({
        platform: "win32",
        closeToTray: true,
        explicitQuitRequested: true,
        shutdownComplete: false,
        updaterHandoffActive: false,
      }),
    ).toBe(false);

    expect(
      shouldHideWindowToTrayOnClose({
        platform: "win32",
        closeToTray: true,
        explicitQuitRequested: false,
        shutdownComplete: true,
        updaterHandoffActive: false,
      }),
    ).toBe(false);

    expect(
      shouldHideWindowToTrayOnClose({
        platform: "win32",
        closeToTray: true,
        explicitQuitRequested: false,
        shutdownComplete: false,
        updaterHandoffActive: true,
      }),
    ).toBe(false);
  });
});

describe("tooltip and tray menu builder", () => {
  it("normalizes running task counts and formats localized tooltips", () => {
    expect(normalizeTrayRunningTaskCount(-2)).toBe(0);
    expect(normalizeTrayRunningTaskCount(Number.NaN)).toBe(0);
    expect(normalizeTrayRunningTaskCount(3.9)).toBe(3);

    expect(formatDesktopTrayTooltip({ locale: "zh-CN", runningTaskCount: 0 })).toBe("Moss");
    expect(formatDesktopTrayTooltip({ locale: "zh-CN", runningTaskCount: 2 })).toBe(
      "Moss · 2 个任务运行中",
    );
    expect(formatDesktopTrayTooltip({ locale: "en-US", runningTaskCount: 0 })).toBe("Moss");
    expect(formatDesktopTrayTooltip({ locale: "en-US", runningTaskCount: 2 })).toBe(
      "Moss · 2 running",
    );
  });

  it("builds zh-CN tray menu with and without running task indicator and fires action handlers", () => {
    const callbacks = {
      onOpen: vi.fn(),
      onNewChat: vi.fn(),
      onOpenSettings: vi.fn(),
      onCheckUpdates: vi.fn(),
      onQuit: vi.fn(),
    };

    const idleTemplate = buildDesktopTrayMenuTemplate({
      locale: "zh-CN",
      runningTaskCount: 0,
      ...callbacks,
    });
    expect(idleTemplate.map((item) => item.label ?? item.type)).toEqual([
      "打开 Moss",
      "新建对话",
      "separator",
      "设置",
      "检查更新",
      "separator",
      "退出 Moss",
    ]);

    const busyTemplate = buildDesktopTrayMenuTemplate({
      locale: "zh-CN",
      runningTaskCount: 3,
      ...callbacks,
    });
    expect(busyTemplate.map((item) => item.label ?? item.type)).toEqual([
      "打开 Moss",
      "新建对话",
      "separator",
      "● 3 个任务运行中",
      "设置",
      "检查更新",
      "separator",
      "退出 Moss",
    ]);
    expect(busyTemplate[3]).toMatchObject({ enabled: false });

    const clickContext = {} as unknown as Electron.MenuItem;
    const keyboardEvent = {} as unknown as Electron.KeyboardEvent;
    busyTemplate[0]?.click?.(clickContext, undefined, keyboardEvent);
    busyTemplate[1]?.click?.(clickContext, undefined, keyboardEvent);
    busyTemplate[4]?.click?.(clickContext, undefined, keyboardEvent);
    busyTemplate[5]?.click?.(clickContext, undefined, keyboardEvent);
    busyTemplate[7]?.click?.(clickContext, undefined, keyboardEvent);

    expect(callbacks.onOpen).toHaveBeenCalledTimes(1);
    expect(callbacks.onNewChat).toHaveBeenCalledTimes(1);
    expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(callbacks.onCheckUpdates).toHaveBeenCalledTimes(1);
    expect(callbacks.onQuit).toHaveBeenCalledTimes(1);
  });

  it("builds en-US tray menu with and without running task indicator", () => {
    const callbacks = {
      onOpen: vi.fn(),
      onNewChat: vi.fn(),
      onOpenSettings: vi.fn(),
      onCheckUpdates: vi.fn(),
      onQuit: vi.fn(),
    };

    const idleTemplate = buildDesktopTrayMenuTemplate({
      locale: "en-US",
      runningTaskCount: 0,
      ...callbacks,
    });
    expect(idleTemplate.map((item) => item.label ?? item.type)).toEqual([
      "Open Moss",
      "New chat",
      "separator",
      "Settings",
      "Check for updates",
      "separator",
      "Quit Moss",
    ]);

    const busyTemplate = buildDesktopTrayMenuTemplate({
      locale: "en",
      runningTaskCount: 1,
      ...callbacks,
    });
    expect(busyTemplate.map((item) => item.label ?? item.type)).toEqual([
      "Open Moss",
      "New chat",
      "separator",
      "● 1 running",
      "Settings",
      "Check for updates",
      "separator",
      "Quit Moss",
    ]);
    expect(busyTemplate[3]).toMatchObject({ enabled: false });
  });
});

describe("resolveDesktopTrayIcon", () => {
  function createFakeNativeImageApi() {
    const addedReps: Array<{
      scaleFactor: number | undefined;
      width: number | undefined;
      height: number | undefined;
    }> = [];
    const makeImage = (empty = false): NativeImage => {
      const image = {
        addRepresentation: (opts: { scaleFactor?: number; width?: number; height?: number }) => {
          addedReps.push({
            scaleFactor: opts.scaleFactor,
            width: opts.width,
            height: opts.height,
          });
        },
        resize: () => makeImage(false) as unknown as NativeImage,
        toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        isEmpty: () => empty && addedReps.length === 0,
      } as unknown as NativeImage;
      return image;
    };

    const api: DesktopTrayNativeImageApi = {
      createEmpty: () => makeImage(true),
      createFromBuffer: () => makeImage(false),
      createFromPath: () => makeImage(false),
    };
    return { api, addedReps };
  }

  it("extracts multi-scale tray representations from Windows icon.ico", () => {
    const { api, addedReps } = createFakeNativeImageApi();
    const resolved = resolveDesktopTrayIcon({
      platform: "win32",
      nativeImageApi: api,
      resolveResourcePath: (fileName) =>
        fileName === "icon.ico" ? Path.join(RESOURCES_DIR, "icon.ico") : null,
    });

    expect(resolved).not.toBeNull();
    expect(addedReps.map((rep) => `${rep.width}@${rep.scaleFactor}`)).toEqual([
      "16@1",
      "20@1.25",
      "24@1.5",
      "32@2",
    ]);
  });

  it("falls back cleanly to PNG icons on Linux", () => {
    const { api, addedReps } = createFakeNativeImageApi();
    const resolved = resolveDesktopTrayIcon({
      platform: "linux",
      nativeImageApi: api,
      resolveResourcePath: (fileName) =>
        fileName === "app-icon-linux.png" ? Path.join(RESOURCES_DIR, "app-icon-linux.png") : null,
    });

    expect(resolved).not.toBeNull();
    expect(addedReps).toHaveLength(4);
  });
});

describe("createDesktopTrayController", () => {
  it("rebuilds menu and tooltip when locale or running task count changes, wires clicks, and destroys cleanly", () => {
    const listeners = new Map<string, () => void>();
    const setToolTip = vi.fn();
    const setContextMenu = vi.fn();
    const destroy = vi.fn();
    let isTrayDestroyed = false;

    const builtTemplates: MenuItemConstructorOptions[][] = [];
    const buildMenu = vi.fn((template: MenuItemConstructorOptions[]) => {
      builtTemplates.push(template);
      return { template } as unknown as Menu;
    });
    const onOpen = vi.fn();

    const controller = createDesktopTrayController({
      icon: "fake-icon",
      createTray: () => ({
        setToolTip,
        setContextMenu,
        on: (event, listener) => {
          listeners.set(event, listener);
        },
        destroy: () => {
          isTrayDestroyed = true;
          destroy();
        },
        isDestroyed: () => isTrayDestroyed,
      }),
      buildMenu,
      initialLocale: "zh-CN",
      initialRunningTaskCount: 0,
      onOpen,
      onNewChat: vi.fn(),
      onOpenSettings: vi.fn(),
      onCheckUpdates: vi.fn(),
      onQuit: vi.fn(),
    });

    expect(controller.isActive()).toBe(true);
    expect(setToolTip).toHaveBeenLastCalledWith("Moss");
    expect(builtTemplates).toHaveLength(1);

    // No-op when values stay identical.
    controller.setLocale("zh-CN");
    controller.setRunningTaskCount(0);
    expect(builtTemplates).toHaveLength(1);

    // Update running task count -> updates tooltip & rebuilds menu.
    controller.setRunningTaskCount(2);
    expect(setToolTip).toHaveBeenLastCalledWith("Moss · 2 个任务运行中");
    expect(builtTemplates[1]?.[3]).toMatchObject({
      label: "● 2 个任务运行中",
      enabled: false,
    });

    // Switch locale to English -> updates tooltip & rebuilds menu.
    controller.setLocale("en-US");
    expect(setToolTip).toHaveBeenLastCalledWith("Moss · 2 running");
    expect(builtTemplates[2]?.[0]?.label).toBe("Open Moss");
    expect(builtTemplates[2]?.[3]?.label).toBe("● 2 running");

    listeners.get("click")?.();
    listeners.get("double-click")?.();
    expect(onOpen).toHaveBeenCalledTimes(2);

    controller.destroy();
    controller.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(controller.isActive()).toBe(false);

    // Further updates after destroy are ignored.
    controller.setRunningTaskCount(5);
    expect(builtTemplates).toHaveLength(3);
  });

  it("handles missing icons or headless tray initialization failures without throwing", () => {
    const onError = vi.fn();
    const controller = createDesktopTrayController({
      icon: "fake-icon",
      createTray: () => {
        throw new Error("no display");
      },
      buildMenu: () => ({}) as unknown as Menu,
      onOpen: vi.fn(),
      onNewChat: vi.fn(),
      onOpenSettings: vi.fn(),
      onCheckUpdates: vi.fn(),
      onQuit: vi.fn(),
      onError,
    });

    expect(controller.isActive()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    controller.setRunningTaskCount(3);
    controller.destroy();
  });
});
