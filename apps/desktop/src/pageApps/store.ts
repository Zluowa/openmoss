// FILE: store.ts
// Purpose: Persistent 0o600 JSON storage and 8-slot icon rotation for installed Page Apps.
// Layer: Desktop pageApps

import * as FS from "node:fs";
import * as Path from "node:path";

import {
  PAGE_APP_ICON_SLOT_COUNT,
  type DesktopPageAppPermission,
  type InstalledDesktopPageApp,
  type StoredDesktopPageAppPermission,
  type StoredDesktopPageAppWindowStyle,
} from "./types";

const INSTALLED_APPS_FILENAME = "moss-installed-apps.json";
const PERMISSIONS_FILENAME = "moss-app-permissions.json";
const WINDOW_STYLES_FILENAME = "moss-app-window-styles.json";
const ICONS_SUBDIR = Path.join("moss-apps", "icons");
const FILE_MODE_PRIVATE = 0o600;
const DIR_MODE_PRIVATE = 0o700;

interface InstalledAppsFile {
  readonly version: 1;
  readonly apps: InstalledDesktopPageApp[];
}

interface PermissionsFile {
  readonly version: 1;
  readonly records: Record<string, StoredDesktopPageAppPermission>;
}

interface WindowStylesFile {
  readonly version: 1;
  readonly styles: Record<string, StoredDesktopPageAppWindowStyle>;
}

function ensurePrivateDir(dirPath: string): void {
  FS.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE_PRIVATE });
  try {
    FS.chmodSync(dirPath, DIR_MODE_PRIVATE);
  } catch {
    // Windows ignores POSIX chmod bits; best-effort for POSIX hosts.
  }
}

function writePrivateFileSync(filePath: string, data: string | Buffer): void {
  ensurePrivateDir(Path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  FS.writeFileSync(tmpPath, data, { mode: FILE_MODE_PRIVATE });
  try {
    FS.chmodSync(tmpPath, FILE_MODE_PRIVATE);
  } catch {
    // Best effort on Windows.
  }
  FS.renameSync(tmpPath, filePath);
  try {
    FS.chmodSync(filePath, FILE_MODE_PRIVATE);
  } catch {
    // Best effort on Windows.
  }
}

function readJsonFileSync<T>(filePath: string, fallback: T): T {
  try {
    const raw = FS.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as T | null;
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Builds the canonical permission map key `<accountId>|<orgId>|<appId>|<permission>` (lowercased). */
export function buildPermissionStorageKey(
  accountId: string,
  orgId: string,
  appId: string,
  permission: DesktopPageAppPermission,
): string {
  return `${accountId}|${orgId}|${appId}|${permission}`.toLowerCase();
}

/** Parses a canonical permission storage key back into its components, or null if invalid. */
export function parsePermissionStorageKey(key: string): {
  readonly accountId: string;
  readonly orgId: string;
  readonly appId: string;
  readonly permission: string;
} | null {
  const parts = key.split("|");
  if (parts.length !== 4) return null;
  const [accountId, orgId, appId, permission] = parts;
  if (!appId || !permission) return null;
  return { accountId: accountId ?? "", orgId: orgId ?? "", appId, permission };
}

/** Resolves the icon file path for a given installId and rotation slot (0..7). */
export function resolveIconSlotPath(
  userDataDir: string,
  installId: string,
  slot: number,
  ext: "ico" | "png" | "icns" = "ico",
): string {
  const normalizedSlot =
    ((Math.floor(slot) % PAGE_APP_ICON_SLOT_COUNT) + PAGE_APP_ICON_SLOT_COUNT) %
    PAGE_APP_ICON_SLOT_COUNT;
  const suffix = normalizedSlot === 0 ? "" : `-${normalizedSlot}`;
  return Path.join(userDataDir, ICONS_SUBDIR, `${installId}${suffix}.${ext}`);
}

export class DesktopPageAppStore {
  readonly userDataDir: string;
  readonly installedAppsPath: string;
  readonly permissionsPath: string;
  readonly windowStylesPath: string;
  readonly iconsDir: string;

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
    this.installedAppsPath = Path.join(userDataDir, INSTALLED_APPS_FILENAME);
    this.permissionsPath = Path.join(userDataDir, PERMISSIONS_FILENAME);
    this.windowStylesPath = Path.join(userDataDir, WINDOW_STYLES_FILENAME);
    this.iconsDir = Path.join(userDataDir, ICONS_SUBDIR);
  }

  listInstalled(): InstalledDesktopPageApp[] {
    const file = readJsonFileSync<InstalledAppsFile>(this.installedAppsPath, {
      version: 1,
      apps: [],
    });
    return Array.isArray(file.apps) ? [...file.apps] : [];
  }

  saveInstalledList(apps: readonly InstalledDesktopPageApp[]): void {
    const payload: InstalledAppsFile = { version: 1, apps: [...apps] };
    writePrivateFileSync(this.installedAppsPath, JSON.stringify(payload, null, 2));
  }

  findInstalledByAppId(appId: string): InstalledDesktopPageApp | null {
    return this.listInstalled().find((entry) => entry.appId === appId) ?? null;
  }

  findInstalledByInstallId(installId: string): InstalledDesktopPageApp | null {
    return this.listInstalled().find((entry) => entry.installId === installId) ?? null;
  }

  upsertInstalled(entry: InstalledDesktopPageApp): InstalledDesktopPageApp[] {
    const current = this.listInstalled().filter(
      (item) => item.installId !== entry.installId && item.appId !== entry.appId,
    );
    const next = [...current, entry];
    this.saveInstalledList(next);
    return next;
  }

  removeInstalledByInstallId(installId: string): InstalledDesktopPageApp | null {
    const current = this.listInstalled();
    const removed = current.find((item) => item.installId === installId) ?? null;
    if (!removed) return null;
    this.saveInstalledList(current.filter((item) => item.installId !== installId));
    return removed;
  }

  /** Allocates the next 8-slot icon path and cleans up all previous slot files for that installId. */
  writeRotatedIcon(
    installId: string,
    bytes: Buffer,
    currentSlot: number | undefined,
    ext: "ico" | "png" | "icns" = "ico",
  ): { readonly iconPath: string; readonly iconSlot: number } {
    ensurePrivateDir(this.iconsDir);
    const nextSlot = currentSlot === undefined ? 0 : (currentSlot + 1) % PAGE_APP_ICON_SLOT_COUNT;
    const iconPath = resolveIconSlotPath(this.userDataDir, installId, nextSlot, ext);
    writePrivateFileSync(iconPath, bytes);
    for (let slot = 0; slot < PAGE_APP_ICON_SLOT_COUNT; slot += 1) {
      if (slot === nextSlot) continue;
      for (const candidateExt of ["ico", "png", "icns"] as const) {
        const candidate = resolveIconSlotPath(this.userDataDir, installId, slot, candidateExt);
        try {
          if (FS.existsSync(candidate)) FS.unlinkSync(candidate);
        } catch {
          // Best effort cleanup of rotated icon slots.
        }
      }
    }
    return { iconPath, iconSlot: nextSlot };
  }

  removeAllIconSlots(installId: string): void {
    for (let slot = 0; slot < PAGE_APP_ICON_SLOT_COUNT; slot += 1) {
      for (const ext of ["ico", "png", "icns"] as const) {
        const candidate = resolveIconSlotPath(this.userDataDir, installId, slot, ext);
        try {
          if (FS.existsSync(candidate)) FS.unlinkSync(candidate);
        } catch {
          // Best effort cleanup.
        }
      }
    }
  }

  readAllPermissions(): Record<string, StoredDesktopPageAppPermission> {
    const file = readJsonFileSync<PermissionsFile>(this.permissionsPath, {
      version: 1,
      records: {},
    });
    return file.records && typeof file.records === "object" ? { ...file.records } : {};
  }

  writeAllPermissions(records: Record<string, StoredDesktopPageAppPermission>): void {
    const payload: PermissionsFile = { version: 1, records };
    writePrivateFileSync(this.permissionsPath, JSON.stringify(payload, null, 2));
  }

  getPermission(
    accountId: string,
    orgId: string,
    appId: string,
    permission: DesktopPageAppPermission,
  ): StoredDesktopPageAppPermission | null {
    const key = buildPermissionStorageKey(accountId, orgId, appId, permission);
    return this.readAllPermissions()[key] ?? null;
  }

  setPermission(
    accountId: string,
    orgId: string,
    appId: string,
    permission: DesktopPageAppPermission,
    record: StoredDesktopPageAppPermission | null,
  ): void {
    const all = this.readAllPermissions();
    const key = buildPermissionStorageKey(accountId, orgId, appId, permission);
    if (record === null) {
      delete all[key];
    } else {
      all[key] = record;
    }
    this.writeAllPermissions(all);
  }

  /**
   * Removes granted permissions for an app on uninstall while retaining explicit `"denied"`
   * records across uninstall/reinstall cycles.
   */
  removePermissionsForApp(appId: string): void {
    const targetAppId = appId.toLowerCase();
    const all = this.readAllPermissions();
    let changed = false;
    for (const key of Object.keys(all)) {
      const parsed = parsePermissionStorageKey(key);
      if (parsed && parsed.appId.toLowerCase() === targetAppId && all[key]?.answer === "granted") {
        delete all[key];
        changed = true;
      }
    }
    if (changed) {
      this.writeAllPermissions(all);
    }
  }

  getWindowStyle(appKey: string): StoredDesktopPageAppWindowStyle | null {
    const file = readJsonFileSync<WindowStylesFile>(this.windowStylesPath, {
      version: 1,
      styles: {},
    });
    return file.styles?.[appKey] ?? null;
  }

  setWindowStyle(appKey: string, style: StoredDesktopPageAppWindowStyle | null): void {
    const file = readJsonFileSync<WindowStylesFile>(this.windowStylesPath, {
      version: 1,
      styles: {},
    });
    const nextStyles = { ...file.styles };
    if (style === null) {
      delete nextStyles[appKey];
    } else {
      nextStyles[appKey] = style;
    }
    writePrivateFileSync(
      this.windowStylesPath,
      JSON.stringify({ version: 1, styles: nextStyles } satisfies WindowStylesFile, null, 2),
    );
  }
}
