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
}
