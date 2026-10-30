import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  MossFilesystemCapability,
  MossFilesystemCapabilityInput,
  MossOwnershipLock,
  MossOwnershipStore,
  MossPrivateStagePayload,
} from "@synara/contracts";

import {
  mossProjectionContentHash,
  mossProjectionIdentityFingerprint,
  mossProjectionPrivateManifestRecordHash,
  type MossOwnershipMutationScope,
  type MossProjectionFrozenTarget,
  type MossProjectionOwnershipMutationReceipt,
  type MossProjectionOwnershipMutationRequest,
  type MossProjectionOwnershipMutationResult,
  type MossProjectionOwnershipStore,
  type MossProjectionPrivateManifest,
  type MossProjectionPrivateManifestInput,
  type MossProjectionPrivateManifestReceipt,
  type MossProjectionTargetIdentity,
} from "./mossProjectionMaterializer";

const MISSING_HASH = createHash("sha256").update("missing").digest("hex");
const DEFAULT_STATE_FINGERPRINT = "0".repeat(64);

export interface MossProjectionOwnershipAdapterAuthority {
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly stateFingerprint?: string;
}

export interface MossProjectionOwnershipAdapterOptions {
  readonly ownershipStore: MossOwnershipStore;
  readonly filesystemCapability: MossFilesystemCapability;
  /** Server-bound identity; no projection request can replace these fields. */
  readonly authority: MossProjectionOwnershipAdapterAuthority;
  /** Optional factory liveness fence checked before every durable mutation. */
  readonly assertLive?: () => void;
  readonly now?: () => Date;
}

interface ActiveLock {
  readonly lock: MossOwnershipLock;
  readonly scope: MossOwnershipMutationScope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function authorityReceiptError(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: "concurrent-modification" });
}

function hashAuthority(input: {
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function canonicalPathFingerprint(rootPath: string): string {
  return createHash("sha256").update(rootPath).digest("hex");
}

function assertManifestInput(input: MossProjectionPrivateManifestInput): void {
  if (
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !/^[0-9a-f]{64}$/u.test(input.previousHash) ||
    !/^[0-9a-f]{64}$/u.test(input.recordHash) ||
    input.recordHash !== mossProjectionPrivateManifestRecordHash(input)
  ) {
    throw new Error("Projection private manifest input is unverifiable.");
  }
}

function projectPayload(target: MossProjectionFrozenTarget): MossPrivateStagePayload {
  if (target.kind === "symlink") {
    throw new Error("Symlink projection mutation is not supported by the native capability.");
  }
  if (target.kind === "file") return { kind: "file", content: target.content };
  return {
    kind: "directory",
    entries: target.entries.map((entry) => ({
      relativePath: entry.relativePath,
      kind: entry.kind,
      ...(entry.content ? { content: entry.content } : {}),
    })),
  };
}

function projectionKind(target: MossProjectionFrozenTarget): "skill" | "plugin" {
  if (target.kind === "symlink") {
    throw new Error("Symlink projection mutation is not supported by the native capability.");
  }
  return target.kind === "directory" ? "plugin" : "skill";
}

async function inspectAfterState(
  targetPath: string,
  expectedState: "present" | "absent",
  expectedContentHash?: string,
): Promise<
  | {
      readonly state: "present";
      readonly identity: MossProjectionTargetIdentity;
      readonly fingerprint: string;
      readonly contentHash: string;
    }
  | {
      readonly state: "absent";
      readonly fingerprint: "absent";
      readonly contentHash: "absent";
    }
> {
  const targetStat = await lstat(targetPath).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (!targetStat) {
    if (expectedState === "absent") {
      return { state: "absent", fingerprint: "absent", contentHash: "absent" };
    }
    throw new Error("Projection target is absent after a durable mutation.");
  }
  if (targetStat.isSymbolicLink() || (!targetStat.isFile() && !targetStat.isDirectory())) {
    throw new Error("Projection target is not a regular durable entry.");
  }
  const identity: MossProjectionTargetIdentity = {
    dev: String(targetStat.dev),
    ino: String(targetStat.ino),
    mode: targetStat.mode,
    ctimeMs: targetStat.ctimeMs,
  };
  const contentHash = targetStat.isFile()
    ? createHash("sha256")
        .update(await readFile(targetPath))
        .digest("hex")
    : await mossProjectionContentHash(targetPath);
  if (expectedContentHash !== undefined && contentHash !== expectedContentHash) {
    throw new Error("Projection target content hash differs from the frozen descriptor.");
  }
  return {
    state: "present",
    identity,
    fingerprint: mossProjectionIdentityFingerprint(identity),
    contentHash,
  };
}

function mutationFailure(error: unknown): MossProjectionOwnershipMutationResult {
  const code = errorCode(error);
  if (code === "durability-unsupported") {
    return { status: "unsupported", reason: "Canonical filesystem durability is unavailable." };
  }
  if (code === "recovery-needed") {
    return {
      status: "recovery-needed",
      reason: "Canonical mutation needs private-state recovery.",
    };
  }
  if (code === "concurrent-modification" || code === "conflict") {
    return { status: "conflict", reason: "Canonical projection target changed during CAS." };
  }
  return {
    status: "conflict",
    reason: error instanceof Error ? error.message : "Canonical projection mutation failed.",
  };
}

export function makeMossProjectionOwnershipAdapter(
  options: MossProjectionOwnershipAdapterOptions,
): MossProjectionOwnershipStore {
  const activeLocks = new Map<string, ActiveLock>();
  const authority = options.authority;
  const stateFingerprint =
    authority.stateFingerprint ??
    hashAuthority({
      ownerId: authority.ownerId,
      projectId: authority.projectId,
      workspaceId: authority.workspaceId,
      principalId: authority.principalId,
      sessionId: authority.sessionId,
    });
  const now = options.now ?? (() => new Date());

  const withMutationLock = async <T>(
    scope: MossOwnershipMutationScope,
    operation: (fencingToken: string) => Promise<T>,
  ): Promise<T> => {
    options.assertLive?.();
    if (scope.ownerId !== authority.ownerId) {
      throw new Error("Projection ownership owner is not server-authorized.");
    }
    const lock = await options.ownershipStore.acquireLock({
      cwd: scope.projectRoot,
      ownerId: authority.ownerId,
      projectId: authority.projectId,
      workspaceId: authority.workspaceId,
      principalId: authority.principalId,
      sessionId: authority.sessionId,
      nonce: scope.nonce,
    });
    if (
      lock.ownerId !== authority.ownerId ||
      lock.projectId !== authority.projectId ||
      lock.workspaceId !== authority.workspaceId ||
      lock.principalId !== authority.principalId ||
      lock.sessionId !== authority.sessionId ||
      lock.nonce !== scope.nonce
    ) {
      await lock.release().catch(() => undefined);
      throw new Error("Canonical projection ownership lock binding is invalid.");
    }
    options.assertLive?.();
    const key = `${scope.projectRoot}\0${scope.operationId}\0${scope.nonce}`;
    activeLocks.set(key, { lock, scope });
    try {
      options.assertLive?.();
      return await operation(lock.fencingToken);
    } finally {
      activeLocks.delete(key);
      await lock.release();
    }
  };

  const appendPrivateManifest = async (
    input: MossProjectionPrivateManifestInput,
  ): Promise<MossProjectionPrivateManifestReceipt> => {
    assertManifestInput(input);
    // A projection manifest append is part of the surrounding canonical lock.
    // The input has no authority fields, so accepting it outside an active lock
    // would let a caller manufacture a second projection chain. A materializer
    // append is always reached from withProjectionMutationLock; fail closed for
    // direct callers and for ambiguous concurrent locks.
    const active = activeLocks.size === 1 ? [...activeLocks.values()][0] : undefined;
    if (!active) {
      throw authorityReceiptError(
        "Projection private manifest append is outside one canonical authority lock.",
      );
    }
    const authorityValue = {
      ownerId: authority.ownerId,
      projectId: authority.projectId,
      workspaceId: authority.workspaceId,
      principalId: authority.principalId,
      sessionId: authority.sessionId,
      stateFingerprint,
      fencingToken: active.lock.fencingToken,
      generation: active.lock.generation,
      nonce: active.lock.nonce,
    } as const;
    const storedValue = {
      schemaVersion: 1,
      projectionSequence: input.sequence,
      projectionPreviousHash: input.previousHash,
      projectionRecordHash: input.recordHash,
      operationId: input.operationId,
      authority: authorityValue,
      value: input.value,
    } as const;
    options.assertLive?.();
    const appended = await options.ownershipStore.appendPrivateManifest({
      fileName: input.fileName,
      transactionId: input.transactionId,
      value: storedValue,
      ownerId: authority.ownerId,
      projectId: authority.projectId,
      workspaceId: authority.workspaceId,
      principalId: authority.principalId,
      sessionId: authority.sessionId,
      stateFingerprint,
      nonce: active.lock.nonce,
    });
    const readBack = await options.ownershipStore.readPrivateManifest({ fileName: input.fileName });
    const readBackValue = readBack && isRecord(readBack.value) ? readBack.value : undefined;
    const readBackAuthority =
      readBackValue && isRecord(readBackValue.authority) ? readBackValue.authority : undefined;
    const receiptAuthorityValid =
      appended.transactionId === input.transactionId &&
      appended.ownerId === authority.ownerId &&
      appended.projectId === authority.projectId &&
      appended.workspaceId === authority.workspaceId &&
      appended.principalId === authority.principalId &&
      appended.sessionId === authority.sessionId &&
      appended.stateFingerprint === stateFingerprint &&
      appended.nonce === active.lock.nonce &&
      readBack?.locator === appended.locator &&
      readBack?.transactionId === appended.transactionId &&
      readBack?.sequence === appended.sequence &&
      readBack?.previousHash === appended.previousHash &&
      readBack?.recordHash === appended.recordHash &&
      readBack?.ownerId === appended.ownerId &&
      readBack?.projectId === appended.projectId &&
      readBack?.workspaceId === appended.workspaceId &&
      readBack?.principalId === appended.principalId &&
      readBack?.sessionId === appended.sessionId &&
      readBack?.stateFingerprint === appended.stateFingerprint &&
      readBack?.nonce === appended.nonce &&
      readBackValue?.schemaVersion === storedValue.schemaVersion &&
      readBackValue?.projectionSequence === input.sequence &&
      readBackValue?.projectionPreviousHash === input.previousHash &&
      readBackValue?.projectionRecordHash === input.recordHash &&
      readBackValue?.operationId === input.operationId &&
      readBackAuthority?.ownerId === authorityValue.ownerId &&
      readBackAuthority?.projectId === authorityValue.projectId &&
      readBackAuthority?.workspaceId === authorityValue.workspaceId &&
      readBackAuthority?.principalId === authorityValue.principalId &&
      readBackAuthority?.sessionId === authorityValue.sessionId &&
      readBackAuthority?.stateFingerprint === authorityValue.stateFingerprint &&
      readBackAuthority?.fencingToken === authorityValue.fencingToken &&
      readBackAuthority?.generation === authorityValue.generation &&
      readBackAuthority?.nonce === authorityValue.nonce;
    if (!receiptAuthorityValid) {
      throw authorityReceiptError(
        "Canonical private manifest receipt did not verify its authority or chain head.",
      );
    }
    return {
      locator: appended.locator,
      transactionId: input.transactionId,
      operationId: input.operationId,
      sequence: input.sequence,
      previousHash: input.previousHash,
      recordHash: input.recordHash,
    };
  };

  const readPrivateManifest = async (input: {
    readonly fileName: string;
  }): Promise<MossProjectionPrivateManifest | null> => {
    const record = await options.ownershipStore.readPrivateManifest(input);
    if (!record || !isRecord(record.value)) return null;
    const projectionValue = record.value;
    if (
      projectionValue.schemaVersion !== 1 ||
      typeof projectionValue.projectionSequence !== "number" ||
      typeof projectionValue.projectionPreviousHash !== "string" ||
      typeof projectionValue.projectionRecordHash !== "string" ||
      typeof projectionValue.operationId !== "string" ||
      !Object.prototype.hasOwnProperty.call(projectionValue, "value")
    ) {
      return null;
    }
    return {
      locator: record.locator,
      transactionId: record.transactionId,
      operationId: projectionValue.operationId,
      sequence: projectionValue.projectionSequence,
      previousHash: projectionValue.projectionPreviousHash,
      recordHash: projectionValue.projectionRecordHash,
      value: projectionValue.value,
    };
  };

  const mutate = async (
    request: MossProjectionOwnershipMutationRequest,
    target: MossProjectionFrozenTarget | undefined,
    operation: "create" | "publish" | "replace" | "remove",
  ): Promise<MossProjectionOwnershipMutationResult> => {
    options.assertLive?.();
    if (request.ownerId !== authority.ownerId) {
      return { status: "unsupported", reason: "Projection owner is not server-authorized." };
    }
    const active = [...activeLocks.values()].find(
      (candidate) => candidate.lock.fencingToken === request.fencingToken,
    );
    if (!active) {
      return {
        status: "unsupported",
        reason: "Projection mutation is outside the canonical lock.",
      };
    }
    if (operation !== "remove" && target === undefined) {
      return { status: "unsupported", reason: "Projection mutation payload is missing." };
    }
    if (request.expectedAfterState === "present" && !request.contentHash) {
      return { status: "unsupported", reason: "Projection mutation content hash is missing." };
    }
    if (target?.kind === "symlink") {
      return {
        status: "unsupported",
        reason: "Native capability does not publish symlink projections.",
      };
    }
    try {
      const kind = target ? projectionKind(target) : "skill";
      options.assertLive?.();
      const stage =
        operation === "remove"
          ? undefined
          : await options.ownershipStore.createPrivateStage({
              transactionId: request.privateManifest.transactionId,
              operationId: request.operationId,
              kind,
              canonicalRoot: request.canonicalRoot.rootPath,
              ownerId: authority.ownerId,
              projectId: authority.projectId,
              workspaceId: authority.workspaceId,
              principalId: authority.principalId,
              sessionId: authority.sessionId,
              fencingToken: request.fencingToken,
              generation: active.lock.generation,
              nonce: active.lock.nonce,
              createdAt: now().toISOString(),
              leaseExpiresAt: new Date(now().getTime() + 300_000).toISOString(),
            });
      if (stage && !options.ownershipStore.writePrivateStage) {
        return {
          status: "unsupported",
          reason: "Canonical store cannot stage frozen projection data.",
        };
      }
      if (stage && target) {
        options.assertLive?.();
        await options.ownershipStore.writePrivateStage!({ stage, payload: projectPayload(target) });
      }
      const expectedBeforeHash =
        request.expectedBeforeHash === "absent" ? MISSING_HASH : request.expectedBeforeHash;
      const expectedAfterHash =
        request.expectedAfterState === "present" ? request.contentHash! : MISSING_HASH;
      // The shared projection root identity includes ctime for race detection.
      // The native capability's descriptor must use its stable path-bound
      // fingerprint: creating a child directory legitimately changes the
      // parent's ctime and must not turn the next engine into a false CAS race.
      const capabilityRootFingerprint = canonicalPathFingerprint(request.canonicalRoot.rootPath);
      const capabilityInput: MossFilesystemCapabilityInput = {
        cwd: request.projectRoot,
        canonicalRoot: {
          rootPath: request.canonicalRoot.rootPath,
          identityFingerprint: capabilityRootFingerprint,
          projectId: authority.projectId,
          workspaceId: authority.workspaceId,
          principalId: authority.principalId,
          sessionId: authority.sessionId,
        },
        ownerId: authority.ownerId,
        projectId: authority.projectId,
        workspaceId: authority.workspaceId,
        principalId: authority.principalId,
        sessionId: authority.sessionId,
        targetPath: resolve(request.targetAbs),
        ...(stage ? { stage } : {}),
        operationId: request.operationId,
        kind,
        fencingToken: request.fencingToken,
        generation: active.lock.generation,
        nonce: active.lock.nonce,
        expected: {
          identityFingerprint: request.canonicalRoot.identityFingerprint,
          hash: expectedBeforeHash,
        },
        expectedFingerprint: capabilityRootFingerprint,
        expectedBeforeHash,
        ...(request.expectedAfterState === "present"
          ? {
              expectedAfter: {
                identityFingerprint: request.canonicalRoot.identityFingerprint,
                hash: expectedAfterHash,
              },
              expectedAfterHash,
            }
          : { expectedAfterHash }),
      };
      options.assertLive?.();
      const capabilityResult = await options.filesystemCapability[operation](capabilityInput);
      const capabilityReceipt = capabilityResult.receipt;
      if (
        capabilityReceipt.canonicalRoot.rootPath !== capabilityInput.canonicalRoot.rootPath ||
        capabilityReceipt.canonicalRoot.identityFingerprint !== capabilityRootFingerprint ||
        capabilityReceipt.projectId !== authority.projectId ||
        capabilityReceipt.workspaceId !== authority.workspaceId ||
        capabilityReceipt.ownerId !== authority.ownerId ||
        capabilityReceipt.principalId !== authority.principalId ||
        capabilityReceipt.sessionId !== authority.sessionId ||
        capabilityReceipt.operationId !== request.operationId ||
        capabilityReceipt.fencingToken !== request.fencingToken ||
        capabilityReceipt.generation !== active.lock.generation ||
        capabilityReceipt.nonce !== active.lock.nonce ||
        capabilityReceipt.expected.hash !== expectedBeforeHash ||
        capabilityReceipt.expectedAfter?.hash !== expectedAfterHash ||
        capabilityReceipt.observed.hash !== capabilityResult.afterHash ||
        capabilityReceipt.afterHash !== capabilityResult.afterHash ||
        capabilityReceipt.durableObservedFingerprint !==
          capabilityResult.durableObservedFingerprint ||
        capabilityReceipt.durable !== true
      ) {
        throw authorityReceiptError(
          "Native filesystem capability returned an unverifiable authority receipt.",
        );
      }
      if (capabilityResult.afterHash !== expectedAfterHash) {
        return {
          status: "conflict",
          reason: "Native capability returned an unexpected after hash.",
        };
      }
      const after = await inspectAfterState(
        request.targetAbs,
        request.expectedAfterState,
        request.expectedAfterState === "present" ? request.contentHash : undefined,
      );
      options.assertLive?.();
      const manifest = await appendPrivateManifest(request.privateManifest);
      const receipt: MossProjectionOwnershipMutationReceipt = {
        operationId: request.operationId,
        canonicalRoot: request.canonicalRoot,
        expectedFingerprint: request.expectedFingerprint,
        observedFingerprint: after.fingerprint,
        expectedBeforeHash: request.expectedBeforeHash,
        after,
        fencingToken: request.fencingToken,
        generation: request.generation,
        nonce: request.nonce,
        manifest,
        durable: true,
      };
      return { status: "applied", receipt };
    } catch (error) {
      return mutationFailure(error);
    }
  };

  return {
    withMutationLock,
    appendPrivateManifest,
    readPrivateManifest,
    create: (request, target) => mutate(request, target, "create"),
    publish: (request, target) => mutate(request, target, "publish"),
    replace: (request, target) => mutate(request, target, "replace"),
    remove: (request) => mutate(request, undefined, "remove"),
  };
}
