import { supportsPosixPermissions } from "@synara/shared/filesystemPlatform";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  MossCanonicalResourceMutationPayload,
  MossResourceImportPlan as MossResourceImportPlanSchema,
  type MossCanonicalResourceMutationAction,
  type MossCanonicalResourceMutationPayload as MossCanonicalResourceMutationPayloadType,
  type MossOwnershipStore,
  type MossResourceImportPlan,
} from "@synara/contracts";
import { Schema } from "effect";
import { getMossSourceLayout } from "@synara/shared/mossSourceLayout";

import { slugifyResourceName } from "./mossCreateResource.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/iu;
const CANONICAL_PLAN_SCHEMA_VERSION = 1 as const;
const CANONICAL_PLAN_PREFIX = "canonical-plans";
const IMPORT_PLAN_PREFIX = "import-plans";
const PLAN_GC_PREFIX = "plan-gc";
const DEFAULT_MAX_PLANS_PER_WORKSPACE = 128;
const DEFAULT_MAX_PLAN_BYTES_PER_WORKSPACE = 2 * 1024 * 1024;
const DEFAULT_MAX_PLAN_TOMBSTONES = 64;
const MAX_PLAN_REGISTRY_LIMIT = 1_000;
const MAX_PLAN_REGISTRY_BYTES = 16 * 1024 * 1024;

export type MossCanonicalMutationIntentErrorCode =
  | "invalid-identity"
  | "plan-invalid"
  | "plan-expired"
  | "plan-budget-exceeded"
  | "authorization-required"
  | "ticket-mismatch"
  | "transaction-invalid"
  | "concurrent-modification"
  | "durability-unsupported";

export class MossCanonicalMutationIntentError extends Error {
  readonly code: MossCanonicalMutationIntentErrorCode;

  constructor(code: MossCanonicalMutationIntentErrorCode, message: string) {
    super(message);
    this.name = "MossCanonicalMutationIntentError";
    this.code = code;
  }
}

export interface MossCanonicalMutationPlan {
  readonly schemaVersion: typeof CANONICAL_PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly operationId: string;
  readonly planHash: string;
  readonly action: MossCanonicalResourceMutationAction;
  readonly payload: MossCanonicalResourceMutationPayloadType;
  readonly cwd: string;
  readonly canonicalRoot: string;
  readonly targetPath: string;
  readonly issuer: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly expiresAt: string;
  readonly selectionTicketDigest?: string;
}

export interface MossCanonicalMutationPlanScope {
  readonly cwd: string;
  readonly issuer: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
}

export interface MossPrivatePlanRegistryOptions {
  readonly maxPlansPerWorkspace?: number;
  readonly maxBytesPerWorkspace?: number;
  readonly maxTombstoneRecords?: number;
}

export interface MossCanonicalMutationPlanResolution extends MossCanonicalMutationPlan {
  readonly intentKey: string;
}

function sha256(value: string): string {
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

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new MossCanonicalMutationIntentError("invalid-identity", `${label} is invalid.`);
  }
}

function assertHash(value: string, label: string): void {
  if (!HASH_PATTERN.test(value)) {
    throw new MossCanonicalMutationIntentError("transaction-invalid", `${label} is invalid.`);
  }
}

function isExpired(expiresAt: string, now: Date): boolean {
  const parsed = Date.parse(expiresAt);
  return !Number.isFinite(parsed) || parsed <= now.getTime();
}

function canonicalTargetPath(
  cwd: string,
  payload: MossCanonicalResourceMutationPayloadType,
): string {
  const layout = getMossSourceLayout(cwd);
  if (payload.kind === "mcp") return nodePath.resolve(layout.mcpConfig);
  const root = payload.kind === "skill" ? layout.skillsRoot : layout.pluginsRoot;
  const slug = slugifyResourceName(payload.name);
  if (!slug) {
    throw new MossCanonicalMutationIntentError(
      "invalid-identity",
      "The canonical mutation plan name is invalid.",
    );
  }
  return nodePath.resolve(
    payload.kind === "skill" ? nodePath.join(root, slug, "SKILL.md") : nodePath.join(root, slug),
  );
}

function unsignedCanonicalPlan(plan: Omit<MossCanonicalMutationPlan, "planHash">) {
  return plan;
}

function canonicalPlanHash(plan: Omit<MossCanonicalMutationPlan, "planHash">): string {
  return sha256(stableJson(unsignedCanonicalPlan(plan)));
}

function canonicalPlanFile(planId: string): string {
  assertId(planId, "Canonical plan id");
  return `${CANONICAL_PLAN_PREFIX}/${planId}.json`;
}

function importPlanFile(planId: string): string {
  assertId(planId, "Import plan id");
  return `${IMPORT_PLAN_PREFIX}/${planId}.json`;
}

async function readStoredRecord(
  ownershipStore: MossOwnershipStore,
  fileName: string,
): Promise<Awaited<ReturnType<MossOwnershipStore["readPrivateRecord"]>>> {
  return ownershipStore.readPrivateRecord({ fileName });
}

function normalizedPlanRegistryOptions(
  options: MossPrivatePlanRegistryOptions | undefined,
): Required<MossPrivatePlanRegistryOptions> {
  const bounded = (value: number | undefined, fallback: number, maximum: number): number => {
    const candidate =
      typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(1, Math.min(candidate, maximum));
  };
  return {
    maxPlansPerWorkspace: bounded(
      options?.maxPlansPerWorkspace,
      DEFAULT_MAX_PLANS_PER_WORKSPACE,
      MAX_PLAN_REGISTRY_LIMIT,
    ),
    maxBytesPerWorkspace: bounded(
      options?.maxBytesPerWorkspace,
      DEFAULT_MAX_PLAN_BYTES_PER_WORKSPACE,
      MAX_PLAN_REGISTRY_BYTES,
    ),
    maxTombstoneRecords: bounded(
      options?.maxTombstoneRecords,
      DEFAULT_MAX_PLAN_TOMBSTONES,
      MAX_PLAN_REGISTRY_LIMIT,
    ),
  };
}

function registryNonce(scope: MossCanonicalMutationPlanScope): string {
  return `plan-registry-${sha256(stableJson(scope)).slice(0, 32)}`;
}

function baseRecordFileName(fileName: string): string {
  const directory = nodePath.dirname(fileName);
  const leaf = nodePath.basename(fileName);
  const base = leaf.replace(/\.\d+\.json$/u, ".json");
  return directory === "." ? base : `${directory}/${base}`;
}

async function withPrivatePlanRegistryLock<T>(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly scope: MossCanonicalMutationPlanScope;
  readonly operation: (lock: Awaited<ReturnType<MossOwnershipStore["acquireLock"]>>) => Promise<T>;
}): Promise<T> {
  const nonce = registryNonce(input.scope);
  let lock: Awaited<ReturnType<MossOwnershipStore["acquireLock"]>> | undefined;
  let lastCause: unknown;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    try {
      lock = await input.ownershipStore.acquireLock({
        cwd: nodePath.resolve(input.scope.cwd),
        ownerId: input.scope.ownerId,
        projectId: input.scope.projectId,
        workspaceId: input.scope.workspaceId,
        principalId: input.scope.principalId,
        sessionId: input.scope.sessionId,
        nonce,
      });
      break;
    } catch (cause) {
      lastCause = cause;
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        cause.code !== "concurrent-modification"
      ) {
        throw cause;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }
  if (!lock) {
    throw new MossCanonicalMutationIntentError(
      "concurrent-modification",
      lastCause instanceof Error
        ? lastCause.message
        : "Private plan registry could not acquire the workspace ownership lock.",
    );
  }
  if (
    lock.ownerId !== input.scope.ownerId ||
    lock.projectId !== input.scope.projectId ||
    lock.workspaceId !== input.scope.workspaceId ||
    lock.principalId !== input.scope.principalId ||
    lock.sessionId !== input.scope.sessionId ||
    lock.nonce !== nonce ||
    lock.fencingToken.length === 0 ||
    lock.generation.length === 0
  ) {
    await lock.release().catch(() => undefined);
    throw new MossCanonicalMutationIntentError(
      "authorization-required",
      "Private plan registry ownership lock authority does not match.",
    );
  }
  try {
    return await input.operation(lock);
  } finally {
    await lock.release();
  }
}

function requirePrivateRecordCompaction(
  ownershipStore: MossOwnershipStore,
): NonNullable<MossOwnershipStore["compactPrivateRecord"]> {
  if (!ownershipStore.compactPrivateRecord) {
    throw new MossCanonicalMutationIntentError(
      "durability-unsupported",
      "The private ownership store cannot compact expired plan records durably.",
    );
  }
  return ownershipStore.compactPrivateRecord;
}

async function appendImmutableRecord(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly fileName: string;
  readonly transactionId: string;
  readonly value: unknown;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly stateFingerprint: string;
  readonly nonce: string;
  readonly stateDir?: string;
}): Promise<void> {
  if (input.stateDir) {
    const parent = nodePath.dirname(input.stateDir);
    const parentStat = await fs.lstat(parent).catch(() => null);
    if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new MossCanonicalMutationIntentError(
        "authorization-required",
        "The private mutation plan state parent is not a prepared server directory.",
      );
    }
    const existingState = await fs.lstat(input.stateDir).catch(() => null);
    if (!existingState) {
      await fs.mkdir(input.stateDir, { mode: 0o700 });
    }
    const stateStat = await fs.lstat(input.stateDir);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
      throw new MossCanonicalMutationIntentError(
        "authorization-required",
        "The private mutation plan state directory is unsafe.",
      );
    }
    if (supportsPosixPermissions()) await fs.chmod(input.stateDir, 0o700);
  }
  const existing = await readStoredRecord(input.ownershipStore, input.fileName);
  if (existing !== null) {
    if (stableJson(existing.value) !== stableJson(input.value)) {
      throw new MossCanonicalMutationIntentError(
        "transaction-invalid",
        "The private mutation plan is immutable and cannot be replaced.",
      );
    }
    return;
  }
  const receipt = await input.ownershipStore.appendPrivateRecord({
    fileName: input.fileName,
    transactionId: input.transactionId,
    value: input.value,
    ownerId: input.ownerId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    sessionId: input.sessionId,
    stateFingerprint: input.stateFingerprint,
    nonce: input.nonce,
  });
  if (
    receipt.transactionId !== input.transactionId ||
    receipt.ownerId !== input.ownerId ||
    receipt.projectId !== input.projectId ||
    receipt.workspaceId !== input.workspaceId ||
    receipt.principalId !== input.principalId ||
    receipt.sessionId !== input.sessionId ||
    receipt.stateFingerprint !== input.stateFingerprint ||
    receipt.nonce !== input.nonce ||
    stableJson(receipt.value) !== stableJson(input.value)
  ) {
    throw new MossCanonicalMutationIntentError(
      "transaction-invalid",
      "The private mutation plan append returned an unverifiable receipt.",
    );
  }
}

interface PrivatePlanRecordEntry {
  readonly fileName: string;
  readonly record: NonNullable<Awaited<ReturnType<MossOwnershipStore["readPrivateRecord"]>>>;
  readonly value: Record<string, unknown>;
  readonly expiresAt: string;
}

async function listPrivatePlanRecords(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly scope: MossCanonicalMutationPlanScope;
}): Promise<PrivatePlanRecordEntry[]> {
  const entries: PrivatePlanRecordEntry[] = [];
  for (const prefix of [CANONICAL_PLAN_PREFIX, IMPORT_PLAN_PREFIX] as const) {
    const names = await input.ownershipStore.listPrivateRecords({ prefix });
    const baseNames = [...new Set(names.map(baseRecordFileName))].toSorted();
    for (const fileName of baseNames) {
      const record = await readStoredRecord(input.ownershipStore, fileName);
      if (!record) continue;
      const value = isRecordValue(record.value) ? record.value : undefined;
      if (!value || value.workspaceId !== input.scope.workspaceId) continue;
      if (
        value.ownerId !== input.scope.ownerId ||
        value.projectId !== input.scope.projectId ||
        value.principalId !== input.scope.principalId ||
        value.sessionId !== input.scope.sessionId ||
        value.issuer !== input.scope.issuer ||
        typeof value.planId !== "string" ||
        typeof value.planHash !== "string" ||
        typeof value.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(value.expiresAt))
      ) {
        throw new MossCanonicalMutationIntentError(
          "plan-invalid",
          "A private plan registry record failed strict authority validation.",
        );
      }
      entries.push({
        fileName,
        record,
        value,
        expiresAt: value.expiresAt,
      });
    }
  }
  return entries;
}

async function compactPlanAuditRecords(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly scope: MossCanonicalMutationPlanScope;
  readonly registry: Required<MossPrivatePlanRegistryOptions>;
  readonly lock: Awaited<ReturnType<MossOwnershipStore["acquireLock"]>>;
}): Promise<void> {
  const names = await input.ownershipStore.listPrivateRecords({ prefix: PLAN_GC_PREFIX });
  const baseNames = [...new Set(names.map(baseRecordFileName))].toSorted();
  const entries: Array<{
    readonly fileName: string;
    readonly record: NonNullable<Awaited<ReturnType<MossOwnershipStore["readPrivateRecord"]>>>;
    readonly value: Record<string, unknown>;
  }> = [];
  for (const fileName of baseNames) {
    const record = await readStoredRecord(input.ownershipStore, fileName);
    if (!record) continue;
    const value = isRecordValue(record.value) ? record.value : undefined;
    if (!value || value.workspaceId !== input.scope.workspaceId) continue;
    entries.push({ fileName, record, value });
  }
  if (entries.length <= input.registry.maxTombstoneRecords) return;
  const summaries = entries.map(({ value }) =>
    value.kind === "moss-plan-expired-tombstone"
      ? {
          kind: value.kind,
          planId: value.planId,
          planHash: value.planHash,
          payloadDigest: value.payloadDigest,
          compactedRecordHash: value.compactedRecordHash,
        }
      : { kind: value.kind, tombstoneDigest: value.tombstoneDigest },
  );
  const tombstoneDigest = sha256(stableJson(summaries));
  const aggregateFile = `${PLAN_GC_PREFIX}/${sha256(input.scope.workspaceId).slice(0, 32)}-aggregate-${tombstoneDigest.slice(0, 32)}.json`;
  const aggregateValue = {
    schemaVersion: 1,
    kind: "moss-plan-gc-aggregate-tombstone",
    workspaceId: input.scope.workspaceId,
    tombstoneDigest,
    recordCount: entries.length,
  } as const;
  await appendImmutableRecord({
    ownershipStore: input.ownershipStore,
    fileName: aggregateFile,
    transactionId: `plan-gc-aggregate-${tombstoneDigest.slice(0, 32)}`,
    value: aggregateValue,
    ownerId: input.scope.ownerId,
    projectId: input.scope.projectId,
    workspaceId: input.scope.workspaceId,
    principalId: input.scope.principalId,
    sessionId: input.scope.sessionId,
    stateFingerprint: tombstoneDigest,
    nonce: `plan-gc-aggregate-nonce-${tombstoneDigest.slice(0, 32)}`,
  });
  const compactPrivateRecord = requirePrivateRecordCompaction(input.ownershipStore);
  for (const entry of entries) {
    if (entry.fileName === aggregateFile) continue;
    await compactPrivateRecord({
      lock: input.lock,
      fileName: entry.fileName,
      expectedSequence: entry.record.sequence,
      expectedRecordHash: entry.record.recordHash,
      ownerId: entry.record.ownerId,
      projectId: entry.record.projectId,
      workspaceId: entry.record.workspaceId,
      principalId: entry.record.principalId,
      sessionId: entry.record.sessionId,
      stateFingerprint: entry.record.stateFingerprint,
      nonce: entry.record.nonce,
    });
  }
}

async function gcPrivatePlanRegistryUnlocked(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly scope: MossCanonicalMutationPlanScope;
  readonly registry: Required<MossPrivatePlanRegistryOptions>;
  readonly now: Date;
  readonly lock: Awaited<ReturnType<MossOwnershipStore["acquireLock"]>>;
}): Promise<{ readonly expiredPlans: number; readonly compactedPlans: number }> {
  const plans = await listPrivatePlanRecords(input);
  const expired = plans.filter(({ expiresAt }) => isExpired(expiresAt, input.now));
  let compactedPlans = 0;
  if (expired.length > 0) {
    const compactPrivateRecord = requirePrivateRecordCompaction(input.ownershipStore);
    for (const entry of expired) {
      const payloadDigest = sha256(stableJson(entry.value));
      const tombstone = {
        schemaVersion: 1,
        kind: "moss-plan-expired-tombstone",
        workspaceId: input.scope.workspaceId,
        planId: entry.value.planId,
        planHash: entry.value.planHash,
        payloadDigest,
        compactedRecordHash: entry.record.recordHash,
        expiresAt: entry.expiresAt,
      } as const;
      const tombstoneDigest = sha256(stableJson(tombstone));
      const auditFile = `${PLAN_GC_PREFIX}/${sha256(
        stableJson({ workspaceId: input.scope.workspaceId, planId: entry.value.planId }),
      ).slice(0, 48)}.json`;
      await appendImmutableRecord({
        ownershipStore: input.ownershipStore,
        fileName: auditFile,
        transactionId: `plan-gc-${sha256(auditFile).slice(0, 32)}`,
        value: tombstone,
        ownerId: input.scope.ownerId,
        projectId: input.scope.projectId,
        workspaceId: input.scope.workspaceId,
        principalId: input.scope.principalId,
        sessionId: input.scope.sessionId,
        stateFingerprint: tombstoneDigest,
        nonce: `plan-gc-nonce-${sha256(auditFile).slice(0, 32)}`,
      });
      await compactPrivateRecord({
        lock: input.lock,
        fileName: entry.fileName,
        expectedSequence: entry.record.sequence,
        expectedRecordHash: entry.record.recordHash,
        ownerId: entry.record.ownerId,
        projectId: entry.record.projectId,
        workspaceId: entry.record.workspaceId,
        principalId: entry.record.principalId,
        sessionId: entry.record.sessionId,
        stateFingerprint: entry.record.stateFingerprint,
        nonce: entry.record.nonce,
      });
      compactedPlans += 1;
    }
  }
  await compactPlanAuditRecords(input);
  return { expiredPlans: expired.length, compactedPlans };
}

async function assertPrivatePlanRegistryBudget(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly scope: MossCanonicalMutationPlanScope;
  readonly registry: Required<MossPrivatePlanRegistryOptions>;
  readonly planFileName: string;
  readonly plan: unknown;
  readonly now: Date;
}): Promise<void> {
  const existing = await readStoredRecord(input.ownershipStore, input.planFileName);
  if (existing && stableJson(existing.value) === stableJson(input.plan)) return;
  const plans = await listPrivatePlanRecords(input);
  const active = plans.filter(({ expiresAt }) => !isExpired(expiresAt, input.now));
  const planBytes = Buffer.byteLength(stableJson(input.plan));
  const activeBytes = active.reduce(
    (total, entry) => total + Buffer.byteLength(stableJson(entry.value)),
    0,
  );
  if (
    active.length + 1 > input.registry.maxPlansPerWorkspace ||
    activeBytes + planBytes > input.registry.maxBytesPerWorkspace
  ) {
    throw new MossCanonicalMutationIntentError(
      "plan-budget-exceeded",
      "The private workspace plan registry has reached its bounded active budget.",
    );
  }
}

export async function gcMossPrivatePlanRegistry(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly scope: MossCanonicalMutationPlanScope;
  readonly registry?: MossPrivatePlanRegistryOptions;
  readonly now?: Date;
}): Promise<{ readonly expiredPlans: number; readonly compactedPlans: number }> {
  const registry = normalizedPlanRegistryOptions(input.registry);
  return withPrivatePlanRegistryLock({
    ownershipStore: input.ownershipStore,
    scope: input.scope,
    operation: (lock) =>
      gcPrivatePlanRegistryUnlocked({
        ownershipStore: input.ownershipStore,
        scope: input.scope,
        registry,
        now: input.now ?? new Date(),
        lock,
      }),
  });
}

function scopeMismatch(
  plan: MossCanonicalMutationPlan,
  scope: MossCanonicalMutationPlanScope,
): boolean {
  return (
    plan.cwd !== nodePath.resolve(scope.cwd) ||
    plan.issuer !== scope.issuer ||
    plan.ownerId !== scope.ownerId ||
    plan.projectId !== scope.projectId ||
    plan.principalId !== scope.principalId ||
    plan.sessionId !== scope.sessionId ||
    plan.workspaceId !== scope.workspaceId
  );
}

function validateCanonicalPlan(plan: MossCanonicalMutationPlan): void {
  assertId(plan.planId, "Canonical plan id");
  assertId(plan.operationId, "Canonical operation id");
  assertHash(plan.planHash, "Canonical plan hash");
  if (plan.schemaVersion !== CANONICAL_PLAN_SCHEMA_VERSION) {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "Canonical mutation plan schema is unsupported.",
    );
  }
  const { planHash: _planHash, ...unsigned } = plan;
  if (canonicalPlanHash(unsigned) !== plan.planHash) {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "Canonical mutation plan content hash does not match.",
    );
  }
  if (
    nodePath.resolve(plan.cwd) !== plan.cwd ||
    nodePath.resolve(plan.canonicalRoot) !== plan.canonicalRoot
  ) {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "Canonical mutation plan paths are not canonical.",
    );
  }
  if (nodePath.resolve(plan.targetPath) !== plan.targetPath) {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "Canonical mutation plan target is not canonical.",
    );
  }
  if (
    plan.payload.cwd !== plan.cwd ||
    plan.canonicalRoot !== nodePath.resolve(getMossSourceLayout(plan.cwd).root) ||
    plan.targetPath !== canonicalTargetPath(plan.cwd, plan.payload)
  ) {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "Canonical mutation plan target is not server-derived from its immutable payload.",
    );
  }
  if (isExpired(plan.expiresAt, new Date(0))) {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "Canonical mutation plan expiration is invalid.",
    );
  }
}

export async function issueMossCanonicalMutationPlan(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly stateDir?: string;
  readonly scope: MossCanonicalMutationPlanScope;
  readonly action: MossCanonicalResourceMutationAction;
  readonly payload: MossCanonicalResourceMutationPayloadType;
  readonly planTtlMillis?: number;
  readonly selectionTicketDigest?: string;
  readonly registry?: MossPrivatePlanRegistryOptions;
  readonly now?: () => Date;
}): Promise<MossCanonicalMutationPlan> {
  const scope = { ...input.scope, cwd: nodePath.resolve(input.scope.cwd) };
  const payload = { ...input.payload, cwd: scope.cwd };
  if (input.action === "update" && typeof payload.enabled !== "boolean") {
    throw new MossCanonicalMutationIntentError(
      "invalid-identity",
      "An update mutation plan requires an explicit enabled state.",
    );
  }
  if (input.action === "update" && payload.kind === "skill") {
    throw new MossCanonicalMutationIntentError(
      "invalid-identity",
      "Only plugin and MCP resources can be updated.",
    );
  }
  if ((input.action === "create" || input.action === "delete") && payload.enabled !== undefined) {
    throw new MossCanonicalMutationIntentError(
      "invalid-identity",
      "Create and delete mutation plans cannot carry an update-only enabled state.",
    );
  }
  const planId = `plan-${randomUUID()}`;
  const operationId = `operation-${randomUUID()}`;
  const canonicalRoot = nodePath.resolve(getMossSourceLayout(scope.cwd).root);
  const targetPath = canonicalTargetPath(scope.cwd, payload);
  const createdAt = (input.now ?? (() => new Date()))();
  const expiresAt = new Date(
    createdAt.getTime() + Math.max(1_000, Math.min(input.planTtlMillis ?? 5 * 60_000, 60 * 60_000)),
  ).toISOString();
  const unsigned = {
    schemaVersion: CANONICAL_PLAN_SCHEMA_VERSION,
    planId,
    operationId,
    action: input.action,
    payload,
    cwd: scope.cwd,
    canonicalRoot,
    targetPath,
    issuer: scope.issuer,
    ownerId: scope.ownerId,
    projectId: scope.projectId,
    principalId: scope.principalId,
    sessionId: scope.sessionId,
    workspaceId: scope.workspaceId,
    expiresAt,
    ...(input.selectionTicketDigest ? { selectionTicketDigest: input.selectionTicketDigest } : {}),
  } satisfies Omit<MossCanonicalMutationPlan, "planHash">;
  const plan: MossCanonicalMutationPlan = { ...unsigned, planHash: canonicalPlanHash(unsigned) };
  validateCanonicalPlan(plan);
  const registry = normalizedPlanRegistryOptions(input.registry);
  await withPrivatePlanRegistryLock({
    ownershipStore: input.ownershipStore,
    scope,
    operation: async (lock) => {
      await gcPrivatePlanRegistryUnlocked({
        ownershipStore: input.ownershipStore,
        scope,
        registry,
        now: createdAt,
        lock,
      });
      await assertPrivatePlanRegistryBudget({
        ownershipStore: input.ownershipStore,
        scope,
        registry,
        planFileName: canonicalPlanFile(plan.planId),
        plan,
        now: createdAt,
      });
      await appendImmutableRecord({
        ownershipStore: input.ownershipStore,
        fileName: canonicalPlanFile(plan.planId),
        transactionId: `canonical-plan-${sha256(plan.planId).slice(0, 32)}`,
        value: plan,
        ownerId: plan.ownerId,
        projectId: plan.projectId,
        workspaceId: plan.workspaceId,
        principalId: plan.principalId,
        sessionId: plan.sessionId,
        stateFingerprint: plan.planHash,
        nonce: `canonical-plan-nonce-${sha256(plan.planId).slice(0, 32)}`,
        ...(input.stateDir ? { stateDir: input.stateDir } : {}),
      });
    },
  });
  return plan;
}

async function resolveMossCanonicalMutationPlanUnlocked(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly planId: string;
  readonly operationId: string;
  readonly scope: MossCanonicalMutationPlanScope;
  readonly action: MossCanonicalResourceMutationAction;
  readonly now?: Date;
}): Promise<MossCanonicalMutationPlanResolution> {
  assertId(input.planId, "Canonical plan id");
  assertId(input.operationId, "Canonical operation id");
  const fileName = canonicalPlanFile(input.planId);
  const storedRecord = await readStoredRecord(input.ownershipStore, fileName);
  if (storedRecord === null) {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "The canonical mutation plan is not present in private server state.",
    );
  }
  const value = storedRecord.value;
  let plan: MossCanonicalMutationPlan;
  try {
    const decoded = Schema.decodeUnknownSync(MossCanonicalResourceMutationPlanSchema)(value);
    const { selectionTicketDigest, ...withoutTicket } = decoded;
    plan = (
      selectionTicketDigest === undefined
        ? withoutTicket
        : { ...withoutTicket, selectionTicketDigest }
    ) as MossCanonicalMutationPlan;
  } catch {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "The private canonical mutation plan failed strict validation.",
    );
  }
  validateCanonicalPlan(plan);
  if (
    storedRecord.transactionId !== `canonical-plan-${sha256(plan.planId).slice(0, 32)}` ||
    storedRecord.ownerId !== plan.ownerId ||
    storedRecord.projectId !== plan.projectId ||
    storedRecord.workspaceId !== plan.workspaceId ||
    storedRecord.principalId !== plan.principalId ||
    storedRecord.sessionId !== plan.sessionId ||
    storedRecord.stateFingerprint !== plan.planHash ||
    storedRecord.nonce !== `canonical-plan-nonce-${sha256(plan.planId).slice(0, 32)}`
  ) {
    throw new MossCanonicalMutationIntentError(
      "authorization-required",
      "The private canonical mutation plan authority metadata does not match.",
    );
  }
  if (
    plan.planId !== input.planId ||
    plan.operationId !== input.operationId ||
    plan.action !== input.action ||
    scopeMismatch(plan, input.scope)
  ) {
    throw new MossCanonicalMutationIntentError(
      "authorization-required",
      "The canonical mutation plan does not match the authenticated intent.",
    );
  }
  if (isExpired(plan.expiresAt, input.now ?? new Date())) {
    throw new MossCanonicalMutationIntentError(
      "plan-expired",
      "The canonical mutation plan has expired.",
    );
  }
  const intentKey = deriveMossCanonicalMutationIdempotencyKey({ plan });
  return { ...plan, intentKey };
}

export async function resolveMossCanonicalMutationPlan(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly planId: string;
  readonly operationId: string;
  readonly scope: MossCanonicalMutationPlanScope;
  readonly action: MossCanonicalResourceMutationAction;
  readonly registry?: MossPrivatePlanRegistryOptions;
  readonly now?: Date;
}): Promise<MossCanonicalMutationPlanResolution> {
  const scope = { ...input.scope, cwd: nodePath.resolve(input.scope.cwd) };
  return withPrivatePlanRegistryLock({
    ownershipStore: input.ownershipStore,
    scope,
    operation: () =>
      resolveMossCanonicalMutationPlanUnlocked({
        ownershipStore: input.ownershipStore,
        planId: input.planId,
        operationId: input.operationId,
        scope,
        action: input.action,
        ...(input.now ? { now: input.now } : {}),
      }),
  });
}

export function deriveMossCanonicalMutationIdempotencyKey(input: {
  readonly plan: Pick<
    MossCanonicalMutationPlan,
    "planId" | "operationId" | "planHash" | "action" | "targetPath" | "selectionTicketDigest"
  > &
    Partial<MossCanonicalMutationPlanScope>;
}): string {
  const digest = sha256(
    stableJson({
      schemaVersion: 1,
      planId: input.plan.planId,
      operationId: input.plan.operationId,
      planHash: input.plan.planHash,
      action: input.plan.action,
      targetPath: input.plan.targetPath,
      selectionTicketDigest: input.plan.selectionTicketDigest ?? null,
      issuer: input.plan.issuer ?? null,
      ownerId: input.plan.ownerId ?? null,
      projectId: input.plan.projectId ?? null,
      principalId: input.plan.principalId ?? null,
      sessionId: input.plan.sessionId ?? null,
      workspaceId: input.plan.workspaceId ?? null,
    }),
  );
  return `moss-${digest.slice(0, 48)}`;
}

/** Stable capability identity for an operation inside an immutable import plan. */
export function deriveMossResourceImportMutationKey(input: {
  readonly planId: string;
  readonly planHash: string;
  readonly operationId: string;
  readonly targetPath: string;
  readonly action: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly issuer: string;
  readonly selectionTicketDigest?: string;
}): string {
  assertId(input.planId, "Import plan id");
  assertId(input.operationId, "Import operation id");
  assertHash(input.planHash, "Import plan hash");
  return `moss-${sha256(stableJson({ schemaVersion: 1, ...input })).slice(0, 48)}`;
}

/** A plan owns one replayable transaction identity across process restarts. */
export function deriveMossResourceImportTransactionId(input: {
  readonly planId: string;
  readonly planHash: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly issuer: string;
  readonly selectionTicketDigest?: string;
}): string {
  assertId(input.planId, "Import plan id");
  assertHash(input.planHash, "Import plan hash");
  return `transaction-${sha256(stableJson({ schemaVersion: 1, ...input })).slice(0, 48)}`;
}

const MossCanonicalResourceMutationPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal(CANONICAL_PLAN_SCHEMA_VERSION),
  planId: Schema.String,
  operationId: Schema.String,
  planHash: Schema.String,
  action: Schema.Literals(["create", "delete", "update"]),
  payload: MossCanonicalResourceMutationPayload,
  cwd: Schema.String,
  canonicalRoot: Schema.String,
  targetPath: Schema.String,
  issuer: Schema.String,
  ownerId: Schema.String,
  projectId: Schema.String,
  principalId: Schema.String,
  sessionId: Schema.String,
  workspaceId: Schema.String,
  expiresAt: Schema.String,
  selectionTicketDigest: Schema.optional(Schema.String),
});

function importPlanHash(plan: Omit<MossResourceImportPlan, "planHash">): string {
  return sha256(stableJson(plan));
}

export async function registerMossResourceImportPlan(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly plan: MossResourceImportPlan;
  readonly registry?: MossPrivatePlanRegistryOptions;
}): Promise<void> {
  const plan = input.plan;
  const { planHash: _planHash, ...unsigned } = plan;
  assertHash(plan.planHash, "Import plan hash");
  if (importPlanHash(unsigned) !== plan.planHash) {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "Import plan content hash does not match before registry append.",
    );
  }
  const scope: MossCanonicalMutationPlanScope = {
    cwd: nodePath.resolve(plan.cwd),
    issuer: plan.issuer,
    ownerId: plan.ownerId,
    projectId: plan.projectId,
    principalId: plan.principalId,
    sessionId: plan.sessionId,
    workspaceId: plan.workspaceId,
  };
  const registry = normalizedPlanRegistryOptions(input.registry);
  await withPrivatePlanRegistryLock({
    ownershipStore: input.ownershipStore,
    scope,
    operation: async (lock) => {
      await gcPrivatePlanRegistryUnlocked({
        ownershipStore: input.ownershipStore,
        scope,
        registry,
        now: new Date(plan.createdAt),
        lock,
      });
      await assertPrivatePlanRegistryBudget({
        ownershipStore: input.ownershipStore,
        scope,
        registry,
        planFileName: importPlanFile(plan.planId),
        plan,
        now: new Date(plan.createdAt),
      });
      await appendImmutableRecord({
        ownershipStore: input.ownershipStore,
        fileName: importPlanFile(plan.planId),
        transactionId: `import-plan-${sha256(plan.planId).slice(0, 32)}`,
        value: plan,
        ownerId: plan.ownerId,
        projectId: plan.projectId,
        workspaceId: plan.workspaceId,
        principalId: plan.principalId,
        sessionId: plan.sessionId,
        stateFingerprint: plan.stateFingerprint,
        nonce: plan.nonce,
      });
    },
  });
}

async function resolveMossResourceImportPlanUnlocked(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly plan: MossResourceImportPlan;
  readonly scope: MossCanonicalMutationPlanScope;
  readonly now?: Date;
}): Promise<MossResourceImportPlan> {
  const storedRecord = await readStoredRecord(
    input.ownershipStore,
    importPlanFile(input.plan.planId),
  );
  if (storedRecord === null) {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "The import plan is not present in private server state.",
    );
  }
  const value = storedRecord.value;
  let stored: MossResourceImportPlan;
  try {
    stored = Schema.decodeUnknownSync(MossResourceImportPlanSchema)(value);
  } catch {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "The private import plan failed strict validation.",
    );
  }
  const { planHash: storedHash, ...storedUnsigned } = stored;
  if (
    stored.planId !== input.plan.planId ||
    stored.planHash !== storedHash ||
    importPlanHash(storedUnsigned) !== storedHash ||
    stableJson(stored) !== stableJson(input.plan)
  ) {
    throw new MossCanonicalMutationIntentError(
      "plan-invalid",
      "The submitted import plan does not match the private immutable plan.",
    );
  }
  if (
    storedRecord.transactionId !== `import-plan-${sha256(stored.planId).slice(0, 32)}` ||
    storedRecord.ownerId !== stored.ownerId ||
    storedRecord.projectId !== stored.projectId ||
    storedRecord.workspaceId !== stored.workspaceId ||
    storedRecord.principalId !== stored.principalId ||
    storedRecord.sessionId !== stored.sessionId ||
    storedRecord.stateFingerprint !== stored.stateFingerprint ||
    storedRecord.nonce !== stored.nonce
  ) {
    throw new MossCanonicalMutationIntentError(
      "authorization-required",
      "The private import plan authority metadata does not match.",
    );
  }
  if (
    nodePath.resolve(stored.cwd) !== nodePath.resolve(input.scope.cwd) ||
    stored.issuer !== input.scope.issuer ||
    stored.ownerId !== input.scope.ownerId ||
    stored.projectId !== input.scope.projectId ||
    stored.principalId !== input.scope.principalId ||
    stored.sessionId !== input.scope.sessionId ||
    stored.workspaceId !== input.scope.workspaceId
  ) {
    throw new MossCanonicalMutationIntentError(
      "authorization-required",
      "The import plan does not match the authenticated workspace scope.",
    );
  }
  if (isExpired(stored.expiresAt, input.now ?? new Date())) {
    throw new MossCanonicalMutationIntentError("plan-expired", "The import plan has expired.");
  }
  return stored;
}

export async function resolveMossResourceImportPlan(input: {
  readonly ownershipStore: MossOwnershipStore;
  readonly plan: MossResourceImportPlan;
  readonly scope: MossCanonicalMutationPlanScope;
  readonly registry?: MossPrivatePlanRegistryOptions;
  readonly now?: Date;
}): Promise<MossResourceImportPlan> {
  const scope = { ...input.scope, cwd: nodePath.resolve(input.scope.cwd) };
  return withPrivatePlanRegistryLock({
    ownershipStore: input.ownershipStore,
    scope,
    operation: () =>
      resolveMossResourceImportPlanUnlocked({
        ownershipStore: input.ownershipStore,
        plan: input.plan,
        scope,
        ...(input.now ? { now: input.now } : {}),
      }),
  });
}
