// FILE: codexPathIdentity.ts
// Purpose: Canonicalizes Codex home paths for account-boundary comparisons.
// Layer: Server filesystem utility.

import { codexAuthFs, runCodexAuthIoSync, type CodexAuthIo } from "./codexAuthIo.ts";
import path from "node:path";

function normalizeIdentity(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// Resolve symlinks in every existing path component while preserving a missing tail.
export function resolveCodexPathIdentity(inputPath: string): string {
  return runCodexAuthIoSync(resolveCodexPathIdentityIo(inputPath));
}

export function* resolveCodexPathIdentityIo(inputPath: string): CodexAuthIo<string> {
  const resolvedInput = path.resolve(inputPath);
  const missingSegments: string[] = [];
  let candidate = resolvedInput;

  while (true) {
    try {
      const realCandidate = yield* codexAuthFs.realpath(candidate);
      const rebuilt =
        missingSegments.length > 0 ? path.join(realCandidate, ...missingSegments) : realCandidate;
      return normalizeIdentity(rebuilt);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return normalizeIdentity(resolvedInput);
      }
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export function codexPathsReferenceSameLocation(left: string, right: string): boolean {
  return resolveCodexPathIdentity(left) === resolveCodexPathIdentity(right);
}

export function* codexPathsReferenceSameLocationIo(
  left: string,
  right: string,
): CodexAuthIo<boolean> {
  return (yield* resolveCodexPathIdentityIo(left)) === (yield* resolveCodexPathIdentityIo(right));
}

/** Windows short names may identify the same directory without redirecting it.
 * This is a path comparison, never a substitute for managed-home authority.
 * Missing paths keep the existing lexical-only provisioning contract.
 */
export function codexDirectoriesReferenceSameUnredirectedLocation(
  left: string,
  right: string,
): boolean {
  return runCodexAuthIoSync(codexDirectoriesReferenceSameUnredirectedLocationIo(left, right));
}

export function* codexDirectoriesReferenceSameUnredirectedLocationIo(
  left: string,
  right: string,
): CodexAuthIo<boolean> {
  if (path.resolve(left) === path.resolve(right)) return true;
  if (process.platform !== "win32") return false;
  const directoryIdentity = function* (directory: string) {
    const resolved = path.resolve(directory);
    const stat = yield* codexAuthFs.lstat(resolved);
    for (let current = resolved; ; current = path.dirname(current)) {
      const entry = current === resolved ? stat : yield* codexAuthFs.lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return undefined;
      if (path.dirname(current) === current) break;
    }
    return {
      path: normalizeIdentity(yield* codexAuthFs.realpath(resolved)),
      dev: stat.dev,
      ino: stat.ino,
    };
  };
  try {
    const leftIdentity = yield* directoryIdentity(left);
    const rightIdentity = yield* directoryIdentity(right);
    return Boolean(
      leftIdentity &&
      rightIdentity &&
      leftIdentity.path === rightIdentity.path &&
      leftIdentity.dev === rightIdentity.dev &&
      leftIdentity.ino === rightIdentity.ino,
    );
  } catch {
    return false;
  }
}
