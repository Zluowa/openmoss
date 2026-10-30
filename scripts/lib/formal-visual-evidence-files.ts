// FILE: formal-visual-evidence-files.ts
// Purpose: Provides a fail-closed filesystem boundary for formal visual capture evidence.
// Layer: Release verification filesystem boundary

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  assertFormalVisualDirectoryPlatformSupported,
  openNativeDirectoryEntry,
  readNativeDirectoryNames,
  renameNativeDirectoryEntryExclusiveVerified,
} from "./formal-visual-directory-native.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const POSIX_MODES = process.platform !== "win32";
const DIRECTORY_PUBLICATION_RECEIPT_SCHEMA = "moss.formal-evidence-directory-publication-receipt";
const DIRECTORY_PUBLICATION_RECEIPT_SCHEMA_VERSION = 1;
const DIRECTORY_PUBLICATION_JOURNAL_SCHEMA = "moss.formal-evidence-directory-publication-journal";
const DIRECTORY_PUBLICATION_JOURNAL_SCHEMA_VERSION = 1;
const DIRECTORY_PUBLICATION_DIGEST_ALGORITHM = "sha256-tree-v1";
const FORMAL_CAPTURE_MANIFEST_NAME = "formal-capture-manifest.json";

export interface FrozenEvidenceFile {
  readonly path: string;
  readonly label: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly mode: bigint;
  readonly sha256: string;
  readonly requirePrivateMode: boolean;
}

export interface FrozenEvidenceRead {
  readonly frozen: FrozenEvidenceFile;
  readonly bytes: Buffer;
}

interface FrozenDirectoryIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface EvidencePublicationDirectoryTransaction {
  readonly directories: readonly FrozenDirectoryIdentity[];
}

interface OwnedDirectoryEntryIdentity {
  readonly path: string;
  readonly parentPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly ctimeNs: bigint;
  readonly parentDev: bigint;
  readonly parentIno: bigint;
  readonly parentMtimeNs: bigint;
  readonly parentCtimeNs: bigint;
}

/** @internal Deterministic fault injection for no-replace and cleanup tests. */
export interface EvidencePublicationFaultHooks {
  readonly beforeExclusiveLink?: () => void;
  readonly aroundExclusiveLink?: (publish: () => void) => void;
  readonly afterExclusiveLink?: () => void;
  readonly beforeOwnedCleanupUnlink?: (path: string) => void;
  readonly afterParentDirectoryFsync?: (path: string) => void;
}

/** @internal Deterministic fault observation for atomic directory-publication tests. */
export interface EvidenceDirectoryPublicationFaultHooks {
  readonly platformForTest?: NodeJS.Platform;
  /** Runs inside the native addon after source-name verification and before renameat*. */
  readonly afterNativeSourcePrecheck?: (context: { readonly rejectedPath: string }) => void;
  readonly afterVerifiedRename?: (targetPath: string) => void;
  /** @internal Must throw; deterministically models failure of the first post-rename parent fsync. */
  readonly injectPostRenameParentFsyncFailure?: () => never;
  readonly afterPostRenameParentFsync?: (parentPath: string) => void;
  /** Observes the pre-exposure transaction journal after its file and parent are durable. */
  readonly afterPublicationPendingJournalParentFsync?: (journalPath: string) => void;
  readonly afterReceiptVerifiedRename?: (receiptPath: string) => void;
  /** @internal Must throw; models failure of the parent fsync after receipt rename. */
  readonly injectPostReceiptParentFsyncFailure?: (context: {
    readonly receiptPath: string;
    readonly receiptQuarantinePath: string;
  }) => never;
  /** Runs natively after receipt-name identity verification and immediately before quarantine. */
  readonly afterNativeReceiptFailureQuarantinePrecheck?: (context: {
    readonly receiptPath: string;
    readonly receiptQuarantinePath: string;
    readonly rejectedPath: string;
  }) => void;
  /** Runs natively after target-name identity verification and immediately before quarantine. */
  readonly afterNativeTargetFailureQuarantinePrecheck?: (context: {
    readonly targetPath: string;
    readonly targetQuarantinePath: string;
    readonly rejectedPath: string;
  }) => void;
  readonly afterReceiptFailureCleanup?: (context: {
    readonly method: "receipt-quarantine" | "target-quarantine";
    readonly receiptPath: string;
    readonly receiptQuarantinePath: string;
    readonly targetPath: string;
    readonly targetQuarantinePath: string;
  }) => void;
  /** @internal Must throw; models failure of the first compensation parent fsync. */
  readonly injectReceiptFailureCleanupParentFsyncFailure?: () => never;
  /** @internal Must throw; models failure of the second compensation parent fsync. */
  readonly injectSecondReceiptFailureCleanupParentFsyncFailure?: () => never;
  readonly afterReceiptFailureCleanupParentFsync?: (parentPath: string) => void;
  /** @internal Must throw; models failure of the parent fsync after journal promotion. */
  readonly injectPostCommittedJournalParentFsyncFailure?: (context: {
    readonly pendingJournalPath: string;
    readonly committedJournalPath: string;
  }) => never;
}

export class EvidenceDirectoryPublicationDurabilityError extends Error {
  readonly canonicalTargetPath: string;
  /** Backward-compatible path alias; it does not assert that the canonical name is still present. */
  readonly committedTargetPath: string;
  readonly publicationReceiptPath: string;
  readonly durabilityConfirmed = false as const;

  constructor(targetPath: string, receiptPath: string, cause: unknown) {
    super(
      `Evidence publication durability is unconfirmed for canonical target ${targetPath}; the transaction remains fail closed regardless of the current canonical-name state.`,
      { cause },
    );
    this.name = "EvidenceDirectoryPublicationDurabilityError";
    this.canonicalTargetPath = targetPath;
    this.committedTargetPath = targetPath;
    this.publicationReceiptPath = receiptPath;
  }
}

export class EvidenceDirectoryPublicationRecoveryError extends Error {
  readonly canonicalTargetPath: string;
  readonly publicationReceiptPath: string;
  readonly requiresExplicitQuarantine = true as const;

  constructor(targetPath: string, receiptPath: string, cause: unknown) {
    super(
      `Unrecoverable evidence publication failure for canonical target ${targetPath} and receipt ${receiptPath}: final publication journal eligibility could not be verified. The formal consumer gate must evaluate the current state; explicit quarantine is required before republishing.`,
      { cause },
    );
    this.name = "EvidenceDirectoryPublicationRecoveryError";
    this.canonicalTargetPath = targetPath;
    this.publicationReceiptPath = receiptPath;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function describePathKind(metadata: BigIntStats): string {
  if (metadata.isSymbolicLink()) return "symbolic link";
  if (metadata.isFIFO()) return "FIFO";
  if (metadata.isSocket()) return "socket";
  if (metadata.isCharacterDevice()) return "character device";
  if (metadata.isBlockDevice()) return "block device";
  if (metadata.isDirectory()) return "directory";
  return "non-regular file";
}

function assertPrivateFileMode(mode: bigint, label: string): void {
  if (POSIX_MODES && Number(mode & 0o777n) !== PRIVATE_FILE_MODE) {
    throw new Error(`${label} must use private mode 0600.`);
  }
}

function sameOpenedFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function absolutePathComponents(pathInput: string): readonly string[] {
  const path = resolve(pathInput);
  const root = parse(path).root;
  const fromRoot = relative(root, path);
  if (!fromRoot) return [];
  const components: string[] = [];
  let current = root;
  for (const part of fromRoot.split(sep)) {
    current = join(current, part);
    components.push(current);
  }
  return components;
}

function inspectDirectoryIdentity(path: string, label: string): FrozenDirectoryIdentity {
  let metadata: BigIntStats;
  try {
    metadata = lstatSync(path, { bigint: true });
  } catch (cause) {
    throw new Error(`${label} ancestor directory is unavailable: ${path}`, { cause });
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} uses a symbolic ancestor directory: ${path}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} uses a non-directory ancestor: ${path}`);
  }
  return { path, dev: metadata.dev, ino: metadata.ino };
}

function freezeAncestorDirectories(
  pathInput: string,
  label: string,
): readonly FrozenDirectoryIdentity[] {
  return absolutePathComponents(dirname(resolve(pathInput))).map((path) =>
    inspectDirectoryIdentity(path, label),
  );
}

function assertAncestorDirectoriesFrozen(
  ancestors: readonly FrozenDirectoryIdentity[],
  label: string,
): void {
  for (const frozen of ancestors) {
    const current = inspectDirectoryIdentity(frozen.path, label);
    if (current.dev !== frozen.dev || current.ino !== frozen.ino) {
      throw new Error(`${label} ancestor directory changed while evidence was being accessed.`);
    }
  }
}

function beginEvidencePublicationDirectoryTransaction(
  targetPath: string,
  label: string,
): EvidencePublicationDirectoryTransaction {
  return { directories: freezeAncestorDirectories(targetPath, label) };
}

function assertEvidencePublicationDirectoryTransaction(
  transaction: EvidencePublicationDirectoryTransaction,
  label: string,
): void {
  assertAncestorDirectoriesFrozen(transaction.directories, label);
}

function inspectEvidenceFile(
  pathInput: string,
  label: string,
  options: { readonly requirePrivateMode?: boolean } = {},
): FrozenEvidenceRead {
  const path = resolve(pathInput);
  const ancestors = freezeAncestorDirectories(path, label);
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (cause) {
    throw new Error(`${label} must be an available regular file: ${path}`, { cause });
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a ${describePathKind(before)}: ${path}`);
  }
  if (before.nlink !== 1n) {
    throw new Error(`${label} must not be a hardlink (nlink must equal 1): ${path}`);
  }
  if (options.requirePrivateMode) assertPrivateFileMode(before.mode, label);

  let descriptor: number | undefined;
  let bytes: Buffer;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (!openedBefore.isFile() || !sameOpenedFile(before, openedBefore)) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    if (!sameOpenedFile(openedBefore, openedAfter)) {
      throw new Error(`${label} changed while it was being read.`);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const after = lstatSync(path, { bigint: true });
  if (!sameOpenedFile(after, before)) {
    throw new Error(`${label} changed while it was being frozen.`);
  }
  assertAncestorDirectoriesFrozen(ancestors, label);
  return {
    frozen: {
      path,
      label,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      mode: before.mode,
      sha256: sha256(bytes),
      requirePrivateMode: options.requirePrivateMode === true,
    },
    bytes,
  };
}

export function readFrozenEvidenceFile(
  path: string,
  label: string,
  options: { readonly requirePrivateMode?: boolean } = {},
): FrozenEvidenceRead {
  return inspectEvidenceFile(path, label, options);
}

export function freezeEvidenceFile(
  path: string,
  label: string,
  options: { readonly requirePrivateMode?: boolean } = {},
): FrozenEvidenceFile {
  return inspectEvidenceFile(path, label, options).frozen;
}

export function assertFrozenEvidenceFile(frozen: FrozenEvidenceFile): void {
  const current = inspectEvidenceFile(frozen.path, frozen.label, {
    requirePrivateMode: frozen.requirePrivateMode,
  }).frozen;
  if (
    current.dev !== frozen.dev ||
    current.ino !== frozen.ino ||
    current.size !== frozen.size ||
    current.mtimeNs !== frozen.mtimeNs ||
    current.mode !== frozen.mode ||
    current.sha256 !== frozen.sha256
  ) {
    throw new Error(`${frozen.label} changed after it was frozen: ${frozen.path}`);
  }
}

export function assertPrivateEvidenceDirectory(pathInput: string, label = "Evidence run"): string {
  const path = resolve(pathInput);
  const ancestors = freezeAncestorDirectories(path, label);
  let metadata: BigIntStats;
  try {
    metadata = lstatSync(path, { bigint: true });
  } catch (cause) {
    throw new Error(`${label} directory is unavailable: ${path}`, { cause });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symbolic or non-directory path.`);
  }
  if (POSIX_MODES) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new Error(`${label} directory changed while it was being opened.`);
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    const after = lstatSync(path, { bigint: true });
    if (!after.isDirectory() || after.dev !== metadata.dev || after.ino !== metadata.ino) {
      throw new Error(`${label} directory changed while it was being verified.`);
    }
    metadata = after;
  }
  assertAncestorDirectoriesFrozen(ancestors, label);
  if (POSIX_MODES && Number(metadata.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(`${label} directory must use private mode 0700.`);
  }
  return path;
}

export function ensurePrivateEvidenceDirectory(pathInput: string): string {
  const path = resolve(pathInput);
  for (const component of absolutePathComponents(path)) {
    try {
      const metadata = lstatSync(component, { bigint: true });
      if (metadata.isSymbolicLink()) {
        throw new Error(`Evidence output uses a symbolic ancestor directory: ${component}`);
      }
      if (!metadata.isDirectory()) {
        throw new Error(`Evidence output uses a non-directory ancestor: ${component}`);
      }
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.message.startsWith("Evidence output uses a symbolic ancestor") ||
          cause.message.startsWith("Evidence output uses a non-directory ancestor"))
      ) {
        throw cause;
      }
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      try {
        mkdirSync(component, { mode: PRIVATE_DIRECTORY_MODE });
      } catch (mkdirCause) {
        if ((mkdirCause as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirCause;
      }
      inspectDirectoryIdentity(component, "Evidence output");
    }
  }
  if (POSIX_MODES) {
    let descriptor: number | undefined;
    try {
      const before = lstatSync(path, { bigint: true });
      descriptor = openSync(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error(`Evidence output directory changed while it was being opened: ${path}`);
      }
      fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  return assertPrivateEvidenceDirectory(path, "Evidence output");
}

export function resolveEvidenceFile(rootInput: string, file: string, label: string): string {
  const root = assertPrivateEvidenceDirectory(rootInput);
  if (
    isAbsolute(file) ||
    file.includes("\\") ||
    file.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must use a safe capture-relative path.`);
  }
  const path = resolve(root, file);
  const fromRoot = relative(root, path);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} escapes the controlled evidence run root.`);
  }
  let parent = root;
  const parts = fromRoot.split(sep);
  for (const part of parts.slice(0, -1)) {
    parent = resolve(parent, part);
    let metadata: BigIntStats;
    try {
      metadata = lstatSync(parent, { bigint: true });
    } catch (cause) {
      throw new Error(`${label} parent directory is unavailable inside the run root.`, { cause });
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${label} uses a symbolic parent directory inside the run root.`);
    }
  }
  return path;
}

interface BoundPublicationDirectory {
  readonly descriptor: number;
  readonly expected: FrozenDirectoryIdentity;
  readonly parentPath: string;
}

/**
 * Node does not expose descriptor-relative openat/renameat. The tiny audited native boundary used
 * here keeps every mutation anchored to this already-verified directory descriptor. It never
 * changes process.cwd(), so Worker threads and libuv callbacks keep the caller's working directory.
 */
function sameDirectoryIdentity(
  metadata: Pick<BigIntStats, "dev" | "ino">,
  expected: Pick<FrozenDirectoryIdentity, "dev" | "ino">,
): boolean {
  return metadata.dev === expected.dev && metadata.ino === expected.ino;
}

function assertBoundPublicationDirectory(bound: BoundPublicationDirectory, label: string): void {
  const opened = fstatSync(bound.descriptor, { bigint: true });
  if (!opened.isDirectory() || !sameDirectoryIdentity(opened, bound.expected)) {
    throw new Error(`${label} fixed parent directory binding changed unexpectedly.`);
  }
}

function withBoundPublicationDirectory<T>(
  transaction: EvidencePublicationDirectoryTransaction,
  targetPath: string,
  label: string,
  action: (bound: BoundPublicationDirectory) => T,
): T {
  const parentPath = dirname(targetPath);
  const expected = transaction.directories[transaction.directories.length - 1];
  if (!expected || expected.path !== parentPath) {
    throw new Error(`${label} has no verified parent directory transaction.`);
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      parentPath,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const bound: BoundPublicationDirectory = { descriptor, expected, parentPath };
    assertBoundPublicationDirectory(bound, label);
    return action(bound);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Closing a directory descriptor cannot invalidate a completed synchronous mutation.
      }
    }
  }
}

function openBoundDirectoryEntry(
  bound: BoundPublicationDirectory,
  entryName: string,
  flags: number,
  mode: number,
  label: string,
): number {
  assertBoundPublicationDirectory(bound, label);
  return openNativeDirectoryEntry(bound.descriptor, entryName, flags, mode, label);
}

function statBoundDirectoryEntry(
  bound: BoundPublicationDirectory,
  entryName: string,
  flags: number,
  label: string,
): BigIntStats {
  let descriptor: number | undefined;
  try {
    descriptor = openBoundDirectoryEntry(bound, entryName, flags, 0, label);
    return fstatSync(descriptor, { bigint: true });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function freezeBoundOwnedDirectoryEntry(
  bound: BoundPublicationDirectory,
  targetName: string,
  owned: Pick<BigIntStats, "dev" | "ino">,
  label: string,
): OwnedDirectoryEntryIdentity {
  assertBoundPublicationDirectory(bound, label);
  const parent = fstatSync(bound.descriptor, { bigint: true });
  const entry = statBoundDirectoryEntry(
    bound,
    targetName,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    label,
  );
  if (!entry.isFile() || entry.dev !== owned.dev || entry.ino !== owned.ino) {
    throw new Error(`${label} directory entry has an unexpected identity.`);
  }
  return {
    path: targetName,
    parentPath: bound.parentPath,
    dev: entry.dev,
    ino: entry.ino,
    nlink: entry.nlink,
    ctimeNs: entry.ctimeNs,
    parentDev: parent.dev,
    parentIno: parent.ino,
    parentMtimeNs: parent.mtimeNs,
    parentCtimeNs: parent.ctimeNs,
  };
}

function assertBoundOwnedDirectoryEntryUnchanged(
  bound: BoundPublicationDirectory,
  entry: OwnedDirectoryEntryIdentity,
  label: string,
): void {
  assertBoundPublicationDirectory(bound, label);
  const parent = fstatSync(bound.descriptor, { bigint: true });
  const current = statBoundDirectoryEntry(
    bound,
    entry.path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    label,
  );
  if (
    parent.dev !== entry.parentDev ||
    parent.ino !== entry.parentIno ||
    parent.mtimeNs !== entry.parentMtimeNs ||
    parent.ctimeNs !== entry.parentCtimeNs ||
    !current.isFile() ||
    current.dev !== entry.dev ||
    current.ino !== entry.ino ||
    current.nlink !== entry.nlink ||
    current.ctimeNs !== entry.ctimeNs
  ) {
    throw new Error(`${label} directory entry changed after exclusive publication.`);
  }
}

function inspectBoundEvidenceFile(
  bound: BoundPublicationDirectory,
  entry: OwnedDirectoryEntryIdentity,
  targetPath: string,
  label: string,
): FrozenEvidenceRead {
  assertBoundOwnedDirectoryEntryUnchanged(bound, entry, label);
  let descriptor: number | undefined;
  try {
    descriptor = openBoundDirectoryEntry(
      bound,
      entry.path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      0,
      label,
    );
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (
      !openedBefore.isFile() ||
      openedBefore.dev !== entry.dev ||
      openedBefore.ino !== entry.ino ||
      openedBefore.nlink !== 1n
    ) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    assertPrivateFileMode(openedBefore.mode, label);
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    if (!sameOpenedFile(openedBefore, openedAfter)) {
      throw new Error(`${label} changed while it was being read.`);
    }
    assertBoundOwnedDirectoryEntryUnchanged(bound, entry, label);
    return {
      frozen: {
        path: targetPath,
        label,
        dev: openedBefore.dev,
        ino: openedBefore.ino,
        size: openedBefore.size,
        mtimeNs: openedBefore.mtimeNs,
        mode: openedBefore.mode,
        sha256: sha256(bytes),
        requirePrivateMode: true,
      },
      bytes,
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function publishExactPrivateEvidenceFile(
  root: string,
  file: string,
  inputBytes: string | Buffer,
  hooks?: EvidencePublicationFaultHooks,
  preparedTransaction?: {
    readonly targetPath: string;
    readonly transaction: EvidencePublicationDirectoryTransaction;
  },
): FrozenEvidenceFile {
  assertFormalVisualDirectoryPlatformSupported();
  const targetPath = preparedTransaction?.targetPath ?? resolveEvidenceFile(root, file, file);
  const targetName = basename(targetPath);
  const bytes = Buffer.isBuffer(inputBytes) ? Buffer.from(inputBytes) : Buffer.from(inputBytes);
  assertPrivateEvidenceDirectory(dirname(targetPath), `${file} parent`);
  const transaction =
    preparedTransaction?.transaction ??
    beginEvidencePublicationDirectoryTransaction(targetPath, file);
  assertEvidencePublicationDirectoryTransaction(transaction, file);
  if (resolveEvidenceFile(root, file, file) !== targetPath) {
    throw new Error(`${file} publication target changed before exclusive publication.`);
  }
  let final: FrozenEvidenceFile | undefined;

  withBoundPublicationDirectory(transaction, targetPath, file, (bound) => {
    assertEvidencePublicationDirectoryTransaction(transaction, file);
    hooks?.beforeExclusiveLink?.();

    let descriptor: number | undefined;
    let owned: Pick<BigIntStats, "dev" | "ino"> | undefined;
    let entry: OwnedDirectoryEntryIdentity | undefined;
    const publish = () => {
      if (descriptor !== undefined) {
        throw new Error(`${file} exclusive publication callback was invoked more than once.`);
      }
      assertBoundPublicationDirectory(bound, file);
      try {
        descriptor = openBoundDirectoryEntry(
          bound,
          targetName,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            (fsConstants.O_NOFOLLOW ?? 0),
          PRIVATE_FILE_MODE,
          file,
        );
      } catch (cause) {
        throw new Error(
          `${file} already exists or cannot be created; exclusive evidence publication refused: ${targetPath}`,
          { cause },
        );
      }
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n) {
        throw new Error(`${file} exclusive publication created an unexpected file.`);
      }
      owned = { dev: opened.dev, ino: opened.ino };
      if (POSIX_MODES) fchmodSync(descriptor, PRIVATE_FILE_MODE);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    };

    try {
      if (hooks?.aroundExclusiveLink) hooks.aroundExclusiveLink(publish);
      else publish();
      if (descriptor === undefined || owned === undefined) {
        throw new Error(`${file} exclusive publication callback did not publish evidence.`);
      }
      assertBoundPublicationDirectory(bound, file);
      assertEvidencePublicationDirectoryTransaction(transaction, file);
      entry = freezeBoundOwnedDirectoryEntry(bound, targetName, owned, file);
      if (entry.nlink !== 1n) {
        throw new Error(`${file} final publication link count is not one.`);
      }
      hooks?.afterExclusiveLink?.();
      assertEvidencePublicationDirectoryTransaction(transaction, file);
      assertBoundOwnedDirectoryEntryUnchanged(bound, entry, file);

      fsyncSync(bound.descriptor);
      hooks?.afterParentDirectoryFsync?.(bound.parentPath);
      assertEvidencePublicationDirectoryTransaction(transaction, file);
      assertBoundOwnedDirectoryEntryUnchanged(bound, entry, file);

      fsyncSync(bound.descriptor);
      hooks?.afterParentDirectoryFsync?.(bound.parentPath);
      assertEvidencePublicationDirectoryTransaction(transaction, file);
      assertBoundOwnedDirectoryEntryUnchanged(bound, entry, file);

      const inspected = inspectBoundEvidenceFile(bound, entry, targetPath, file);
      if (
        inspected.frozen.dev !== owned.dev ||
        inspected.frozen.ino !== owned.ino ||
        inspected.frozen.size !== BigInt(bytes.byteLength) ||
        inspected.frozen.sha256 !== sha256(bytes)
      ) {
        throw new Error(`${file} changed while its evidence was being published.`);
      }
      final = { ...inspected.frozen, path: targetPath };
    } catch (cause) {
      if (owned !== undefined) {
        try {
          hooks?.beforeOwnedCleanupUnlink?.(targetPath);
        } catch {
          // The original publication failure remains authoritative.
        }
      }
      // There is no portable atomic "unlink only if inode is still X" operation in Node.
      // Failed publication entries are deliberately left in their private/quarantined location.
      throw cause;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  });

  assertEvidencePublicationDirectoryTransaction(transaction, file);
  if (!final) throw new Error(`${file} did not produce final evidence.`);
  assertFrozenEvidenceFile(final);
  return final;
}

export function publishPrivateEvidenceFile(
  root: string,
  file: string,
  bytes: string | Buffer,
  hooks?: EvidencePublicationFaultHooks,
): FrozenEvidenceFile {
  return publishExactPrivateEvidenceFile(root, file, bytes, hooks);
}

export function publishGeneratedPrivateEvidenceFile(
  root: string,
  file: string,
  produce: () => string | Buffer,
  hooks?: EvidencePublicationFaultHooks,
): FrozenEvidenceFile {
  const targetPath = resolveEvidenceFile(root, file, file);
  assertPrivateEvidenceDirectory(dirname(targetPath), `${file} parent`);
  const transaction = beginEvidencePublicationDirectoryTransaction(targetPath, file);
  assertEvidencePublicationDirectoryTransaction(transaction, file);
  const generated = produce();
  if (typeof generated !== "string" && !Buffer.isBuffer(generated)) {
    throw new Error(`${file} generator must return exact string or Buffer evidence bytes.`);
  }
  const bytes = Buffer.isBuffer(generated) ? Buffer.from(generated) : generated;
  assertEvidencePublicationDirectoryTransaction(transaction, file);
  return publishExactPrivateEvidenceFile(root, file, bytes, hooks, {
    targetPath,
    transaction,
  });
}

interface FrozenEvidenceDirectorySnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly evidenceSha256: string;
  readonly manifestSha256: string;
  readonly fileCount: number;
  readonly directoryCount: number;
}

interface EvidenceDirectoryPublicationReceipt {
  readonly schema: typeof DIRECTORY_PUBLICATION_RECEIPT_SCHEMA;
  readonly schemaVersion: typeof DIRECTORY_PUBLICATION_RECEIPT_SCHEMA_VERSION;
  readonly targetName: string;
  readonly targetDev: string;
  readonly targetIno: string;
  readonly manifest: {
    readonly file: typeof FORMAL_CAPTURE_MANIFEST_NAME;
    readonly sha256: string;
  };
  readonly evidence: {
    readonly algorithm: typeof DIRECTORY_PUBLICATION_DIGEST_ALGORITHM;
    readonly sha256: string;
    readonly fileCount: number;
    readonly directoryCount: number;
  };
}

interface EvidenceDirectoryPublicationJournal {
  readonly schema: typeof DIRECTORY_PUBLICATION_JOURNAL_SCHEMA;
  readonly schemaVersion: typeof DIRECTORY_PUBLICATION_JOURNAL_SCHEMA_VERSION;
  readonly targetName: string;
  readonly receiptName: string;
  readonly receiptSha256: string;
}

function publicationTargetDigest(targetName: string): string {
  return sha256(Buffer.from(targetName));
}

function publicationReceiptName(targetName: string): string {
  return `.moss-formal-publication-${publicationTargetDigest(targetName)}.json`;
}

function publicationPendingJournalName(targetName: string): string {
  return `.moss-formal-publication-${publicationTargetDigest(targetName)}.pending.json`;
}

function publicationCommittedJournalName(targetName: string): string {
  return `.moss-formal-publication-${publicationTargetDigest(targetName)}.committed.json`;
}

export function evidenceDirectoryPublicationReceiptPath(targetInput: string): string {
  const targetPath = resolve(targetInput);
  return join(dirname(targetPath), publicationReceiptName(basename(targetPath)));
}

export function evidenceDirectoryPublicationPendingJournalPath(targetInput: string): string {
  const targetPath = resolve(targetInput);
  return join(dirname(targetPath), publicationPendingJournalName(basename(targetPath)));
}

export function evidenceDirectoryPublicationCommittedJournalPath(targetInput: string): string {
  const targetPath = resolve(targetInput);
  return join(dirname(targetPath), publicationCommittedJournalName(basename(targetPath)));
}

function uniqueNativeEntryName(kind: string): string {
  return `.moss-formal-${kind}-${randomBytes(16).toString("hex")}`;
}

function sameStableDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertPrivateDirectoryMetadata(metadata: BigIntStats, label: string): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} contains a symbolic or non-directory tree entry.`);
  }
  if (POSIX_MODES && Number(metadata.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(`${label} directory tree entries must use private mode 0700.`);
  }
}

function freezeEvidenceDirectorySnapshot(
  rootDescriptor: number,
  label: string,
): FrozenEvidenceDirectorySnapshot {
  const openedBefore = fstatSync(rootDescriptor, { bigint: true });
  assertPrivateDirectoryMetadata(openedBefore, label);

  const records: Array<
    | { readonly kind: "directory"; readonly path: string; readonly mode: number }
    | {
        readonly kind: "file";
        readonly path: string;
        readonly mode: number;
        readonly bytes: string;
        readonly sha256: string;
      }
  > = [];
  let fileCount = 0;
  let directoryCount = 0;
  let manifestSha256: string | undefined;

  const walk = (directoryDescriptor: number, relativeDirectory: string): void => {
    const before = fstatSync(directoryDescriptor, { bigint: true });
    assertPrivateDirectoryMetadata(before, label);
    const recordPath = relativeDirectory || ".";
    records.push({
      kind: "directory",
      path: recordPath,
      mode: Number(before.mode & 0o777n),
    });
    directoryCount += 1;
    const namesBefore = readNativeDirectoryNames(directoryDescriptor, label).toSorted();
    for (const name of namesBefore) {
      const relativeEntry = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      let entryDescriptor: number | undefined;
      try {
        entryDescriptor = openNativeDirectoryEntry(
          directoryDescriptor,
          name,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
          0,
          `${label} ${relativeEntry}`,
        );
        const entryBefore = fstatSync(entryDescriptor, { bigint: true });
        if (entryBefore.isDirectory()) {
          walk(entryDescriptor, relativeEntry);
          const entryAfter = fstatSync(entryDescriptor, { bigint: true });
          if (!sameStableDirectory(entryBefore, entryAfter)) {
            throw new Error(`${label} directory entry ${relativeEntry} changed during digest.`);
          }
          continue;
        }
        if (!entryBefore.isFile() || entryBefore.isSymbolicLink()) {
          throw new Error(
            `${label} publication digest rejects non-regular entry ${relativeEntry}.`,
          );
        }
        if (entryBefore.nlink !== 1n) {
          throw new Error(`${label} publication digest rejects hardlinked entry ${relativeEntry}.`);
        }
        assertPrivateFileMode(entryBefore.mode, `${label} ${relativeEntry}`);
        const bytes = readFileSync(entryDescriptor);
        const entryAfter = fstatSync(entryDescriptor, { bigint: true });
        if (!sameOpenedFile(entryBefore, entryAfter)) {
          throw new Error(`${label} file entry ${relativeEntry} changed during digest.`);
        }
        const entrySha256 = sha256(bytes);
        records.push({
          kind: "file",
          path: relativeEntry,
          mode: Number(entryAfter.mode & 0o777n),
          bytes: entryAfter.size.toString(),
          sha256: entrySha256,
        });
        fileCount += 1;
        if (relativeEntry === FORMAL_CAPTURE_MANIFEST_NAME) {
          manifestSha256 = entrySha256;
        }
      } finally {
        if (entryDescriptor !== undefined) closeSync(entryDescriptor);
      }
    }
    const namesAfter = readNativeDirectoryNames(directoryDescriptor, label).toSorted();
    const after = fstatSync(directoryDescriptor, { bigint: true });
    if (
      namesAfter.length !== namesBefore.length ||
      namesAfter.some((name, index) => name !== namesBefore[index]) ||
      !sameStableDirectory(before, after)
    ) {
      throw new Error(`${label} directory tree changed while its publication digest was computed.`);
    }
  };

  walk(rootDescriptor, "");
  const openedAfter = fstatSync(rootDescriptor, { bigint: true });
  if (!sameStableDirectory(openedBefore, openedAfter)) {
    throw new Error(`${label} root changed while its publication digest was computed.`);
  }
  if (!manifestSha256) {
    throw new Error(`${label} must contain ${FORMAL_CAPTURE_MANIFEST_NAME} before publication.`);
  }
  return {
    dev: openedAfter.dev,
    ino: openedAfter.ino,
    evidenceSha256: sha256(Buffer.from(JSON.stringify(records))),
    manifestSha256,
    fileCount,
    directoryCount,
  };
}

function sameEvidenceDirectorySnapshot(
  left: FrozenEvidenceDirectorySnapshot,
  right: FrozenEvidenceDirectorySnapshot,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.evidenceSha256 === right.evidenceSha256 &&
    left.manifestSha256 === right.manifestSha256 &&
    left.fileCount === right.fileCount &&
    left.directoryCount === right.directoryCount
  );
}

function publicationReceiptBytes(
  targetName: string,
  snapshot: FrozenEvidenceDirectorySnapshot,
): Buffer {
  const receipt: EvidenceDirectoryPublicationReceipt = {
    schema: DIRECTORY_PUBLICATION_RECEIPT_SCHEMA,
    schemaVersion: DIRECTORY_PUBLICATION_RECEIPT_SCHEMA_VERSION,
    targetName,
    targetDev: snapshot.dev.toString(),
    targetIno: snapshot.ino.toString(),
    manifest: {
      file: FORMAL_CAPTURE_MANIFEST_NAME,
      sha256: snapshot.manifestSha256,
    },
    evidence: {
      algorithm: DIRECTORY_PUBLICATION_DIGEST_ALGORITHM,
      sha256: snapshot.evidenceSha256,
      fileCount: snapshot.fileCount,
      directoryCount: snapshot.directoryCount,
    },
  };
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

function publicationJournalBytes(
  targetName: string,
  receiptName: string,
  receiptBytes: Buffer,
): Buffer {
  const journal: EvidenceDirectoryPublicationJournal = {
    schema: DIRECTORY_PUBLICATION_JOURNAL_SCHEMA,
    schemaVersion: DIRECTORY_PUBLICATION_JOURNAL_SCHEMA_VERSION,
    targetName,
    receiptName,
    receiptSha256: sha256(receiptBytes),
  };
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
}

function exactReceiptKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an invalid schema.`);
  }
}

function parsePublicationReceipt(
  bytes: Buffer,
  label: string,
): EvidenceDirectoryPublicationReceipt {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error(`${label} is not valid JSON.`, { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} has an invalid schema.`);
  }
  const receipt = value as Record<string, unknown>;
  exactReceiptKeys(
    receipt,
    ["schema", "schemaVersion", "targetName", "targetDev", "targetIno", "manifest", "evidence"],
    label,
  );
  if (
    receipt.schema !== DIRECTORY_PUBLICATION_RECEIPT_SCHEMA ||
    receipt.schemaVersion !== DIRECTORY_PUBLICATION_RECEIPT_SCHEMA_VERSION ||
    typeof receipt.targetName !== "string" ||
    typeof receipt.targetDev !== "string" ||
    !/^\d+$/u.test(receipt.targetDev) ||
    typeof receipt.targetIno !== "string" ||
    !/^\d+$/u.test(receipt.targetIno)
  ) {
    throw new Error(`${label} has an invalid schema or target identity binding.`);
  }
  if (receipt.manifest === null || typeof receipt.manifest !== "object") {
    throw new Error(`${label} has an invalid manifest binding.`);
  }
  if (receipt.evidence === null || typeof receipt.evidence !== "object") {
    throw new Error(`${label} has an invalid evidence binding.`);
  }
  const manifest = receipt.manifest as Record<string, unknown>;
  const evidence = receipt.evidence as Record<string, unknown>;
  exactReceiptKeys(manifest, ["file", "sha256"], `${label} manifest`);
  exactReceiptKeys(
    evidence,
    ["algorithm", "sha256", "fileCount", "directoryCount"],
    `${label} evidence`,
  );
  if (
    manifest.file !== FORMAL_CAPTURE_MANIFEST_NAME ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.sha256) ||
    evidence.algorithm !== DIRECTORY_PUBLICATION_DIGEST_ALGORITHM ||
    typeof evidence.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(evidence.sha256) ||
    !Number.isSafeInteger(evidence.fileCount) ||
    (evidence.fileCount as number) < 1 ||
    !Number.isSafeInteger(evidence.directoryCount) ||
    (evidence.directoryCount as number) < 1
  ) {
    throw new Error(`${label} has an invalid manifest or evidence digest binding.`);
  }
  return receipt as unknown as EvidenceDirectoryPublicationReceipt;
}

function parsePublicationJournal(
  bytes: Buffer,
  label: string,
): EvidenceDirectoryPublicationJournal {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error(`${label} is not valid JSON.`, { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} has an invalid schema.`);
  }
  const journal = value as Record<string, unknown>;
  exactReceiptKeys(
    journal,
    ["schema", "schemaVersion", "targetName", "receiptName", "receiptSha256"],
    label,
  );
  if (
    journal.schema !== DIRECTORY_PUBLICATION_JOURNAL_SCHEMA ||
    journal.schemaVersion !== DIRECTORY_PUBLICATION_JOURNAL_SCHEMA_VERSION ||
    typeof journal.targetName !== "string" ||
    typeof journal.receiptName !== "string" ||
    typeof journal.receiptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(journal.receiptSha256)
  ) {
    throw new Error(`${label} has an invalid schema or receipt binding.`);
  }
  return journal as unknown as EvidenceDirectoryPublicationJournal;
}

function readBoundPrivateFile(
  bound: BoundPublicationDirectory,
  entryName: string,
  label: string,
): { readonly descriptor: number; readonly bytes: Buffer; readonly metadata: BigIntStats } {
  const descriptor = openBoundDirectoryEntry(
    bound,
    entryName,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    0,
    label,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new Error(`${label} must be one privately owned regular file.`);
    }
    assertPrivateFileMode(before.mode, label);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameOpenedFile(before, after)) throw new Error(`${label} changed while it was read.`);
    return { descriptor, bytes, metadata: after };
  } catch (cause) {
    closeSync(descriptor);
    throw cause;
  }
}

/**
 * Consumer gate for a canonical formal evidence directory. Directory presence alone is never
 * sufficient: a pending journal always rejects, while a committed journal must bind the adjacent
 * receipt and that receipt must bind the reopened inode, manifest, and complete tree.
 */
export function assertPublishedPrivateEvidenceDirectory(
  targetInput: string,
  label = "Formal evidence publication",
): string {
  assertFormalVisualDirectoryPlatformSupported();
  const targetPath = resolve(targetInput);
  const targetName = basename(targetPath);
  const receiptName = publicationReceiptName(targetName);
  const pendingJournalName = publicationPendingJournalName(targetName);
  const committedJournalName = publicationCommittedJournalName(targetName);
  const transaction = beginEvidencePublicationDirectoryTransaction(targetPath, label);
  let accepted = false;
  withBoundPublicationDirectory(transaction, targetPath, label, (bound) => {
    const parentBefore = fstatSync(bound.descriptor, { bigint: true });
    let targetDescriptor: number | undefined;
    let receiptDescriptor: number | undefined;
    let journalDescriptor: number | undefined;
    try {
      const journalNamesBefore = new Set(
        readNativeDirectoryNames(bound.descriptor, `${label} publication journal`),
      );
      if (journalNamesBefore.has(pendingJournalName)) {
        throw new Error(
          `${label} pending transaction journal blocks the publication receipt until recovery or explicit quarantine.`,
        );
      }
      if (!journalNamesBefore.has(committedJournalName)) {
        throw new Error(
          `${label} committed publication journal is unavailable; the publication receipt is not eligible.`,
        );
      }
      let journalRead: ReturnType<typeof readBoundPrivateFile>;
      try {
        journalRead = readBoundPrivateFile(
          bound,
          committedJournalName,
          `${label} committed publication journal`,
        );
      } catch (cause) {
        throw new Error(
          `${label} committed publication journal is unavailable or invalid; the publication receipt is not eligible.`,
          { cause },
        );
      }
      journalDescriptor = journalRead.descriptor;
      const journal = parsePublicationJournal(
        journalRead.bytes,
        `${label} committed publication journal`,
      );
      try {
        targetDescriptor = openBoundDirectoryEntry(
          bound,
          targetName,
          fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
          0,
          label,
        );
      } catch (cause) {
        throw new Error(
          `${label} canonical target is unavailable and has no acceptable publication receipt.`,
          { cause },
        );
      }
      const targetMetadata = fstatSync(targetDescriptor, { bigint: true });
      assertPrivateDirectoryMetadata(targetMetadata, label);
      let receiptRead: ReturnType<typeof readBoundPrivateFile>;
      try {
        receiptRead = readBoundPrivateFile(bound, receiptName, `${label} publication receipt`);
      } catch (cause) {
        throw new Error(`${label} publication receipt is unavailable or invalid.`, { cause });
      }
      receiptDescriptor = receiptRead.descriptor;
      const receipt = parsePublicationReceipt(receiptRead.bytes, `${label} publication receipt`);
      if (
        journal.targetName !== targetName ||
        journal.receiptName !== receiptName ||
        journal.receiptSha256 !== sha256(receiptRead.bytes)
      ) {
        throw new Error(
          `${label} committed publication journal does not bind the canonical publication receipt.`,
        );
      }
      const snapshot = freezeEvidenceDirectorySnapshot(targetDescriptor, label);
      if (
        receipt.targetName !== targetName ||
        receipt.targetDev !== snapshot.dev.toString() ||
        receipt.targetIno !== snapshot.ino.toString() ||
        receipt.manifest.sha256 !== snapshot.manifestSha256 ||
        receipt.evidence.sha256 !== snapshot.evidenceSha256 ||
        receipt.evidence.fileCount !== snapshot.fileCount ||
        receipt.evidence.directoryCount !== snapshot.directoryCount
      ) {
        throw new Error(`${label} publication receipt does not match the reopened evidence tree.`);
      }
      const targetAfter = fstatSync(targetDescriptor, { bigint: true });
      const namedTarget = statBoundDirectoryEntry(
        bound,
        targetName,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
        label,
      );
      if (
        !sameStableDirectory(targetMetadata, targetAfter) ||
        !sameStableDirectory(targetAfter, namedTarget)
      ) {
        throw new Error(`${label} canonical target changed during receipt validation.`);
      }
      const receiptAfter = fstatSync(receiptDescriptor, { bigint: true });
      const namedReceipt = statBoundDirectoryEntry(
        bound,
        receiptName,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        `${label} publication receipt`,
      );
      if (
        !sameOpenedFile(receiptRead.metadata, receiptAfter) ||
        !sameOpenedFile(receiptAfter, namedReceipt)
      ) {
        throw new Error(`${label} publication receipt changed during target validation.`);
      }
      const journalAfter = fstatSync(journalDescriptor, { bigint: true });
      const namedJournal = statBoundDirectoryEntry(
        bound,
        committedJournalName,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        `${label} committed publication journal`,
      );
      if (
        !sameOpenedFile(journalRead.metadata, journalAfter) ||
        !sameOpenedFile(journalAfter, namedJournal)
      ) {
        throw new Error(`${label} committed publication journal changed during validation.`);
      }
      const journalNamesAfter = new Set(
        readNativeDirectoryNames(bound.descriptor, `${label} publication journal`),
      );
      if (
        journalNamesAfter.has(pendingJournalName) ||
        !journalNamesAfter.has(committedJournalName)
      ) {
        throw new Error(`${label} publication journal state changed during receipt validation.`);
      }
      assertEvidencePublicationDirectoryTransaction(transaction, label);
      assertBoundPublicationDirectory(bound, label);
      const parentAfter = fstatSync(bound.descriptor, { bigint: true });
      if (!sameStableDirectory(parentBefore, parentAfter)) {
        throw new Error(`${label} parent directory changed during receipt validation.`);
      }
      accepted = true;
    } finally {
      if (journalDescriptor !== undefined) closeSync(journalDescriptor);
      if (receiptDescriptor !== undefined) closeSync(receiptDescriptor);
      if (targetDescriptor !== undefined) closeSync(targetDescriptor);
    }
  });
  if (!accepted) throw new Error(`${label} publication receipt was not accepted.`);
  return targetPath;
}

/**
 * Atomically exposes a fully validated private staging directory. A durable pending journal exists
 * before the canonical target can appear and is promoted only after target and receipt durability.
 *
 * Platform contract: formal publication supports macOS (`renameatx_np`) and Linux
 * (`renameat2`). Other platforms fail closed before mutation.
 */
export function publishPrivateEvidenceDirectory(
  stagingInput: string,
  targetInput: string,
  hooks?: EvidenceDirectoryPublicationFaultHooks,
): string {
  if (hooks?.platformForTest !== undefined) {
    assertFormalVisualDirectoryPlatformSupported(hooks.platformForTest);
  }
  assertFormalVisualDirectoryPlatformSupported();
  const stagingPath = assertPrivateEvidenceDirectory(stagingInput, "Evidence staging");
  const targetPath = resolve(targetInput);
  const parentPath = dirname(targetPath);
  if (dirname(stagingPath) !== parentPath) {
    throw new Error("Evidence staging and canonical output must share one verified parent.");
  }
  inspectDirectoryIdentity(parentPath, "Evidence publication parent");
  const stagingName = basename(stagingPath);
  const targetName = basename(targetPath);
  const stagingIdentity = inspectDirectoryIdentity(stagingPath, "Evidence staging");
  const receiptPath = evidenceDirectoryPublicationReceiptPath(targetPath);
  const receiptName = basename(receiptPath);
  const pendingJournalPath = evidenceDirectoryPublicationPendingJournalPath(targetPath);
  const pendingJournalName = basename(pendingJournalPath);
  const committedJournalPath = evidenceDirectoryPublicationCommittedJournalPath(targetPath);
  const committedJournalName = basename(committedJournalPath);
  const transaction = beginEvidencePublicationDirectoryTransaction(targetPath, "Evidence run");
  assertEvidencePublicationDirectoryTransaction(transaction, "Evidence run");

  withBoundPublicationDirectory(transaction, targetPath, "Evidence run", (bound) => {
    let stagingDescriptor: number | undefined;
    let receiptDescriptor: number | undefined;
    let journalDescriptor: number | undefined;
    try {
      try {
        lstatSync(targetPath);
        const markerState = (() => {
          try {
            lstatSync(receiptPath);
            return "with an existing publication receipt";
          } catch {
            return "without a publication receipt";
          }
        })();
        throw new Error(
          `Evidence canonical output already exists ${markerState}; stale output must be explicitly quarantined and is never overwritten: ${targetPath}`,
        );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      try {
        lstatSync(receiptPath);
        throw new Error(
          `Evidence publication receipt already exists without a canonical target; explicit quarantine is required: ${receiptPath}`,
        );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      for (const [journalPath, state] of [
        [pendingJournalPath, "pending"],
        [committedJournalPath, "committed"],
      ] as const) {
        try {
          lstatSync(journalPath);
          throw new Error(
            `Evidence publication ${state} journal already exists; explicit quarantine is required: ${journalPath}`,
          );
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }
      assertEvidencePublicationDirectoryTransaction(transaction, "Evidence run");
      assertBoundPublicationDirectory(bound, "Evidence run");
      stagingDescriptor = openBoundDirectoryEntry(
        bound,
        stagingName,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
        0,
        "Evidence staging",
      );
      const openedStaging = fstatSync(stagingDescriptor, { bigint: true });
      if (!openedStaging.isDirectory() || !sameDirectoryIdentity(openedStaging, stagingIdentity)) {
        throw new Error("Evidence staging directory changed before atomic exposure.");
      }
      const stagedSnapshot = freezeEvidenceDirectorySnapshot(stagingDescriptor, "Evidence staging");
      const receiptBytes = publicationReceiptBytes(targetName, stagedSnapshot);
      const journalBytes = publicationJournalBytes(targetName, receiptName, receiptBytes);
      assertEvidencePublicationDirectoryTransaction(transaction, "Evidence run");
      fsyncSync(stagingDescriptor);
      fsyncSync(bound.descriptor);
      assertEvidencePublicationDirectoryTransaction(transaction, "Evidence run");
      const pendingJournal = publishPrivateEvidenceFile(
        bound.parentPath,
        pendingJournalName,
        journalBytes,
      );
      journalDescriptor = openBoundDirectoryEntry(
        bound,
        pendingJournalName,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        0,
        "Evidence pending publication journal",
      );
      const openedPendingJournal = fstatSync(journalDescriptor, { bigint: true });
      if (
        !openedPendingJournal.isFile() ||
        openedPendingJournal.dev !== pendingJournal.dev ||
        openedPendingJournal.ino !== pendingJournal.ino ||
        openedPendingJournal.nlink !== 1n
      ) {
        throw new Error("Evidence pending publication journal changed before target exposure.");
      }
      fsyncSync(bound.descriptor);
      const durablePendingJournal = statBoundDirectoryEntry(
        bound,
        pendingJournalName,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        "Evidence pending publication journal",
      );
      if (!sameOpenedFile(openedPendingJournal, durablePendingJournal)) {
        throw new Error("Evidence pending publication journal changed before target exposure.");
      }
      hooks?.afterPublicationPendingJournalParentFsync?.(pendingJournalPath);
      assertEvidencePublicationDirectoryTransaction(transaction, "Evidence run");
      const rejectedName = uniqueNativeEntryName("rejected-directory");
      // The callback executes inside the native addon after fstat/fstatat identity equality has
      // succeeded and immediately before renameat*. A mismatched post-rename identity is moved from
      // the canonical name to this unique no-replace quarantine before native control returns.
      renameNativeDirectoryEntryExclusiveVerified(
        bound.descriptor,
        stagingDescriptor,
        stagingName,
        targetName,
        rejectedName,
        "Evidence run",
        hooks?.afterNativeSourcePrecheck
          ? () =>
              hooks.afterNativeSourcePrecheck?.({
                rejectedPath: join(bound.parentPath, rejectedName),
              })
          : undefined,
      );
      hooks?.afterVerifiedRename?.(targetPath);
      const committedSnapshot = freezeEvidenceDirectorySnapshot(
        stagingDescriptor,
        "Evidence canonical output",
      );
      if (!sameEvidenceDirectorySnapshot(stagedSnapshot, committedSnapshot)) {
        const quarantineName = uniqueNativeEntryName("changed-directory");
        try {
          renameNativeDirectoryEntryExclusiveVerified(
            bound.descriptor,
            stagingDescriptor,
            targetName,
            quarantineName,
            uniqueNativeEntryName("changed-directory-rejected"),
            "Evidence changed canonical output",
          );
        } catch (quarantineCause) {
          throw new Error(
            "Evidence directory content changed and its canonical entry could not be quarantined; no publication receipt was committed.",
            { cause: quarantineCause },
          );
        }
        throw new Error(
          `Evidence directory content changed across atomic exposure and was quarantined at ${join(bound.parentPath, quarantineName)}.`,
        );
      }

      // This is the durability boundary for the canonical directory rename. Until it succeeds no
      // receipt exists, so consumers reject the live target even though the rename already committed.
      try {
        hooks?.injectPostRenameParentFsyncFailure?.();
        fsyncSync(bound.descriptor);
      } catch (cause) {
        throw new EvidenceDirectoryPublicationDurabilityError(targetPath, receiptPath, cause);
      }
      hooks?.afterPostRenameParentFsync?.(bound.parentPath);

      const durableOpenedTarget = fstatSync(stagingDescriptor, { bigint: true });
      const durableNamedTarget = statBoundDirectoryEntry(
        bound,
        targetName,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
        "Evidence durable canonical output",
      );
      if (
        durableOpenedTarget.dev !== committedSnapshot.dev ||
        durableOpenedTarget.ino !== committedSnapshot.ino ||
        !sameStableDirectory(durableOpenedTarget, durableNamedTarget)
      ) {
        throw new Error(
          "Evidence canonical target changed after its durable rename; no publication receipt was committed.",
        );
      }

      const receiptTemporaryName = uniqueNativeEntryName("publication-receipt");
      let receiptTemporary: FrozenEvidenceFile;
      try {
        receiptTemporary = publishPrivateEvidenceFile(
          bound.parentPath,
          receiptTemporaryName,
          receiptBytes,
        );
        receiptDescriptor = openBoundDirectoryEntry(
          bound,
          receiptTemporaryName,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
          0,
          "Evidence publication receipt",
        );
        const openedReceipt = fstatSync(receiptDescriptor, { bigint: true });
        if (
          !openedReceipt.isFile() ||
          openedReceipt.dev !== receiptTemporary.dev ||
          openedReceipt.ino !== receiptTemporary.ino ||
          openedReceipt.nlink !== 1n
        ) {
          throw new Error("Evidence publication receipt changed before exclusive commit.");
        }
        renameNativeDirectoryEntryExclusiveVerified(
          bound.descriptor,
          receiptDescriptor,
          receiptTemporaryName,
          receiptName,
          uniqueNativeEntryName("rejected-publication-receipt"),
          "Evidence publication receipt",
        );
      } catch (cause) {
        const quarantineName = uniqueNativeEntryName("receipt-failed-directory");
        try {
          renameNativeDirectoryEntryExclusiveVerified(
            bound.descriptor,
            stagingDescriptor,
            targetName,
            quarantineName,
            uniqueNativeEntryName("receipt-failed-directory-rejected"),
            "Evidence receipt-failed canonical output",
          );
        } catch (quarantineCause) {
          throw new EvidenceDirectoryPublicationRecoveryError(
            targetPath,
            receiptPath,
            new AggregateError(
              [cause, quarantineCause],
              "Receipt publication and canonical-target compensation both failed.",
            ),
          );
        }
        try {
          fsyncSync(bound.descriptor);
        } catch (cleanupFsyncCause) {
          throw new EvidenceDirectoryPublicationDurabilityError(
            targetPath,
            receiptPath,
            new AggregateError(
              [cause, cleanupFsyncCause],
              "Receipt failure target quarantine could not be confirmed durable.",
            ),
          );
        }
        throw new Error(
          `Evidence publication receipt failed; the canonical directory was quarantined at ${join(bound.parentPath, quarantineName)}.`,
          { cause },
        );
      }
      const receiptFailureQuarantineName = uniqueNativeEntryName("durability-unconfirmed-receipt");
      const receiptFailureRejectedName = uniqueNativeEntryName(
        "durability-unconfirmed-receipt-rejected",
      );
      try {
        hooks?.afterReceiptVerifiedRename?.(receiptPath);
        hooks?.injectPostReceiptParentFsyncFailure?.({
          receiptPath,
          receiptQuarantinePath: join(bound.parentPath, receiptFailureQuarantineName),
        });
        fsyncSync(bound.descriptor);
      } catch (receiptFsyncCause) {
        const failures: unknown[] = [receiptFsyncCause];
        if (receiptDescriptor === undefined || stagingDescriptor === undefined) {
          throw new EvidenceDirectoryPublicationRecoveryError(
            targetPath,
            receiptPath,
            new AggregateError(
              failures,
              "Committed publication descriptors were unavailable for fail-closed compensation.",
            ),
          );
        }
        const committedReceiptDescriptor = receiptDescriptor;
        const committedTargetDescriptor = stagingDescriptor;
        let cleanupMethod: "receipt-quarantine" | "target-quarantine" | undefined;
        let cleanupReceiptQuarantineName = receiptFailureQuarantineName;
        let cleanupTargetQuarantineName = uniqueNativeEntryName("durability-unconfirmed-directory");

        const reportCleanup = (): void => {
          if (cleanupMethod === undefined) return;
          hooks?.afterReceiptFailureCleanup?.({
            method: cleanupMethod,
            receiptPath,
            receiptQuarantinePath: join(bound.parentPath, cleanupReceiptQuarantineName),
            targetPath,
            targetQuarantinePath: join(bound.parentPath, cleanupTargetQuarantineName),
          });
        };

        const quarantineReceipt = (allowFaultHook: boolean): void => {
          const rejectedName =
            allowFaultHook === true
              ? receiptFailureRejectedName
              : uniqueNativeEntryName("durability-unconfirmed-receipt-rejected");
          renameNativeDirectoryEntryExclusiveVerified(
            bound.descriptor,
            committedReceiptDescriptor,
            receiptName,
            cleanupReceiptQuarantineName,
            rejectedName,
            "Evidence durability-unconfirmed publication receipt",
            allowFaultHook && hooks?.afterNativeReceiptFailureQuarantinePrecheck
              ? () =>
                  hooks.afterNativeReceiptFailureQuarantinePrecheck?.({
                    receiptPath,
                    receiptQuarantinePath: join(bound.parentPath, cleanupReceiptQuarantineName),
                    rejectedPath: join(bound.parentPath, rejectedName),
                  })
              : undefined,
          );
          cleanupMethod = "receipt-quarantine";
          reportCleanup();
        };

        const quarantineTarget = (): void => {
          const rejectedName = uniqueNativeEntryName("durability-unconfirmed-directory-rejected");
          renameNativeDirectoryEntryExclusiveVerified(
            bound.descriptor,
            committedTargetDescriptor,
            targetName,
            cleanupTargetQuarantineName,
            rejectedName,
            "Evidence durability-unconfirmed canonical directory",
            hooks?.afterNativeTargetFailureQuarantinePrecheck
              ? () =>
                  hooks.afterNativeTargetFailureQuarantinePrecheck?.({
                    targetPath,
                    targetQuarantinePath: join(bound.parentPath, cleanupTargetQuarantineName),
                    rejectedPath: join(bound.parentPath, rejectedName),
                  })
              : undefined,
          );
          cleanupMethod = "target-quarantine";
          reportCleanup();
        };

        try {
          quarantineReceipt(true);
        } catch (receiptQuarantineCause) {
          failures.push(receiptQuarantineCause);
          try {
            quarantineTarget();
          } catch (targetQuarantineCause) {
            failures.push(targetQuarantineCause);
            throw new EvidenceDirectoryPublicationRecoveryError(
              targetPath,
              receiptPath,
              new AggregateError(
                failures,
                "Neither canonical side could be quarantined after receipt fsync failure.",
              ),
            );
          }
        }

        try {
          hooks?.injectReceiptFailureCleanupParentFsyncFailure?.();
          fsyncSync(bound.descriptor);
          hooks?.afterReceiptFailureCleanupParentFsync?.(bound.parentPath);
        } catch (firstCleanupFsyncCause) {
          failures.push(firstCleanupFsyncCause);
          try {
            if (cleanupMethod === "receipt-quarantine") {
              cleanupTargetQuarantineName = uniqueNativeEntryName(
                "durability-unconfirmed-directory",
              );
              quarantineTarget();
            } else {
              cleanupReceiptQuarantineName = uniqueNativeEntryName(
                "durability-unconfirmed-receipt",
              );
              quarantineReceipt(false);
            }
          } catch (secondaryCleanupCause) {
            failures.push(secondaryCleanupCause);
          }
          try {
            hooks?.injectSecondReceiptFailureCleanupParentFsyncFailure?.();
            fsyncSync(bound.descriptor);
            hooks?.afterReceiptFailureCleanupParentFsync?.(bound.parentPath);
          } catch (secondaryCleanupFsyncCause) {
            failures.push(secondaryCleanupFsyncCause);
          }
        }

        let canonicalPairPresent: boolean;
        try {
          const names = new Set(
            readNativeDirectoryNames(
              bound.descriptor,
              "Evidence failed-publication canonical-pair verification",
            ),
          );
          canonicalPairPresent = names.has(targetName) && names.has(receiptName);
        } catch (verificationCause) {
          failures.push(verificationCause);
          throw new EvidenceDirectoryPublicationRecoveryError(
            targetPath,
            receiptPath,
            new AggregateError(
              failures,
              "Unable to verify that receipt-failure compensation removed a canonical side.",
            ),
          );
        }
        if (canonicalPairPresent) {
          throw new EvidenceDirectoryPublicationRecoveryError(
            targetPath,
            receiptPath,
            new AggregateError(
              failures,
              "Receipt-failure compensation left both canonical names present.",
            ),
          );
        }
        throw new EvidenceDirectoryPublicationDurabilityError(
          targetPath,
          receiptPath,
          failures.length === 1
            ? receiptFsyncCause
            : new AggregateError(
                failures,
                "Receipt publication or fail-closed compensation durability failed.",
              ),
        );
      }

      if (journalDescriptor === undefined) {
        throw new EvidenceDirectoryPublicationRecoveryError(
          targetPath,
          receiptPath,
          new Error("Durable pending publication journal descriptor is unavailable."),
        );
      }
      const promotionParentBefore = fstatSync(bound.descriptor, { bigint: true });
      const promotionNames = new Set(
        readNativeDirectoryNames(bound.descriptor, "Evidence publication journal promotion"),
      );
      if (
        !promotionNames.has(targetName) ||
        !promotionNames.has(receiptName) ||
        !promotionNames.has(pendingJournalName) ||
        promotionNames.has(committedJournalName)
      ) {
        throw new EvidenceDirectoryPublicationRecoveryError(
          targetPath,
          receiptPath,
          new Error("Canonical publication names changed before journal promotion."),
        );
      }
      const promotionTargetSnapshot = freezeEvidenceDirectorySnapshot(
        stagingDescriptor,
        "Evidence journal-promotion canonical output",
      );
      const promotionOpenedTarget = fstatSync(stagingDescriptor, { bigint: true });
      const promotionNamedTarget = statBoundDirectoryEntry(
        bound,
        targetName,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
        "Evidence journal-promotion canonical output",
      );
      const promotionReceiptBefore = fstatSync(receiptDescriptor, { bigint: true });
      const promotionReceiptBytes = readFileSync(receiptDescriptor);
      const promotionReceiptAfter = fstatSync(receiptDescriptor, { bigint: true });
      const promotionNamedReceipt = statBoundDirectoryEntry(
        bound,
        receiptName,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        "Evidence journal-promotion publication receipt",
      );
      const promotionJournalBefore = fstatSync(journalDescriptor, { bigint: true });
      const promotionJournalBytes = readFileSync(journalDescriptor);
      const promotionJournalAfter = fstatSync(journalDescriptor, { bigint: true });
      const promotionNamedJournal = statBoundDirectoryEntry(
        bound,
        pendingJournalName,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        "Evidence pending publication journal",
      );
      const promotionParentAfter = fstatSync(bound.descriptor, { bigint: true });
      if (
        !sameEvidenceDirectorySnapshot(committedSnapshot, promotionTargetSnapshot) ||
        !sameStableDirectory(promotionOpenedTarget, promotionNamedTarget) ||
        !sameOpenedFile(promotionReceiptBefore, promotionReceiptAfter) ||
        !sameOpenedFile(promotionReceiptAfter, promotionNamedReceipt) ||
        !promotionReceiptBytes.equals(receiptBytes) ||
        !sameOpenedFile(promotionJournalBefore, promotionJournalAfter) ||
        !sameOpenedFile(promotionJournalAfter, promotionNamedJournal) ||
        !promotionJournalBytes.equals(journalBytes) ||
        !sameStableDirectory(promotionParentBefore, promotionParentAfter)
      ) {
        throw new EvidenceDirectoryPublicationRecoveryError(
          targetPath,
          receiptPath,
          new Error("Publication binding changed before committed journal promotion."),
        );
      }
      try {
        // The pending name was made durable before target exposure. Moving that same verified inode
        // is the only operation that can make consumers eligible, and it occurs only after the
        // target and receipt directory entries have each crossed their parent-fsync boundary.
        renameNativeDirectoryEntryExclusiveVerified(
          bound.descriptor,
          journalDescriptor,
          pendingJournalName,
          committedJournalName,
          uniqueNativeEntryName("rejected-publication-journal"),
          "Evidence publication journal commit",
        );
      } catch (cause) {
        throw new EvidenceDirectoryPublicationRecoveryError(targetPath, receiptPath, cause);
      }
      const openedCommittedJournal = fstatSync(journalDescriptor, { bigint: true });
      const namedCommittedJournal = statBoundDirectoryEntry(
        bound,
        committedJournalName,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        "Evidence committed publication journal",
      );
      if (!sameOpenedFile(openedCommittedJournal, namedCommittedJournal)) {
        throw new EvidenceDirectoryPublicationRecoveryError(
          targetPath,
          receiptPath,
          new Error("Committed publication journal name does not bind the verified journal inode."),
        );
      }
      try {
        hooks?.injectPostCommittedJournalParentFsyncFailure?.({
          pendingJournalPath,
          committedJournalPath,
        });
        fsyncSync(bound.descriptor);
      } catch (cause) {
        throw new Error(
          `Evidence target and receipt are durable, but committed publication journal durability is unconfirmed and recovery may reject ${targetPath}.`,
          { cause },
        );
      }
    } finally {
      if (journalDescriptor !== undefined) {
        try {
          closeSync(journalDescriptor);
        } catch {
          // Preserve the authoritative publication result.
        }
      }
      if (receiptDescriptor !== undefined) {
        try {
          closeSync(receiptDescriptor);
        } catch {
          // Preserve the authoritative publication result.
        }
      }
      if (stagingDescriptor !== undefined) {
        try {
          closeSync(stagingDescriptor);
        } catch {
          // Preserve the authoritative pre-commit failure.
        }
      }
    }
  });
  assertPublishedPrivateEvidenceDirectory(targetPath, "Evidence run");
  return targetPath;
}
