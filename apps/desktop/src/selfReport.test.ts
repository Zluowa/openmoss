import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSelfReportWindowControl,
  keepSelfReportWindowOffscreen,
  offscreenWindowPosition,
  resolveSelfReportWindowPlacement,
  windowPlacementReport,
  pngSize,
  resolveScreenshotDir,
  resolveSelfReportPolicy,
  screenshotFileName,
} from "./selfReport";

describe("resolveSelfReportPolicy", () => {
  it("is on in development builds", () => {
    expect(resolveSelfReportPolicy({ isPackaged: false, env: {} })).toEqual({
      enabled: true,
      reason: "development",
    });
  });

  it("is on in a packaged build only with MOSS_SELF_REPORT=1 and an isolated profile", () => {
    const isolated = { MOSS_DESKTOP_USER_DATA_DIR: Path.join(tmpdir(), "iso", "electron") };
    expect(
      resolveSelfReportPolicy({ isPackaged: true, env: { ...isolated, MOSS_SELF_REPORT: "1" } }),
    ).toEqual({ enabled: true, reason: "isolated-profile" });
    // A person's normal start: neither.
    expect(resolveSelfReportPolicy({ isPackaged: true, env: {} })).toEqual({ enabled: false });
    // The switch alone, in the person's own profile: still off.
    expect(resolveSelfReportPolicy({ isPackaged: true, env: { MOSS_SELF_REPORT: "1" } })).toEqual({
      enabled: false,
    });
    expect(resolveSelfReportPolicy({ isPackaged: true, env: isolated })).toEqual({
      enabled: false,
    });
    expect(
      resolveSelfReportPolicy({ isPackaged: true, env: { ...isolated, MOSS_SELF_REPORT: "true" } }),
    ).toEqual({ enabled: false });
  });
});

describe("screenshot files", () => {
  it("names a file from the label only", () => {
    const at = new Date("2026-11-18T06:30:01.250Z");
    expect(screenshotFileName("element-1101x782", at)).toBe(
      "element-1101x782-2026-11-18T06-30-01-250Z.png",
    );
    expect(screenshotFileName("../../evil name", at)).toBe(
      "evil-name-2026-11-18T06-30-01-250Z.png",
    );
  });

  it("writes into the caller's absolute folder or the profile's self-report folder", () => {
    const profile = Path.join(tmpdir(), "iso", "electron");
    expect(resolveScreenshotDir(undefined, profile)).toBe(
      Path.join(profile, "self-report", "shots"),
    );
    const absolute = Path.join(tmpdir(), "shots");
    expect(resolveScreenshotDir(absolute, profile)).toBe(Path.normalize(absolute));
    expect(() => resolveScreenshotDir("relative/shots", profile)).toThrow(/absolute/);
  });

  it("reads a PNG's size from its header", () => {
    const header = Buffer.alloc(24);
    header.writeUInt32BE(0x49484452, 12);
    header.writeUInt32BE(1651, 16);
    header.writeUInt32BE(1173, 20);
    expect(pngSize(header)).toEqual({ width: 1651, height: 1173 });
    expect(pngSize(Buffer.from("not a png"))).toEqual({ width: 0, height: 0 });
  });
});

describe("createSelfReportWindowControl", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function fakeWindow(zoom = 1.25) {
    const state = {
      size: [1400, 900],
      minimum: [840, 620],
      maximized: true,
      captured: [] as unknown[],
    };
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x49484452, 12);
    png.writeUInt32BE(800, 16);
    png.writeUInt32BE(600, 20);
    const window = {
      getContentSize: () => [...state.size],
      setContentSize: (width: number, height: number) => {
        state.size = [width, height];
      },
      getMinimumSize: () => [...state.minimum],
      setMinimumSize: (width: number, height: number) => {
        state.minimum = [width, height];
      },
      isMaximized: () => state.maximized,
      unmaximize: () => {
        state.maximized = false;
      },
      maximize: () => {
        state.maximized = true;
      },
      webContents: {
        getZoomFactor: () => zoom,
        capturePage: async (rect?: unknown) => {
          state.captured.push(rect);
          return { toPNG: () => png } as unknown as Electron.NativeImage;
        },
      },
    };
    return { window, state };
  }

  it("sizes the page in CSS pixels at the page's zoom, below the usual minimum, and restores", async () => {
    const { window, state } = fakeWindow(1.25);
    dir = mkdtempSync(Path.join(tmpdir(), "moss-self-report-"));
    const control = createSelfReportWindowControl({ window, userDataDir: dir });
    await control.resize({ width: 390, height: 844 });
    expect(state.maximized).toBe(false);
    expect(state.minimum).toEqual([200, 200]);
    expect(state.size).toEqual([488, 1055]);
    await control.resize({ width: 1101, height: 782 });
    expect(state.size).toEqual([1376, 978]);
    await control.restore();
    // As it was before the first resize.
    expect(state).toMatchObject({ size: [1400, 900], minimum: [840, 620], maximized: true });
    await expect(control.resize({ width: 50, height: 50 })).rejects.toThrow(/between 200/);
  });

  it("captures an element's box in window pixels and writes the PNG", async () => {
    const { window, state } = fakeWindow(1.25);
    dir = mkdtempSync(Path.join(tmpdir(), "moss-self-report-"));
    const control = createSelfReportWindowControl({
      window,
      userDataDir: dir,
      now: () => new Date("2026-11-18T06:30:01.250Z"),
    });
    const file = await control.capture({
      rect: { x: 10, y: 20.4, width: 300, height: 100 },
      name: "element-1101x782",
    });
    expect(state.captured).toEqual([{ x: 13, y: 26, width: 375, height: 125 }]);
    expect(file).toEqual({
      path: Path.join(dir, "self-report", "shots", "element-1101x782-2026-11-18T06-30-01-250Z.png"),
      width: 800,
      height: 600,
    });
    expect(readFileSync(file.path).length).toBe(24);
    await control.capture({ name: "window" });
    expect(state.captured[1]).toBeUndefined();
  });
});

describe("off-screen windows for acceptance runs", () => {
  const isolated = { MOSS_DESKTOP_USER_DATA_DIR: Path.join(tmpdir(), "iso", "electron") };
  const on = resolveSelfReportPolicy({
    isPackaged: true,
    env: { ...isolated, MOSS_SELF_REPORT: "1" },
  });
  const offscreen = { MOSS_SELF_REPORT_WINDOW: "offscreen" };

  it("is asked for with MOSS_SELF_REPORT_WINDOW=offscreen, only in an isolated profile", () => {
    expect(resolveSelfReportWindowPlacement({ policy: on, env: offscreen })).toBe("offscreen");
    expect(resolveSelfReportWindowPlacement({ policy: on, env: {} })).toBeNull();
    expect(
      resolveSelfReportWindowPlacement({ policy: { enabled: false }, env: offscreen }),
    ).toBeNull();
    // Never in development, where a person runs Moss on their own screen.
    expect(
      resolveSelfReportWindowPlacement({
        policy: resolveSelfReportPolicy({ isPackaged: false, env: {} }),
        env: offscreen,
      }),
    ).toBeNull();
  });

  it("goes left of every display, a second monitor on the left included", () => {
    const primary = { x: 0, y: 0, width: 2560, height: 1440 };
    const leftMonitor = { x: -1920, y: 200, width: 1920, height: 1080 };
    expect(
      offscreenWindowPosition({ displays: [primary, leftMonitor], primary, width: 1101 }),
    ).toEqual({ x: -1920 - 1101 - 200, y: 40 });
  });

  it("is placed as it is created, has no taskbar button, and stays off after show, maximize, restore, resize and move", () => {
    const listeners = new Map<string, () => void>();
    const state = {
      size: [1100, 780],
      position: [0, 0],
      maximized: false,
      skipTaskbar: false,
    };
    const placedAt: Array<{ x: number; y: number }> = [];
    let moves = 0;
    const window = {
      isDestroyed: () => false,
      isFullScreen: () => false,
      isMaximized: () => state.maximized,
      unmaximize: () => {
        state.maximized = false;
      },
      getSize: () => [...state.size],
      getPosition: () => [...state.position],
      setPosition: (x: number, y: number) => {
        state.position = [x, y];
        moves += 1;
      },
      setSkipTaskbar: (skip: boolean) => {
        state.skipTaskbar = skip;
      },
      on: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
    };
    const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
    keepSelfReportWindowOffscreen(
      window as never,
      { getAllDisplays: () => [display], getPrimaryDisplay: () => display },
      (position) => placedAt.push(position),
    );
    // Before anything shows it.
    expect(state.position).toEqual([-1300, 40]);
    expect(state.skipTaskbar).toBe(true);
    // Moss centers the window when it shows it the first time.
    state.position = [410, 150];
    listeners.get("show")!();
    expect(state.position).toEqual([-1300, 40]);
    state.maximized = true;
    listeners.get("maximize")!();
    expect(state).toMatchObject({ maximized: false, position: [-1300, 40] });
    // A wider window (a screenshot size) moves further left, so no edge reaches the display.
    state.size = [1375, 886];
    listeners.get("resize")!();
    expect(state.position).toEqual([-1575, 40]);
    expect(state.position[0]! + state.size[0]!).toBeLessThan(0);
    // The voice overlay moves itself next to the cursor (same size, so only a move).
    state.position = [600, 500];
    listeners.get("move")!();
    expect(state.position).toEqual([-1575, 40]);
    // Off-screen, Windows rounds the size by a few pixels after a move, which emits a resize.
    // A window still off every display is left alone, so that never turns into endless moves.
    const before = moves;
    state.size = [1380, 890];
    listeners.get("resize")!();
    listeners.get("move")!();
    expect(moves).toBe(before);
    expect(state.position).toEqual([-1575, 40]);
    expect([...listeners.keys()].toSorted()).toEqual([
      "maximize",
      "move",
      "resize",
      "restore",
      "show",
    ]);
    // One log line per window.
    expect(placedAt).toEqual([{ x: -1300, y: 40 }]);
  });

  it("measures whether any display shows the window", () => {
    const displays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: -1920, y: 0, width: 1920, height: 1080 },
    ];
    expect(
      windowPlacementReport({ bounds: { x: -3221, y: 40, width: 1101, height: 782 }, displays }),
    ).toEqual({ left: -3221, top: 40, width: 1101, height: 782, offscreen: true });
    // Part of it on the left monitor is on a screen.
    expect(
      windowPlacementReport({ bounds: { x: -2020, y: 40, width: 101, height: 782 }, displays })
        .offscreen,
    ).toBe(false);
  });
});
