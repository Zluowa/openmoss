import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import * as nodePath from "node:path";

import { MossCanonicalResourceMutationReceipt as MossCanonicalResourceMutationReceiptSchema } from "@synara/contracts";
import type {
  MossCanonicalResourceMutationReceipt,
  MossCanonicalRootDescriptor,
  MossFilesystemCapabilityInput,
  MossFilesystemIdentity,
  MossOwnershipStore,
  MossPrivateManifest,
  MossPrivateManifestReceipt,
} from "@synara/contracts";
import { Schema } from "effect";

import {
  hashMossCanonicalResource,
  MOSS_CANONICAL_MISSING_HASH,
} from "./mossCanonicalResourceHash.ts";
import { MossResourceImportError } from "./mossResourceImport.ts";

export const MOSS_CANONICAL_RECOVERY_SCHEMA_VERSION = 3 as const;
export const MOSS_FILESYSTEM_MANIFEST_FILE = "filesystem-mutations.json";
export const MOSS_MISSING_HASH = MOSS_CANONICAL_MISSING_HASH;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;

export type MossCanonicalRecoveryPhase =
  | "intent"
  | "cas-observed"
  | "committed"
  | "recovery-needed"
  | "conflict";

export type MossCanonicalRecoveryAction = "create" | "publish" | "replace" | "remove";

export interface MossCanonicalRecoveryJournal {
  readonly schemaVersion: typeof MOSS_CANONICAL_RECOVERY_SCHEMA_VERSION;
  readonly phase: MossCanonicalRecoveryPhase;
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly action: MossCanonicalRecoveryAction;
  readonly targetPath: string;
  readonly canonicalRoot: MossCanonicalRootDescriptor & { readonly ownerId: string };
  readonly expectedBefore: MossFilesystemIdentity;
  readonly expectedAfter: MossFilesystemIdentity;
  readonly observed?: MossFilesystemIdentity;
  readonly fencingToken: string;
  readonly generation: string;
  readonly nonce: string;
  readonly planHash: string;
}

export interface MossCanonicalRecoveryBinding {
  readonly currentOperationId: string;
  /** Stable server-validated request key; legacy capability callers default to operationId. */
  readonly currentIdempotencyKey?: string;
  readonly action: MossCanonicalRecoveryAction;
  readonly transactionId: string;
  readonly canonicalRoot: MossCanonicalRootDescriptor;
  readonly targetPath: string;
  readonly expectedBefore: MossFilesystemIdentity;
  readonly expectedAfter: MossFilesystemIdentity;
  readonly fencingToken: string;
  readonly generation: string;
  readonly nonce: string;
}

export interface MossCanonicalRecoveryRecord {
  readonly journal: MossCanonicalRecoveryJournal;
  readonly record: MossPrivateManifest;
}

export type MossCanonicalRecoveryOutcome =
  | { readonly status: "none" }
  | { readonly status: "retry"; readonly record: MossCanonicalRecoveryRecord }
  | {
      readonly status: "committed" | "settled";
      readonly record: MossCanonicalRecoveryRecord;
      readonly receipt: MossCanonicalResourceMutationReceipt;
    };

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function recoveryError(
  code: ConstructorParameters<typeof MossResourceImportError>[0],
  message: string,
): MossResourceImportError {
  return new MossResourceImportError(code, message);
}

function ownerFor(root: MossCanonicalRootDescriptor): string {
  return root.ownerId ?? root.principalId;
}

function canonicalRootFor(
  root: MossCanonicalRootDescriptor,
): MossCanonicalRootDescriptor & { readonly ownerId: string } {
  return { ...root, ownerId: ownerFor(root) };
}

async function assertSafeTarget(rootPath: string, targetPath: string): Promise<string> {
  const resolvedRoot = nodePath.resolve(rootPath);
  const resolvedTarget = nodePath.resolve(targetPath);
  const relative = nodePath.relative(resolvedRoot, resolvedTarget);
  if (relative.length === 0 || relative.startsWith("..") || nodePath.isAbsolute(relative)) {
    throw recoveryError("path-traversal", "Canonical recovery target leaves the canonical root.");
  }
  let current = resolvedRoot;
  const parentRelative = nodePath.relative(resolvedRoot, nodePath.dirname(resolvedTarget));
  for (const segment of parentRelative.split(nodePath.sep).filter(Boolean)) {
    current = nodePath.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
        break;
      }
      throw cause;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw recoveryError("symlink-escape", "Canonical recovery target parent is unsafe.");
    }
  }
  return resolvedTarget;
}

export async function inspectMossCanonicalTarget(
  rootPath: string,
  targetPath: string,
): Promise<MossFilesystemIdentity> {
  const resolvedTarget = await assertSafeTarget(rootPath, targetPath);
  let stat;
  try {
    stat = await lstat(resolvedTarget);
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      return { identityFingerprint: "absent", hash: MOSS_MISSING_HASH };
    }
    throw cause;
  }
  if (stat.isSymbolicLink()) {
    throw recoveryError("symlink-escape", "Canonical recovery target is a symbolic link.");
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw recoveryError("unsupported", "Canonical recovery target is not a file or directory.");
  }
  const canonical = await hashMossCanonicalResource({
    rootPath,
    targetPath: resolvedTarget,
    requirePresent: true,
  });
  return {
    identityFingerprint: canonical.identityFingerprint,
    hash: canonical.hash,
  };
}

export function canonicalMutationPlanHash(input: {
  readonly operationId: string;
  readonly targetPath: string;
  readonly beforeHash: string;
  readonly afterHash: string;
}): string {
  return sha256(stableJson(input));
}

function normalizeBinding(binding: MossCanonicalRecoveryBinding): MossCanonicalRecoveryBinding {
  return {
    ...binding,
    canonicalRoot: canonicalRootFor(binding.canonicalRoot),
  };
}

function idempotencyKeyFor(binding: MossCanonicalRecoveryBinding): string {
  return binding.currentIdempotencyKey ?? binding.currentOperationId;
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw recoveryError(
      "transaction-invalid",
      "Canonical recovery idempotency key is missing or out of bounds.",
    );
  }
}

export function makeMossCanonicalRecoveryJournal(input: {
  readonly binding: MossCanonicalRecoveryBinding;
  readonly phase: MossCanonicalRecoveryPhase;
  readonly transactionId?: string;
  readonly observed?: MossFilesystemIdentity;
  readonly base?: MossCanonicalRecoveryJournal;
}): MossCanonicalRecoveryJournal {
  const binding = normalizeBinding(input.binding);
  const base = input.base;
  const idempotencyKey = base?.idempotencyKey ?? idempotencyKeyFor(binding);
  assertIdempotencyKey(idempotencyKey);
  return {
    schemaVersion: MOSS_CANONICAL_RECOVERY_SCHEMA_VERSION,
    phase: input.phase,
    transactionId: base?.transactionId ?? input.transactionId ?? binding.transactionId,
    idempotencyKey,
    operationId: base?.operationId ?? binding.currentOperationId,
    action: base?.action ?? binding.action,
    targetPath: base?.targetPath ?? binding.targetPath,
    canonicalRoot: base?.canonicalRoot ?? canonicalRootFor(binding.canonicalRoot),
    expectedBefore: base?.expectedBefore ?? binding.expectedBefore,
    expectedAfter: base?.expectedAfter ?? binding.expectedAfter,
    ...(input.observed ? { observed: input.observed } : {}),
    fencingToken: binding.fencingToken,
    generation: binding.generation,
    nonce: binding.nonce,
    planHash:
      base?.planHash ??
      canonicalMutationPlanHash({
        operationId: binding.currentOperationId,
        targetPath: binding.targetPath,
        beforeHash: binding.expectedBefore.hash,
        afterHash: binding.expectedAfter.hash,
      }),
  };
}

function decodeJournal(value: unknown): MossCanonicalRecoveryJournal {
  if (!isRecord(value) || value.schemaVersion !== MOSS_CANONICAL_RECOVERY_SCHEMA_VERSION) {
    throw recoveryError(
      "transaction-invalid",
      "Canonical recovery journal schema is missing or unsupported.",
    );
  }
  const root = value.canonicalRoot;
  const before = value.expectedBefore;
  const after = value.expectedAfter;
  const observed = value.observed;
  if (
    !isNonEmptyString(value.phase) ||
    !["intent", "cas-observed", "committed", "recovery-needed", "conflict"].includes(value.phase) ||
    !isNonEmptyString(value.transactionId) ||
    !isNonEmptyString(value.idempotencyKey) ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    !isNonEmptyString(value.operationId) ||
    !["create", "publish", "replace", "remove"].includes(String(value.action)) ||
    !isNonEmptyString(value.targetPath) ||
    !isRecord(root) ||
    !isNonEmptyString(root.rootPath) ||
    !isHash(root.identityFingerprint) ||
    !isNonEmptyString(root.ownerId) ||
    !isNonEmptyString(root.projectId) ||
    !isNonEmptyString(root.workspaceId) ||
    !isNonEmptyString(root.principalId) ||
    !isNonEmptyString(root.sessionId) ||
    !isRecord(before) ||
    !isNonEmptyString(before.identityFingerprint) ||
    !isHash(before.hash) ||
    !isRecord(after) ||
    !isNonEmptyString(after.identityFingerprint) ||
    !isHash(after.hash) ||
    (observed !== undefined &&
      (!isRecord(observed) ||
        !isNonEmptyString(observed.identityFingerprint) ||
        !isHash(observed.hash))) ||
    !isNonEmptyString(value.fencingToken) ||
    !isNonEmptyString(value.generation) ||
    !isNonEmptyString(value.nonce) ||
    !isHash(value.planHash)
  ) {
    throw recoveryError("transaction-invalid", "Canonical recovery journal failed validation.");
  }
  return value as unknown as MossCanonicalRecoveryJournal;
}

function privateManifestRecordHash(input: {
  readonly transactionId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly value: unknown;
}): string {
  const value = isRecord(input.value)
    ? { ...input.value, sequence: input.sequence, previousHash: input.previousHash }
    : input.value;
  return sha256(
    stableJson({
      schemaVersion: 3,
      transactionId: input.transactionId,
      sequence: input.sequence,
      previousHash: input.previousHash,
      value,
    }),
  );
}

function assertManifestReceipt(
  receipt: MossPrivateManifestReceipt,
  journal: MossCanonicalRecoveryJournal,
): void {
  const ownerId = journal.canonicalRoot.ownerId;
  if (
    receipt.transactionId !== journal.transactionId ||
    receipt.ownerId !== ownerId ||
    receipt.projectId !== journal.canonicalRoot.projectId ||
    receipt.workspaceId !== journal.canonicalRoot.workspaceId ||
    receipt.principalId !== journal.canonicalRoot.principalId ||
    receipt.sessionId !== journal.canonicalRoot.sessionId ||
    receipt.stateFingerprint !== journal.canonicalRoot.identityFingerprint ||
    receipt.nonce !== journal.nonce ||
    !isNonEmptyString(journal.fencingToken) ||
    !isNonEmptyString(journal.generation) ||
    !Number.isInteger(receipt.sequence) ||
    receipt.sequence < 0 ||
    !isHash(receipt.previousHash) ||
    !isHash(receipt.recordHash) ||
    stableJson(receipt.value) !== stableJson(journal) ||
    receipt.recordHash !==
      privateManifestRecordHash({
        transactionId: receipt.transactionId,
        sequence: receipt.sequence,
        previousHash: receipt.previousHash,
        value: receipt.value,
      })
  ) {
    throw recoveryError(
      "recovery-needed",
      "Canonical recovery received an unverifiable private journal receipt.",
    );
  }
}

export async function appendMossCanonicalRecoveryJournal(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly journal: MossCanonicalRecoveryJournal;
  readonly preCas?: boolean;
}): Promise<MossCanonicalRecoveryRecord> {
  const ownerId = input.journal.canonicalRoot.ownerId;
  let receipt: MossPrivateManifestReceipt;
  try {
    receipt = await input.ownershipStore.appendPrivateManifest({
      fileName: MOSS_FILESYSTEM_MANIFEST_FILE,
      transactionId: input.journal.transactionId,
      value: input.journal,
      ownerId,
      projectId: input.journal.canonicalRoot.projectId,
      workspaceId: input.journal.canonicalRoot.workspaceId,
      principalId: input.journal.canonicalRoot.principalId,
      sessionId: input.journal.canonicalRoot.sessionId,
      stateFingerprint: input.journal.canonicalRoot.identityFingerprint,
      nonce: input.journal.nonce,
    });
  } catch (cause) {
    if (cause instanceof MossResourceImportError) {
      if (input.preCas && cause.code === "recovery-needed") {
        throw recoveryError(
          "durability-unsupported",
          "Canonical recovery intent could not be persisted before CAS.",
        );
      }
      throw cause;
    }
    throw recoveryError(
      input.preCas ? "durability-unsupported" : "recovery-needed",
      input.preCas
        ? "Canonical recovery intent could not be persisted before CAS."
        : "Canonical recovery phase could not be persisted after CAS.",
    );
  }
  try {
    assertManifestReceipt(receipt, input.journal);
  } catch (cause) {
    if (cause instanceof MossResourceImportError) throw cause;
    throw recoveryError("recovery-needed", "Canonical recovery receipt validation failed.");
  }
  const record: MossPrivateManifest = receipt;
  return { journal: input.journal, record };
}

export async function readMossCanonicalRecoveryRecord(
  ownershipStore: MossOwnershipStore,
): Promise<MossCanonicalRecoveryRecord | null> {
  const record = await ownershipStore.readPrivateManifest({
    fileName: MOSS_FILESYSTEM_MANIFEST_FILE,
  });
  if (!record) return null;
  const journal = decodeJournal(record.value);
  if (
    record.transactionId !== journal.transactionId ||
    record.ownerId !== journal.canonicalRoot.ownerId ||
    record.projectId !== journal.canonicalRoot.projectId ||
    record.workspaceId !== journal.canonicalRoot.workspaceId ||
    record.principalId !== journal.canonicalRoot.principalId ||
    record.sessionId !== journal.canonicalRoot.sessionId ||
    record.stateFingerprint !== journal.canonicalRoot.identityFingerprint ||
    record.nonce !== journal.nonce ||
    !isHash(record.previousHash) ||
    !isHash(record.recordHash) ||
    record.recordHash !==
      privateManifestRecordHash({
        transactionId: record.transactionId,
        sequence: record.sequence,
        previousHash: record.previousHash,
        value: record.value,
      })
  ) {
    throw recoveryError("transaction-invalid", "Canonical recovery record chain is invalid.");
  }
  return { journal, record };
}

function assertSameScope(
  journal: MossCanonicalRecoveryJournal,
  binding: MossCanonicalRecoveryBinding,
): void {
  const root = canonicalRootFor(binding.canonicalRoot);
  if (
    journal.canonicalRoot.rootPath !== root.rootPath ||
    journal.canonicalRoot.identityFingerprint !== root.identityFingerprint ||
    journal.canonicalRoot.ownerId !== root.ownerId ||
    journal.canonicalRoot.projectId !== root.projectId ||
    journal.canonicalRoot.workspaceId !== root.workspaceId ||
    journal.canonicalRoot.principalId !== root.principalId ||
    journal.canonicalRoot.sessionId !== root.sessionId
  ) {
    throw recoveryError(
      "concurrent-modification",
      "Canonical recovery authority or root binding changed.",
    );
  }
  if (journal.targetPath !== binding.targetPath) {
    throw recoveryError("concurrent-modification", "Canonical recovery target binding changed.");
  }
}

function assertSameOperationPlan(
  journal: MossCanonicalRecoveryJournal,
  binding: MossCanonicalRecoveryBinding,
): void {
  if (
    journal.transactionId !== binding.transactionId ||
    journal.operationId !== binding.currentOperationId ||
    journal.idempotencyKey !== idempotencyKeyFor(binding) ||
    journal.action !== binding.action ||
    stableJson(journal.expectedBefore) !== stableJson(binding.expectedBefore) ||
    stableJson(journal.expectedAfter) !== stableJson(binding.expectedAfter) ||
    journal.planHash !==
      canonicalMutationPlanHash({
        operationId: binding.currentOperationId,
        targetPath: binding.targetPath,
        beforeHash: binding.expectedBefore.hash,
        afterHash: binding.expectedAfter.hash,
      })
  ) {
    throw recoveryError(
      "concurrent-modification",
      "Canonical recovery idempotency binding changed.",
    );
  }
}

function sameLease(
  journal: MossCanonicalRecoveryJournal,
  binding: MossCanonicalRecoveryBinding,
): boolean {
  return (
    journal.fencingToken === binding.fencingToken &&
    journal.generation === binding.generation &&
    journal.nonce === binding.nonce
  );
}

async function settleRecord(
  ownershipStore: MossOwnershipStore,
  record: MossCanonicalRecoveryRecord,
  binding: MossCanonicalRecoveryBinding,
  observed: MossFilesystemIdentity,
): Promise<MossCanonicalRecoveryRecord> {
  const committedJournal = makeMossCanonicalRecoveryJournal({
    binding,
    phase: "committed",
    observed,
    base: record.journal,
  });
  return appendMossCanonicalRecoveryJournal({ ownershipStore, journal: committedJournal });
}

export async function recoverMossCanonicalResourceMutation(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly binding: MossCanonicalRecoveryBinding;
}): Promise<MossCanonicalRecoveryOutcome> {
  const binding = normalizeBinding(input.binding);
  const current = await readMossCanonicalRecoveryRecord(input.ownershipStore);
  if (!current) return { status: "none" };
  const { journal } = current;
  if (journal.phase === "committed") {
    if (journal.operationId !== binding.currentOperationId) return { status: "none" };
    assertSameScope(journal, binding);
    assertSameOperationPlan(journal, binding);
    const observed =
      journal.observed ??
      (await inspectMossCanonicalTarget(journal.canonicalRoot.rootPath, journal.targetPath));
    return {
      status: "committed",
      record: current,
      receipt: makeMossCanonicalResourceMutationReceipt(journal, observed, current.record),
    };
  }
  if (journal.phase === "conflict") {
    if (journal.operationId !== binding.currentOperationId) return { status: "none" };
    assertSameScope(journal, binding);
    assertSameOperationPlan(journal, binding);
    throw recoveryError("concurrent-modification", "Canonical recovery is already conflicted.");
  }

  assertSameScope(journal, binding);
  if (journal.operationId !== binding.currentOperationId) {
    throw recoveryError(
      "concurrent-modification",
      "A different canonical operation owns the pending recovery journal.",
    );
  }

  assertSameOperationPlan(journal, binding);
  const observed = await inspectMossCanonicalTarget(
    journal.canonicalRoot.rootPath,
    journal.targetPath,
  );
  if (observed.hash === journal.expectedBefore.hash) {
    return { status: "retry", record: current };
  }
  if (observed.hash !== journal.expectedAfter.hash) {
    if (!sameLease(journal, binding)) {
      throw recoveryError(
        "concurrent-modification",
        "Canonical recovery lease changed before a conflict could be recorded.",
      );
    }
    const conflictJournal = makeMossCanonicalRecoveryJournal({
      binding,
      phase: "conflict",
      observed,
      base: journal,
    });
    await appendMossCanonicalRecoveryJournal({
      ownershipStore: input.ownershipStore,
      journal: conflictJournal,
    });
    throw recoveryError(
      "concurrent-modification",
      "Canonical recovery observed neither the expected before nor after state.",
    );
  }

  let observedRecord = current;
  if (journal.phase === "intent" || journal.phase === "recovery-needed") {
    observedRecord = await appendMossCanonicalRecoveryJournal({
      ownershipStore: input.ownershipStore,
      journal: makeMossCanonicalRecoveryJournal({
        binding,
        phase: "cas-observed",
        observed,
        base: journal,
      }),
    });
  }
  const committed = await settleRecord(input.ownershipStore, observedRecord, binding, observed);
  return {
    status: "committed",
    record: committed,
    receipt: makeMossCanonicalResourceMutationReceipt(
      committed.journal,
      observed,
      committed.record,
    ),
  };
}

export function makeMossCanonicalResourceMutationReceipt(
  journal: MossCanonicalRecoveryJournal,
  observed: MossFilesystemIdentity,
  record: MossPrivateManifest,
): MossCanonicalResourceMutationReceipt {
  if (journal.phase !== "committed") {
    throw recoveryError(
      "recovery-needed",
      "Only a committed journal can produce an applied receipt.",
    );
  }
  const value = {
    schemaVersion: MOSS_CANONICAL_RECOVERY_SCHEMA_VERSION,
    transactionId: journal.transactionId,
    operationId: journal.operationId,
    idempotencyKey: journal.idempotencyKey,
    planHash: journal.planHash,
    canonicalRoot: journal.canonicalRoot,
    targetPath: journal.targetPath,
    expectedBefore: journal.expectedBefore,
    expectedAfter: journal.expectedAfter,
    observed,
    fencingToken: journal.fencingToken,
    generation: journal.generation,
    nonce: journal.nonce,
    manifest: {
      fileName: MOSS_FILESYSTEM_MANIFEST_FILE,
      sequence: record.sequence,
      previousHash: record.previousHash,
      recordHash: record.recordHash,
    },
    durable: true as const,
    afterState: [
      {
        operationId: journal.operationId,
        targetPath: journal.targetPath,
        state: observed.hash === MOSS_MISSING_HASH ? ("absent" as const) : ("present" as const),
        afterHash: observed.hash,
        durable: true as const,
      },
    ],
  };
  try {
    return Schema.decodeUnknownSync(MossCanonicalResourceMutationReceiptSchema)(value);
  } catch {
    throw recoveryError(
      "transaction-invalid",
      "Canonical mutation receipt failed strict validation.",
    );
  }
}

export async function readCommittedMossCanonicalResourceMutationReceipt(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly binding: MossCanonicalRecoveryBinding;
}): Promise<MossCanonicalResourceMutationReceipt | null> {
  const binding = normalizeBinding(input.binding);
  const current = await readMossCanonicalRecoveryRecord(input.ownershipStore);
  if (!current || current.journal.phase !== "committed") return null;
  assertSameScope(current.journal, binding);
  assertSameOperationPlan(current.journal, binding);
  if (!sameLease(current.journal, binding)) {
    throw recoveryError("concurrent-modification", "Canonical committed lease binding changed.");
  }
  const observed =
    current.journal.observed ??
    (await inspectMossCanonicalTarget(
      current.journal.canonicalRoot.rootPath,
      current.journal.targetPath,
    ));
  return makeMossCanonicalResourceMutationReceipt(current.journal, observed, current.record);
}

export function recoveryBindingForFilesystemInput(
  input: MossFilesystemCapabilityInput,
  action: MossCanonicalRecoveryAction,
  transactionId: string,
): MossCanonicalRecoveryBinding {
  const canonicalRoot = {
    ...input.canonicalRoot,
    ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
  };
  return {
    currentOperationId: input.operationId,
    currentIdempotencyKey: input.operationId,
    action,
    transactionId,
    canonicalRoot,
    targetPath: input.targetPath,
    expectedBefore: input.expected,
    expectedAfter: input.expectedAfter ?? {
      identityFingerprint: input.canonicalRoot.identityFingerprint,
      hash: input.expectedAfterHash ?? MOSS_MISSING_HASH,
    },
    fencingToken: input.fencingToken,
    generation: input.generation,
    nonce: input.nonce,
  };
}
