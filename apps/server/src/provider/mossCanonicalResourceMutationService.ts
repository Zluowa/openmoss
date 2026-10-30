import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type {
  MossCanonicalResourceMutationReceipt,
  MossCanonicalResourceMutationPayload,
  MossCreateResourceInput,
  MossCreateResourceResult,
  MossDeleteResourceInput,
  MossDeleteResourceResult,
  MossFilesystemCapability,
  MossFilesystemCapabilityInput,
  MossOwnershipLock,
  MossOwnershipStore,
  MossPrivateStage,
  MossPrivateStageInput,
  MossPrivateStagePayload,
  MossUpdateResourceInput,
  MossUpdateResourcePayload,
  MossUpdateResourceResult,
} from "@synara/contracts";
import { getMossSourceLayout } from "@synara/shared/mossSourceLayout";

import {
  canonicalMutationPlanHash,
  readCommittedMossCanonicalResourceMutationReceipt,
  readMossCanonicalRecoveryRecord,
  recoverMossCanonicalResourceMutation,
} from "./mossCanonicalResourceRecovery.ts";
import type { MossCanonicalRecoveryOutcome } from "./mossCanonicalResourceRecovery.ts";
import {
  hashMossCanonicalResource,
  MOSS_CANONICAL_MISSING_HASH,
} from "./mossCanonicalResourceHash.ts";
import { MossResourceImportError } from "./mossResourceImport.ts";
import { slugifyResourceName } from "./mossCreateResource.ts";
import {
  resolveMossCanonicalMutationPlan,
  type MossCanonicalMutationPlanScope,
} from "./mossCanonicalMutationIntent.ts";

const MISSING_HASH = MOSS_CANONICAL_MISSING_HASH;

export interface MossCanonicalResourceMutationContext {
  readonly cwd: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly issuer: string;
}

export interface MossCanonicalResourceMutationServiceOptions {
  readonly ownershipStore: MossOwnershipStore;
  readonly filesystemCapability: MossFilesystemCapability;
  readonly stateDir: string;
  readonly now?: () => Date;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function mutationError(
  code: ConstructorParameters<typeof MossResourceImportError>[0],
  message: string,
) {
  return new MossResourceImportError(code, message);
}

type MossCanonicalMutationInput =
  | MossCreateResourceInput
  | MossDeleteResourceInput
  | MossUpdateResourceInput;

function isWithin(root: string, candidate: string, strict = false): boolean {
  const rootResolved = nodePath.resolve(root);
  const candidateResolved = nodePath.resolve(candidate);
  if (!strict && rootResolved === candidateResolved) return true;
  if (rootResolved === candidateResolved) return false;
  const relative = nodePath.relative(rootResolved, candidateResolved);
  return relative !== "" && !relative.startsWith("..") && !nodePath.isAbsolute(relative);
}

async function lstatOrNull(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      return null;
    }
    throw cause;
  }
}

async function canonicalHash(rootPath: string, targetPath: string): Promise<string> {
  return (
    await hashMossCanonicalResource({
      rootPath,
      targetPath,
    })
  ).hash;
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  const stat = await lstatOrNull(filePath);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw mutationError("symlink-escape", "Canonical JSON resource is not a regular file.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw mutationError("invalid-json", `Canonical JSON resource is invalid: ${filePath}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw mutationError("invalid-json", `Canonical JSON resource is not an object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function canonicalRoot(context: MossCanonicalResourceMutationContext): string {
  return nodePath.resolve(getMossSourceLayout(context.cwd).root);
}

async function assertCanonicalTargetSafety(
  context: MossCanonicalResourceMutationContext,
  targetPath: string,
): Promise<void> {
  const rootPath = canonicalRoot(context);
  const resolvedTarget = nodePath.resolve(targetPath);
  if (!isWithin(rootPath, resolvedTarget, true)) {
    throw mutationError("path-traversal", "The canonical target leaves the Moss root.");
  }
  const rootStat = await lstatOrNull(rootPath);
  if (rootStat?.isSymbolicLink()) {
    throw mutationError("symlink-escape", "The canonical Moss root is a symlink.");
  }
  if (rootStat && !rootStat.isDirectory()) {
    throw mutationError("symlink-escape", "The canonical Moss root is not a directory.");
  }
  let current = rootPath;
  const relativeParent = nodePath.relative(rootPath, nodePath.dirname(resolvedTarget));
  for (const segment of relativeParent.split(nodePath.sep).filter(Boolean)) {
    current = nodePath.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw mutationError("symlink-escape", "The canonical target parent is unsafe.");
    }
  }
  const targetStat = await lstatOrNull(resolvedTarget);
  if (targetStat?.isSymbolicLink()) {
    throw mutationError("symlink-escape", "The canonical target is a symlink.");
  }
}

function targetFor(
  input: MossCanonicalResourceMutationPayload,
  context: MossCanonicalResourceMutationContext,
): string {
  const layout = getMossSourceLayout(context.cwd);
  if (input.kind === "mcp") return layout.mcpConfig;
  const root = input.kind === "skill" ? layout.skillsRoot : layout.pluginsRoot;
  const slug = slugifyResourceName(input.name);
  if (!slug) throw mutationError("invalid-identity", "The canonical resource name is invalid.");
  if ("path" in input && input.path) {
    const candidate = nodePath.resolve(input.path);
    if (input.kind === "plugin" && nodePath.basename(candidate) === "plugin.json") {
      if (!isWithin(root, nodePath.dirname(candidate), true)) {
        throw mutationError("path-traversal", "The plugin target leaves the canonical root.");
      }
      return nodePath.dirname(candidate);
    }
    if (!isWithin(root, candidate, true)) {
      throw mutationError("path-traversal", "The canonical target leaves the canonical root.");
    }
    return candidate;
  }
  return input.kind === "skill" ? nodePath.join(root, slug, "SKILL.md") : nodePath.join(root, slug);
}

function descriptor(
  context: MossCanonicalResourceMutationContext,
): MossFilesystemCapabilityInput["canonicalRoot"] {
  const rootPath = canonicalRoot(context);
  return {
    rootPath,
    identityFingerprint: sha256(rootPath),
    ownerId: context.ownerId,
    projectId: context.projectId,
    workspaceId: context.workspaceId,
    principalId: context.principalId,
    sessionId: context.sessionId,
  };
}

async function recoverServiceMutation(input: {
  readonly options: MossCanonicalResourceMutationServiceOptions;
  readonly context: MossCanonicalResourceMutationContext;
  readonly lock: MossOwnershipLock;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly action: "create" | "publish" | "replace" | "remove";
  readonly targetPath: string;
  readonly beforeHash: string;
  readonly afterHash: string;
}): Promise<MossCanonicalRecoveryOutcome> {
  const root = descriptor(input.context);
  const latest = await readMossCanonicalRecoveryRecord(input.options.ownershipStore);
  let expectedBefore = { identityFingerprint: root.identityFingerprint, hash: input.beforeHash };
  let expectedAfter = { identityFingerprint: root.identityFingerprint, hash: input.afterHash };
  const transactionId = `transaction-${input.operationId}`;
  if (latest?.journal.operationId === input.operationId) {
    if (
      latest.journal.transactionId !== transactionId ||
      latest.journal.idempotencyKey !== input.idempotencyKey ||
      latest.journal.action !== input.action ||
      latest.journal.targetPath !== input.targetPath ||
      latest.journal.expectedAfter.identityFingerprint !== root.identityFingerprint ||
      latest.journal.expectedAfter.hash !== input.afterHash
    ) {
      throw mutationError(
        "concurrent-modification",
        "Canonical recovery idempotency binding changed.",
      );
    }
    expectedBefore = latest.journal.expectedBefore;
    expectedAfter = latest.journal.expectedAfter;
  }
  return recoverMossCanonicalResourceMutation({
    ownershipStore: input.options.ownershipStore,
    binding: {
      currentOperationId: input.operationId,
      currentIdempotencyKey: input.idempotencyKey,
      action: input.action,
      transactionId,
      canonicalRoot: root,
      targetPath: input.targetPath,
      expectedBefore,
      expectedAfter,
      fencingToken: input.lock.fencingToken,
      generation: input.lock.generation,
      nonce: input.lock.nonce,
    },
  });
}

async function committedServiceReceipt(input: {
  readonly options: MossCanonicalResourceMutationServiceOptions;
  readonly context: MossCanonicalResourceMutationContext;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly action: "create" | "publish" | "replace" | "remove";
  readonly lock: MossOwnershipLock;
  readonly targetPath: string;
  readonly beforeHash?: string;
  readonly afterHash?: string;
}): Promise<MossCanonicalResourceMutationReceipt | null> {
  const root = descriptor(input.context);
  const receipt = await readCommittedMossCanonicalResourceMutationReceipt({
    ownershipStore: input.options.ownershipStore,
    binding: {
      currentOperationId: input.operationId,
      currentIdempotencyKey: input.idempotencyKey,
      action: input.action,
      transactionId: `transaction-${input.operationId}`,
      canonicalRoot: root,
      targetPath: input.targetPath,
      expectedBefore: {
        identityFingerprint: root.identityFingerprint,
        hash: input.beforeHash ?? MISSING_HASH,
      },
      expectedAfter: {
        identityFingerprint: root.identityFingerprint,
        hash: input.afterHash ?? MISSING_HASH,
      },
      fencingToken: input.lock.fencingToken,
      generation: input.lock.generation,
      nonce: input.lock.nonce,
    },
  });
  if (!receipt) return null;
  if (
    receipt.transactionId !== `transaction-${input.operationId}` ||
    receipt.operationId !== input.operationId ||
    receipt.idempotencyKey !== input.idempotencyKey ||
    receipt.targetPath !== input.targetPath ||
    receipt.canonicalRoot.rootPath !== root.rootPath ||
    receipt.canonicalRoot.identityFingerprint !== root.identityFingerprint ||
    receipt.canonicalRoot.ownerId !== input.context.ownerId ||
    receipt.canonicalRoot.projectId !== input.context.projectId ||
    receipt.canonicalRoot.workspaceId !== input.context.workspaceId ||
    receipt.canonicalRoot.principalId !== input.context.principalId ||
    receipt.canonicalRoot.sessionId !== input.context.sessionId ||
    receipt.fencingToken !== input.lock.fencingToken ||
    receipt.generation !== input.lock.generation ||
    receipt.nonce !== input.lock.nonce ||
    receipt.expectedBefore.identityFingerprint !== root.identityFingerprint ||
    receipt.expectedAfter.identityFingerprint !== root.identityFingerprint ||
    (input.beforeHash !== undefined && receipt.expectedBefore.hash !== input.beforeHash) ||
    (input.afterHash !== undefined && receipt.expectedAfter.hash !== input.afterHash) ||
    receipt.planHash !==
      canonicalMutationPlanHash({
        operationId: input.operationId,
        targetPath: input.targetPath,
        beforeHash: receipt.expectedBefore.hash,
        afterHash: receipt.expectedAfter.hash,
      }) ||
    receipt.durable !== true
  ) {
    throw mutationError("transaction-invalid", "Canonical committed receipt failed verification.");
  }
  return receipt;
}

function assertDurableMutationResult(input: {
  readonly result: Awaited<ReturnType<MossFilesystemCapability["create"]>>;
  readonly context: MossCanonicalResourceMutationContext;
  readonly root: MossFilesystemCapabilityInput["canonicalRoot"];
  readonly lock: MossOwnershipLock;
  readonly operationId: string;
  readonly beforeHash: string;
  readonly afterHash: string;
}): void {
  const receipt = input.result.receipt;
  if (
    receipt.durable !== true ||
    input.result.afterHash !== input.afterHash ||
    receipt.afterHash !== input.afterHash ||
    receipt.canonicalRoot.rootPath !== input.root.rootPath ||
    receipt.canonicalRoot.identityFingerprint !== input.root.identityFingerprint ||
    receipt.canonicalRoot.ownerId !== input.context.ownerId ||
    receipt.canonicalRoot.projectId !== input.context.projectId ||
    receipt.canonicalRoot.workspaceId !== input.context.workspaceId ||
    receipt.canonicalRoot.principalId !== input.context.principalId ||
    receipt.canonicalRoot.sessionId !== input.context.sessionId ||
    receipt.ownerId !== input.context.ownerId ||
    receipt.projectId !== input.context.projectId ||
    receipt.workspaceId !== input.context.workspaceId ||
    receipt.principalId !== input.context.principalId ||
    receipt.sessionId !== input.context.sessionId ||
    receipt.operationId !== input.operationId ||
    receipt.fencingToken !== input.lock.fencingToken ||
    receipt.generation !== input.lock.generation ||
    receipt.nonce !== input.lock.nonce ||
    receipt.expected.hash !== input.beforeHash ||
    receipt.expected.identityFingerprint !== input.root.identityFingerprint ||
    receipt.expectedAfter?.hash !== input.afterHash ||
    receipt.expectedAfter?.identityFingerprint !== input.root.identityFingerprint ||
    receipt.observed.hash !== input.afterHash ||
    input.result.observed.hash !== input.afterHash ||
    receipt.durableObservedFingerprint !== input.result.durableObservedFingerprint ||
    receipt.observed.identityFingerprint !== input.result.durableObservedFingerprint
  ) {
    throw mutationError("transaction-invalid", "Canonical mutation receipt could not be verified.");
  }
}

async function stagePayload(
  options: MossCanonicalResourceMutationServiceOptions,
  context: MossCanonicalResourceMutationContext,
  lock: MossOwnershipLock,
  operationId: string,
  transactionId: string,
  kind: "skill" | "plugin" | "mcp",
  payload: MossPrivateStagePayload,
): Promise<MossPrivateStage> {
  if (!options.ownershipStore.writePrivateStage) {
    throw mutationError(
      "durability-unsupported",
      "The canonical store cannot stage mutations durably.",
    );
  }
  const stageInput: MossPrivateStageInput = {
    transactionId,
    operationId,
    kind,
    canonicalRoot: canonicalRoot(context),
    ownerId: context.ownerId,
    projectId: context.projectId,
    workspaceId: context.workspaceId,
    principalId: context.principalId,
    sessionId: context.sessionId,
    fencingToken: lock.fencingToken,
    generation: lock.generation,
    nonce: lock.nonce,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    leaseExpiresAt: new Date(
      (options.now ?? (() => new Date()))().valueOf() + 5 * 60 * 1_000,
    ).toISOString(),
  };
  const stage = await options.ownershipStore.createPrivateStage(stageInput);
  await options.ownershipStore.writePrivateStage({ stage, payload });
  return stage;
}

async function mutateFile(
  options: MossCanonicalResourceMutationServiceOptions,
  context: MossCanonicalResourceMutationContext,
  lock: MossOwnershipLock,
  input: {
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly kind: "skill" | "plugin" | "mcp";
    readonly targetPath: string;
    readonly beforeHash: string;
    readonly afterHash: string;
    readonly payload: MossPrivateStagePayload;
    readonly action: "create" | "publish" | "replace";
  },
): Promise<MossCanonicalResourceMutationReceipt> {
  const recovered = await recoverServiceMutation({
    options,
    context,
    lock,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    action: input.action,
    targetPath: input.targetPath,
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
  });
  if (recovered.status === "committed") return recovered.receipt;
  const stage = await stagePayload(
    options,
    context,
    lock,
    input.operationId,
    recovered.status === "retry"
      ? recovered.record.journal.transactionId
      : `transaction-${input.operationId}`,
    input.kind,
    input.payload,
  );
  const root = descriptor(context);
  const result = await options.filesystemCapability[input.action]({
    cwd: context.cwd,
    canonicalRoot: root,
    projectId: context.projectId,
    workspaceId: context.workspaceId,
    ownerId: context.ownerId,
    principalId: context.principalId,
    sessionId: context.sessionId,
    targetPath: input.targetPath,
    stage,
    operationId: input.operationId,
    kind: input.kind,
    fencingToken: lock.fencingToken,
    generation: lock.generation,
    nonce: lock.nonce,
    expected: { identityFingerprint: root.identityFingerprint, hash: input.beforeHash },
    expectedFingerprint: root.identityFingerprint,
    expectedBeforeHash: input.beforeHash,
    expectedAfter: { identityFingerprint: root.identityFingerprint, hash: input.afterHash },
    expectedAfterHash: input.afterHash,
  });
  assertDurableMutationResult({
    result,
    context,
    root,
    lock,
    operationId: input.operationId,
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
  });
  const receipt = await committedServiceReceipt({
    options,
    context,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    action: input.action,
    lock,
    targetPath: input.targetPath,
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
  });
  if (!receipt) {
    throw mutationError(
      "recovery-needed",
      "Canonical filesystem mutation completed without a committed recovery receipt.",
    );
  }
  return receipt;
}

async function mutateRemove(
  options: MossCanonicalResourceMutationServiceOptions,
  context: MossCanonicalResourceMutationContext,
  lock: MossOwnershipLock,
  input: {
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly kind: "skill" | "plugin" | "mcp";
    readonly targetPath: string;
    readonly beforeHash: string;
  },
): Promise<MossCanonicalResourceMutationReceipt> {
  const root = descriptor(context);
  const recovered = await recoverServiceMutation({
    options,
    context,
    lock,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    action: "remove",
    targetPath: input.targetPath,
    beforeHash: input.beforeHash,
    afterHash: MISSING_HASH,
  });
  if (recovered.status === "committed") return recovered.receipt;
  const result = await options.filesystemCapability.remove({
    cwd: context.cwd,
    canonicalRoot: root,
    projectId: context.projectId,
    workspaceId: context.workspaceId,
    ownerId: context.ownerId,
    principalId: context.principalId,
    sessionId: context.sessionId,
    targetPath: input.targetPath,
    operationId: input.operationId,
    kind: input.kind,
    fencingToken: lock.fencingToken,
    generation: lock.generation,
    nonce: lock.nonce,
    expected: { identityFingerprint: root.identityFingerprint, hash: input.beforeHash },
    expectedFingerprint: root.identityFingerprint,
    expectedBeforeHash: input.beforeHash,
    expectedAfter: { identityFingerprint: root.identityFingerprint, hash: MISSING_HASH },
    expectedAfterHash: MISSING_HASH,
  });
  assertDurableMutationResult({
    result,
    context,
    root,
    lock,
    operationId: input.operationId,
    beforeHash: input.beforeHash,
    afterHash: MISSING_HASH,
  });
  const receipt = await committedServiceReceipt({
    options,
    context,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    action: "remove",
    lock,
    targetPath: input.targetPath,
    beforeHash: input.beforeHash,
    afterHash: MISSING_HASH,
  });
  if (!receipt) {
    throw mutationError(
      "recovery-needed",
      "Canonical filesystem removal completed without a committed recovery receipt.",
    );
  }
  return receipt;
}

function lockInput(context: MossCanonicalResourceMutationContext, nonce: string) {
  return {
    cwd: context.cwd,
    ownerId: context.ownerId,
    workspaceId: context.workspaceId,
    projectId: context.projectId,
    principalId: context.principalId,
    sessionId: context.sessionId,
    nonce,
  } as const;
}

export function makeMossCanonicalResourceMutationService(
  options: MossCanonicalResourceMutationServiceOptions,
) {
  const nextOperationIdentity = async (
    input: MossCanonicalMutationInput,
    context: MossCanonicalResourceMutationContext,
    action: "create" | "delete" | "update",
  ): Promise<{
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly payload: MossCanonicalResourceMutationPayload;
  }> => {
    if (Object.prototype.hasOwnProperty.call(input, "idempotencyKey")) {
      throw mutationError(
        "invalid-identity",
        "Canonical mutation idempotency keys are server-derived and cannot be supplied by clients.",
      );
    }
    if (typeof input.planId !== "string" || typeof input.operationId !== "string") {
      throw mutationError(
        "invalid-identity",
        "Canonical mutation requires server-issued plan and operation identifiers.",
      );
    }
    const scope: MossCanonicalMutationPlanScope = {
      cwd: context.cwd,
      issuer: context.issuer,
      ownerId: context.ownerId,
      projectId: context.projectId,
      principalId: context.principalId,
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
    };
    try {
      const plan = await resolveMossCanonicalMutationPlan({
        ownershipStore: options.ownershipStore,
        planId: input.planId,
        operationId: input.operationId,
        scope,
        action,
        now: (options.now ?? (() => new Date()))(),
      });
      return {
        operationId: plan.intentKey,
        idempotencyKey: plan.intentKey,
        payload: plan.payload,
      };
    } catch (cause) {
      if (cause instanceof Error && "code" in cause) {
        const code = (cause as { readonly code?: unknown }).code;
        if (
          code === "invalid-identity" ||
          code === "plan-invalid" ||
          code === "plan-expired" ||
          code === "authorization-required" ||
          code === "ticket-mismatch" ||
          code === "transaction-invalid" ||
          code === "plan-budget-exceeded" ||
          code === "concurrent-modification" ||
          code === "durability-unsupported"
        ) {
          throw mutationError(code, cause.message);
        }
      }
      throw cause;
    }
  };

  const runLocked = async <T>(
    context: MossCanonicalResourceMutationContext,
    operation: (lock: MossOwnershipLock) => Promise<T>,
  ): Promise<T> => {
    const nonce = `mutation-nonce-${randomUUID()}`;
    const lock = await options.ownershipStore.acquireLock(lockInput(context, nonce));
    try {
      if (
        lock.ownerId !== context.ownerId ||
        lock.projectId !== context.projectId ||
        lock.workspaceId !== context.workspaceId ||
        lock.principalId !== context.principalId ||
        lock.sessionId !== context.sessionId ||
        lock.nonce !== nonce
      ) {
        throw mutationError(
          "authorization-required",
          "Canonical ownership lock authority mismatched.",
        );
      }
      return await operation(lock);
    } finally {
      await lock.release();
    }
  };

  const create = async (
    request: MossCreateResourceInput,
    context: MossCanonicalResourceMutationContext,
  ): Promise<MossCreateResourceResult> => {
    const {
      operationId,
      idempotencyKey,
      payload: input,
    } = await nextOperationIdentity(request, context, "create");
    return runLocked(context, async (lock) => {
      const targetPath = targetFor(input, context);
      await assertCanonicalTargetSafety(context, targetPath);
      if (input.kind === "skill") {
        const content = [
          "---",
          `name: ${input.name}`,
          `description: ${input.description ?? `The ${input.name} skill.`}`,
          "enabled: true",
          "---",
          "",
          `# ${input.name}`,
          "",
          input.description ?? `The ${input.name} skill.`,
          "",
        ].join("\n");
        const afterHash = sha256(new TextEncoder().encode(content));
        const existing = await lstatOrNull(targetPath);
        if (existing) {
          const recovered = await recoverServiceMutation({
            options,
            context,
            lock,
            operationId,
            idempotencyKey,
            action: "create",
            targetPath,
            beforeHash: MISSING_HASH,
            afterHash,
          });
          if (recovered.status === "committed") {
            return {
              kind: input.kind,
              name: input.name,
              path: targetPath,
              created: true,
              receipt: recovered.receipt,
            };
          }
          return { kind: input.kind, name: input.name, path: targetPath, created: false };
        }
        const receipt = await mutateFile(options, context, lock, {
          operationId,
          idempotencyKey,
          kind: "skill",
          targetPath,
          beforeHash: MISSING_HASH,
          afterHash,
          payload: { kind: "file", content: new TextEncoder().encode(content) },
          action: "create",
        });
        return { kind: input.kind, name: input.name, path: targetPath, created: true, receipt };
      }
      if (input.kind === "plugin") {
        const manifest = {
          ...(input.plugin?.id ? { id: input.plugin.id } : {}),
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          enabled: true,
          source: "moss-unified-source",
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.plugin?.interface ? { interface: input.plugin.interface } : {}),
          ...(input.plugin?.apps?.length ? { apps: input.plugin.apps } : {}),
          ...(input.plugin?.skills?.length ? { skills: input.plugin.skills } : {}),
          ...(input.plugin?.mcpServers?.length ? { mcpServers: input.plugin.mcpServers } : {}),
        };
        const content = `${JSON.stringify(manifest, null, 2)}\n`;
        const afterHash = sha256(`plugin.json\0${sha256(new TextEncoder().encode(content))}`);
        const existing = await lstatOrNull(targetPath);
        if (existing) {
          const recovered = await recoverServiceMutation({
            options,
            context,
            lock,
            operationId,
            idempotencyKey,
            action: "publish",
            targetPath,
            beforeHash: MISSING_HASH,
            afterHash,
          });
          if (recovered.status === "committed") {
            return {
              kind: input.kind,
              name: input.name,
              path: nodePath.join(targetPath, "plugin.json"),
              created: true,
              receipt: recovered.receipt,
            };
          }
          return {
            kind: input.kind,
            name: input.name,
            path: nodePath.join(targetPath, "plugin.json"),
            created: false,
          };
        }
        const receipt = await mutateFile(options, context, lock, {
          operationId,
          idempotencyKey,
          kind: "plugin",
          targetPath,
          beforeHash: MISSING_HASH,
          afterHash,
          payload: {
            kind: "directory",
            entries: [
              {
                relativePath: "plugin.json",
                kind: "file",
                content: new TextEncoder().encode(content),
              },
            ],
          },
          action: "publish",
        });
        return {
          kind: input.kind,
          name: input.name,
          path: nodePath.join(targetPath, "plugin.json"),
          created: true,
          receipt,
        };
      }
      if (!input.command && !input.url) {
        throw mutationError("invalid-identity", "An MCP server needs a command or URL.");
      }
      const config = (await readJson(targetPath)) ?? {};
      const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
      const next = {
        ...config,
        mcpServers: {
          ...servers,
          [input.name]: {
            ...(input.command ? { command: input.command } : {}),
            ...(input.args?.length ? { args: [...input.args] } : {}),
            ...(input.url ? { url: input.url } : {}),
          },
        },
      };
      const content = `${JSON.stringify(next, null, 2)}\n`;
      const beforeHash = await canonicalHash(canonicalRoot(context), targetPath);
      const afterHash = sha256(new TextEncoder().encode(content));
      if (Object.prototype.hasOwnProperty.call(servers, input.name)) {
        const latest = await readMossCanonicalRecoveryRecord(options.ownershipStore);
        const action =
          latest?.journal.operationId === operationId
            ? latest.journal.action
            : beforeHash === MISSING_HASH
              ? ("create" as const)
              : ("replace" as const);
        const recovered = await recoverServiceMutation({
          options,
          context,
          lock,
          operationId,
          idempotencyKey,
          action,
          targetPath,
          beforeHash,
          afterHash,
        });
        if (recovered.status === "committed") {
          return {
            kind: input.kind,
            name: input.name,
            path: targetPath,
            created: true,
            receipt: recovered.receipt,
          };
        }
        return { kind: input.kind, name: input.name, path: targetPath, created: false };
      }
      const receipt = await mutateFile(options, context, lock, {
        operationId,
        idempotencyKey,
        kind: "mcp",
        targetPath,
        beforeHash,
        afterHash,
        payload: { kind: "file", content: new TextEncoder().encode(content) },
        action: beforeHash === MISSING_HASH ? "create" : "replace",
      });
      return { kind: input.kind, name: input.name, path: targetPath, created: true, receipt };
    });
  };

  const remove = async (
    request: MossDeleteResourceInput,
    context: MossCanonicalResourceMutationContext,
  ): Promise<MossDeleteResourceResult> => {
    const {
      operationId,
      idempotencyKey,
      payload: input,
    } = await nextOperationIdentity(request, context, "delete");
    return runLocked(context, async (lock) => {
      const targetPath = targetFor(input, context);
      await assertCanonicalTargetSafety(context, targetPath);
      if (input.kind === "mcp") {
        const config = await readJson(targetPath);
        if (!config)
          return { kind: input.kind, name: input.name, removed: false, path: targetPath };
        const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
        if (!Object.prototype.hasOwnProperty.call(servers, input.name)) {
          const currentHash = await canonicalHash(canonicalRoot(context), targetPath);
          const recovered = await recoverServiceMutation({
            options,
            context,
            lock,
            operationId,
            idempotencyKey,
            action: "replace",
            targetPath,
            beforeHash: currentHash,
            afterHash: currentHash,
          });
          if (recovered.status === "committed") {
            return {
              kind: input.kind,
              name: input.name,
              removed: true,
              path: targetPath,
              receipt: recovered.receipt,
            };
          }
          return { kind: input.kind, name: input.name, removed: false, path: targetPath };
        }
        const nextServers = { ...servers };
        delete nextServers[input.name];
        const content = `${JSON.stringify({ ...config, mcpServers: nextServers }, null, 2)}\n`;
        const receipt = await mutateFile(options, context, lock, {
          operationId,
          idempotencyKey,
          kind: "mcp",
          targetPath,
          beforeHash: await canonicalHash(canonicalRoot(context), targetPath),
          afterHash: sha256(new TextEncoder().encode(content)),
          payload: { kind: "file", content: new TextEncoder().encode(content) },
          action: "replace",
        });
        return { kind: input.kind, name: input.name, removed: true, path: targetPath, receipt };
      }
      const existing = await lstatOrNull(targetPath);
      if (!existing) {
        const recovered = await recoverServiceMutation({
          options,
          context,
          lock,
          operationId,
          idempotencyKey,
          action: "remove",
          targetPath,
          beforeHash: MISSING_HASH,
          afterHash: MISSING_HASH,
        });
        if (recovered.status === "committed") {
          return {
            kind: input.kind,
            name: input.name,
            removed: true,
            path: targetPath,
            receipt: recovered.receipt,
          };
        }
        return { kind: input.kind, name: input.name, removed: false, path: targetPath };
      }
      const receipt = await mutateRemove(options, context, lock, {
        operationId,
        idempotencyKey,
        kind: input.kind,
        targetPath,
        beforeHash: await canonicalHash(canonicalRoot(context), targetPath),
      });
      return { kind: input.kind, name: input.name, removed: true, path: targetPath, receipt };
    });
  };

  const update = async (
    request: MossUpdateResourceInput,
    context: MossCanonicalResourceMutationContext,
  ): Promise<MossUpdateResourceResult> => {
    const {
      operationId,
      idempotencyKey,
      payload: resolvedInput,
    } = await nextOperationIdentity(request, context, "update");
    const input = resolvedInput as MossUpdateResourcePayload & {
      readonly kind: "plugin" | "mcp";
    };
    const enabled = input.enabled as boolean;
    if (input.kind !== "plugin" && input.kind !== "mcp") {
      throw mutationError("invalid-identity", "Only plugin and MCP resources can be updated.");
    }
    return runLocked(context, async (lock) => {
      const targetPath = targetFor(input, context);
      await assertCanonicalTargetSafety(context, targetPath);
      let targetFile = targetPath;
      let config: Record<string, unknown> | null;
      if (input.kind === "plugin") targetFile = nodePath.join(targetPath, "plugin.json");
      config = await readJson(input.kind === "plugin" ? targetFile : targetPath);
      if (input.kind === "plugin") {
        if (!config)
          return {
            kind: input.kind,
            name: input.name,
            enabled,
            updated: false,
            path: targetFile,
          };
        const content = `${JSON.stringify({ ...config, enabled }, null, 2)}\n`;
        const receipt = await mutateFile(options, context, lock, {
          operationId,
          idempotencyKey,
          kind: "plugin",
          targetPath: targetFile,
          beforeHash: await canonicalHash(canonicalRoot(context), targetFile),
          afterHash: sha256(new TextEncoder().encode(content)),
          payload: { kind: "file", content: new TextEncoder().encode(content) },
          action: "replace",
        });
        return {
          kind: input.kind,
          name: input.name,
          enabled,
          updated: true,
          path: targetFile,
          receipt,
        };
      }
      if (!config)
        return {
          kind: input.kind,
          name: input.name,
          enabled,
          updated: false,
          path: targetPath,
        };
      const servers = config.mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
        return {
          kind: input.kind,
          name: input.name,
          enabled,
          updated: false,
          path: targetPath,
        };
      }
      const current = (servers as Record<string, unknown>)[input.name];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return {
          kind: input.kind,
          name: input.name,
          enabled,
          updated: false,
          path: targetPath,
        };
      }
      const content = `${JSON.stringify(
        {
          ...config,
          mcpServers: {
            ...(servers as Record<string, unknown>),
            [input.name]: { ...(current as Record<string, unknown>), enabled },
          },
        },
        null,
        2,
      )}\n`;
      const receipt = await mutateFile(options, context, lock, {
        operationId,
        idempotencyKey,
        kind: "mcp",
        targetPath,
        beforeHash: await canonicalHash(canonicalRoot(context), targetPath),
        afterHash: sha256(new TextEncoder().encode(content)),
        payload: { kind: "file", content: new TextEncoder().encode(content) },
        action: "replace",
      });
      return {
        kind: input.kind,
        name: input.name,
        enabled,
        updated: true,
        path: targetPath,
        receipt,
      };
    });
  };

  return { create, delete: remove, update };
}
