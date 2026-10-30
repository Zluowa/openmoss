import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import { MossResourceImportError } from "./mossResourceImport.ts";

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_ENTRIES = 4_096;
export const MAX_DEPTH = 32;
export const READ_CHUNK_BYTES = 64 * 1024;

const MAX_ENTRY_NAME_BYTES = 255;
const DIRECTORY_BUFFER_SIZE = 32;
export const MOSS_CANONICAL_MISSING_HASH = createHash("sha256").update("missing").digest("hex");

export interface MossCanonicalResourceHashLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
  readonly maxDepth: number;
}

export interface MossCanonicalResourceHashHooks {
  /** Test-only seam for deterministic replacement races; production never supplies hooks. */
  readonly beforeRead?: (targetPath: string) => void | Promise<void>;
}

export interface MossCanonicalResourceHashInput {
  readonly rootPath: string;
  readonly targetPath: string;
  readonly limits?: Partial<MossCanonicalResourceHashLimits>;
  readonly requirePresent?: boolean;
  readonly hooks?: MossCanonicalResourceHashHooks;
}

export interface MossCanonicalResourceHashResult {
  readonly kind: "file" | "directory" | "missing";
  readonly hash: string;
  readonly identityFingerprint: string;
  readonly bytes: number;
  readonly entries: number;
  readonly depth: number;
}

interface StatSnapshot {
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly size: string;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface PathObservation {
  readonly path: string;
  readonly stat: StatSnapshot;
}

interface HashState {
  readonly limits: MossCanonicalResourceHashLimits;
  readonly hooks?: MossCanonicalResourceHashHooks;
  bytes: number;
  entries: number;
}

interface NodeResult {
  readonly kind: "file" | "directory";
  readonly hash: string;
  readonly identityFingerprint: string;
  readonly depth: number;
}

function hashError(
  code: ConstructorParameters<typeof MossResourceImportError>[0],
  message: string,
): MossResourceImportError {
  return new MossResourceImportError(code, message);
}

function errorCode(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== "object" || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

function filesystemError(cause: unknown, missingCode: "missing-root" | "concurrent-modification") {
  const code = errorCode(cause);
  if (code === "ELOOP") return hashError("symlink-escape", "Canonical hash encountered a symlink.");
  if (code === "ENOENT") return hashError(missingCode, "Canonical hash target disappeared.");
  return hashError("durability-unsupported", "Canonical hash filesystem access failed safely.");
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw hashError("limit-exceeded", "Canonical hash limit is invalid.");
  }
  return value;
}

function normalizeLimits(
  limits: Partial<MossCanonicalResourceHashLimits> | undefined,
): MossCanonicalResourceHashLimits {
  return {
    maxFileBytes: normalizeLimit(limits?.maxFileBytes, MAX_FILE_BYTES),
    maxTotalBytes: normalizeLimit(limits?.maxTotalBytes, MAX_TOTAL_BYTES),
    maxEntries: normalizeLimit(limits?.maxEntries, MAX_ENTRIES),
    maxDepth: normalizeLimit(limits?.maxDepth, MAX_DEPTH),
  };
}

function snapshot(stat: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mode: number;
  readonly size: number | bigint;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): StatSnapshot {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: stat.mode,
    size: String(stat.size),
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameSnapshot(left: StatSnapshot, right: StatSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    Object.is(left.mtimeMs, right.mtimeMs) &&
    Object.is(left.ctimeMs, right.ctimeMs)
  );
}

function identityFingerprint(stat: StatSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        ctimeMs: stat.ctimeMs,
      }),
    )
    .digest("hex");
}

function assertInsideRoot(
  rootPath: string,
  targetPath: string,
): {
  readonly rootPath: string;
  readonly targetPath: string;
} {
  const resolvedRoot = nodePath.resolve(rootPath);
  const resolvedTarget = nodePath.resolve(targetPath);
  const relative = nodePath.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
    throw hashError("path-traversal", "Canonical hash target leaves the canonical root.");
  }
  return { rootPath: resolvedRoot, targetPath: resolvedTarget };
}

async function safeLstat(targetPath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(targetPath);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return null;
    throw filesystemError(cause, "concurrent-modification");
  }
}

async function safeHandleStat(handle: fs.FileHandle): Promise<StatSnapshot> {
  try {
    return snapshot(await handle.stat());
  } catch (cause) {
    throw filesystemError(cause, "concurrent-modification");
  }
}

async function closeHandle(handle: fs.FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    throw hashError("durability-unsupported", "Canonical hash file handle could not be closed.");
  }
}

async function assertSafePath(
  rootPath: string,
  targetPath: string,
): Promise<readonly PathObservation[]> {
  const observations: PathObservation[] = [];
  const rootStat = await safeLstat(rootPath);
  if (!rootStat) return observations;
  if (rootStat.isSymbolicLink()) {
    throw hashError("symlink-escape", "Canonical hash root is a symlink.");
  }
  if (!rootStat.isDirectory()) {
    throw hashError("unsupported", "Canonical hash root is not a directory.");
  }
  observations.push({ path: rootPath, stat: snapshot(rootStat) });

  // The canonical root is the trust boundary. When hashing the root itself,
  // its parent is outside that boundary and must not be traversed. This also
  // keeps root hashing consistent with hashing an immediate child, which does
  // not inspect ancestors above the canonical root.
  if (targetPath === rootPath) return observations;

  const relativeParent = nodePath.relative(rootPath, nodePath.dirname(targetPath));
  let current = rootPath;
  for (const segment of relativeParent.split(nodePath.sep).filter(Boolean)) {
    current = nodePath.join(current, segment);
    const stat = await safeLstat(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw hashError("symlink-escape", "Canonical hash parent is a symlink.");
    }
    if (!stat.isDirectory()) {
      throw hashError("symlink-escape", "Canonical hash parent is not a directory.");
    }
    observations.push({ path: current, stat: snapshot(stat) });
  }
  return observations;
}

async function assertParentsStable(observations: readonly PathObservation[]): Promise<void> {
  for (const observation of observations) {
    const current = await safeLstat(observation.path);
    if (
      !current ||
      current.isSymbolicLink() ||
      !sameSnapshot(observation.stat, snapshot(current))
    ) {
      throw hashError("concurrent-modification", "Canonical hash parent changed during hashing.");
    }
  }
}

async function assertTargetStable(targetPath: string, expected: StatSnapshot): Promise<void> {
  const current = await safeLstat(targetPath);
  if (!current) {
    throw hashError("concurrent-modification", "Canonical hash target changed during hashing.");
  }
  if (current.isSymbolicLink() || !sameSnapshot(expected, snapshot(current))) {
    throw hashError("concurrent-modification", "Canonical hash target changed during hashing.");
  }
}

function openFlags(directory: boolean): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw hashError("durability-unsupported", "Canonical hash no-follow support is unavailable.");
  }
  if (directory && typeof fsConstants.O_DIRECTORY !== "number") {
    throw hashError("durability-unsupported", "Canonical hash directory support is unavailable.");
  }
  return fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (directory ? fsConstants.O_DIRECTORY : 0);
}

async function openNoFollow(targetPath: string, directory: boolean): Promise<fs.FileHandle> {
  try {
    return await fs.open(targetPath, openFlags(directory));
  } catch (cause) {
    throw filesystemError(cause, "concurrent-modification");
  }
}

async function invokeBeforeRead(
  hooks: MossCanonicalResourceHashHooks | undefined,
  targetPath: string,
): Promise<void> {
  if (!hooks?.beforeRead) return;
  try {
    await hooks.beforeRead(targetPath);
  } catch {
    throw hashError("durability-unsupported", "Canonical hash pre-read validation failed.");
  }
}

async function listDirectoryNames(
  targetPath: string,
  expected: StatSnapshot,
  state: HashState,
  enforceGlobalEntryLimit = true,
): Promise<string[]> {
  const descriptor = await openNoFollow(targetPath, true);
  try {
    const opened = await safeHandleStat(descriptor);
    if (!sameSnapshot(expected, opened)) {
      throw hashError("concurrent-modification", "Canonical directory changed before hashing.");
    }
    const names: string[] = [];
    let directory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
    try {
      directory = await fs.opendir(targetPath, { bufferSize: DIRECTORY_BUFFER_SIZE });
      for await (const entry of directory) {
        const remainingEntryBudget = enforceGlobalEntryLimit
          ? state.limits.maxEntries - state.entries
          : state.limits.maxEntries;
        if (names.length + 1 > remainingEntryBudget) {
          throw hashError("limit-exceeded", "Canonical hash entry limit was exceeded.");
        }
        if (
          entry.name.includes("\0") ||
          Buffer.byteLength(entry.name, "utf8") > MAX_ENTRY_NAME_BYTES
        ) {
          throw hashError("limit-exceeded", "Canonical hash entry name limit was exceeded.");
        }
        names.push(entry.name);
      }
    } catch (cause) {
      if (cause instanceof MossResourceImportError) throw cause;
      throw filesystemError(cause, "concurrent-modification");
    } finally {
      if (directory) {
        try {
          await directory.close();
        } catch (cause) {
          if (errorCode(cause) !== "ERR_DIR_CLOSED") {
            throw hashError(
              "durability-unsupported",
              "Canonical hash directory could not be closed.",
            );
          }
        }
      }
    }
    const closed = await safeHandleStat(descriptor);
    if (!sameSnapshot(expected, closed) || !sameSnapshot(opened, closed)) {
      throw hashError("concurrent-modification", "Canonical directory changed during hashing.");
    }
    const current = await safeLstat(targetPath);
    if (!current || current.isSymbolicLink() || !sameSnapshot(expected, snapshot(current))) {
      throw hashError("concurrent-modification", "Canonical directory changed during hashing.");
    }
    return names;
  } finally {
    await closeHandle(descriptor);
  }
}

function addEntries(state: HashState, count: number): void {
  if (state.entries + count > state.limits.maxEntries) {
    throw hashError("limit-exceeded", "Canonical hash entry limit was exceeded.");
  }
  state.entries += count;
}

async function hashFile(
  targetPath: string,
  expected: StatSnapshot,
  parents: readonly PathObservation[],
  state: HashState,
): Promise<string> {
  await invokeBeforeRead(state.hooks, targetPath);
  const handle = await openNoFollow(targetPath, false);
  try {
    const opened = await safeHandleStat(handle);
    if (!sameSnapshot(expected, opened)) {
      throw hashError("concurrent-modification", "Canonical file changed before hashing.");
    }
    if (Number(opened.size) > state.limits.maxFileBytes) {
      throw hashError("limit-exceeded", "Canonical hash file limit was exceeded.");
    }
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let fileBytes = 0;
    while (true) {
      const fileRemaining = state.limits.maxFileBytes - fileBytes;
      const totalRemaining = state.limits.maxTotalBytes - state.bytes;
      const readLength = Math.min(READ_CHUNK_BYTES, fileRemaining + 1, totalRemaining + 1);
      if (readLength <= 0) {
        throw hashError("limit-exceeded", "Canonical hash byte limit was exceeded.");
      }
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(chunk, 0, readLength, fileBytes));
      } catch (cause) {
        throw filesystemError(cause, "concurrent-modification");
      }
      if (bytesRead === 0) break;
      if (bytesRead > fileRemaining || bytesRead > totalRemaining) {
        throw hashError("limit-exceeded", "Canonical hash byte limit was exceeded.");
      }
      digest.update(chunk.subarray(0, bytesRead));
      fileBytes += bytesRead;
      state.bytes += bytesRead;
    }
    const closed = await safeHandleStat(handle);
    if (!sameSnapshot(expected, closed) || !sameSnapshot(opened, closed)) {
      throw hashError("concurrent-modification", "Canonical file changed during hashing.");
    }
    await assertTargetStable(targetPath, expected);
    await assertParentsStable(parents);
    return digest.digest("hex");
  } finally {
    await closeHandle(handle);
  }
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}

async function hashNode(
  rootPath: string,
  targetPath: string,
  depth: number,
  countSelf: boolean,
  expectedPresent: boolean,
  state: HashState,
): Promise<NodeResult | null> {
  if (depth > state.limits.maxDepth) {
    throw hashError("limit-exceeded", "Canonical hash depth limit was exceeded.");
  }
  const parents = await assertSafePath(rootPath, targetPath);
  const stat = await safeLstat(targetPath);
  if (!stat) {
    if (expectedPresent) {
      throw hashError(
        "concurrent-modification",
        "Canonical hash entry disappeared during hashing.",
      );
    }
    return null;
  }
  if (stat.isSymbolicLink()) {
    throw hashError("symlink-escape", "Canonical hash entry is a symlink.");
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw hashError("unsupported", "Canonical hash entry is not a file or directory.");
  }
  const expected = snapshot(stat);

  if (stat.isFile()) {
    if (countSelf) addEntries(state, 1);
    return {
      kind: "file",
      hash: await hashFile(targetPath, expected, parents, state),
      identityFingerprint: identityFingerprint(expected),
      depth,
    };
  }

  if (countSelf && depth > 0) addEntries(state, 1);
  const names = (await listDirectoryNames(targetPath, expected, state)).sort((left, right) =>
    left.localeCompare(right),
  );
  addEntries(state, names.length);
  const digest = createHash("sha256");
  let maximumDepth = depth;
  let first = true;
  for (const name of names) {
    const child = await hashNode(
      rootPath,
      nodePath.join(targetPath, name),
      depth + 1,
      false,
      true,
      state,
    );
    if (!child) {
      throw hashError(
        "concurrent-modification",
        "Canonical hash entry disappeared during hashing.",
      );
    }
    if (maximumDepth < child.depth) maximumDepth = child.depth;
    if (!first) digest.update("\n");
    digest.update(name);
    digest.update("\0");
    digest.update(child.hash);
    first = false;
  }
  const finalNames = (await listDirectoryNames(targetPath, expected, state, false)).sort(
    (left, right) => left.localeCompare(right),
  );
  if (!sameNames(names, finalNames)) {
    throw hashError(
      "concurrent-modification",
      "Canonical directory entries changed during hashing.",
    );
  }
  await assertTargetStable(targetPath, expected);
  await assertParentsStable(parents);
  return {
    kind: "directory",
    hash: digest.digest("hex"),
    identityFingerprint: identityFingerprint(expected),
    depth: maximumDepth,
  };
}

export async function hashMossCanonicalResource(
  input: MossCanonicalResourceHashInput,
): Promise<MossCanonicalResourceHashResult> {
  const { rootPath, targetPath } = assertInsideRoot(input.rootPath, input.targetPath);
  const limits = normalizeLimits(input.limits);
  const state: HashState = {
    limits,
    ...(input.hooks ? { hooks: input.hooks } : {}),
    bytes: 0,
    entries: 0,
  };
  const result = await hashNode(
    rootPath,
    targetPath,
    0,
    true,
    input.requirePresent ?? false,
    state,
  );
  if (!result) {
    return {
      kind: "missing",
      hash: MOSS_CANONICAL_MISSING_HASH,
      identityFingerprint: "absent",
      bytes: 0,
      entries: 0,
      depth: 0,
    };
  }
  return {
    kind: result.kind,
    hash: result.hash,
    identityFingerprint: result.identityFingerprint,
    bytes: state.bytes,
    entries: state.entries,
    depth: result.depth,
  };
}
