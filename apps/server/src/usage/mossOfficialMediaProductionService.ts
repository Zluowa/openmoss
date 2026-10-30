// FILE: mossOfficialMediaProductionService.ts
// Purpose: Server-owned durable coordination boundary for official image/video operations.
// Layer: Server usage boundary. Network gateway and skill callers are injected explicitly.

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import { Effect } from "effect";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { PRIVATE_FILE_MODE, supportsPosixPermissions } from "../privatePathPermissions.ts";
import {
  appendMediaUsageReceipt,
  type MediaUsageReceiptAppender,
} from "./mediaUsageReceiptBridge.ts";
import {
  MossOfficialMediaExecutionError,
  assertDurableMossOfficialMediaCheckpoint,
  createMossOfficialMediaExecutor,
  type ApiMartOfficialMediaTransport,
  type MossOfficialMediaCheckpoint,
  type MossOfficialMediaCheckpointCasResult,
  type MossOfficialMediaCheckpointStore,
  type MossOfficialMediaExecutionRequest,
  type MossOfficialMediaExecutionResult,
} from "./mossOfficialMediaExecutor.ts";

const FILE_VERSION = 1;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CHECKPOINTS = 10_000;
const checkpointFileQueues = new Map<string, Promise<void>>();

export const MOSS_OFFICIAL_MEDIA_PRODUCTION_STATUS = {
  serverOwnedCoordinator: "IMPLEMENTED",
  durableCheckpointStore: "PRIVATE_ATOMIC_FILE",
  restartReconciliation: "KNOWN_TASKS_NO_PROMPT_REQUIRED",
  receiptDeliveryCheckpoint: "IDEMPOTENT_AFTER_ATOMIC_APPEND",
  mediaGatewayRoute: "BLOCKED_NOT_PRESENT",
  unifiedUsageBatchAppend: "BLOCKED_NOT_PRESENT",
  artifactDelivery: "BLOCKED_OPAQUE_REFERENCES_ONLY",
  skillExecutionCaller: "BLOCKED_NOT_PRESENT",
} as const;

export type MossOfficialMediaProductionErrorCode =
  | "durable_checkpoint_scan_required"
  | "durable_usage_appender_required"
  | "checkpoint_file_invalid"
  | "checkpoint_file_too_large"
  | "checkpoint_capacity_exceeded"
  | "usage_receipt_not_durable";

export class MossOfficialMediaProductionError extends Error {
  readonly code: MossOfficialMediaProductionErrorCode;

  constructor(code: MossOfficialMediaProductionErrorCode) {
    super(`Moss official media production coordination failed: ${code}`);
    this.name = "MossOfficialMediaProductionError";
    this.code = code;
  }
}

interface CheckpointFile {
  readonly version: 1;
  readonly checkpoints: ReadonlyArray<MossOfficialMediaCheckpoint>;
}

export interface CreateMossOfficialMediaFileCheckpointStoreOptions {
  readonly filePath: string;
  readonly maxFileBytes?: number;
  readonly maxCheckpoints?: number;
}

function invalidCheckpointFile(): never {
  throw new MossOfficialMediaProductionError("checkpoint_file_invalid");
}

function cloneCheckpoint(checkpoint: MossOfficialMediaCheckpoint): MossOfficialMediaCheckpoint {
  return JSON.parse(JSON.stringify(checkpoint)) as MossOfficialMediaCheckpoint;
}

function parseCheckpointFile(
  text: string,
  maxCheckpoints: number,
): Map<string, MossOfficialMediaCheckpoint> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidCheckpointFile();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => key !== "version" && key !== "checkpoints")
  ) {
    return invalidCheckpointFile();
  }
  const envelope = parsed as Partial<CheckpointFile>;
  if (
    envelope.version !== FILE_VERSION ||
    !Array.isArray(envelope.checkpoints) ||
    envelope.checkpoints.length > maxCheckpoints
  ) {
    return invalidCheckpointFile();
  }
  const checkpoints = new Map<string, MossOfficialMediaCheckpoint>();
  for (const value of envelope.checkpoints) {
    try {
      assertDurableMossOfficialMediaCheckpoint(value);
    } catch {
      return invalidCheckpointFile();
    }
    const operationId = value.operationGraph.attemptOperationId;
    if (checkpoints.has(operationId)) return invalidCheckpointFile();
    checkpoints.set(operationId, cloneCheckpoint(value));
  }
  return checkpoints;
}

function serializeCheckpointFile(
  checkpoints: ReadonlyMap<string, MossOfficialMediaCheckpoint>,
  maxFileBytes: number,
): string {
  const envelope: CheckpointFile = {
    version: FILE_VERSION,
    checkpoints: [...checkpoints.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([, checkpoint]) => checkpoint),
  };
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxFileBytes) {
    throw new MossOfficialMediaProductionError("checkpoint_file_too_large");
  }
  return serialized;
}

async function readCheckpointFile(
  filePath: string,
  maxFileBytes: number,
  maxCheckpoints: number,
): Promise<Map<string, MossOfficialMediaCheckpoint>> {
  const noFollow = supportsPosixPermissions() ? fsConstants.O_NOFOLLOW : 0;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    return invalidCheckpointFile();
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > maxFileBytes ||
      (supportsPosixPermissions() && (info.mode & 0o077) !== 0)
    ) {
      if (info.size > maxFileBytes) {
        throw new MossOfficialMediaProductionError("checkpoint_file_too_large");
      }
      return invalidCheckpointFile();
    }
    return parseCheckpointFile(await handle.readFile({ encoding: "utf8" }), maxCheckpoints);
  } finally {
    await handle.close();
  }
}

function shouldReconcile(checkpoint: MossOfficialMediaCheckpoint): boolean {
  if (checkpoint.receiptAppend) return false;
  return (
    checkpoint.state === "submission_reserved" ||
    checkpoint.state === "submission_ambiguous" ||
    checkpoint.state === "submission_rejected" ||
    checkpoint.state === "submitted" ||
    checkpoint.state === "completed" ||
    checkpoint.state === "failed" ||
    checkpoint.state === "cancelled"
  );
}

/**
 * A content-free, process-serialized store. Moss holds the adjacent SQLite
 * lifecycle lock for the lifetime of one server, so atomic replacement plus
 * this in-process queue provides one writer across normal production startup.
 */
export function createMossOfficialMediaFileCheckpointStore(
  options: CreateMossOfficialMediaFileCheckpointStoreOptions,
): MossOfficialMediaCheckpointStore & {
  readonly listReconcileable: () => Promise<ReadonlyArray<MossOfficialMediaCheckpoint>>;
} {
  const filePath = nodePath.resolve(options.filePath);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxCheckpoints = options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes <= 0 ||
    !Number.isSafeInteger(maxCheckpoints) ||
    maxCheckpoints <= 0
  ) {
    throw new MossOfficialMediaProductionError("checkpoint_file_invalid");
  }

  const serialized = <A>(operation: () => Promise<A>): Promise<A> => {
    const previous = checkpointFileQueues.get(filePath) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    checkpointFileQueues.set(filePath, tail);
    void tail.then(() => {
      if (checkpointFileQueues.get(filePath) === tail) checkpointFileQueues.delete(filePath);
    });
    return result;
  };

  const write = async (checkpoints: ReadonlyMap<string, MossOfficialMediaCheckpoint>) => {
    const contents = serializeCheckpointFile(checkpoints, maxFileBytes);
    await Effect.runPromise(
      writeFileStringAtomically({ filePath, contents, mode: PRIVATE_FILE_MODE }),
    );
  };

  return {
    durability: "DURABLE",
    reserve: (checkpoint) =>
      serialized(async () => {
        assertDurableMossOfficialMediaCheckpoint(checkpoint);
        const operationId = checkpoint.operationGraph.attemptOperationId;
        const checkpoints = await readCheckpointFile(filePath, maxFileBytes, maxCheckpoints);
        const existing = checkpoints.get(operationId);
        if (existing) return { status: "existing", checkpoint: cloneCheckpoint(existing) };
        if (checkpoints.size >= maxCheckpoints) {
          throw new MossOfficialMediaProductionError("checkpoint_capacity_exceeded");
        }
        checkpoints.set(operationId, cloneCheckpoint(checkpoint));
        await write(checkpoints);
        return { status: "inserted", checkpoint: cloneCheckpoint(checkpoint) };
      }),
    load: (attemptOperationId) =>
      serialized(async () => {
        const checkpoints = await readCheckpointFile(filePath, maxFileBytes, maxCheckpoints);
        const checkpoint = checkpoints.get(attemptOperationId);
        return checkpoint ? cloneCheckpoint(checkpoint) : null;
      }),
    compareAndSet: (attemptOperationId, expectedRevision, next) =>
      serialized(async (): Promise<MossOfficialMediaCheckpointCasResult> => {
        assertDurableMossOfficialMediaCheckpoint(next);
        if (
          next.operationGraph.attemptOperationId !== attemptOperationId ||
          next.revision !== expectedRevision + 1
        ) {
          throw new MossOfficialMediaProductionError("checkpoint_file_invalid");
        }
        const checkpoints = await readCheckpointFile(filePath, maxFileBytes, maxCheckpoints);
        const current = checkpoints.get(attemptOperationId);
        if (!current) return { status: "missing" };
        if (current.revision !== expectedRevision) {
          return { status: "stale", checkpoint: cloneCheckpoint(current) };
        }
        checkpoints.set(attemptOperationId, cloneCheckpoint(next));
        await write(checkpoints);
        return { status: "updated", checkpoint: cloneCheckpoint(next) };
      }),
    listReconcileable: () =>
      serialized(async () => {
        const checkpoints = await readCheckpointFile(filePath, maxFileBytes, maxCheckpoints);
        return [...checkpoints.values()]
          .filter(shouldReconcile)
          .toSorted((left, right) =>
            left.operationGraph.attemptOperationId.localeCompare(
              right.operationGraph.attemptOperationId,
            ),
          )
          .map(cloneCheckpoint);
      }),
  };
}

export interface MossOfficialMediaProductionServiceOptions {
  readonly checkpointStore: MossOfficialMediaCheckpointStore;
  readonly transport: ApiMartOfficialMediaTransport;
  readonly usageAppender: MediaUsageReceiptAppender;
  readonly now?: () => string;
}

export interface MossOfficialMediaProductionResult {
  readonly execution: MossOfficialMediaExecutionResult;
  readonly receiptDelivery: "not_terminal" | "appended" | "already_appended";
}

export function createMossOfficialMediaProductionService(
  options: MossOfficialMediaProductionServiceOptions,
) {
  const requireProductionDependencies = () => {
    if (options.checkpointStore.durability !== "DURABLE") {
      throw new MossOfficialMediaExecutionError("durable_checkpoint_required");
    }
    if (!options.checkpointStore.listReconcileable) {
      throw new MossOfficialMediaProductionError("durable_checkpoint_scan_required");
    }
    if (options.usageAppender.instrumentationStatus !== "DURABLE") {
      throw new MossOfficialMediaProductionError("durable_usage_appender_required");
    }
  };

  const executor = createMossOfficialMediaExecutor({
    checkpointStore: options.checkpointStore,
    transport: options.transport,
    ...(options.now ? { now: options.now } : {}),
  });

  const deliverTerminalReceipt = async (
    execution: MossOfficialMediaExecutionResult,
  ): Promise<MossOfficialMediaProductionResult> => {
    if (!("receipt" in execution)) {
      return { execution, receiptDelivery: "not_terminal" };
    }
    const attemptOperationId = execution.checkpoint.operationGraph.attemptOperationId;
    if (execution.checkpoint.receiptAppend) {
      const checkpoint = await executor.acknowledgeCheckpointReceipt(
        attemptOperationId,
        execution.receipt,
      );
      return {
        execution: { ...execution, checkpoint },
        receiptDelivery: "already_appended",
      };
    }
    const appendResults = await appendMediaUsageReceipt(options.usageAppender, execution.receipt);
    if (appendResults.some((result) => result.status === "local_contract_only")) {
      throw new MossOfficialMediaProductionError("usage_receipt_not_durable");
    }
    const checkpoint = await executor.acknowledgeCheckpointReceipt(
      attemptOperationId,
      execution.receipt,
    );
    return {
      execution: { ...execution, checkpoint },
      receiptDelivery: "appended",
    };
  };

  const execute = async (
    request: MossOfficialMediaExecutionRequest,
  ): Promise<MossOfficialMediaProductionResult> => {
    requireProductionDependencies();
    return deliverTerminalReceipt(await executor.startOrResume(request));
  };

  const attachTaskId = async (
    request: MossOfficialMediaExecutionRequest,
    providerTaskId: string,
  ): Promise<MossOfficialMediaProductionResult> => {
    requireProductionDependencies();
    const checkpoint = await executor.attachTaskId(request, providerTaskId);
    return deliverTerminalReceipt(
      await executor.reconcileCheckpoint(checkpoint.operationGraph.attemptOperationId),
    );
  };

  const reconcileAttempt = async (
    attemptOperationId: string,
  ): Promise<MossOfficialMediaProductionResult> => {
    requireProductionDependencies();
    return deliverTerminalReceipt(await executor.reconcileCheckpoint(attemptOperationId));
  };

  const reconcilePending = async (): Promise<ReadonlyArray<MossOfficialMediaProductionResult>> => {
    requireProductionDependencies();
    const checkpoints = await options.checkpointStore.listReconcileable!();
    const results: MossOfficialMediaProductionResult[] = [];
    for (const checkpoint of checkpoints) {
      results.push(await reconcileAttempt(checkpoint.operationGraph.attemptOperationId));
    }
    return results;
  };

  return {
    status: MOSS_OFFICIAL_MEDIA_PRODUCTION_STATUS,
    execute,
    attachTaskId,
    reconcileAttempt,
    reconcilePending,
  } as const;
}
