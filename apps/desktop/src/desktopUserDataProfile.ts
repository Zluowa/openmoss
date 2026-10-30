// FILE: desktopUserDataProfile.ts
// Purpose: Resolves Moss Electron/backend data paths and completes development bridge repair.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const DEV_USER_DATA_DIR_NAME = "moss-dev";
const PROD_USER_DATA_DIR_NAME = "Moss";
const BRIDGE_PROFILE_MANIFEST_FILE_NAME = "moss-profile-seed.json";
const CANONICAL_BROWSER_PARTITION_NAME = "moss-browser";
const BROWSER_PARTITION_SEED_ENTRY_GROUPS = [
  ["Cookies", "Cookies-journal", "Cookies-wal", "Cookies-shm"],
  ["Local Storage"],
  ["IndexedDB"],
  ["Session Storage"],
  ["WebStorage"],
  ["Service Worker"],
  ["Preferences"],
  ["Network Persistent State"],
  ["TransportSecurity"],
  ["Trust Tokens", "Trust Tokens-journal", "Trust Tokens-wal", "Trust Tokens-shm"],
  ["SharedStorage", "SharedStorage-journal", "SharedStorage-wal", "SharedStorage-shm"],
  ["shared_proto_db"],
] as const;
const BROWSER_PARTITION_SEED_ENTRY_NAMES = BROWSER_PARTITION_SEED_ENTRY_GROUPS.flat();

export interface BrowserProfileBridgeRepairResult {
  readonly status: "repaired" | "not-needed" | "bridge-unavailable" | "repair-failed";
  readonly sourcePath: string | null;
  readonly targetPath: string;
  readonly copiedEntries: readonly string[];
  readonly error?: unknown;
}

export interface RetiredBrowserPartitionMigrationResult {
  readonly status: "migrated" | "not-needed" | "migration-failed";
  readonly targetPath: string;
  readonly copiedEntries: readonly string[];
  readonly retiredPartitionCount: number;
  readonly error?: unknown;
}

export function resolveDesktopAppDataBase(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): string {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const homeDir = input?.homeDir ?? OS.homedir();

  if (platform === "win32") {
    return env.APPDATA || Path.join(homeDir, "AppData", "Roaming");
  }
  if (platform === "darwin") {
    return Path.join(homeDir, "Library", "Application Support");
  }
  return env.XDG_CONFIG_HOME || Path.join(homeDir, ".config");
}

export function resolveDesktopUserDataPath(input: {
  readonly appDataBase: string;
  readonly isDevelopment?: boolean;
  readonly userDataDirectoryName?: string;
  readonly overridePath?: string | undefined;
  readonly commandLineOverridePath?: string | undefined;
  readonly testOverridePath?: string | undefined;
}): string {
  for (const candidate of [
    input.testOverridePath,
    input.overridePath,
    input.commandLineOverridePath,
  ]) {
    const overridePath = candidate?.trim();
    if (overridePath && Path.isAbsolute(overridePath)) {
      return Path.resolve(overridePath);
    }
  }
  const userDataDirectoryName =
    input.userDataDirectoryName?.trim() ||
    (input.isDevelopment ? DEV_USER_DATA_DIR_NAME : PROD_USER_DATA_DIR_NAME);
  return Path.join(input.appDataBase, userDataDirectoryName);
}

export function isDesktopDevelopmentRuntime(input: {
  readonly isPackaged: boolean;
  readonly viteDevServerUrl?: string | undefined;
}): boolean {
  return !input.isPackaged && Boolean(input.viteDevServerUrl?.trim());
}

/**
 * Packaged Moss owns a backend namespace separate from historical Moss data.
 * Development keeps its existing default and legacy override, while packaged
 * builds accept only the Moss override used by isolated release tests.
 */
export function resolveDesktopBackendHomePath(input: {
  readonly homeDir: string;
  readonly isDevelopment: boolean;
  readonly mossHome?: string | undefined;
}): string {
  const overridePath = input.mossHome?.trim();
  return overridePath ? Path.resolve(overridePath) : Path.join(input.homeDir, ".moss");
}

function readBridgeProfileSourcePath(targetPath: string): string | null {
  const manifestPath = Path.join(targetPath, BRIDGE_PROFILE_MANIFEST_FILE_NAME);
  if (!FS.existsSync(manifestPath)) return null;

  let parsed: { readonly sourcePath?: unknown };
  try {
    parsed = JSON.parse(FS.readFileSync(manifestPath, "utf8")) as {
      readonly sourcePath?: unknown;
    };
  } catch {
    return null;
  }
  if (typeof parsed.sourcePath !== "string" || !Path.isAbsolute(parsed.sourcePath)) {
    return null;
  }

  const sourcePath = Path.resolve(parsed.sourcePath);
  const resolvedTargetPath = Path.resolve(targetPath);
  if (
    sourcePath === resolvedTargetPath ||
    Path.dirname(sourcePath) !== Path.dirname(resolvedTargetPath)
  ) {
    return null;
  }
  return sourcePath;
}

function findBridgeBrowserPartitionPaths(sourceProfilePath: string): string[] {
  const partitionsPath = Path.join(sourceProfilePath, "Partitions");
  if (!FS.existsSync(partitionsPath)) return [];

  return FS.readdirSync(partitionsPath, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.endsWith("-browser") &&
        entry.name !== CANONICAL_BROWSER_PARTITION_NAME,
    )
    .map((entry) => Path.join(partitionsPath, entry.name))
    .filter((partitionPath) =>
      BROWSER_PARTITION_SEED_ENTRY_NAMES.some((entryName) =>
        FS.existsSync(Path.join(partitionPath, entryName)),
      ),
    )
    .sort((left, right) => FS.statSync(right).mtimeMs - FS.statSync(left).mtimeMs);
}

function copyMissingBrowserPartitionEntries(
  sourcePartitionPath: string,
  targetPartitionPath: string,
): string[] {
  const copiedEntries: string[] = [];
  for (const entryGroup of BROWSER_PARTITION_SEED_ENTRY_GROUPS) {
    const baseEntryName = entryGroup[0];
    if (!FS.existsSync(Path.join(sourcePartitionPath, baseEntryName))) continue;
    if (FS.existsSync(Path.join(targetPartitionPath, baseEntryName))) continue;

    const sourceEntryNames = entryGroup.filter((entryName) =>
      FS.existsSync(Path.join(sourcePartitionPath, entryName)),
    );
    FS.mkdirSync(targetPartitionPath, { recursive: true });
    const stagedGroupPath = FS.mkdtempSync(Path.join(targetPartitionPath, ".moss-bridge-"));
    const stagedSourcePath = Path.join(stagedGroupPath, "source");
    const stagedTargetBackupPath = Path.join(stagedGroupPath, "target-backup");
    try {
      // Stage the whole source generation before removing orphaned target
      // sidecars, so a failed source copy leaves the target untouched.
      FS.mkdirSync(stagedSourcePath, { recursive: true });
      for (const entryName of sourceEntryNames) {
        FS.cpSync(
          Path.join(sourcePartitionPath, entryName),
          Path.join(stagedSourcePath, entryName),
          {
            recursive: true,
            errorOnExist: true,
            force: false,
          },
        );
      }

      // Another startup may have completed the repair while this group was
      // staged. Preserve its database and leave its sidecars untouched.
      if (FS.existsSync(Path.join(targetPartitionPath, baseEntryName))) continue;

      const installOrder = [
        ...sourceEntryNames.filter((entryName) => entryName !== baseEntryName),
        baseEntryName,
      ];
      const displacedTargetEntries: string[] = [];
      const installedSourceEntries: string[] = [];
      try {
        FS.mkdirSync(stagedTargetBackupPath, { recursive: true });
        for (const sidecarEntryName of entryGroup.slice(1)) {
          const targetEntryPath = Path.join(targetPartitionPath, sidecarEntryName);
          if (!FS.existsSync(targetEntryPath)) continue;
          FS.renameSync(targetEntryPath, Path.join(stagedTargetBackupPath, sidecarEntryName));
          displacedTargetEntries.push(sidecarEntryName);
        }
        for (const entryName of installOrder) {
          FS.renameSync(
            Path.join(stagedSourcePath, entryName),
            Path.join(targetPartitionPath, entryName),
          );
          installedSourceEntries.push(entryName);
        }
      } catch (installError) {
        const rollbackErrors: unknown[] = [];
        for (const entryName of installedSourceEntries.reverse()) {
          try {
            FS.rmSync(Path.join(targetPartitionPath, entryName), {
              recursive: true,
              force: true,
            });
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        for (const entryName of displacedTargetEntries) {
          try {
            FS.renameSync(
              Path.join(stagedTargetBackupPath, entryName),
              Path.join(targetPartitionPath, entryName),
            );
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [installError, ...rollbackErrors],
            "Browser profile bridge repair and rollback failed",
          );
        }
        throw installError;
      }
      copiedEntries.push(...sourceEntryNames);
    } finally {
      FS.rmSync(stagedGroupPath, { recursive: true, force: true });
    }
  }
  return copiedEntries;
}

function resolveRetiredPartitionPath(partitionsPath: string): string {
  let suffix = 1;
  while (true) {
    const candidate = Path.join(partitionsPath, `.moss-retired-partition-${suffix}`);
    if (!FS.existsSync(candidate)) return candidate;
    suffix += 1;
  }
}

/**
 * Moves browser partitions left by older desktop builds out of Chromium's
 * active namespace without deleting user data. Missing entries are copied into
 * the canonical Moss partition first; each predecessor directory is then
 * atomically renamed to a neutral, recoverable archive name.
 */
export function migrateRetiredBrowserPartitions(
  targetPath: string,
): RetiredBrowserPartitionMigrationResult {
  const copiedEntries: string[] = [];
  let retiredPartitionCount = 0;
  try {
    const sourcePartitionPaths = findBridgeBrowserPartitionPaths(targetPath);
    if (sourcePartitionPaths.length === 0) {
      return {
        status: "not-needed",
        targetPath,
        copiedEntries,
        retiredPartitionCount,
      };
    }

    const partitionsPath = Path.join(targetPath, "Partitions");
    const targetPartitionPath = Path.join(partitionsPath, CANONICAL_BROWSER_PARTITION_NAME);
    for (const sourcePartitionPath of sourcePartitionPaths) {
      copiedEntries.push(
        ...copyMissingBrowserPartitionEntries(sourcePartitionPath, targetPartitionPath),
      );
    }
    for (const sourcePartitionPath of sourcePartitionPaths) {
      FS.renameSync(sourcePartitionPath, resolveRetiredPartitionPath(partitionsPath));
      retiredPartitionCount += 1;
    }

    return {
      status: "migrated",
      targetPath,
      copiedEntries,
      retiredPartitionCount,
    };
  } catch (error) {
    return {
      status: "migration-failed",
      targetPath,
      copiedEntries,
      retiredPartitionCount,
      error,
    };
  }
}

/**
 * Finishes any browser-partition copy described by the compatibility bridge.
 *
 * The bridge manifest identifies the exact sibling profile that supplied the Moss profile.
 * Discovering its `*-browser` partition from that trusted path avoids shipping predecessor names
 * while still repairing cookies or storage entries that were absent during the first bridge run.
 */
export function repairBrowserProfileFromBridgeManifest(
  targetPath: string,
): BrowserProfileBridgeRepairResult {
  let sourcePath: string | null = null;
  const copiedEntries: string[] = [];
  try {
    sourcePath = readBridgeProfileSourcePath(targetPath);
    if (!sourcePath || !FS.existsSync(sourcePath)) {
      return {
        status: "bridge-unavailable",
        sourcePath,
        targetPath,
        copiedEntries: [],
      };
    }

    const sourcePartitionPath = findBridgeBrowserPartitionPaths(sourcePath)[0];
    if (!sourcePartitionPath) {
      return {
        status: "not-needed",
        sourcePath,
        targetPath,
        copiedEntries: [],
      };
    }

    const targetPartitionPath = Path.join(
      targetPath,
      "Partitions",
      CANONICAL_BROWSER_PARTITION_NAME,
    );
    copiedEntries.push(
      ...copyMissingBrowserPartitionEntries(sourcePartitionPath, targetPartitionPath),
    );

    return {
      status: copiedEntries.length > 0 ? "repaired" : "not-needed",
      sourcePath,
      targetPath,
      copiedEntries,
    };
  } catch (error) {
    return {
      status: "repair-failed",
      sourcePath,
      targetPath,
      copiedEntries,
      error,
    };
  }
}
