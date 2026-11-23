import fs from "node:fs";
import os from "node:os";
import Path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultCloseToTray,
  defaultDesktopPreferences,
  isCloseToTraySupported,
  isLoginItemSupported,
  parseDesktopPreferences,
  readDesktopPreferences,
  readLoginItemState,
  resolveDesktopPreferencesPath,
  updateDesktopPreferences,
  writeDesktopPreferences,
  writeLoginItemEnabled,
} from "./desktopPreferences";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), "moss-desktop-prefs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("desktopPreferences", () => {
  it("resolves close-to-tray support and defaults by platform", () => {
    expect(isCloseToTraySupported("win32")).toBe(true);
    expect(isCloseToTraySupported("linux")).toBe(true);
    expect(isCloseToTraySupported("darwin")).toBe(false);

    expect(defaultCloseToTray("win32")).toBe(true);
    expect(defaultCloseToTray("linux")).toBe(true);
    expect(defaultCloseToTray("darwin")).toBe(false);

    expect(defaultDesktopPreferences("win32")).toEqual({
      closeToTray: true,
      hasShownTrayHint: false,
    });
    expect(defaultDesktopPreferences("darwin")).toEqual({
      closeToTray: false,
      hasShownTrayHint: false,
    });
  });

  it("falls back safely when JSON is missing, corrupt, or partially invalid", () => {
    const dir = createTempDir();
    const filePath = resolveDesktopPreferencesPath(dir);

    expect(readDesktopPreferences(filePath, "win32")).toEqual({
      closeToTray: true,
      hasShownTrayHint: false,
    });

    fs.writeFileSync(filePath, "{not valid json", "utf8");
    expect(readDesktopPreferences(filePath, "win32")).toEqual({
      closeToTray: true,
      hasShownTrayHint: false,
    });

    expect(
      parseDesktopPreferences({ closeToTray: "yes", hasShownTrayHint: true }, "win32"),
    ).toEqual({
      closeToTray: true,
      hasShownTrayHint: true,
    });
    expect(parseDesktopPreferences(["unexpected"], "linux")).toEqual({
      closeToTray: true,
      hasShownTrayHint: false,
    });
  });

  it("writes and partially updates preferences on disk", () => {
    const dir = createTempDir();
    const filePath = resolveDesktopPreferencesPath(Path.join(dir, "nested"));

    const written = writeDesktopPreferences(filePath, {
      closeToTray: false,
      hasShownTrayHint: false,
    });
    expect(written).toEqual({ closeToTray: false, hasShownTrayHint: false });
    expect(readDesktopPreferences(filePath, "win32")).toEqual({
      closeToTray: false,
      hasShownTrayHint: false,
    });

    const updated = updateDesktopPreferences(filePath, { hasShownTrayHint: true }, "win32");
    expect(updated).toEqual({ closeToTray: false, hasShownTrayHint: true });
    expect(readDesktopPreferences(filePath, "win32")).toEqual({
      closeToTray: false,
      hasShownTrayHint: true,
    });
  });

  it("marks launch-at-login unsupported on Linux, dev binaries, or missing APIs", () => {
    const packagedApp = {
      isPackaged: true,
      getLoginItemSettings: () => ({ openAtLogin: true }),
      setLoginItemSettings: vi.fn(),
    };

    expect(
      isLoginItemSupported({
        app: packagedApp,
        platform: "linux",
        execPath: "/opt/Moss/moss",
      }),
    ).toBe(false);
    expect(
      readLoginItemState({
        app: packagedApp,
        platform: "linux",
        execPath: "/opt/Moss/moss",
      }),
    ).toEqual({ supported: false, openAtLogin: false });

    expect(
      readLoginItemState({
        app: { ...packagedApp, isPackaged: false },
        platform: "win32",
        execPath: "C:\\dev\\electron.exe",
      }),
    ).toEqual({ supported: false, openAtLogin: false });

    expect(
      readLoginItemState({
        app: packagedApp,
        platform: "win32",
        execPath: "C:\\dev\\electron.exe",
      }),
    ).toEqual({ supported: false, openAtLogin: false });
  });

  it("reads and updates launch-at-login safely on packaged Windows and macOS apps", () => {
    let storedOpenAtLogin = false;
    const setLoginItemSettings = vi.fn((settings: { readonly openAtLogin: boolean }) => {
      storedOpenAtLogin = settings.openAtLogin;
    });
    const appStub = {
      isPackaged: true,
      getLoginItemSettings: () => ({ openAtLogin: storedOpenAtLogin }),
      setLoginItemSettings,
    };

    expect(
      readLoginItemState({
        app: appStub,
        platform: "win32",
        execPath: "C:\\Program Files\\Moss\\Moss.exe",
      }),
    ).toEqual({ supported: true, openAtLogin: false });

    expect(
      writeLoginItemEnabled({
        app: appStub,
        enabled: true,
        platform: "win32",
        execPath: "C:\\Program Files\\Moss\\Moss.exe",
      }),
    ).toEqual({ supported: true, openAtLogin: true });
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });

    expect(
      writeLoginItemEnabled({
        app: appStub,
        enabled: false,
        platform: "darwin",
        execPath: "/Applications/Moss.app/Contents/MacOS/Moss",
      }),
    ).toEqual({ supported: true, openAtLogin: false });
  });

  it("handles Electron login-item exceptions without throwing", () => {
    const brokenApp = {
      isPackaged: true,
      getLoginItemSettings: () => {
        throw new Error("registry unavailable");
      },
      setLoginItemSettings: () => {
        throw new Error("permission denied");
      },
    };

    expect(
      readLoginItemState({
        app: brokenApp,
        platform: "win32",
        execPath: "C:\\Program Files\\Moss\\Moss.exe",
      }),
    ).toEqual({ supported: false, openAtLogin: false });

    expect(
      writeLoginItemEnabled({
        app: brokenApp,
        enabled: true,
        platform: "win32",
        execPath: "C:\\Program Files\\Moss\\Moss.exe",
      }),
    ).toEqual({ supported: false, openAtLogin: false });
  });
});
