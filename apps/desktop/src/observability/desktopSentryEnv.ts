// FILE: desktopSentryEnv.ts
// Purpose: Decides the Sentry settings desktop processes add on top of their launch environment.
// Layer: Desktop runtime observability
// Depends on: Shared Moss configuration names and the local preference file.

import * as FS from "node:fs";
import * as Path from "node:path";

import { MOSS_SENTRY_DSN_ENV, MOSS_SENTRY_ENVIRONMENT_ENV } from "@moss/shared/observability";

/**
 * A packaged app never sees the build environment, so release builds embed the
 * DSN. A launch environment still wins, and an empty value turns reporting off
 * for a rehearsal of a packaged build. Development builds embed nothing, so an
 * embedded DSN also means this is a production build.
 */
export function resolveDesktopSentryEnv(
  env: Readonly<Record<string, string | undefined>>,
  embeddedDsn: string,
): Readonly<Record<string, string>> {
  const dsn = embeddedDsn.trim();
  if (!dsn || env[MOSS_SENTRY_DSN_ENV] !== undefined) return {};
  return {
    [MOSS_SENTRY_DSN_ENV]: dsn,
    [MOSS_SENTRY_ENVIRONMENT_ENV]: env[MOSS_SENTRY_ENVIRONMENT_ENV]?.trim() || "production",
  };
}

/**
 * The server settings hold the user's choice, but main needs it before the
 * backend is up, so the renderer mirrors it here. No file means reports are on,
 * the default. A file that can't be understood means off: it may hold a "no".
 */
export function readDesktopErrorReportsPreference(path: string): boolean {
  let saved: string;
  try {
    saved = FS.readFileSync(path, "utf8").trim();
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
  return saved === "on";
}

export async function writeDesktopErrorReportsPreference(
  path: string,
  enabled: boolean,
): Promise<void> {
  await FS.promises.mkdir(Path.dirname(path), { recursive: true });
  const stagedPath = `${path}.${process.pid}.tmp`;
  await FS.promises.writeFile(stagedPath, enabled ? "on\n" : "off\n", "utf8");
  await FS.promises.rename(stagedPath, path);
}
