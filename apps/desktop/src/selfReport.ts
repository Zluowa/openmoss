// FILE: selfReport.ts
// Purpose: The desktop half of Moss's self-report tools (the renderer half is
//          apps/web/src/lib/selfReport): whether they exist in this process, and the window
//          resize and capture behind `screenshot`.
//
// Where they exist:
// - development (unpackaged) builds: always;
// - packaged builds: only when the process starts with MOSS_SELF_REPORT=1 AND an isolated
//   profile (MOSS_DESKTOP_USER_DATA_DIR), which is how the acceptance kit launches Moss. A person
//   starting Moss normally never has either, so the tools are absent: no window global, no IPC
//   handler, no listener. They are kept in packaged builds on purpose: acceptance must check the
//   build that ships, not a development build.
// They add no new way in: an outside session reaches them through the renderer, i.e. the
// debugging port the launcher opened, which already gives full control of the page. They read
// only this window's screen, never storage, other chats, tokens or files.
// Layer: Desktop main process

import { mkdir, writeFile } from "node:fs/promises";
import * as Path from "node:path";

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, NativeImage } from "electron";

import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

export { SELF_REPORT_PRELOAD_ARGUMENT } from "./selfReportArgument";
export const SELF_REPORT_ENV = "MOSS_SELF_REPORT";

export type SelfReportPolicy =
  | { readonly enabled: true; readonly reason: "development" | "isolated-profile" }
  | { readonly enabled: false };

export function resolveSelfReportPolicy(input: {
  readonly isPackaged: boolean;
  readonly env: NodeJS.ProcessEnv;
}): SelfReportPolicy {
  if (!input.isPackaged) return { enabled: true, reason: "development" };
  const isolatedProfile = Boolean(input.env.MOSS_DESKTOP_USER_DATA_DIR?.trim());
  return input.env[SELF_REPORT_ENV] === "1" && isolatedProfile
    ? { enabled: true, reason: "isolated-profile" }
    : { enabled: false };
}

/** Set to "offscreen" (with self-report on) to keep the window off every display. */
export const SELF_REPORT_WINDOW_ENV = "MOSS_SELF_REPORT_WINDOW";

/**
 * Acceptance runs keep every window off the person's screen: neither DevTools nor `moveTo`
 * can move a Moss window, so the launcher asks for it here. Honoured only for a packaged build
 * in an isolated profile with self-report on (never in development, never in a normal start).
 */
export function resolveSelfReportWindowPlacement(input: {
  readonly policy: SelfReportPolicy;
  readonly env: NodeJS.ProcessEnv;
}): "offscreen" | null {
  return input.policy.enabled &&
    input.policy.reason === "isolated-profile" &&
    input.env[SELF_REPORT_WINDOW_ENV]?.trim() === "offscreen"
    ? "offscreen"
    : null;
}

/** Where a window is, and whether any display shows any of it (measured, not assumed). */
export function windowPlacementReport(input: {
  readonly bounds: PlacementRect;
  readonly displays: ReadonlyArray<PlacementRect>;
}): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly offscreen: boolean;
} {
  const { bounds } = input;
  const onSome = input.displays.some(
    (display) =>
      bounds.x < display.x + display.width &&
      display.x < bounds.x + bounds.width &&
      bounds.y < display.y + display.height &&
      display.y < bounds.y + bounds.height,
  );
  return {
    left: bounds.x,
    top: bounds.y,
    width: bounds.width,
    height: bounds.height,
    offscreen: !onSome,
  };
}

interface PlacementRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Left of every display, with a margin, level with the primary display's top. */
export function offscreenWindowPosition(input: {
  readonly displays: ReadonlyArray<PlacementRect>;
  readonly primary: PlacementRect;
  readonly width: number;
}): { readonly x: number; readonly y: number } {
  const left = Math.min(input.primary.x, ...input.displays.map((display) => display.x));
  return { x: left - input.width - 200, y: input.primary.y + 40 };
}

type OffscreenWindow = Pick<
  BrowserWindow,
  | "isDestroyed"
  | "isMaximized"
  | "unmaximize"
  | "isFullScreen"
  | "getSize"
  | "getPosition"
  | "setPosition"
  | "setSkipTaskbar"
> & {
  on(event: "show" | "maximize" | "restore" | "resize" | "move", listener: () => void): unknown;
};

/**
 * Puts the window off every display as it is created (before it is ever shown) and again after
 * anything that brings any of it back onto a display: a show (Moss may center it), a maximize, a
 * restore, a resize (a wider window reaches further right) or a move (the voice overlay places
 * itself near the cursor). A window already off every display is left where it is: on Windows,
 * moving an off-screen window changes its size by a few pixels of rounding, which emits a
 * resize, so re-placing on every event never ends (seen 2026-11-18: the main window jittered and
 * the main process spun at full speed). It has no taskbar button, so it never flashes there.
 * `onPlaced` hears the first placement (for one log line).
 */
export function keepSelfReportWindowOffscreen(
  window: OffscreenWindow,
  screen: {
    getAllDisplays(): ReadonlyArray<{ readonly bounds: PlacementRect }>;
    getPrimaryDisplay(): { readonly bounds: PlacementRect };
  },
  onPlaced?: (position: { readonly x: number; readonly y: number }) => void,
): void {
  let placed = false;
  window.setSkipTaskbar(true);
  const place = () => {
    if (window.isDestroyed() || window.isFullScreen()) return;
    if (window.isMaximized()) window.unmaximize();
    const displays = screen.getAllDisplays().map((display) => display.bounds);
    const [currentX = 0, currentY = 0] = window.getPosition();
    const [width = 0, height = 0] = window.getSize();
    if (
      placed &&
      windowPlacementReport({ bounds: { x: currentX, y: currentY, width, height }, displays })
        .offscreen
    ) {
      return;
    }
    const { x, y } = offscreenWindowPosition({
      displays,
      primary: screen.getPrimaryDisplay().bounds,
      width,
    });
    window.setPosition(x, y);
    if (!placed) {
      placed = true;
      onPlaced?.({ x, y });
    }
  };
  place();
  for (const event of ["show", "maximize", "restore", "resize", "move"] as const) {
    window.on(event, place);
  }
}

export interface SelfReportSize {
  readonly width: number;
  readonly height: number;
}

export interface SelfReportCaptureRequest {
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly dir?: string;
  readonly name: string;
}

/** Page CSS pixels to window DIPs at the page's zoom. */
export function toDips(value: number, zoomFactor: number): number {
  return Math.max(1, Math.round(value * zoomFactor));
}

/** A file name from the caller's label: letters, digits, underscore and dash only. */
export function screenshotFileName(name: string, now: Date): string {
  const label =
    name
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "screen";
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${label}-${stamp}.png`;
}

/** The caller's absolute folder, or `self-report/shots` in this profile. */
export function resolveScreenshotDir(dir: string | undefined, userDataDir: string): string {
  if (dir !== undefined) {
    if (!Path.isAbsolute(dir)) throw new Error("dir must be an absolute folder.");
    return Path.normalize(dir);
  }
  return Path.join(userDataDir, "self-report", "shots");
}

/** Width and height from a PNG's header, in device pixels. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) return { width: 0, height: 0 };
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function validSize(size: unknown): size is SelfReportSize {
  const value = size as SelfReportSize | null;
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width >= 200 &&
    value.height >= 200 &&
    value.width <= 7680 &&
    value.height <= 4320
  );
}

type SelfReportWindow = Pick<
  BrowserWindow,
  | "getContentSize"
  | "setContentSize"
  | "getMinimumSize"
  | "setMinimumSize"
  | "isMaximized"
  | "unmaximize"
  | "maximize"
> & {
  readonly webContents: {
    getZoomFactor(): number;
    capturePage(rect?: Electron.Rectangle): Promise<NativeImage>;
  };
};

/**
 * The window's resize/capture/restore for one main window. `resize` remembers the size it found
 * the first time; `restore` puts it back (also the minimum size and a maximized state).
 */
export function createSelfReportWindowControl(input: {
  readonly window: SelfReportWindow;
  readonly userDataDir: string;
  readonly now?: () => Date;
}) {
  const { window } = input;
  let saved: { size: number[]; minimum: number[]; maximized: boolean } | null = null;
  return {
    resize: async (size: unknown): Promise<void> => {
      if (!validSize(size))
        throw new Error("A size needs a width and height between 200 and 7680x4320.");
      saved ??= {
        size: window.getContentSize(),
        minimum: window.getMinimumSize(),
        maximized: window.isMaximized(),
      };
      if (window.isMaximized()) window.unmaximize();
      // A phone width is below the window's usual minimum.
      window.setMinimumSize(200, 200);
      const zoom = window.webContents.getZoomFactor();
      window.setContentSize(toDips(size.width, zoom), toDips(size.height, zoom));
    },
    capture: async (
      request: SelfReportCaptureRequest,
    ): Promise<{ path: string; width: number; height: number }> => {
      const zoom = window.webContents.getZoomFactor();
      const rect = request.rect
        ? {
            x: Math.max(0, Math.round(request.rect.x * zoom)),
            y: Math.max(0, Math.round(request.rect.y * zoom)),
            width: toDips(request.rect.width, zoom),
            height: toDips(request.rect.height, zoom),
          }
        : undefined;
      const image = await window.webContents.capturePage(rect);
      const png = image.toPNG();
      const dir = resolveScreenshotDir(request.dir, input.userDataDir);
      await mkdir(dir, { recursive: true });
      const path = Path.join(
        dir,
        screenshotFileName(String(request.name ?? ""), input.now?.() ?? new Date()),
      );
      await writeFile(path, png);
      return { path, ...pngSize(png) };
    },
    restore: async (): Promise<void> => {
      if (!saved) return;
      const { size, minimum, maximized } = saved;
      saved = null;
      window.setContentSize(size[0]!, size[1]!);
      window.setMinimumSize(minimum[0]!, minimum[1]!);
      if (maximized) window.maximize();
    },
  };
}

/**
 * Answers the renderer's self-report calls, from the main window only. Called once, and only
 * when {@link resolveSelfReportPolicy} enabled self-report.
 */
export function registerSelfReportIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly userDataDir: string;
  readonly mainWindowFor: (event: IpcMainInvokeEvent) => BrowserWindow | null;
  readonly screen: { getAllDisplays(): ReadonlyArray<{ readonly bounds: PlacementRect }> };
}): void {
  const controls = new WeakMap<BrowserWindow, ReturnType<typeof createSelfReportWindowControl>>();
  const controlFor = (event: IpcMainInvokeEvent) => {
    const window = input.mainWindowFor(event);
    if (!window) throw new Error("Self-report answers the main window only.");
    let control = controls.get(window);
    if (!control) {
      control = createSelfReportWindowControl({ window, userDataDir: input.userDataDir });
      controls.set(window, control);
    }
    return control;
  };
  const channels = DESKTOP_IPC_CHANNELS.selfReport;
  input.ipcMain.handle(channels.resize, (event, size: unknown) => controlFor(event).resize(size));
  input.ipcMain.handle(channels.capture, (event, request: SelfReportCaptureRequest) =>
    controlFor(event).capture(request),
  );
  input.ipcMain.handle(channels.restore, (event) => controlFor(event).restore());
  input.ipcMain.handle(channels.placement, (event) => {
    const window = input.mainWindowFor(event);
    if (!window) throw new Error("Self-report answers the main window only.");
    return windowPlacementReport({
      bounds: window.getBounds(),
      displays: input.screen.getAllDisplays().map((display) => display.bounds),
    });
  });
}
