// FILE: appFileIcon.ts
// Purpose: Reads another app's system icon for Settings › Computer use rows, from the
//          executable or bundle path the computer driver reported.
// Layer: Desktop main process
// Exports: isReadableAppIconPath, readAppFileIconDataUrl

import * as Path from "node:path";

/** Small and bounded: one settings page lists at most a few dozen apps. */
const ICON_CACHE_LIMIT = 64;
const iconCache = new Map<string, string | null>();

/**
 * Only an absolute path to an app (`.exe` on Windows, `.app` on macOS) is
 * read. The renderer cannot use this to probe arbitrary files: anything else
 * answers null without touching the disk.
 */
export function isReadableAppIconPath(raw: unknown, platform = process.platform): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_096) return false;
  if (raw.includes("\0")) return false;
  const path = platform === "win32" ? Path.win32 : Path.posix;
  if (!path.isAbsolute(raw)) return false;
  const lower = raw.toLowerCase();
  return platform === "win32"
    ? lower.endsWith(".exe")
    : platform === "darwin"
      ? lower.endsWith(".app") || lower.endsWith(".app/")
      : false;
}

export async function readAppFileIconDataUrl(
  raw: unknown,
  getFileIcon: (path: string) => Promise<{ isEmpty(): boolean; toDataURL(): string }>,
  platform = process.platform,
): Promise<string | null> {
  if (!isReadableAppIconPath(raw, platform)) return null;
  const cached = iconCache.get(raw);
  if (cached !== undefined) return cached;
  let icon: string | null = null;
  try {
    const image = await getFileIcon(raw);
    icon = image.isEmpty() ? null : image.toDataURL();
  } catch {
    icon = null;
  }
  if (iconCache.size >= ICON_CACHE_LIMIT) {
    const oldest = iconCache.keys().next().value;
    if (oldest !== undefined) iconCache.delete(oldest);
  }
  iconCache.set(raw, icon);
  return icon;
}
