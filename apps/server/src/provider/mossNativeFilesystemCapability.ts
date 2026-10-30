import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { lstat, realpath } from "node:fs/promises";
import * as nodePath from "node:path";

import type {
  MossFilesystemCapability,
  MossFilesystemCapabilityInput,
  MossFilesystemCapabilityResult,
  MossFilesystemIdentity,
  MossOwnershipStore,
  MossPrivateStage,
} from "@synara/contracts";

import { MossResourceImportError } from "./mossResourceImport.ts";
import {
  appendMossCanonicalRecoveryJournal,
  inspectMossCanonicalTarget,
  makeMossCanonicalRecoveryJournal,
  MOSS_MISSING_HASH,
  recoverMossCanonicalResourceMutation,
  recoveryBindingForFilesystemInput,
} from "./mossCanonicalResourceRecovery.ts";
import {
  makeMossCanonicalFilesystemHelper,
  MossCanonicalFilesystemHelperError,
  type MossCanonicalFilesystemHelper,
} from "./mossCanonicalFilesystemHelper.ts";
import { hashMossCanonicalResource } from "./mossCanonicalResourceHash.ts";

const MISSING_HASH = MOSS_MISSING_HASH;
const DEFAULT_MAX_STAGE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_STAGE_ENTRIES = 10_000;

export type MossNativeFilesystemStagePayload =
  | {
      readonly kind: "file";
      readonly content: Uint8Array;
    }
  | {
      readonly kind: "directory";
      readonly entries: ReadonlyArray<{
        readonly relativePath: string;
        readonly kind: "file" | "directory";
        readonly content?: Uint8Array;
      }>;
    };

export interface MossNativeFilesystemCapabilityOptions {
  /** The one canonical MossOwnershipStore; no fallback store is created here. */
  readonly ownershipStore: MossOwnershipStore;
  /** Reads an immutable private stage without exposing a filesystem path to callers. */
  readonly readStage: (stage: MossPrivateStage) => Promise<MossNativeFilesystemStagePayload>;
  /** Test/fault-injection seam; production leaves this unset. */
  readonly beforeMutation?: (input: {
    readonly action: "create" | "publish" | "replace" | "remove";
    readonly targetPath: string;
    readonly operationId: string;
  }) => void | Promise<void>;
  /** Production uses the packaged macOS descriptor helper; tests may inject one. */
  readonly filesystemHelper?: MossCanonicalFilesystemHelper;
  readonly helperPath?: string;
  readonly helperTimeoutMs?: number;
  readonly helperEnv?: NodeJS.ProcessEnv;
  readonly maxStageBytes?: number;
  readonly maxStageEntries?: number;
}

interface RootObservation {
  readonly rootPath: string;
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
  readonly ctimeSeconds: number;
  readonly ctimeNanoseconds: number;
  readonly workspacePath: string;
  readonly workspaceRealpath: string;
  readonly workspaceDev: number;
  readonly workspaceIno: number;
}

interface TargetParentObservation {
  readonly path: string;
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
}

interface TargetObservation {
  readonly identity: MossFilesystemIdentity;
  readonly kind: "file" | "directory";
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly ctimeSeconds: number;
  readonly ctimeNanoseconds: number;
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function identityFingerprint(input: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mode: number;
  readonly ctimeSeconds: number;
  readonly ctimeNanoseconds: number;
}): string {
  return hash(
    JSON.stringify({
      dev: String(input.dev),
      ino: String(input.ino),
      mode: input.mode,
      ctimeSeconds: input.ctimeSeconds,
      ctimeNanoseconds: input.ctimeNanoseconds,
    }),
  );
}

function ctimeParts(stat: { readonly ctimeMs: number; readonly ctimeNs?: bigint | number }): {
  readonly ctimeSeconds: number;
  readonly ctimeNanoseconds: number;
} {
  if (typeof stat.ctimeNs === "bigint") {
    const seconds = stat.ctimeNs / 1_000_000_000n;
    const nanoseconds = stat.ctimeNs % 1_000_000_000n;
    return { ctimeSeconds: Number(seconds), ctimeNanoseconds: Number(nanoseconds) };
  }
  if (typeof stat.ctimeNs === "number" && Number.isSafeInteger(stat.ctimeNs)) {
    const ctimeSeconds = Math.trunc(stat.ctimeNs / 1_000_000_000);
    return {
      ctimeSeconds,
      ctimeNanoseconds: stat.ctimeNs - ctimeSeconds * 1_000_000_000,
    };
  }
  const milliseconds = Math.trunc(stat.ctimeMs);
  const ctimeSeconds = Math.trunc(milliseconds / 1_000);
  return {
    ctimeSeconds,
    ctimeNanoseconds: (milliseconds - ctimeSeconds * 1_000) * 1_000_000,
  };
}

function isWithin(rootPath: string, candidatePath: string, strict = false): boolean {
  const root = nodePath.resolve(rootPath);
  const candidate = nodePath.resolve(candidatePath);
  if (!strict && root === candidate) return true;
  if (root === candidate) return false;
  const relative = nodePath.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !nodePath.isAbsolute(relative);
}

function pathTraversal(message: string): MossResourceImportError {
  return new MossResourceImportError("path-traversal", message);
}

function concurrent(message: string): MossResourceImportError {
  return new MossResourceImportError("concurrent-modification", message);
}

function durability(message: string): MossResourceImportError {
  return new MossResourceImportError("durability-unsupported", message);
}

async function readTargetObservation(
  rootPath: string,
  targetPath: string,
  requirePresent = false,
): Promise<TargetObservation | null> {
  let targetStat;
  try {
    targetStat = await lstat(targetPath);
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      if (requirePresent) {
        throw concurrent("Canonical target disappeared during the bounded hash.");
      }
      return null;
    }
    throw cause;
  }
  if (targetStat.isSymbolicLink()) {
    throw new MossResourceImportError("symlink-escape", "Canonical target is a symbolic link.");
  }
  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw new MossResourceImportError(
      "unsupported",
      "Canonical target is not a file or directory.",
    );
  }
  const ctime = ctimeParts(targetStat);
  const canonical = await hashMossCanonicalResource({
    rootPath,
    targetPath,
    requirePresent: true,
  });
  return {
    kind: targetStat.isDirectory() ? "directory" : "file",
    identity: {
      identityFingerprint: identityFingerprint({ ...targetStat, ...ctime }),
      hash: canonical.hash,
    },
    dev: targetStat.dev,
    ino: targetStat.ino,
    mode: targetStat.mode,
    ...ctime,
  };
}

async function assertCanonicalRoot(input: MossFilesystemCapabilityInput): Promise<RootObservation> {
  const rootPath = nodePath.resolve(input.canonicalRoot.rootPath);
  if (
    rootPath !== input.canonicalRoot.rootPath ||
    input.expectedFingerprint !== input.canonicalRoot.identityFingerprint ||
    input.projectId !== input.canonicalRoot.projectId ||
    input.workspaceId !== input.canonicalRoot.workspaceId ||
    (input.canonicalRoot.ownerId !== undefined && input.ownerId !== input.canonicalRoot.ownerId) ||
    input.principalId !== input.canonicalRoot.principalId ||
    input.sessionId !== input.canonicalRoot.sessionId
  ) {
    throw concurrent("Canonical root descriptor does not match the server authority.");
  }
  let rootStat;
  try {
    rootStat = await lstat(rootPath);
  } catch {
    throw durability("Canonical root could not be opened durably.");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Canonical root is not a regular directory.",
    );
  }
  const openedRealpath = await realpath(rootPath).catch(() => null);
  if (!openedRealpath) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Canonical root crossed a symlink boundary.",
    );
  }
  const cwdRealpath = await realpath(nodePath.resolve(input.cwd)).catch(() => null);
  if (!cwdRealpath || !isWithin(cwdRealpath, openedRealpath, false)) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Canonical root leaves the authenticated workspace.",
    );
  }
  const workspaceStat = await lstat(cwdRealpath).catch(() => null);
  if (!workspaceStat || workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
    throw new MossResourceImportError(
      "symlink-escape",
      "The authenticated workspace anchor is not a regular directory.",
    );
  }
  const pathFingerprint = hash(rootPath);
  const rootCtime = ctimeParts(rootStat);
  const observedRootFingerprint = hash(
    JSON.stringify({
      dev: String(rootStat.dev),
      ino: String(rootStat.ino),
      ctimeSeconds: rootCtime.ctimeSeconds,
      ctimeNanoseconds: rootCtime.ctimeNanoseconds,
      realpath: openedRealpath,
    }),
  );
  if (
    input.canonicalRoot.identityFingerprint !== pathFingerprint &&
    input.canonicalRoot.identityFingerprint !== observedRootFingerprint
  ) {
    throw concurrent("Canonical root descriptor does not match the opened root identity.");
  }
  return {
    rootPath,
    realpath: openedRealpath,
    dev: rootStat.dev,
    ino: rootStat.ino,
    ...rootCtime,
    workspacePath: cwdRealpath,
    workspaceRealpath: cwdRealpath,
    workspaceDev: workspaceStat.dev,
    workspaceIno: workspaceStat.ino,
  };
}

async function ensureCanonicalRootForCreate(
  input: MossFilesystemCapabilityInput,
  action: "create" | "publish" | "replace" | "remove",
): Promise<void> {
  if (action !== "create" && action !== "publish") return;
  const rootPath = nodePath.resolve(input.canonicalRoot.rootPath);
  const existing = await lstat(rootPath).catch((cause) => {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      return null;
    }
    throw cause;
  });
  if (existing) return;
  const parent = nodePath.dirname(rootPath);
  const parentRealpath = await realpath(parent).catch(() => null);
  if (!parentRealpath) {
    throw new MossResourceImportError("symlink-escape", "Canonical root parent is unsafe.");
  }
  const cwdRealpath = await realpath(nodePath.resolve(input.cwd)).catch(() => null);
  if (!cwdRealpath || !isWithin(cwdRealpath, parentRealpath, false)) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Canonical root parent leaves the authenticated workspace.",
    );
  }
  await fs.mkdir(rootPath, { mode: 0o700 });
  await syncDirectory(parent);
}

async function assertRootUnchanged(observed: RootObservation): Promise<void> {
  const current = await assertCanonicalRoot({
    cwd: observed.workspaceRealpath,
    canonicalRoot: {
      rootPath: observed.rootPath,
      identityFingerprint: hash(observed.rootPath),
      projectId: "root-check",
      workspaceId: "root-check",
      principalId: "root-check",
      sessionId: "root-check",
    },
    projectId: "root-check",
    workspaceId: "root-check",
    principalId: "root-check",
    sessionId: "root-check",
    targetPath: observed.rootPath,
    operationId: "root-check",
    kind: "skill",
    fencingToken: "root-check",
    generation: "root-check",
    nonce: "root-check",
    expectedFingerprint: hash(observed.rootPath),
    expectedBeforeHash: MISSING_HASH,
    expected: { identityFingerprint: hash(observed.rootPath), hash: MISSING_HASH },
  });
  if (
    current.realpath !== observed.realpath ||
    current.dev !== observed.dev ||
    current.ino !== observed.ino
  ) {
    throw concurrent("Canonical root changed while the filesystem CAS was prepared.");
  }
}

async function ensureTargetParent(
  rootPath: string,
  rootRealpath: string,
  targetPath: string,
): Promise<{ readonly targetPath: string; readonly parent: TargetParentObservation | null }> {
  if (
    !nodePath.isAbsolute(targetPath) ||
    targetPath.includes("\0") ||
    targetPath.split(nodePath.sep).some((segment) => segment === "." || segment === "..")
  ) {
    throw pathTraversal("Canonical target must be an absolute normalized path.");
  }
  const resolvedTarget = nodePath.resolve(targetPath);
  if (!isWithin(rootPath, resolvedTarget, true)) {
    throw pathTraversal("Canonical target leaves the canonical Moss root.");
  }
  const parent = nodePath.dirname(resolvedTarget);
  const relativeParent = nodePath.relative(rootPath, parent);
  let current = rootPath;
  for (const segment of relativeParent.split(nodePath.sep).filter(Boolean)) {
    current = nodePath.join(current, segment);
    let currentStat;
    try {
      currentStat = await lstat(current);
    } catch (cause) {
      if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")) {
        throw cause;
      }
      return { targetPath: resolvedTarget, parent: null };
    }
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw new MossResourceImportError("symlink-escape", "Canonical target parent is unsafe.");
    }
  }
  const parentRealpath = await realpath(parent).catch(() => null);
  if (!parentRealpath || !isWithin(rootRealpath, parentRealpath, false)) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Canonical target parent escaped the root.",
    );
  }
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") {
      return { targetPath: resolvedTarget, parent: null };
    }
    throw cause;
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new MossResourceImportError("symlink-escape", "Canonical target parent is unsafe.");
  }
  return {
    targetPath: resolvedTarget,
    parent: {
      path: parent,
      realpath: parentRealpath,
      dev: parentStat.dev,
      ino: parentStat.ino,
    },
  };
}

async function assertTargetParentUnchanged(
  observed: TargetParentObservation,
  root: RootObservation,
): Promise<void> {
  let currentStat;
  try {
    currentStat = await lstat(observed.path);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") {
      throw concurrent("Canonical target parent disappeared during the filesystem CAS.");
    }
    throw cause;
  }
  if (currentStat.isSymbolicLink()) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Canonical target parent became a symbolic link during the filesystem CAS.",
    );
  }
  if (!currentStat.isDirectory()) {
    throw concurrent("Canonical target parent is no longer a directory.");
  }
  const currentRealpath = await realpath(observed.path).catch(() => null);
  if (!currentRealpath || !isWithin(root.realpath, currentRealpath, false)) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Canonical target parent escaped the canonical root during the filesystem CAS.",
    );
  }
  if (
    currentRealpath !== observed.realpath ||
    currentStat.dev !== observed.dev ||
    currentStat.ino !== observed.ino
  ) {
    throw concurrent("Canonical target parent identity changed during the filesystem CAS.");
  }
}

async function assertMutationBoundary(
  root: RootObservation,
  parent: TargetParentObservation | null,
): Promise<void> {
  await assertRootUnchanged(root);
  if (parent) await assertTargetParentUnchanged(parent, root);
}

function assertStageAuthority(input: MossFilesystemCapabilityInput): void {
  if (!input.stage) return;
  if (
    input.stage.operationId !== input.operationId ||
    input.stage.kind !== input.kind ||
    input.stage.canonicalRoot !== input.canonicalRoot.rootPath ||
    (input.ownerId !== undefined && input.stage.ownerId !== input.ownerId) ||
    input.stage.projectId !== input.projectId ||
    input.stage.workspaceId !== input.workspaceId ||
    input.stage.principalId !== input.principalId ||
    input.stage.sessionId !== input.sessionId ||
    input.stage.fencingToken !== input.fencingToken ||
    input.stage.generation !== input.generation ||
    input.stage.nonce !== input.nonce
  ) {
    throw concurrent("Private stage authority does not match the canonical capability.");
  }
}

function assertRelativeStagePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    nodePath.isAbsolute(relativePath) ||
    relativePath.includes("\0") ||
    relativePath
      .split(/[\\/]+/u)
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new MossResourceImportError("path-traversal", "Private stage entry path is unsafe.");
  }
}

function helperPayloadForStage(
  entries: MossNativeFilesystemStagePayload,
  limits: { readonly maxBytes: number; readonly maxEntries: number },
): MossNativeFilesystemStagePayload {
  let totalBytes = 0;
  if (entries.kind === "file") {
    if (entries.content.byteLength > limits.maxBytes) {
      throw new MossResourceImportError("limit-exceeded", "Private stage exceeds its byte limit.");
    }
    return entries;
  }
  if (entries.entries.length > limits.maxEntries) {
    throw new MossResourceImportError("limit-exceeded", "Private stage has too many entries.");
  }
  const validatedEntries: Array<{
    readonly relativePath: string;
    readonly kind: "file" | "directory";
    readonly content?: Uint8Array;
  }> = [];
  for (const entry of entries.entries.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    assertRelativeStagePath(entry.relativePath);
    if (entry.kind === "directory") {
      validatedEntries.push({ relativePath: entry.relativePath, kind: entry.kind });
      continue;
    }
    const content = entry.content;
    if (!content) throw durability("Private stage file content is missing.");
    totalBytes += content.byteLength;
    if (totalBytes > limits.maxBytes) {
      throw new MossResourceImportError("limit-exceeded", "Private stage exceeds its byte limit.");
    }
    validatedEntries.push({ relativePath: entry.relativePath, kind: entry.kind, content });
  }
  return { kind: "directory", entries: validatedEntries };
}

function relativeSegments(fromPath: string, toPath: string, label: string): string[] {
  const relative = nodePath.relative(fromPath, toPath);
  if (relative === "" && label === "canonical target") {
    throw pathTraversal("Canonical target must name a resource below the canonical root.");
  }
  const segments = relative === "" ? [] : relative.split(nodePath.sep);
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  ) {
    throw pathTraversal(`${label} is not a safe descriptor-relative path.`);
  }
  return segments;
}

function helperExpectedTarget(
  target: TargetObservation | null,
):
  | { readonly kind: "missing" }
  | { readonly kind: "file" | "directory"; readonly dev: number; readonly ino: number } {
  if (!target) return { kind: "missing" };
  return { kind: target.kind, dev: target.dev, ino: target.ino };
}

function helperAfterMatches(
  after: {
    readonly kind: "file" | "directory";
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly ctimeSeconds: number;
    readonly ctimeNanoseconds: number;
  } | null,
  observed: TargetObservation | null,
): boolean {
  if (!after || !observed) return after === null && observed === null;
  return (
    after.kind === observed.kind &&
    after.dev === observed.dev &&
    after.ino === observed.ino &&
    after.mode === observed.mode
  );
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await fs.open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    throw durability("Canonical filesystem directory durability could not be confirmed.");
  }
}

function errorCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return undefined;
  const value = cause.code;
  return typeof value === "string" ? value : undefined;
}

function resultFor(
  input: MossFilesystemCapabilityInput,
  after: MossFilesystemIdentity,
): MossFilesystemCapabilityResult {
  return {
    observed: after,
    afterHash: after.hash,
    durableObservedFingerprint: after.identityFingerprint,
    receipt: {
      canonicalRoot: input.canonicalRoot,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      principalId: input.principalId,
      sessionId: input.sessionId,
      operationId: input.operationId,
      fencingToken: input.fencingToken,
      generation: input.generation,
      nonce: input.nonce,
      expected: input.expected,
      ...(input.expectedAfter ? { expectedAfter: input.expectedAfter } : {}),
      observed: after,
      afterHash: after.hash,
      durableObservedFingerprint: after.identityFingerprint,
      durable: true,
    },
  };
}

export function makeMossNativeFilesystemCapability(
  options: MossNativeFilesystemCapabilityOptions,
): MossFilesystemCapability {
  const maxStageBytes = options.maxStageBytes ?? DEFAULT_MAX_STAGE_BYTES;
  const maxStageEntries = options.maxStageEntries ?? DEFAULT_MAX_STAGE_ENTRIES;
  const helperOptions = {
    ...(options.helperPath !== undefined ? { helperPath: options.helperPath } : {}),
    ...(options.helperTimeoutMs !== undefined ? { timeoutMs: options.helperTimeoutMs } : {}),
    ...(options.helperEnv !== undefined ? { env: options.helperEnv } : {}),
  } as const;
  const filesystemHelper =
    options.filesystemHelper ?? makeMossCanonicalFilesystemHelper(helperOptions);

  const mutate = async (
    action: "create" | "publish" | "replace" | "remove",
    input: MossFilesystemCapabilityInput,
  ): Promise<MossFilesystemCapabilityResult> => {
    if (!input.canonicalRoot.rootPath || !input.targetPath) {
      throw durability("Canonical filesystem capability input is incomplete.");
    }
    await ensureCanonicalRootForCreate(input, action);
    const root = await assertCanonicalRoot(input);
    assertStageAuthority(input);
    if (action !== "remove" && !input.stage) {
      throw durability("Canonical create/replace requires a private stage.");
    }
    const ensuredTarget = await ensureTargetParent(root.rootPath, root.realpath, input.targetPath);
    const targetPath = ensuredTarget.targetPath;
    const targetParent = ensuredTarget.parent;
    const before = await readTargetObservation(root.rootPath, targetPath);
    const beforeHash = before?.identity.hash ?? MISSING_HASH;

    const transactionId = input.stage?.transactionId ?? `transaction-${input.operationId}`;
    const recoveryBinding = recoveryBindingForFilesystemInput(input, action, transactionId);
    const recovery = await recoverMossCanonicalResourceMutation({
      ownershipStore: options.ownershipStore,
      binding: recoveryBinding,
    });
    if (recovery.status === "committed") {
      return resultFor(input, recovery.receipt.observed);
    }
    let pendingRecoveryJournal =
      recovery.status === "retry" || recovery.status === "settled"
        ? recovery.record.journal
        : undefined;

    if (beforeHash !== input.expectedBeforeHash) {
      throw concurrent("Canonical target changed before the filesystem CAS.");
    }
    if (action === "create" || action === "publish") {
      if (before) {
        throw new MossResourceImportError("conflict", "Canonical target already exists.");
      }
    } else if (action === "replace" && !before) {
      throw concurrent("Canonical replace target disappeared before the filesystem CAS.");
    }

    if (recovery.status === "none" || recovery.status === "settled") {
      const intentRecord = await appendMossCanonicalRecoveryJournal({
        ownershipStore: options.ownershipStore,
        journal: makeMossCanonicalRecoveryJournal({
          binding: recoveryBinding,
          phase: "intent",
        }),
        preCas: true,
      });
      pendingRecoveryJournal = intentRecord.journal;
    }

    try {
      let payload: MossNativeFilesystemStagePayload | undefined;
      if (action !== "remove") {
        try {
          payload = await options.readStage(input.stage!);
        } catch (cause) {
          if (cause instanceof MossResourceImportError) throw cause;
          throw durability("Private stage could not be read durably.");
        }
        payload = helperPayloadForStage(payload, {
          maxBytes: maxStageBytes,
          maxEntries: maxStageEntries,
        });
        if (before && before.kind !== payload.kind) {
          throw concurrent("Canonical target type changed during the filesystem CAS.");
        }
      }
      await options.beforeMutation?.({ action, targetPath, operationId: input.operationId });
      await assertMutationBoundary(root, targetParent);
      const raced = await readTargetObservation(root.rootPath, targetPath, before !== null);
      const racedHash = raced?.identity.hash ?? MISSING_HASH;
      if (racedHash !== beforeHash) {
        throw concurrent("Canonical target changed while the filesystem CAS was prepared.");
      }
      if (!payload && action !== "remove") {
        throw durability("Canonical filesystem stage payload is missing.");
      }
      const expectedAfterFingerprint = action === "remove" ? MISSING_HASH : input.expectedAfterHash;
      if (!expectedAfterFingerprint) {
        throw durability("Canonical filesystem mutation requires a staged content fingerprint.");
      }
      const helperResult = await filesystemHelper.execute({
        action,
        cwd: root.workspaceRealpath,
        rootSegments: relativeSegments(root.workspaceRealpath, root.realpath, "canonical root"),
        targetSegments: relativeSegments(root.rootPath, targetPath, "canonical target"),
        expectedWorkspace: { dev: root.workspaceDev, ino: root.workspaceIno },
        expectedRoot: { dev: root.dev, ino: root.ino },
        expectedParent: targetParent
          ? { dev: targetParent.dev, ino: targetParent.ino }
          : { dev: 0, ino: 0 },
        expectedTarget: helperExpectedTarget(before),
        expectedBeforeFingerprint: beforeHash,
        expectedAfterFingerprint,
        expectedAfterKind: action === "remove" ? "missing" : payload!.kind,
        payload:
          action === "remove"
            ? { kind: "missing" }
            : payload!.kind === "file"
              ? { kind: "file", content: payload!.content }
              : { kind: "directory", entries: payload!.entries },
      });

      const verifiedTargetParent = (
        await ensureTargetParent(root.rootPath, root.realpath, targetPath)
      ).parent;
      if (!verifiedTargetParent) {
        throw concurrent("Canonical target parent disappeared after the descriptor mutation.");
      }
      if (
        helperResult.parent.dev !== verifiedTargetParent.dev ||
        helperResult.parent.ino !== verifiedTargetParent.ino
      ) {
        throw concurrent(
          "Canonical target parent identity changed during the descriptor mutation.",
        );
      }
      await assertRootUnchanged(root);
      if (targetParent) await assertTargetParentUnchanged(targetParent, root);
      await assertTargetParentUnchanged(verifiedTargetParent, root);
      const after = await readTargetObservation(root.rootPath, targetPath);
      if (!helperAfterMatches(helperResult.after, after)) {
        throw concurrent("Canonical target changed after the descriptor mutation.");
      }
      const afterIdentity: MossFilesystemIdentity = after?.identity ?? {
        identityFingerprint: "absent",
        hash: MISSING_HASH,
      };
      if (helperResult.afterFingerprint !== afterIdentity.hash) {
        throw concurrent("Canonical target content changed after the descriptor mutation.");
      }
      if (input.expectedAfterHash !== undefined && afterIdentity.hash !== input.expectedAfterHash) {
        throw concurrent("Canonical filesystem capability produced an unexpected hash.");
      }
      const baseJournal = pendingRecoveryJournal;
      const observedJournal = await appendMossCanonicalRecoveryJournal({
        ownershipStore: options.ownershipStore,
        journal: makeMossCanonicalRecoveryJournal({
          binding: recoveryBinding,
          phase: "cas-observed",
          observed: afterIdentity,
          ...(baseJournal ? { base: baseJournal } : {}),
        }),
      });
      await appendMossCanonicalRecoveryJournal({
        ownershipStore: options.ownershipStore,
        journal: {
          ...observedJournal.journal,
          phase: "committed",
          observed: afterIdentity,
        },
      });
      return resultFor(input, afterIdentity);
    } catch (cause) {
      if (cause instanceof MossCanonicalFilesystemHelperError) {
        if (action === "remove" && cause.code === "concurrent-modification") {
          const observedAfterHelper = await inspectMossCanonicalTarget(root.rootPath, targetPath);
          if (observedAfterHelper.hash === MISSING_HASH) {
            try {
              await appendMossCanonicalRecoveryJournal({
                ownershipStore: options.ownershipStore,
                journal: makeMossCanonicalRecoveryJournal({
                  binding: recoveryBinding,
                  phase: "conflict",
                  observed: observedAfterHelper,
                  ...(pendingRecoveryJournal ? { base: pendingRecoveryJournal } : {}),
                }),
              });
            } catch {
              throw new MossResourceImportError(
                "recovery-needed",
                "Canonical remove conflict could not be durably fenced.",
              );
            }
          }
        }
        throw new MossResourceImportError(cause.code, cause.message);
      }
      if (cause instanceof MossResourceImportError) throw cause;
      if (["EEXIST", "ENOTEMPTY", "ENOENT"].includes(errorCode(cause) ?? "")) {
        throw concurrent("Canonical filesystem target changed during the CAS.");
      }
      throw durability("Canonical filesystem mutation could not be durably confirmed.");
    }
  };

  return {
    create: (input) => mutate("create", input),
    publish: (input) => mutate("publish", input),
    replace: (input) => mutate("replace", input),
    remove: (input) => mutate("remove", input),
  };
}
