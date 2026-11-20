// FILE: macUpdateNotice.ts
// Purpose: New versions for Mac builds that cannot update themselves. Squirrel.Mac only replaces
//          the app with a build that satisfies the running app's designated requirement; an
//          ad-hoc signed build's requirement is its own cdhash, so every other build is refused
//          after the whole zip has been downloaded. Such a build never asks electron-updater:
//          it reads a small notice beside the desktop feed and links to the download page.
// Layer: Desktop update runtime (no Electron imports; main.ts passes the fetch and team id).

import type { DesktopUpdateState } from "@moss/contracts";
import { MOSS_DESKTOP_UPDATE_FEED_PATH } from "@moss/shared/mossUpdateMirror";

import {
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";

/** Where a Mac user downloads Moss by hand. Fixed here: the notice file only carries a version. */
export const MOSS_DOWNLOAD_PAGE_URL = "https://mossbotai.com/download";

/**
 * The notice, under each download source (`mossDownloadSources.ts`), beside `latest.yml`. Its body
 * is `{"version":"X.Y.Z"}`. Installed Macs before this file existed only read `moss-mac.yml`, so
 * publishing the notice cannot start a download that would fail on them.
 */
export const MAC_UPDATE_NOTICE_PATH = `${MOSS_DESKTOP_UPDATE_FEED_PATH}moss-mac-notice.json`;

const NOTICE_REQUEST_TIMEOUT_MS = 10_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export type DesktopUpdateDelivery = "in-app" | "manual-download";

/**
 * `readTeamId` reports the running app's signing team the way main.ts's `ownAppTeamId` does: the
 * team id, null when ad-hoc signed or unsigned, "unavailable" when codesign could not tell. Only a
 * real team id keeps the in-app update, so an install that would fail is never offered.
 */
export function resolveDesktopUpdateDelivery(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly readTeamId: () => string | null;
}): DesktopUpdateDelivery {
  // Unpackaged runs keep electron-updater so mock-update rehearsals behave as before.
  if (input.platform !== "darwin" || !input.isPackaged) return "in-app";
  const teamId = input.readTeamId();
  return teamId === null || teamId === "unavailable" ? "manual-download" : "in-app";
}

export function parseMacUpdateNotice(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const version = (parsed as { readonly version?: unknown }).version;
  return typeof version === "string" && VERSION_PATTERN.test(version.trim())
    ? version.trim()
    : null;
}

export type MacUpdateNoticeFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

export type MacUpdateNoticeResult =
  | { readonly status: "found"; readonly version: string }
  | { readonly status: "none" }
  | { readonly status: "failed"; readonly message: string };

/**
 * Tries each source in order. The first readable notice wins; a 404 means nothing is announced
 * (yet); anything else moves on to the next source.
 */
export async function fetchMacUpdateNotice(input: {
  readonly sources: ReadonlyArray<string>;
  readonly fetch: MacUpdateNoticeFetch;
  readonly timeoutMs?: number;
}): Promise<MacUpdateNoticeResult> {
  let sawMissing = false;
  const problems: string[] = [];
  for (const source of input.sources) {
    const url = new URL(MAC_UPDATE_NOTICE_PATH, source);
    url.searchParams.set("noCache", Date.now().toString(32));
    try {
      const response = await input.fetch(url.toString(), {
        signal: AbortSignal.timeout(input.timeoutMs ?? NOTICE_REQUEST_TIMEOUT_MS),
      });
      if (response.status === 404) {
        sawMissing = true;
        continue;
      }
      if (!response.ok) {
        problems.push(`${url.host} answered ${response.status}`);
        continue;
      }
      const version = parseMacUpdateNotice(await response.text());
      if (version) return { status: "found", version };
      problems.push(`${url.host} served an unreadable notice`);
    } catch (error) {
      problems.push(`${url.host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (sawMissing) return { status: "none" };
  return {
    status: "failed",
    message: `Could not read the update notice (${problems.join("; ")}).`,
  };
}

export function applyMacUpdateNoticeResult(
  state: DesktopUpdateState,
  result: MacUpdateNoticeResult,
  options: { readonly acceptVersion: (version: string) => boolean; readonly checkedAt: string },
): DesktopUpdateState {
  if (result.status === "found" && options.acceptVersion(result.version)) {
    return reduceDesktopUpdateStateOnUpdateAvailable(state, result.version, options.checkedAt);
  }
  if (result.status === "failed") {
    // A flaky network must not take back a version already announced.
    if (state.status === "available" && state.availableVersion !== null) return state;
    return reduceDesktopUpdateStateOnCheckFailure(state, result.message, options.checkedAt);
  }
  return reduceDesktopUpdateStateOnNoUpdate(state, options.checkedAt);
}
