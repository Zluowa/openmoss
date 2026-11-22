// FILE: update-mirror-prune.ts
// Purpose: Pure retention planning for obsolete desktop installer versions on Moss update mirror
//          stores (Cloudflare R2, Tencent COS). Selects only versioned desktop installers directly
//          under the feed prefix that fall outside the retention window, while unconditionally
//          protecting manifests, signatures, notices, nested prefixes (desktop/code/, runtimes/,
//          preview/, plugin-catalog/), and any version referenced by synced manifests or
//          moss-mac-notice.json.
// Layer: Release tooling. Lives in scripts/lib because apps/server compiles this folder; imports
//        nothing outside it so it stays dependency-free under both @moss/scripts and @moss/server.

export const DEFAULT_KEEP_WIN_VERSIONS = 2;
export const DEFAULT_KEEP_MAC_VERSIONS = 1;
export const MAC_UPDATE_NOTICE_FILE_NAME = "moss-mac-notice.json";

export type DesktopInstallerPlatform = "win" | "mac";
export type DesktopInstallerArch = "x64" | "arm64";
export type DesktopInstallerLane = `${DesktopInstallerPlatform}-${DesktopInstallerArch}`;

export interface UpdateMirrorObject {
  /** Full bucket key (e.g. "desktop/Moss-1.0.10-x64.exe") or prefix-relative key when prefix is "". */
  readonly key: string;
  /** Stored size in bytes. */
  readonly size: number;
}

export interface ParsedSemver {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number>;
}

export interface ParsedDesktopInstaller {
  readonly platform: DesktopInstallerPlatform;
  readonly arch: DesktopInstallerArch;
  readonly lane: DesktopInstallerLane;
  readonly version: string;
  readonly semver: ParsedSemver;
  readonly extension: string;
  readonly isBlockmap: boolean;
}

export interface UpdateMirrorPruneCandidate {
  readonly key: string;
  /** File name relative to the feed prefix (the name passed to store.delete). */
  readonly fileName: string;
  readonly size: number;
  readonly platform: DesktopInstallerPlatform;
  readonly arch: DesktopInstallerArch;
  readonly lane: DesktopInstallerLane;
  readonly version: string;
}

export interface PlanUpdateMirrorPruneInput {
  readonly objects: ReadonlyArray<UpdateMirrorObject>;
  /** Feed prefix in the bucket, e.g. "desktop/". Defaults to "". */
  readonly prefix?: string;
  /** Number of latest Windows versions to retain per architecture lane. Default: 2. */
  readonly keepWinVersions?: number;
  /** Number of latest macOS versions to retain per architecture lane. Default: 1. */
  readonly keepMacVersions?: number;
  /**
   * File names referenced by synced channel manifests (e.g. `latest.yml`, `moss.yml`).
   * Both each named file and its companion `<file>.blockmap` are always protected.
   */
  readonly protectedFileNames?: ReadonlyArray<string>;
  /**
   * macOS versions referenced by `<prefix>moss-mac-notice.json`.
   * Every macOS installer matching one of these versions is always protected.
   */
  readonly protectedMacVersions?: ReadonlyArray<string>;
  /**
   * Fail-closed guard: when true (e.g. `moss-mac-notice.json` exists on the store but could not be
   * read or parsed), no macOS installer objects are selected for deletion.
   */
  readonly protectAllMacVersions?: boolean;
}

export interface UpdateMirrorPrunePlan {
  readonly prefix: string;
  readonly keepWinVersions: number;
  readonly keepMacVersions: number;
  /** Obsolete installer objects to delete, ordered deterministically (lane, oldest semver, key). */
  readonly toDelete: ReadonlyArray<UpdateMirrorPruneCandidate>;
  /** Objects that remain on the store after pruning. */
  readonly toKeep: ReadonlyArray<UpdateMirrorObject>;
  readonly bytesToFree: number;
  readonly totalBytesBefore: number;
  readonly remainingBytes: number;
  readonly remainingObjectCount: number;
  readonly protectedFileNames: ReadonlyArray<string>;
  readonly protectedMacVersions: ReadonlyArray<string>;
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const NUMERIC_IDENTIFIER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const LEADING_ZERO_DIGITS_PATTERN = /^0\d+$/u;

const DESKTOP_INSTALLER_PATTERN =
  /^Moss-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)-(x64|arm64)\.(exe(?:\.blockmap)?|dmg(?:\.blockmap)?|zip(?:\.blockmap)?)$/u;

/** Parses a strict SemVer 2.0.0 version (major.minor.patch with optional prerelease). */
export function parseSemver(version: string): ParsedSemver | null {
  const trimmed = version.trim();
  const match = SEMVER_PATTERN.exec(trimmed);
  if (!match) return null;
  const [, majorText, minorText, patchText, prereleaseText] = match;
  const prerelease: Array<string | number> = [];
  if (prereleaseText !== undefined) {
    for (const part of prereleaseText.split(".")) {
      if (part === "" || LEADING_ZERO_DIGITS_PATTERN.test(part)) return null;
      prerelease.push(NUMERIC_IDENTIFIER_PATTERN.test(part) ? Number(part) : part);
    }
  }
  return {
    raw: trimmed,
    major: Number(majorText),
    minor: Number(minorText),
    patch: Number(patchText),
    prerelease,
  };
}

/**
 * SemVer 2.0.0 precedence comparator: returns < 0 when left < right, 0 when equal, > 0 when
 * left > right (e.g. `1.0.10 > 1.0.9 > 1.0.2`, and `1.0.10 > 1.0.10-rc.1`).
 */
export function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;

  const leftPre = left.prerelease;
  const rightPre = right.prerelease;
  if (leftPre.length === 0 && rightPre.length === 0) return 0;
  if (leftPre.length === 0) return 1;
  if (rightPre.length === 0) return -1;

  const length = Math.min(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftPre[index]!;
    const b = rightPre[index]!;
    if (a === b) continue;
    const aNum = typeof a === "number";
    const bNum = typeof b === "number";
    if (aNum && bNum) return a - b;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return leftPre.length - rightPre.length;
}

/**
 * Matches only versioned Moss desktop installers directly under the feed prefix:
 * - Windows: `Moss-<semver>-(x64|arm64).exe` and `.exe.blockmap`
 * - macOS: `Moss-<semver>-(arm64|x64).dmg`, `.zip`, and their `.blockmap` companions
 * Anything else (nested paths, manifests, signatures, notices, unknown names) returns null.
 */
export function parseDesktopInstallerFileName(fileName: string): ParsedDesktopInstaller | null {
  if (fileName.includes("/") || fileName.includes("\\")) return null;
  const match = DESKTOP_INSTALLER_PATTERN.exec(fileName);
  if (!match) return null;
  const [, versionText, archText, extension] = match;
  const semver = parseSemver(versionText!);
  if (!semver) return null;
  const platform: DesktopInstallerPlatform = extension!.startsWith("exe") ? "win" : "mac";
  const arch = archText as DesktopInstallerArch;
  return {
    platform,
    arch,
    lane: `${platform}-${arch}`,
    version: semver.raw,
    semver,
    extension: extension!,
    isBlockmap: extension!.endsWith(".blockmap"),
  };
}

/** Reads `{"version":"X.Y.Z"}` from `moss-mac-notice.json`; returns null if unreadable or invalid. */
export function parseMacUpdateNoticeVersion(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const version = (parsed as { readonly version?: unknown }).version;
  if (typeof version !== "string") return null;
  const semver = parseSemver(version);
  return semver ? semver.raw : null;
}

function assertPositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (>= 1), got ${String(value)}.`);
  }
  return value;
}

function normalizeRelativeFileName(name: string, prefix: string): string {
  const trimmed = name.trim();
  if (prefix !== "" && trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length);
  }
  return trimmed;
}

/**
 * Computes which obsolete desktop installer objects under `prefix` can be safely deleted.
 * Never selects:
 * - Objects outside `prefix` or inside nested subdirectories (e.g. `desktop/code/`, `preview/`,
 *   `plugin-catalog/`, `runtimes/`).
 * - Manifests (`*.yml`, `*.sig`, `*.json`) or any unrecognized filename.
 * - The latest `keepWinVersions` Windows versions per arch lane or latest `keepMacVersions` macOS
 *   versions per arch lane (ordered by SemVer 2.0.0).
 * - Any file (or its `.blockmap`) named in `protectedFileNames`.
 * - Any macOS installer whose version is in `protectedMacVersions` (or all macOS installers when
 *   `protectAllMacVersions` is true).
 */
export function planUpdateMirrorPrune(input: PlanUpdateMirrorPruneInput): UpdateMirrorPrunePlan {
  const prefix = input.prefix ?? "";
  const keepWinVersions = assertPositiveInteger(
    "keepWinVersions",
    input.keepWinVersions ?? DEFAULT_KEEP_WIN_VERSIONS,
  );
  const keepMacVersions = assertPositiveInteger(
    "keepMacVersions",
    input.keepMacVersions ?? DEFAULT_KEEP_MAC_VERSIONS,
  );

  const protectedFiles = new Set<string>();
  for (const rawName of input.protectedFileNames ?? []) {
    const fileName = normalizeRelativeFileName(rawName, prefix);
    if (!fileName) continue;
    protectedFiles.add(fileName);
    if (!fileName.endsWith(".blockmap")) {
      protectedFiles.add(`${fileName}.blockmap`);
    }
  }

  const protectedMacVersions = new Set<string>();
  for (const rawVersion of input.protectedMacVersions ?? []) {
    const semver = parseSemver(rawVersion);
    if (semver) protectedMacVersions.add(semver.raw);
  }

  interface VersionGroup {
    readonly version: string;
    readonly semver: ParsedSemver;
    readonly items: Array<{
      readonly object: UpdateMirrorObject;
      readonly fileName: string;
      readonly parsed: ParsedDesktopInstaller;
    }>;
  }

  const lanes = new Map<DesktopInstallerLane, Map<string, VersionGroup>>();
  let totalBytesBefore = 0;

  for (const object of input.objects) {
    const size = Math.max(0, object.size);
    totalBytesBefore += size;

    if (!object.key.startsWith(prefix)) continue;
    const fileName = object.key.slice(prefix.length);
    const parsed = parseDesktopInstallerFileName(fileName);
    if (!parsed) continue;

    let laneVersions = lanes.get(parsed.lane);
    if (!laneVersions) {
      laneVersions = new Map();
      lanes.set(parsed.lane, laneVersions);
    }
    let group = laneVersions.get(parsed.version);
    if (!group) {
      group = { version: parsed.version, semver: parsed.semver, items: [] };
      laneVersions.set(parsed.version, group);
    }
    group.items.push({ object: { key: object.key, size }, fileName, parsed });
  }

  const candidates: Array<UpdateMirrorPruneCandidate & { readonly semver: ParsedSemver }> = [];
  const deleteKeys = new Set<string>();

  for (const [lane, laneVersions] of lanes) {
    const keepCount = lane.startsWith("win-") ? keepWinVersions : keepMacVersions;
    const sortedVersions = [...laneVersions.values()].toSorted(
      (left, right) =>
        compareSemver(right.semver, left.semver) || right.version.localeCompare(left.version),
    );

    for (const group of sortedVersions.slice(keepCount)) {
      for (const item of group.items) {
        if (protectedFiles.has(item.fileName)) continue;
        if (
          item.parsed.platform === "mac" &&
          (input.protectAllMacVersions || protectedMacVersions.has(item.parsed.version))
        ) {
          continue;
        }
        deleteKeys.add(item.object.key);
        candidates.push({
          key: item.object.key,
          fileName: item.fileName,
          size: item.object.size,
          platform: item.parsed.platform,
          arch: item.parsed.arch,
          lane: item.parsed.lane,
          version: item.parsed.version,
          semver: item.parsed.semver,
        });
      }
    }
  }

  candidates.sort(
    (left, right) =>
      left.lane.localeCompare(right.lane) ||
      compareSemver(left.semver, right.semver) ||
      left.key.localeCompare(right.key),
  );

  const toDelete: UpdateMirrorPruneCandidate[] = candidates.map(
    ({ semver: _semver, ...candidate }) => candidate,
  );
  const toKeep: UpdateMirrorObject[] = [];
  let remainingBytes = 0;
  for (const object of input.objects) {
    if (deleteKeys.has(object.key)) continue;
    const size = Math.max(0, object.size);
    toKeep.push({ key: object.key, size });
    remainingBytes += size;
  }

  const bytesToFree = toDelete.reduce((sum, item) => sum + item.size, 0);

  return {
    prefix,
    keepWinVersions,
    keepMacVersions,
    toDelete,
    toKeep,
    bytesToFree,
    totalBytesBefore,
    remainingBytes,
    remainingObjectCount: toKeep.length,
    protectedFileNames: [...protectedFiles].toSorted(),
    protectedMacVersions: [...protectedMacVersions].toSorted(),
  };
}

/** Detects S3/COS/R2 permission denials (403 / AccessDenied / Forbidden) from Bun or S3 errors. */
export function isS3PermissionError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !visited.has(current)) {
    visited.add(current);
    if (typeof current === "object") {
      const record = current as {
        readonly code?: unknown;
        readonly status?: unknown;
        readonly statusCode?: unknown;
        readonly message?: unknown;
        readonly cause?: unknown;
      };
      if (record.status === 403 || record.statusCode === 403) return true;
      if (typeof record.code === "string") {
        const normalizedCode = record.code.trim().toLowerCase();
        if (
          normalizedCode === "accessdenied" ||
          normalizedCode === "forbidden" ||
          normalizedCode === "err_s3_access_denied"
        ) {
          return true;
        }
      }
      if (
        typeof record.message === "string" &&
        /\b403\b|access\s*denied|forbidden/iu.test(record.message)
      ) {
        return true;
      }
      current = record.cause;
      continue;
    }
    if (typeof current === "string" && /\b403\b|access\s*denied|forbidden/iu.test(current)) {
      return true;
    }
    break;
  }
  return false;
}

/** Formats a byte count using decimal units (matching R2/COS billing units: 1 GB = 1e9 bytes). */
export function formatByteSize(bytes: number): string {
  const safe = Math.max(0, bytes);
  if (safe >= 1_000_000_000) return `${(safe / 1_000_000_000).toFixed(2)} GB`;
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)} MB`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)} KB`;
  return `${safe} B`;
}

/** Formats a byte count in decimal GB (e.g. "1.93 GB"). */
export function formatGigabytes(bytes: number): string {
  return `${(Math.max(0, bytes) / 1_000_000_000).toFixed(2)} GB`;
}

export function formatUpdateMirrorPruneSummary(input: {
  readonly dryRun: boolean;
  readonly deletedCount: number;
  readonly freedBytes: number;
  readonly remainingObjects: number;
  readonly remainingBytes: number;
  readonly prefix: string;
}): string {
  const prefixScope = input.prefix ? ` under ${input.prefix}` : "";
  const freedText = `${formatByteSize(input.freedBytes)} (${formatGigabytes(input.freedBytes)})`;
  if (input.dryRun) {
    return `Prune dry-run summary: would delete ${input.deletedCount} object(s), freeing ${freedText}; would remain ${input.remainingObjects} object(s), ${formatGigabytes(input.remainingBytes)}${prefixScope}.`;
  }
  return `Prune summary: deleted ${input.deletedCount} object(s), freed ${freedText}; remaining ${input.remainingObjects} object(s), ${formatGigabytes(input.remainingBytes)}${prefixScope}.`;
}
