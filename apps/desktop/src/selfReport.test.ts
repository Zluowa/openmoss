import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSelfReportWindowControl,
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
