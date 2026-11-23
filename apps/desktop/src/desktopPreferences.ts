// FILE: desktopPreferences.ts
// Purpose: Persist desktop tray/close behavior preferences and safely query/update Electron login-item settings.
// Layer: Desktop main-process helper
// Exports: DesktopPreferences, DesktopLoginItemState, preference persistence, and login-item helpers.

import fs from "node:fs";
import Path from "node:path";

export const DESKTOP_PREFERENCES_FILE_NAME = "desktop-preferences.json";

export interface DesktopPreferences {
  readonly closeToTray: boolean;
  readonly hasShownTrayHint: boolean;
}

export interface DesktopLoginItemState {
  readonly supported: boolean;
  readonly openAtLogin: boolean;
}

export interface DesktopLoginItemApp {
  readonly isPackaged?: boolean;
  readonly getLoginItemSettings?: () => { readonly openAtLogin?: boolean };
  readonly setLoginItemSettings?: (settings: { readonly openAtLogin: boolean }) => void;
}

/** Close-to-tray applies on Windows and Linux where minimizing to the tray replaces closing the last window. */
export function isCloseToTraySupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "linux";
}

export function defaultCloseToTray(platform: NodeJS.Platform = process.platform): boolean {
  return isCloseToTraySupported(platform);
}

export function defaultDesktopPreferences(
  platform: NodeJS.Platform = process.platform,
): DesktopPreferences {
  return {
    closeToTray: defaultCloseToTray(platform),
    hasShownTrayHint: false,
  };
}

export function parseDesktopPreferences(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
): DesktopPreferences {
  const fallback = defaultDesktopPreferences(platform);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fallback;
  }
  const candidate = raw as Record<string, unknown>;
  return {
    closeToTray:
      typeof candidate.closeToTray === "boolean" ? candidate.closeToTray : fallback.closeToTray,
    hasShownTrayHint:
      typeof candidate.hasShownTrayHint === "boolean"
        ? candidate.hasShownTrayHint
        : fallback.hasShownTrayHint,
  };
}

export function resolveDesktopPreferencesPath(configDir: string): string {
  return Path.join(configDir, DESKTOP_PREFERENCES_FILE_NAME);
}

export function readDesktopPreferences(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): DesktopPreferences {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseDesktopPreferences(JSON.parse(raw), platform);
  } catch {
    return defaultDesktopPreferences(platform);
  }
}

export function writeDesktopPreferences(
  filePath: string,
  preferences: DesktopPreferences,
): DesktopPreferences {
  const normalized: DesktopPreferences = {
    closeToTray: Boolean(preferences.closeToTray),
    hasShownTrayHint: Boolean(preferences.hasShownTrayHint),
  };
  fs.mkdirSync(Path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function updateDesktopPreferences(
  filePath: string,
  patch: Partial<DesktopPreferences>,
  platform: NodeJS.Platform = process.platform,
): DesktopPreferences {
  const current = readDesktopPreferences(filePath, platform);
  const next: DesktopPreferences = {
    closeToTray: typeof patch.closeToTray === "boolean" ? patch.closeToTray : current.closeToTray,
    hasShownTrayHint:
      typeof patch.hasShownTrayHint === "boolean"
        ? patch.hasShownTrayHint
        : current.hasShownTrayHint,
  };
  return writeDesktopPreferences(filePath, next);
}

function isPackagedDesktopExecutable(input: {
  readonly isPackaged?: boolean | undefined;
  readonly execPath?: string | undefined;
}): boolean {
  if (input.isPackaged !== true) {
    return false;
  }
  const execPath = input.execPath ?? process.execPath;
  const executableName = Path.basename(execPath).toLowerCase();
  // Dev/unpackaged binaries named electron(.exe) would register bare Electron instead of Moss.
  return executableName !== "electron" && executableName !== "electron.exe";
}

/** Launch-at-login is only wired for packaged Windows and macOS builds with Electron's login-item API. */
export function isLoginItemSupported(input: {
  readonly app: DesktopLoginItemApp;
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
}): boolean {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin") {
    return false;
  }
  if (
    !isPackagedDesktopExecutable({ isPackaged: input.app.isPackaged, execPath: input.execPath })
  ) {
    return false;
  }
  return (
    typeof input.app.getLoginItemSettings === "function" &&
    typeof input.app.setLoginItemSettings === "function"
  );
}

export function readLoginItemState(input: {
  readonly app: DesktopLoginItemApp;
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
}): DesktopLoginItemState {
  if (!isLoginItemSupported(input)) {
    return { supported: false, openAtLogin: false };
  }
  try {
    const settings = input.app.getLoginItemSettings?.();
    return {
      supported: true,
      openAtLogin: settings?.openAtLogin === true,
    };
  } catch {
    return { supported: false, openAtLogin: false };
  }
}

export function writeLoginItemEnabled(input: {
  readonly app: DesktopLoginItemApp;
  readonly enabled: boolean;
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
}): DesktopLoginItemState {
  if (!isLoginItemSupported(input)) {
    return { supported: false, openAtLogin: false };
  }
  try {
    input.app.setLoginItemSettings?.({ openAtLogin: Boolean(input.enabled) });
    const settings = input.app.getLoginItemSettings?.();
    return {
      supported: true,
      openAtLogin: settings?.openAtLogin === true,
    };
  } catch {
    return { supported: false, openAtLogin: false };
  }
}
