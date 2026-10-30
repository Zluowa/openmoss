import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  type Stats,
} from "node:fs";
import path from "node:path";

import { resolveActiveCodexHomeWritePath, resolveBaseCodexHomePath } from "./codexHomePaths.ts";

export interface CodexHomeIdentityInput {
  readonly homePath?: string | undefined;
  readonly shadowHomePath?: string | undefined;
  readonly accountId?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

export interface CodexHomeIdentityPaths {
  readonly sourceHomePath: string;
  readonly shadowHomePath?: string;
  readonly activeHomePath: string;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const SAFE_MISSING_CODEX_HOME_SEGMENT = /^[A-Za-z0-9._-]+$/;

function validateMissingCodexHomeSegment(segment: string, resolvedPath: string): string {
  if (segment === "." || segment === ".." || !SAFE_MISSING_CODEX_HOME_SEGMENT.test(segment)) {
    throw new Error(
      `Cannot canonicalize missing Codex home '${resolvedPath}': segment '${segment}' must contain only ASCII letters, digits, '.', '_', or '-'.`,
    );
  }
  return segment;
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function toggledAsciiCase(value: string): string | undefined {
  const match = /[A-Za-z]/.exec(value);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const character = match[0];
  const toggled =
    character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
  return `${value.slice(0, match.index)}${toggled}${value.slice(match.index + 1)}`;
}

function cannotDetermineCaseSensitivity(identityPath: string): Error {
  return new Error(
    `Cannot safely determine filesystem case sensitivity for Codex home '${identityPath}'.`,
  );
}

function hasSameFilesystemIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function probeDirectoryCaseSensitivity(directory: string, identityPath: string): boolean {
  // A newly-created managed account directory commonly has an empty `accounts`
  // parent, so there is no existing entry whose case alias can be inspected.
  // Use an atomically-created, private, removable directory in that exact
  // parent instead. rmdirSync only removes our probe while it remains empty;
  // replacement or concurrent contents therefore fail closed without deleting
  // someone else's data.
  const probePath = mkdtempSync(path.join(directory, ".moss-fs-case-probe-"));
  const probeStats = lstatSync(probePath);
  const variantName = toggledAsciiCase(path.basename(probePath));
  if (!variantName) {
    throw cannotDetermineCaseSensitivity(identityPath);
  }

  try {
    try {
      const variantStats = lstatSync(path.join(directory, variantName));
      const probeStatsAfterLookup = lstatSync(probePath);
      if (
        !hasSameFilesystemIdentity(probeStats, probeStatsAfterLookup) ||
        !hasSameFilesystemIdentity(probeStats, variantStats)
      ) {
        throw cannotDetermineCaseSensitivity(identityPath);
      }
      return false;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const probeStatsAfterLookup = lstatSync(probePath);
      if (!hasSameFilesystemIdentity(probeStats, probeStatsAfterLookup)) {
        throw cannotDetermineCaseSensitivity(identityPath);
      }
      return true;
    }
  } finally {
    const cleanupStats = lstatSync(probePath);
    if (!cleanupStats.isDirectory() || !hasSameFilesystemIdentity(probeStats, cleanupStats)) {
      throw cannotDetermineCaseSensitivity(identityPath);
    }
    rmdirSync(probePath);
  }
}

function existingEntryIsCaseSensitive(
  directory: string,
  entryName: string,
  identityPath: string,
  entries = readdirSync(directory),
): boolean {
  const variantName = toggledAsciiCase(entryName);
  if (!variantName || !entries.includes(entryName)) {
    throw cannotDetermineCaseSensitivity(identityPath);
  }
  if (entries.includes(variantName)) {
    return true;
  }

  const entryPath = path.join(directory, entryName);
  const entryStats = lstatSync(entryPath);
  try {
    const variantStats = lstatSync(path.join(directory, variantName));
    const entryStatsAfterProbe = lstatSync(entryPath);
    if (
      entryStatsAfterProbe.dev !== entryStats.dev ||
      entryStatsAfterProbe.ino !== entryStats.ino ||
      variantStats.dev !== entryStats.dev ||
      variantStats.ino !== entryStats.ino
    ) {
      throw cannotDetermineCaseSensitivity(identityPath);
    }
    return false;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    const entryStatsAfterProbe = lstatSync(entryPath);
    if (
      entryStatsAfterProbe.dev !== entryStats.dev ||
      entryStatsAfterProbe.ino !== entryStats.ino
    ) {
      throw cannotDetermineCaseSensitivity(identityPath);
    }
    return true;
  }
}

function directoryIsCaseSensitive(directory: string, identityPath: string): boolean {
  if (path.dirname(directory) === directory || !statSync(directory).isDirectory()) {
    throw cannotDetermineCaseSensitivity(identityPath);
  }
  const entries = readdirSync(directory);
  const probeEntry = entries.find((entry) => toggledAsciiCase(entry) !== undefined);
  if (!probeEntry) {
    return probeDirectoryCaseSensitivity(directory, identityPath);
  }
  return existingEntryIsCaseSensitive(directory, probeEntry, identityPath, entries);
}

function normalizeExistingFilesystemIdentity(realpathIdentity: string): string {
  const parsed = path.parse(realpathIdentity);
  const segments = realpathIdentity.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let actualParent = parsed.root;
  let identityParent = parsed.root;
  for (const segment of segments) {
    const identitySegment = /[A-Z]/.test(segment)
      ? existingEntryIsCaseSensitive(actualParent, segment, realpathIdentity)
        ? segment
        : foldAsciiCase(segment)
      : segment;
    actualParent = path.join(actualParent, segment);
    identityParent = path.join(identityParent, identitySegment);
  }
  return identityParent;
}

function normalizeFilesystemIdentity(
  canonicalExistingAncestor: string,
  missingSegments: readonly string[],
): string {
  const existingIdentity = normalizeExistingFilesystemIdentity(canonicalExistingAncestor);
  if (missingSegments.length === 0) {
    return existingIdentity;
  }
  const missingHasAsciiCase = missingSegments.some((segment) => /[A-Za-z]/.test(segment));
  const caseSensitive = missingHasAsciiCase
    ? directoryIsCaseSensitive(
        canonicalExistingAncestor,
        path.join(canonicalExistingAncestor, ...missingSegments),
      )
    : true;
  return path.join(
    existingIdentity,
    ...missingSegments.map((segment) => (caseSensitive ? segment : foldAsciiCase(segment))),
  );
}

export function canonicalizeCodexHomeIdentityPath(rawPath: string): string {
  const resolvedPath = path.resolve(rawPath);
  const missingSegments: string[] = [];
  let candidate = resolvedPath;

  for (;;) {
    let canonicalAncestor: string;
    try {
      canonicalAncestor = realpathSync.native(candidate);
    } catch (error) {
      if (!isMissingPathError(error)) {
        // Permission failures, non-directory components, and symlink loops are
        // unsafe to reduce to a textual identity. Callers must fail closed.
        throw error;
      }

      try {
        lstatSync(candidate);
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) {
          throw lstatError;
        }

        const parent = path.dirname(candidate);
        if (parent === candidate) {
          throw error;
        }
        missingSegments.unshift(
          validateMissingCodexHomeSegment(path.basename(candidate), resolvedPath),
        );
        candidate = parent;
        continue;
      }

      // The entry exists but realpath still reported ENOENT. This indicates a
      // broken symlink or a concurrent filesystem mutation, neither of which
      // has a stable canonical identity.
      throw error;
    }

    // Keep this outside the realpath catch: if the canonical ancestor changes
    // or disappears between the two filesystem reads, that race is unsafe and
    // must propagate instead of being mistaken for another missing suffix.
    if (missingSegments.length > 0 && !statSync(canonicalAncestor).isDirectory()) {
      throw new Error(
        `Cannot canonicalize Codex home '${resolvedPath}': nearest existing ancestor is not a directory.`,
      );
    }
    // Existing components are normalized one directory lookup at a time, so
    // per-directory case sensitivity remains authoritative. Missing suffixes
    // inherit the verified lookup semantics of their nearest existing parent.
    return normalizeFilesystemIdentity(canonicalAncestor, missingSegments);
  }
}

export function resolveCodexHomeIdentityPaths(
  input: CodexHomeIdentityInput = {},
): CodexHomeIdentityPaths {
  const environment = { ...process.env, ...input.environment };
  const sourceHomePath = resolveBaseCodexHomePath(environment, input.homePath);
  const shadowHomePath = input.shadowHomePath
    ? resolveBaseCodexHomePath(environment, input.shadowHomePath)
    : undefined;
  const activeHomePath = resolveActiveCodexHomeWritePath({
    env: environment,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });

  return {
    sourceHomePath: canonicalizeCodexHomeIdentityPath(sourceHomePath),
    ...(shadowHomePath
      ? { shadowHomePath: canonicalizeCodexHomeIdentityPath(shadowHomePath) }
      : {}),
    activeHomePath: canonicalizeCodexHomeIdentityPath(activeHomePath),
  };
}

export function uniqueCodexHomeIdentityPaths(
  input: CodexHomeIdentityInput = {},
): readonly string[] {
  const identities = resolveCodexHomeIdentityPaths(input);
  return [
    identities.sourceHomePath,
    ...(identities.shadowHomePath ? [identities.shadowHomePath] : []),
    identities.activeHomePath,
  ].filter((candidate, index, values) => values.indexOf(candidate) === index);
}

/**
 * Canonical identities used by account lifecycle locks, teardown matching,
 * generation tombstones, and provider-binding fences.
 *
 * A shadow-only caller did not select the process-default source home; that
 * source is a shared configuration baseline and must not become a global
 * ~/.codex account identity. Explicit homePath or caller environment.CODEX_HOME
 * selections remain authoritative and are included with shadow + active home.
 */
export function uniqueCodexLifecycleHomeIdentityPaths(
  input: CodexHomeIdentityInput = {},
): readonly string[] {
  const identities = resolveCodexHomeIdentityPaths(input);
  const hasExplicitSourceHome = Boolean(
    input.homePath?.trim() || input.environment?.CODEX_HOME?.trim(),
  );
  return [
    ...(input.shadowHomePath && !hasExplicitSourceHome ? [] : [identities.sourceHomePath]),
    ...(identities.shadowHomePath ? [identities.shadowHomePath] : []),
    identities.activeHomePath,
  ].filter((candidate, index, values) => values.indexOf(candidate) === index);
}
