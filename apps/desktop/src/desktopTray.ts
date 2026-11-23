// FILE: desktopTray.ts
// Purpose: Pure tray close policy, localized tray menu/tooltip builders, crisp icon resolution,
//          and Electron Tray lifecycle controller.
// Layer: Desktop main-process helper
// Exports: shouldHideWindowToTrayOnClose, buildDesktopTrayMenuTemplate, formatDesktopTrayTooltip,
//          resolveDesktopTrayIcon, createDesktopTrayController

import fs from "node:fs";
import type { Menu, MenuItemConstructorOptions, NativeImage } from "electron";
import { isCloseToTraySupported } from "./desktopPreferences";
import { normalizeNativeMenuLocale, type NativeMenuLocale } from "./nativeMenuLocalization";
import { extractIcoPngImages } from "./windowsShellIco";

export const DEFAULT_DESKTOP_TRAY_APP_NAME = "Moss";

const TRAY_SCALE_REPRESENTATIONS = [
  { size: 16, scaleFactor: 1 },
  { size: 20, scaleFactor: 1.25 },
  { size: 24, scaleFactor: 1.5 },
  { size: 32, scaleFactor: 2 },
] as const;

export interface ShouldHideWindowToTrayOnCloseInput {
  readonly platform: NodeJS.Platform;
  readonly closeToTray: boolean;
  readonly explicitQuitRequested: boolean;
  readonly shutdownComplete: boolean;
  readonly updaterHandoffActive: boolean;
}

/**
 * Only Windows/Linux intercept window-close into tray minimization, and only when the user
 * enabled close-to-tray and did not request an explicit quit, shutdown, or updater handoff.
 */
export function shouldHideWindowToTrayOnClose(input: ShouldHideWindowToTrayOnCloseInput): boolean {
  if (!isCloseToTraySupported(input.platform)) {
    return false;
  }
  if (!input.closeToTray) {
    return false;
  }
  if (input.explicitQuitRequested || input.shutdownComplete || input.updaterHandoffActive) {
    return false;
  }
  return true;
}

export function normalizeTrayRunningTaskCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function toLocaleHint(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function formatDesktopTrayTooltip(input: {
  readonly locale?: unknown;
  readonly runningTaskCount?: unknown;
  readonly appName?: string | undefined;
}): string {
  const appName = input.appName?.trim() || DEFAULT_DESKTOP_TRAY_APP_NAME;
  const count = normalizeTrayRunningTaskCount(input.runningTaskCount);
  if (count === 0) {
    return appName;
  }
  const locale = normalizeNativeMenuLocale(toLocaleHint(input.locale));
  if (locale === "zh-CN") {
    return `${appName} · ${count} 个任务运行中`;
  }
  return `${appName} · ${count} running`;
}

export interface BuildDesktopTrayMenuTemplateInput {
  readonly locale?: unknown;
  readonly runningTaskCount: number;
  readonly onOpen: () => void;
  readonly onNewChat: () => void;
  readonly onOpenSettings: () => void;
  readonly onCheckUpdates: () => void;
  readonly onQuit: () => void;
}

export function buildDesktopTrayMenuTemplate(
  input: BuildDesktopTrayMenuTemplateInput,
): MenuItemConstructorOptions[] {
  const locale = normalizeNativeMenuLocale(toLocaleHint(input.locale));
  const count = normalizeTrayRunningTaskCount(input.runningTaskCount);
  const isZhCn = locale === "zh-CN";

  const statusItem: MenuItemConstructorOptions[] =
    count > 0
      ? [
          {
            id: "tray-running-status",
            label: isZhCn ? `● ${count} 个任务运行中` : `● ${count} running`,
            enabled: false,
          },
        ]
      : [];

  return [
    {
      id: "tray-open",
      label: isZhCn ? "打开 Moss" : "Open Moss",
      click: input.onOpen,
    },
    {
      id: "tray-new-chat",
      label: isZhCn ? "新建对话" : "New chat",
      click: input.onNewChat,
    },
    { type: "separator" },
    ...statusItem,
    {
      id: "tray-settings",
      label: isZhCn ? "设置" : "Settings",
      click: input.onOpenSettings,
    },
    {
      id: "tray-check-updates",
      label: isZhCn ? "检查更新" : "Check for updates",
      click: input.onCheckUpdates,
    },
    { type: "separator" },
    {
      id: "tray-quit",
      label: isZhCn ? "退出 Moss" : "Quit Moss",
      click: input.onQuit,
    },
  ];
}

export interface DesktopTrayNativeImageApi {
  readonly createEmpty: () => NativeImage;
  readonly createFromBuffer: (buffer: Buffer) => NativeImage;
  readonly createFromPath: (path: string) => NativeImage;
}

function pngBufferToDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

function buildMultiScaleTrayImage(
  nativeImageApi: DesktopTrayNativeImageApi,
  pngForSize: (size: number) => Buffer | null,
): NativeImage | null {
  const image = nativeImageApi.createEmpty();
  let added = 0;

  for (const rep of TRAY_SCALE_REPRESENTATIONS) {
    const png = pngForSize(rep.size);
    if (!png || png.length === 0) continue;
    image.addRepresentation({
      scaleFactor: rep.scaleFactor,
      width: rep.size,
      height: rep.size,
      dataURL: pngBufferToDataUrl(png),
    });
    added += 1;
  }

  if (added > 0 && !image.isEmpty()) {
    return image;
  }
  return null;
}

function resolveTrayIconFromIco(
  icoPath: string,
  nativeImageApi: DesktopTrayNativeImageApi,
): NativeImage | null {
  try {
    const bytes = fs.readFileSync(icoPath);
    const entries = extractIcoPngImages(bytes);
    if (entries.length === 0) {
      return null;
    }
    const bySize = new Map<number, Buffer>();
    for (const entry of entries) {
      if (entry.width === entry.height && !bySize.has(entry.width)) {
        bySize.set(entry.width, entry.png);
      }
    }
    const largest = entries.reduce((best, item) => (item.width > best.width ? item : best));
    const largestImage = nativeImageApi.createFromBuffer(largest.png);
    const multiScale = buildMultiScaleTrayImage(nativeImageApi, (size) => {
      const exact = bySize.get(size);
      if (exact) return exact;
      if (largestImage.isEmpty()) return null;
      return largestImage.resize({ width: size, height: size, quality: "best" }).toPNG();
    });
    if (multiScale) {
      return multiScale;
    }
    if (!largestImage.isEmpty()) {
      return largestImage.resize({ width: 16, height: 16, quality: "best" });
    }
  } catch {
    // Fall back to PNG app icon candidates below.
  }
  return null;
}

function resolveTrayIconFromPng(
  pngPath: string,
  nativeImageApi: DesktopTrayNativeImageApi,
): NativeImage | null {
  try {
    const baseImage = nativeImageApi.createFromPath(pngPath);
    if (baseImage.isEmpty()) {
      return null;
    }
    const multiScale = buildMultiScaleTrayImage(nativeImageApi, (size) =>
      baseImage.resize({ width: size, height: size, quality: "best" }).toPNG(),
    );
    if (multiScale) {
      return multiScale;
    }
    return baseImage.resize({ width: 16, height: 16, quality: "best" });
  } catch {
    return null;
  }
}

export function resolveDesktopTrayIcon(input: {
  readonly resolveResourcePath: (fileName: string) => string | null;
  readonly nativeImageApi: DesktopTrayNativeImageApi;
  readonly platform?: NodeJS.Platform;
}): NativeImage | null {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    for (const icoName of ["app-icon-windows.ico", "icon.ico"]) {
      const icoPath = input.resolveResourcePath(icoName);
      if (!icoPath) continue;
      const resolved = resolveTrayIconFromIco(icoPath, input.nativeImageApi);
      if (resolved) return resolved;
    }
  }

  const pngCandidates =
    platform === "linux"
      ? ["app-icon-linux.png", "moss.png", "icon.png"]
      : ["moss.png", "icon.png", "app-icon-linux.png"];
  for (const fileName of pngCandidates) {
    const resourcePath = input.resolveResourcePath(fileName);
    if (!resourcePath) continue;
    const resolved = resolveTrayIconFromPng(resourcePath, input.nativeImageApi);
    if (resolved) return resolved;
  }

  return null;
}

export interface DesktopTrayInstance {
  setToolTip: (toolTip: string) => void;
  setContextMenu: (menu: Menu | null) => void;
  on(event: "click", listener: () => void): unknown;
  on(event: "double-click", listener: () => void): unknown;
  destroy: () => void;
  isDestroyed?: () => boolean;
}

export interface CreateDesktopTrayControllerInput {
  readonly icon: NativeImage | string | null;
  readonly createTray: (icon: NativeImage | string) => DesktopTrayInstance;
  readonly buildMenu: (template: MenuItemConstructorOptions[]) => Menu;
  readonly initialLocale?: unknown;
  readonly initialRunningTaskCount?: number;
  readonly appName?: string;
  readonly onOpen: () => void;
  readonly onNewChat: () => void;
  readonly onOpenSettings: () => void;
  readonly onCheckUpdates: () => void;
  readonly onQuit: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface DesktopTrayController {
  readonly isActive: () => boolean;
  readonly getLocale: () => NativeMenuLocale;
  readonly getRunningTaskCount: () => number;
  readonly setLocale: (locale: unknown) => void;
  readonly setRunningTaskCount: (count: unknown) => void;
  readonly destroy: () => void;
}

export function createDesktopTrayController(
  input: CreateDesktopTrayControllerInput,
): DesktopTrayController {
  let locale: NativeMenuLocale = normalizeNativeMenuLocale(toLocaleHint(input.initialLocale));
  let runningTaskCount = normalizeTrayRunningTaskCount(input.initialRunningTaskCount);
  let destroyed = false;
  let tray: DesktopTrayInstance | null = null;

  const syncTray = () => {
    if (!tray || destroyed || tray.isDestroyed?.()) {
      return;
    }
    try {
      tray.setToolTip(
        formatDesktopTrayTooltip({
          locale,
          runningTaskCount,
          appName: input.appName,
        }),
      );
      const template = buildDesktopTrayMenuTemplate({
        locale,
        runningTaskCount,
        onOpen: input.onOpen,
        onNewChat: input.onNewChat,
        onOpenSettings: input.onOpenSettings,
        onCheckUpdates: input.onCheckUpdates,
        onQuit: input.onQuit,
      });
      tray.setContextMenu(input.buildMenu(template));
    } catch (error) {
      input.onError?.(error);
    }
  };

  if (input.icon) {
    try {
      tray = input.createTray(input.icon);
      tray.on("click", input.onOpen);
      tray.on("double-click", input.onOpen);
      syncTray();
    } catch (error) {
      tray = null;
      input.onError?.(error);
    }
  }

  return {
    isActive: () => Boolean(tray && !destroyed && !tray.isDestroyed?.()),
    getLocale: () => locale,
    getRunningTaskCount: () => runningTaskCount,
    setLocale: (nextLocale) => {
      const normalized = normalizeNativeMenuLocale(toLocaleHint(nextLocale));
      if (normalized === locale) {
        return;
      }
      locale = normalized;
      syncTray();
    },
    setRunningTaskCount: (nextCount) => {
      const normalized = normalizeTrayRunningTaskCount(nextCount);
      if (normalized === runningTaskCount) {
        return;
      }
      runningTaskCount = normalized;
      syncTray();
    },
    destroy: () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      const current = tray;
      tray = null;
      if (!current || current.isDestroyed?.()) {
        return;
      }
      try {
        current.destroy();
      } catch (error) {
        input.onError?.(error);
      }
    },
  };
}
