import { lstatSync } from "node:fs";
import path from "node:path";

import { Effect, type FileSystem } from "effect";

import {
  resolveCodexHomeOverlayWritePath,
  MOSS_CODEX_HOME_ACCOUNT_OVERLAYS_DIR,
  MOSS_CODEX_HOME_OVERLAY_DIR,
} from "../codexHomePaths.ts";

export interface MossCodexAccountOverlayInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly homePath: string;
  readonly accountId: string;
}

function normalizedAccountId(accountId: string): string {
  const normalized = accountId.trim();
  if (!normalized || normalized === "default") {
    throw new Error("A non-default Codex account id is required for overlay cleanup.");
  }
  return normalized;
}

function assertRealDirectory(directoryPath: string, label: string): void {
  const info = lstatSync(directoryPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Refusing to clean ${label} through a non-directory or symbolic link.`);
  }
}

function assertRealAccountsDirectory(accountsDirectory: string): void {
  assertRealDirectory(path.dirname(accountsDirectory), "the Codex overlay root");
  assertRealDirectory(accountsDirectory, "the Codex accounts directory");
}

function isMissingPathError(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function assertRealDirectoryIfPresent(directoryPath: string, label: string): boolean {
  try {
    assertRealDirectory(directoryPath, label);
    return true;
  } catch (cause) {
    if (isMissingPathError(cause)) {
      return false;
    }
    throw cause;
  }
}

function assertRealExactOverlayDirectoryIfPresent(overlayPath: string): boolean {
  const accountsDirectory = path.dirname(overlayPath);
  const overlayDirectory = path.dirname(accountsDirectory);

  if (!assertRealDirectoryIfPresent(overlayDirectory, "the Codex overlay root")) {
    return false;
  }
  if (!assertRealDirectoryIfPresent(accountsDirectory, "the Codex accounts directory")) {
    return false;
  }
  return assertRealDirectoryIfPresent(overlayPath, "a Codex account overlay");
}

function assertRealOwnedOverlayDirectory(accountsDirectory: string, entry: string): string {
  const entryPath = path.join(accountsDirectory, entry);
  if (path.dirname(entryPath) !== accountsDirectory) {
    throw new Error("Refusing to clean a Codex account overlay outside the accounts directory.");
  }
  assertRealDirectory(entryPath, "a Codex account overlay");
  return entryPath;
}

/**
 * Resolve only the account-scoped overlay produced by codexHomePaths. The
 * structural checks fail closed if a future path-layout change would otherwise
 * make account cleanup target a source home or a broader runtime directory.
 */
export function resolveMossCodexAccountOverlayPath(input: MossCodexAccountOverlayInput): string {
  const accountId = normalizedAccountId(input.accountId);
  const sourceHomePath = path.resolve(input.homePath);
  const overlayPath = path.resolve(
    resolveCodexHomeOverlayWritePath({
      env: input.env ?? process.env,
      homePath: sourceHomePath,
      accountId,
    }),
  );
  const accountsDirectory = path.dirname(overlayPath);
  const overlayDirectory = path.dirname(accountsDirectory);

  if (
    overlayPath === sourceHomePath ||
    path.basename(accountsDirectory) !== MOSS_CODEX_HOME_ACCOUNT_OVERLAYS_DIR ||
    path.basename(overlayDirectory) !== MOSS_CODEX_HOME_OVERLAY_DIR
  ) {
    throw new Error("Refusing to remove an unexpected Codex account overlay path.");
  }

  return overlayPath;
}

export function removeMossCodexAccountOverlay(
  fs: FileSystem.FileSystem,
  input: MossCodexAccountOverlayInput,
) {
  return Effect.try({
    try: () => {
      const overlayPath = resolveMossCodexAccountOverlayPath(input);
      return assertRealExactOverlayDirectoryIfPresent(overlayPath) ? overlayPath : undefined;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap((overlayPath) =>
      overlayPath ? fs.remove(overlayPath, { recursive: true, force: true }) : Effect.void,
    ),
  );
}

/**
 * Older Moss builds rotated the BYOK source home without removing the derived
 * account overlay. Sweep only reserved account segments with the exact
 * `<account>-<12 hex>` shape, never arbitrary children of the accounts root.
 */
export function removeMossCodexAccountOverlayFamily(
  fs: FileSystem.FileSystem,
  input: MossCodexAccountOverlayInput,
) {
  return Effect.gen(function* () {
    const overlayPath = yield* Effect.try({
      try: () => resolveMossCodexAccountOverlayPath(input),
      catch: (cause) => cause,
    });
    const accountsDirectory = path.dirname(overlayPath);
    if (!(yield* fs.exists(accountsDirectory))) {
      return;
    }
    yield* Effect.try({
      try: () => assertRealAccountsDirectory(accountsDirectory),
      catch: (cause) => cause,
    });
    const accountId = normalizedAccountId(input.accountId);
    const escapedAccountId = accountId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ownedSegment = new RegExp(`^${escapedAccountId}-[a-f0-9]{12}$`);
    const entries = yield* fs.readDirectory(accountsDirectory);
    yield* Effect.forEach(
      entries.filter((entry) => ownedSegment.test(entry)),
      (entry) =>
        Effect.try({
          try: () => assertRealOwnedOverlayDirectory(accountsDirectory, entry),
          catch: (cause) => cause,
        }).pipe(
          Effect.flatMap((entryPath) =>
            fs.remove(entryPath, {
              recursive: true,
              force: true,
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });
}

/**
 * Upgrade cleanup for builds that created Codex shell snapshots before Moss
 * disabled the feature. Preserve account history and remove only the snapshot
 * directory inside exact reserved-account overlays.
 */
export function removeMossCodexAccountShellSnapshotsFamily(
  fs: FileSystem.FileSystem,
  input: MossCodexAccountOverlayInput,
) {
  return Effect.gen(function* () {
    const overlayPath = yield* Effect.try({
      try: () => resolveMossCodexAccountOverlayPath(input),
      catch: (cause) => cause,
    });
    const accountsDirectory = path.dirname(overlayPath);
    if (!(yield* fs.exists(accountsDirectory))) {
      return;
    }
    yield* Effect.try({
      try: () => assertRealAccountsDirectory(accountsDirectory),
      catch: (cause) => cause,
    });
    const accountId = normalizedAccountId(input.accountId);
    const escapedAccountId = accountId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ownedSegment = new RegExp(`^${escapedAccountId}-[a-f0-9]{12}$`);
    const entries = yield* fs.readDirectory(accountsDirectory);
    yield* Effect.forEach(
      entries.filter((entry) => ownedSegment.test(entry)),
      (entry) =>
        Effect.gen(function* () {
          const entryPath = yield* Effect.try({
            try: () => assertRealOwnedOverlayDirectory(accountsDirectory, entry),
            catch: (cause) => cause,
          });
          const snapshotsPath = path.join(entryPath, "shell_snapshots");
          if (!(yield* fs.exists(snapshotsPath))) {
            return;
          }
          yield* Effect.try({
            try: () => {
              const info = lstatSync(snapshotsPath);
              if (info.isSymbolicLink()) {
                throw new Error("Refusing to clean Codex shell snapshots through a symbolic link.");
              }
            },
            catch: (cause) => cause,
          });
          yield* fs.remove(snapshotsPath, {
            recursive: true,
            force: true,
          });
        }),
      { concurrency: 1, discard: true },
    );
  });
}
