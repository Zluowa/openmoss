// FILE: whatsNew/useMossWhatsNew.ts
// Purpose: Shared state for the post-update top-right "What's new" header button and its dialog,
//          aligned with Claude Desktop's quiet ghost accent nudge: never auto-opens a modal,
//          appears only when the installed version has release notes and has not been seen yet,
//          marks the version seen on open, and hides once the dialog closes until the next update.
// Layer: Hook + module-level external store

import { useCallback, useSyncExternalStore } from "react";

import { APP_VERSION } from "~/branding";
import {
  MOSS_RELEASES,
  compareMossVersions,
  mossReleaseForVersion,
  mossReleasesUpTo,
  type MossRelease,
} from "./mossReleases";

export const MOSS_WHATS_NEW_HEADER_STORAGE_KEY = "moss:whats-new-header:v1";

interface MossWhatsNewHeaderSnapshot {
  readonly dialogOpen: boolean;
  readonly dialogVersion: string | null;
  readonly lastSeenVersion: string | null;
}

const listeners = new Set<() => void>();

function readLastSeenVersionFromStorage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MOSS_WHATS_NEW_HEADER_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") {
      return parsed.trim().length > 0 ? parsed.trim() : null;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "lastSeenVersion" in parsed &&
      typeof (parsed as { lastSeenVersion?: unknown }).lastSeenVersion === "string"
    ) {
      const value = (parsed as { lastSeenVersion: string }).lastSeenVersion.trim();
      return value.length > 0 ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}

function writeLastSeenVersionToStorage(version: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      MOSS_WHATS_NEW_HEADER_STORAGE_KEY,
      JSON.stringify({ lastSeenVersion: version }),
    );
  } catch {
    // Storage quota or restricted contexts never block opening release notes.
  }
}

let snapshot: MossWhatsNewHeaderSnapshot = {
  dialogOpen: false,
  dialogVersion: null,
  lastSeenVersion: null,
};
let storageHydrated = false;

function ensureHydrated(): MossWhatsNewHeaderSnapshot {
  if (!storageHydrated && typeof window !== "undefined") {
    storageHydrated = true;
    snapshot = {
      ...snapshot,
      lastSeenVersion: readLastSeenVersionFromStorage(),
    };
  }
  return snapshot;
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): MossWhatsNewHeaderSnapshot {
  return ensureHydrated();
}

export function shouldShowMossWhatsNewButton(input: {
  readonly currentVersion: string;
  readonly lastSeenVersion: string | null;
  readonly releases?: readonly MossRelease[];
}): boolean {
  const { currentVersion, lastSeenVersion, releases = MOSS_RELEASES } = input;
  const trimmed = currentVersion.trim();
  if (!trimmed) return false;
  if (mossReleaseForVersion(trimmed, releases) === null) return false;
  if (lastSeenVersion !== null && compareMossVersions(trimmed, lastSeenVersion) <= 0) {
    return false;
  }
  return true;
}

export function openMossWhatsNewDialog(
  version: string = APP_VERSION,
  releases: readonly MossRelease[] = MOSS_RELEASES,
): void {
  const current = ensureHydrated();
  const resolvedVersion = version.trim() || APP_VERSION;
  const hasNotes = mossReleaseForVersion(resolvedVersion, releases) !== null;
  let nextLastSeen = current.lastSeenVersion;
  if (
    hasNotes &&
    (nextLastSeen === null || compareMossVersions(resolvedVersion, nextLastSeen) > 0)
  ) {
    nextLastSeen = resolvedVersion;
    writeLastSeenVersionToStorage(resolvedVersion);
  }
  snapshot = {
    dialogOpen: true,
    dialogVersion: resolvedVersion,
    lastSeenVersion: nextLastSeen,
  };
  emit();
}

export function setMossWhatsNewDialogOpen(
  open: boolean,
  version: string = APP_VERSION,
  releases: readonly MossRelease[] = MOSS_RELEASES,
): void {
  if (open) {
    openMossWhatsNewDialog(version, releases);
    return;
  }
  const current = ensureHydrated();
  if (!current.dialogOpen) return;
  snapshot = {
    ...current,
    dialogOpen: false,
  };
  emit();
}

/** Resets module cache so tests can re-read fresh localStorage state cleanly. */
export function resetMossWhatsNewHeaderStore(): void {
  storageHydrated = false;
  snapshot = {
    dialogOpen: false,
    dialogVersion: null,
    lastSeenVersion: null,
  };
  emit();
}

export interface UseMossWhatsNewResult {
  readonly currentVersion: string;
  readonly releases: readonly MossRelease[];
  readonly showButton: boolean;
  readonly isDialogOpen: boolean;
  readonly openDialog: () => void;
  readonly onDialogOpenChange: (open: boolean) => void;
}

export function useMossWhatsNew(options?: {
  readonly currentVersion?: string;
  readonly releases?: readonly MossRelease[];
}): UseMossWhatsNewResult {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const currentVersion = options?.currentVersion ?? state.dialogVersion ?? APP_VERSION;
  const releasesList = options?.releases ?? MOSS_RELEASES;
  const unseen = shouldShowMossWhatsNewButton({
    currentVersion,
    lastSeenVersion: state.lastSeenVersion,
    releases: releasesList,
  });
  // Keep the button mounted while the dialog is open (matching Claude Desktop's `(nudge || open)`),
  // so closing the dialog is what makes the quiet top-right trigger disappear cleanly.
  const showButton = unseen || state.dialogOpen;
  const releases = mossReleasesUpTo(currentVersion, releasesList);

  const openDialog = useCallback(() => {
    openMossWhatsNewDialog(currentVersion, releasesList);
  }, [currentVersion, releasesList]);

  const onDialogOpenChange = useCallback(
    (open: boolean) => {
      setMossWhatsNewDialogOpen(open, currentVersion, releasesList);
    },
    [currentVersion, releasesList],
  );

  return {
    currentVersion,
    releases,
    showButton,
    isDialogOpen: state.dialogOpen,
    openDialog,
    onDialogOpenChange,
  };
}
