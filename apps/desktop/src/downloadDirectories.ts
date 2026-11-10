// FILE: downloadDirectories.ts
// Purpose: Keep Electron's standard file-picker locations usable in isolated profiles.
// Layer: Desktop startup

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

export type DownloadDirectoryName = "desktop" | "downloads";

export interface DownloadDirectoryApp {
  getPath(name: DownloadDirectoryName): string;
  setPath(name: DownloadDirectoryName, value: string): void;
}

export interface DownloadDirectoryFs {
  mkdirSync(path: string, options: { recursive: true }): void;
}

/**
 * Electron can return a standard Windows folder that has not been created yet
 * in a disposable or redirected user profile. Create both locations before
 * renderer downloads or native save dialogs use them, then publish the paths
 * back to Electron so the next picker opens in Downloads instead of a missing
 * Desktop folder.
 */
export function ensureDownloadDirectories(
  app: DownloadDirectoryApp,
  fs: DownloadDirectoryFs = FS,
): Readonly<Record<DownloadDirectoryName, string>> {
  const result = {} as Record<DownloadDirectoryName, string>;
  for (const name of ["desktop", "downloads"] as const) {
    let directory: string;
    try {
      directory = app.getPath(name);
    } catch {
      directory = Path.join(OS.homedir(), name === "desktop" ? "Desktop" : "Downloads");
    }
    if (!Path.isAbsolute(directory)) {
      directory = Path.join(OS.homedir(), name === "desktop" ? "Desktop" : "Downloads");
    }
    fs.mkdirSync(directory, { recursive: true });
    try {
      app.setPath(name, directory);
    } catch {
      // A read-only host can still use the existing directory for this run.
    }
    result[name] = directory;
  }
  return result;
}
