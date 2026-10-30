// FILE: mossOfficialMediaExecutor.ts
// Purpose: Fail-closed, resumable APIMart media task submission and usage receipt construction.
// Layer: Server-only official media execution core. Live gateway and artifact delivery remain gated.

import { createHash } from "node:crypto";

import {
  UsageEventSubject as UsageEventSubjectSchema,
  type UsageCreditEntry,
  type UsageEventSubject,
} from "@synara/contracts";
import { Schema } from "effect";

import {
  buildMediaUsageReceipt,
  type MediaAttemptRole,
  type MediaUsageReceipt,
} from "./mediaUsageReceiptBridge.ts";

export const APIMART_OFFICIAL_MEDIA_ORIGIN = "https://api.apimart.ai" as const;
const APIMART_IMAGE_PATH = "/v1/images/generations";
const APIMART_VIDEO_PATH = "/v1/videos/generations";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUEST_BYTES = 512 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

export const MOSS_OFFICIAL_MEDIA_INSTRUMENTATION = {
  executorCore: "PRODUCTION_COORDINATOR_READY",
  durableCheckpointCaller: "PRIVATE_ATOMIC_FILE_IMPLEMENTED",
  durableUsageAppender: "ATOMIC_APPENDER_REQUIRED_NO_LIVE_GATEWAY",
  artifactPersistence: "OPAQUE_REFS_ONLY_NO_ARTIFACT_STORE",
  productionWiring: "SERVER_FACTORY_BLOCKED_NO_MEDIA_GATEWAY_OR_SKILL_ENTRY",
} as const;

export type MossOfficialImageModel = "gpt-image-2";
export type MossOfficialVideoModel = "sora-2" | "veo3.1-fast-official" | "doubao-seedance-2.0";

export type MossOfficialMediaDescriptor =
  | {
      readonly kind: "image";
      readonly model: MossOfficialImageModel;
      readonly size?:
        | "auto"
        | "1:1"
        | "3:2"
        | "2:3"
        | "4:3"
        | "3:4"
        | "5:4"
        | "4:5"
        | "16:9"
        | "9:16"
        | "2:1"
        | "1:2"
        | "21:9"
        | "9:21";
      readonly resolution?: "1k" | "2k" | "4k";
    }
  | {
      readonly kind: "video";
      readonly model: MossOfficialVideoModel;
      readonly duration: number;
      readonly aspectRatio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9" | "adaptive";
      readonly resolution?: "480p" | "720p" | "1024p" | "1080p" | "4K";
    };

export interface MossOfficialMediaExecutionRequest {
  readonly subject: UsageEventSubject;
  readonly invocationId: string;
  readonly skillRef: string;
  readonly attemptIndex: number;
  readonly role: MediaAttemptRole;
  readonly prompt: string;
  readonly media: MossOfficialMediaDescriptor;
  /** Stable time owned by the caller; it participates in replay identity. */
  readonly occurredAt: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly toolCallId?: string;
}

export interface MossOfficialMediaOperationGraph {
  readonly invocationOperationId: string;
  readonly attemptOperationId: string;
  readonly taskOperationId?: string;
}

export type MossOfficialMediaCheckpointState =
  | "submission_reserved"
  | "submission_ambiguous"
  | "submission_rejected"
  | "submitted"
  | "completed"
  | "failed"
  | "cancelled";

export interface MossOfficialMediaTerminalData {
  readonly providerPayloadDigest: string;
  readonly actualTimeSeconds?: string;
  readonly costUsd?: string;
  readonly creditsCost?: string;
  readonly artifactRefs: ReadonlyArray<string>;
  readonly imageOutputCount?: string;
  readonly videoOutputSeconds?: string;
}

/** Content-free durable checkpoint. Prompt and result URLs are deliberately absent. */
export interface MossOfficialMediaCheckpoint {
  readonly version: 1;
  readonly state: MossOfficialMediaCheckpointState;
  readonly revision: number;
  readonly requestDigest: string;
  readonly subject: UsageEventSubject;
  readonly invocationId: string;
  readonly skillRef: string;
  readonly attemptIndex: number;
  readonly role: MediaAttemptRole;
  readonly descriptor: MossOfficialMediaDescriptor;
  readonly operationGraph: MossOfficialMediaOperationGraph;
  readonly occurredAt: string;
  readonly updatedAt: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly toolCallId?: string;
  readonly taskId?: string;
  readonly terminal?: MossOfficialMediaTerminalData;
  readonly submissionFailure?: {
    readonly code: MossOfficialMediaTransportErrorCode;
    readonly httpStatus?: number;
  };
  /** Written only after the complete deterministic receipt is durably appended. */
  readonly receiptAppend?: {
    readonly state: "appended";
    readonly receiptDigest: string;
    readonly eventIds: ReadonlyArray<string>;
  };
}

export type MossOfficialMediaCheckpointReserveResult =
  | { readonly status: "inserted"; readonly checkpoint: MossOfficialMediaCheckpoint }
  | { readonly status: "existing"; readonly checkpoint: MossOfficialMediaCheckpoint };

export type MossOfficialMediaCheckpointCasResult =
  | { readonly status: "updated"; readonly checkpoint: MossOfficialMediaCheckpoint }
  | { readonly status: "stale"; readonly checkpoint: MossOfficialMediaCheckpoint }
  | { readonly status: "missing" };

export interface MossOfficialMediaCheckpointStore {
  readonly durability: "DURABLE" | "MEMORY_ONLY";
  /** Atomically insert by attemptOperationId or return the existing row. */
  readonly reserve: (
    checkpoint: MossOfficialMediaCheckpoint,
  ) => Promise<MossOfficialMediaCheckpointReserveResult>;
  readonly load: (attemptOperationId: string) => Promise<MossOfficialMediaCheckpoint | null>;
  /** Atomically compare revision and replace the complete content-free row. */
  readonly compareAndSet: (
    attemptOperationId: string,
    expectedRevision: number,
    next: MossOfficialMediaCheckpoint,
  ) => Promise<MossOfficialMediaCheckpointCasResult>;
  /** Optional durable scan used by the server-owned restart reconciler. */
  readonly listReconcileable?: () => Promise<ReadonlyArray<MossOfficialMediaCheckpoint>>;
}

export type ApiMartOfficialMediaTaskState =
  | "submitted"
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ApiMartOfficialMediaTask {
  readonly taskId: string;
  readonly state: ApiMartOfficialMediaTaskState;
  readonly providerPayloadDigest: string;
  readonly actualTimeSeconds?: string;
  readonly costUsd?: string;
  readonly creditsCost?: string;
  readonly artifactRefs?: ReadonlyArray<string>;
  readonly imageOutputCount?: string;
  readonly videoOutputSeconds?: string;
}

export interface ApiMartOfficialMediaTransport {
  readonly submit: (
    media: MossOfficialMediaDescriptor,
    prompt: string,
  ) => Promise<{ readonly taskId: string }>;
  readonly getTask: (taskId: string) => Promise<ApiMartOfficialMediaTask>;
}

export type MossOfficialMediaTransportErrorCode =
  | "invalid_request"
  | "request_too_large"
  | "response_too_large"
  | "timeout"
  | "network"
  | "redirect_rejected"
  | "provider_http"
  | "provider_rejected"
  | "invalid_response";

export class MossOfficialMediaTransportError extends Error {
  readonly code: MossOfficialMediaTransportErrorCode;
  readonly submissionMayHaveBeenAccepted: boolean;
  readonly httpStatus: number | undefined;

  constructor(
    code: MossOfficialMediaTransportErrorCode,
    submissionMayHaveBeenAccepted: boolean,
    httpStatus?: number,
  ) {
    super(`APIMart official media transport failed: ${code}`);
    this.name = "MossOfficialMediaTransportError";
    this.code = code;
    this.submissionMayHaveBeenAccepted = submissionMayHaveBeenAccepted;
    this.httpStatus = httpStatus;
  }
}

const TRANSPORT_ERROR_CODES = new Set<MossOfficialMediaTransportErrorCode>([
  "invalid_request",
  "request_too_large",
  "response_too_large",
  "timeout",
  "network",
  "redirect_rejected",
  "provider_http",
  "provider_rejected",
  "invalid_response",
]);

export type MossOfficialMediaExecutionErrorCode =
  | "durable_checkpoint_required"
  | "checkpoint_missing"
  | "checkpoint_write_failed"
  | "invalid_checkpoint"
  | "invalid_task_result";

export class MossOfficialMediaExecutionError extends Error {
  readonly code: MossOfficialMediaExecutionErrorCode;

  constructor(code: MossOfficialMediaExecutionErrorCode) {
    super(`Moss official media execution failed: ${code}`);
    this.name = "MossOfficialMediaExecutionError";
    this.code = code;
  }
}

export class MossOfficialMediaConflictError extends Error {
  readonly code = "idempotency_conflict" as const;

  constructor() {
    super("Moss official media execution failed closed: idempotency_conflict");
    this.name = "MossOfficialMediaConflictError";
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CreateApiMartOfficialMediaTransportOptions {
  readonly getToken: () => Promise<string> | string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function derivedRef(prefix: string, value: unknown): string {
  return `${prefix}-${digest(value).slice(0, 40)}`;
}

function assertOpaque(value: string): string {
  if (!OPAQUE_REF.test(value)) {
    throw new MossOfficialMediaTransportError("invalid_request", false);
  }
  return value;
}

function assertExecutionOpaque(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!OPAQUE_REF.test(value)) throw new MossOfficialMediaConflictError();
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeDecimal(value: unknown): string | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const normalized = typeof value === "number" ? String(value) : value;
  return NON_NEGATIVE_DECIMAL.test(normalized) ? normalized : undefined;
}

function nonNegativeInteger(value: unknown): string | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const normalized = typeof value === "number" ? String(value) : value;
  return NON_NEGATIVE_INTEGER.test(normalized) ? normalized : undefined;
}

function validateMediaDescriptor(media: MossOfficialMediaDescriptor): void {
  if (!media || typeof media !== "object") {
    throw new MossOfficialMediaTransportError("invalid_request", false);
  }
  if (media.kind === "image") {
    if (Object.keys(media).some((key) => !["kind", "model", "size", "resolution"].includes(key))) {
      throw new MossOfficialMediaTransportError("invalid_request", false);
    }
    const sizes = new Set([
      "auto",
      "1:1",
      "3:2",
      "2:3",
      "4:3",
      "3:4",
      "5:4",
      "4:5",
      "16:9",
      "9:16",
      "2:1",
      "1:2",
      "21:9",
      "9:21",
    ]);
    if (
      media.model !== "gpt-image-2" ||
      (media.size !== undefined && !sizes.has(media.size)) ||
      (media.resolution !== undefined && !["1k", "2k", "4k"].includes(media.resolution))
    ) {
      throw new MossOfficialMediaTransportError("invalid_request", false);
    }
    return;
  }
  const models = new Set<MossOfficialVideoModel>([
    "sora-2",
    "veo3.1-fast-official",
    "doubao-seedance-2.0",
  ]);
  if (
    Object.keys(media).some(
      (key) => !["kind", "model", "duration", "aspectRatio", "resolution"].includes(key),
    ) ||
    media.kind !== "video" ||
    !models.has(media.model) ||
    !Number.isSafeInteger(media.duration) ||
    (media.model === "sora-2" && ![4, 8, 12, 16, 20].includes(media.duration)) ||
    (media.model === "veo3.1-fast-official" && ![4, 6, 8].includes(media.duration)) ||
    (media.model === "doubao-seedance-2.0" && (media.duration < 4 || media.duration > 15)) ||
    (media.model === "sora-2" &&
      media.aspectRatio !== undefined &&
      !["16:9", "9:16"].includes(media.aspectRatio)) ||
    (media.model === "veo3.1-fast-official" &&
      media.aspectRatio !== undefined &&
      !["16:9", "9:16"].includes(media.aspectRatio)) ||
    (media.model === "doubao-seedance-2.0" &&
      media.aspectRatio !== undefined &&
      !["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"].includes(media.aspectRatio)) ||
    (media.model === "sora-2" && media.resolution !== undefined && media.resolution !== "720p") ||
    (media.model === "veo3.1-fast-official" &&
      media.resolution !== undefined &&
      !["720p", "1080p", "4K"].includes(media.resolution)) ||
    (media.model === "doubao-seedance-2.0" &&
      media.resolution !== undefined &&
      !["480p", "720p", "1080p"].includes(media.resolution))
  ) {
    throw new MossOfficialMediaTransportError("invalid_request", false);
  }
}

function normalizeMediaDescriptor(media: MossOfficialMediaDescriptor): MossOfficialMediaDescriptor {
  validateMediaDescriptor(media);
  if (media.kind === "image") {
    return {
      kind: "image",
      model: media.model,
      ...(media.size ? { size: media.size } : {}),
      ...(media.resolution ? { resolution: media.resolution } : {}),
    };
  }
  return {
    kind: "video",
    model: media.model,
    duration: media.duration,
    ...(media.aspectRatio ? { aspectRatio: media.aspectRatio } : {}),
    ...(media.resolution ? { resolution: media.resolution } : {}),
  };
}

function submissionBody(
  media: MossOfficialMediaDescriptor,
  prompt: string,
): Record<string, unknown> {
  validateMediaDescriptor(media);
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new MossOfficialMediaTransportError("invalid_request", false);
  }
  if (media.kind === "image") {
    return {
      model: media.model,
      prompt,
      n: 1,
      ...(media.size ? { size: media.size } : {}),
      ...(media.resolution ? { resolution: media.resolution } : {}),
    };
  }
  return {
    model: media.model,
    prompt,
    duration: media.duration,
    ...(media.aspectRatio
      ? media.model === "doubao-seedance-2.0"
        ? { size: media.aspectRatio }
        : { aspect_ratio: media.aspectRatio }
      : {}),
    ...(media.resolution ? { resolution: media.resolution } : {}),
  };
}

async function readBodyBounded(response: Response, maxBytes: number, submission: boolean) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new MossOfficialMediaTransportError("response_too_large", submission);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MossOfficialMediaTransportError("response_too_large", submission);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new MossOfficialMediaTransportError("invalid_response", submission);
  }
}

function parseJson(text: string, submission: boolean): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MossOfficialMediaTransportError("invalid_response", submission);
  }
}

function requireSuccessfulEnvelope(payload: unknown, submission: boolean) {
  const envelope = asRecord(payload);
  const code = envelope?.code;
  if (code === 200) return envelope;
  if (typeof code === "number" && Number.isSafeInteger(code) && code >= 400 && code < 500) {
    throw new MossOfficialMediaTransportError("provider_rejected", false, code);
  }
  if (typeof code === "number" && Number.isSafeInteger(code) && code >= 500 && code < 600) {
    throw new MossOfficialMediaTransportError("provider_http", submission, code);
  }
  throw new MossOfficialMediaTransportError("invalid_response", submission);
}

function collectArtifactUrls(result: Record<string, unknown>): {
  readonly refs: string[];
  readonly imageCount: number;
  readonly videoOutputSeconds?: string;
} {
  const urls: string[] = [];
  let imageCount = 0;
  let videoOutputSeconds: string | undefined;
  for (const collectionName of ["images", "videos"] as const) {
    const collection = result[collectionName];
    if (!Array.isArray(collection)) continue;
    for (const itemValue of collection) {
      const item = asRecord(itemValue);
      if (!item) continue;
      const itemUrls = Array.isArray(item.url) ? item.url : [item.url];
      let validForItem = 0;
      for (const url of itemUrls) {
        if (typeof url !== "string") continue;
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          continue;
        }
        if (parsed.protocol !== "https:") continue;
        urls.push(url);
        validForItem += 1;
      }
      if (collectionName === "images") imageCount += validForItem;
      if (collectionName === "videos" && videoOutputSeconds === undefined) {
        videoOutputSeconds =
          nonNegativeDecimal(item.duration) ?? nonNegativeDecimal(item.duration_seconds);
      }
    }
  }
  if (typeof result.thumbnail_url === "string") {
    try {
      const parsed = new URL(result.thumbnail_url);
      if (parsed.protocol === "https:") urls.push(result.thumbnail_url);
    } catch {
      // Invalid optional thumbnail URLs are ignored; completed media still needs a primary artifact.
    }
  }
  const refs = [...new Set(urls)].map((url) => derivedRef("apimart-artifact", url));
  return { refs, imageCount, ...(videoOutputSeconds ? { videoOutputSeconds } : {}) };
}

function parseTaskPayload(payload: unknown, requestedTaskId: string): ApiMartOfficialMediaTask {
  const envelope = requireSuccessfulEnvelope(payload, false);
  const data = asRecord(envelope?.data);
  if (!data || (data.id !== undefined && data.id !== requestedTaskId)) {
    throw new MossOfficialMediaTransportError("invalid_response", false);
  }
  const state = data.status;
  if (
    state !== "submitted" &&
    state !== "pending" &&
    state !== "processing" &&
    state !== "completed" &&
    state !== "failed" &&
    state !== "cancelled"
  ) {
    throw new MossOfficialMediaTransportError("invalid_response", false);
  }
  const providerPayloadDigest = digest(data);
  if (state !== "completed") {
    return { taskId: requestedTaskId, state, providerPayloadDigest };
  }
  const result = asRecord(data.result);
  if (!result) throw new MossOfficialMediaTransportError("invalid_response", false);
  const artifacts = collectArtifactUrls(result);
  if (artifacts.refs.length === 0) {
    throw new MossOfficialMediaTransportError("invalid_response", false);
  }
  const costUsd = nonNegativeDecimal(data.cost);
  const creditsCost = nonNegativeInteger(data.credits_cost);
  const actualTimeSeconds = nonNegativeDecimal(data.actual_time);
  return {
    taskId: requestedTaskId,
    state,
    providerPayloadDigest,
    ...(actualTimeSeconds ? { actualTimeSeconds } : {}),
    ...(costUsd ? { costUsd } : {}),
    ...(creditsCost ? { creditsCost } : {}),
    artifactRefs: artifacts.refs,
    ...(artifacts.imageCount > 0 ? { imageOutputCount: String(artifacts.imageCount) } : {}),
    ...(artifacts.videoOutputSeconds ? { videoOutputSeconds: artifacts.videoOutputSeconds } : {}),
  };
}

export function createApiMartOfficialMediaTransport(
  options: CreateApiMartOfficialMediaTransportOptions,
): ApiMartOfficialMediaTransport {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes <= 0 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0
  ) {
    throw new MossOfficialMediaTransportError("invalid_request", false);
  }

  const requestJson = async (
    url: string,
    init: Omit<RequestInit, "headers" | "signal" | "redirect">,
    submission: boolean,
  ): Promise<unknown> => {
    const startedAt = Date.now();
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body && Buffer.byteLength(body, "utf8") > maxRequestBytes) {
      throw new MossOfficialMediaTransportError("request_too_large", false);
    }
    let tokenTimeout: ReturnType<typeof setTimeout> | undefined;
    let token: string;
    try {
      token = await Promise.race([
        Promise.resolve().then(() => options.getToken()),
        new Promise<never>((_, reject) => {
          tokenTimeout = setTimeout(
            () => reject(new MossOfficialMediaTransportError("timeout", false)),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof MossOfficialMediaTransportError) throw error;
      throw new MossOfficialMediaTransportError("invalid_request", false);
    } finally {
      if (tokenTimeout) clearTimeout(tokenTimeout);
    }
    if (typeof token !== "string" || token.trim().length === 0 || /[\r\n]/u.test(token)) {
      throw new MossOfficialMediaTransportError("invalid_request", false);
    }
    const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
    if (remainingTimeoutMs <= 0) {
      throw new MossOfficialMediaTransportError("timeout", false);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        throw new MossOfficialMediaTransportError("redirect_rejected", false, response.status);
      }
      if (!response.ok) {
        await readBodyBounded(response, maxResponseBytes, submission).catch(() => undefined);
        if (response.status >= 400 && response.status < 500) {
          throw new MossOfficialMediaTransportError("provider_rejected", false, response.status);
        }
        throw new MossOfficialMediaTransportError("provider_http", submission, response.status);
      }
      const responseText = await readBodyBounded(response, maxResponseBytes, submission);
      return parseJson(responseText, submission);
    } catch (error) {
      if (error instanceof MossOfficialMediaTransportError) throw error;
      throw new MossOfficialMediaTransportError(timedOut ? "timeout" : "network", submission);
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    submit: async (media, prompt) => {
      const request = submissionBody(media, prompt);
      const payload = await requestJson(
        `${APIMART_OFFICIAL_MEDIA_ORIGIN}${media.kind === "image" ? APIMART_IMAGE_PATH : APIMART_VIDEO_PATH}`,
        { method: "POST", body: JSON.stringify(request) },
        true,
      );
      const envelope = requireSuccessfulEnvelope(payload, true);
      const data = envelope?.data;
      const first = Array.isArray(data) ? asRecord(data[0]) : asRecord(data);
      if (!first || first.status !== "submitted" || typeof first.task_id !== "string") {
        throw new MossOfficialMediaTransportError("invalid_response", true);
      }
      return { taskId: assertOpaque(first.task_id) };
    },
    getTask: async (taskId) => {
      const safeTaskId = assertOpaque(taskId);
      const payload = await requestJson(
        `${APIMART_OFFICIAL_MEDIA_ORIGIN}/v1/tasks/${safeTaskId}?language=zh`,
        { method: "GET" },
        false,
      );
      return parseTaskPayload(payload, safeTaskId);
    },
  };
}

export type MossOfficialMediaExecutionResult =
  | {
      readonly status: "submitted" | "pending" | "processing";
      readonly checkpoint: MossOfficialMediaCheckpoint;
    }
  | {
      readonly status: "needs_reconciliation";
      readonly reasonCode: "submission_reserved" | "submission_ambiguous";
      readonly checkpoint: MossOfficialMediaCheckpoint;
    }
  | {
      readonly status: "submission_failed";
      readonly failure: NonNullable<MossOfficialMediaCheckpoint["submissionFailure"]>;
      readonly checkpoint: MossOfficialMediaCheckpoint;
      readonly receipt: MediaUsageReceipt;
    }
  | {
      readonly status: "completed" | "failed" | "cancelled";
      readonly checkpoint: MossOfficialMediaCheckpoint;
      readonly receipt: MediaUsageReceipt;
    };

export interface CreateMossOfficialMediaExecutorOptions {
  readonly checkpointStore: MossOfficialMediaCheckpointStore;
  readonly transport: ApiMartOfficialMediaTransport;
  readonly now?: () => string;
}

function prepareRequest(request: MossOfficialMediaExecutionRequest, now: string) {
  const descriptor = normalizeMediaDescriptor(request.media);
  const prompt = request.prompt;
  submissionBody(descriptor, prompt);
  const subject = Schema.decodeUnknownSync(UsageEventSubjectSchema)(request.subject);
  if (!Number.isSafeInteger(request.attemptIndex) || request.attemptIndex < 0) {
    throw new MossOfficialMediaConflictError();
  }
  if (request.role !== "primary" && request.role !== "retry" && request.role !== "fallback") {
    throw new MossOfficialMediaConflictError();
  }
  if (new Date(request.occurredAt).toISOString() !== request.occurredAt) {
    throw new MossOfficialMediaConflictError();
  }
  assertExecutionOpaque(request.invocationId);
  assertExecutionOpaque(request.skillRef);
  assertExecutionOpaque(request.subject.accountRef);
  assertExecutionOpaque(request.subject.providerInstanceId);
  assertExecutionOpaque(request.threadId);
  assertExecutionOpaque(request.turnId);
  assertExecutionOpaque(request.requestId);
  assertExecutionOpaque(request.toolCallId);
  const invocationOperationId = derivedRef("official-media-invocation", {
    subject,
    invocationId: request.invocationId,
    skillRef: request.skillRef,
  });
  const attemptOperationId = derivedRef("official-media-attempt", {
    subject,
    invocationId: request.invocationId,
    attemptIndex: request.attemptIndex,
    role: request.role,
  });
  const requestDigest = digest({
    subject,
    invocationId: request.invocationId,
    skillRef: request.skillRef,
    attemptIndex: request.attemptIndex,
    role: request.role,
    submission: submissionBody(descriptor, prompt),
    occurredAt: request.occurredAt,
    threadId: request.threadId,
    turnId: request.turnId,
    requestId: request.requestId,
    toolCallId: request.toolCallId,
  });
  const checkpoint: MossOfficialMediaCheckpoint = {
    version: 1,
    state: "submission_reserved",
    revision: 0,
    requestDigest,
    subject,
    invocationId: request.invocationId,
    skillRef: request.skillRef,
    attemptIndex: request.attemptIndex,
    role: request.role,
    descriptor,
    operationGraph: { invocationOperationId, attemptOperationId },
    occurredAt: request.occurredAt,
    updatedAt: now,
    ...(request.threadId ? { threadId: request.threadId } : {}),
    ...(request.turnId ? { turnId: request.turnId } : {}),
    ...(request.requestId ? { requestId: request.requestId } : {}),
    ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
  };
  return { checkpoint, submission: { media: descriptor, prompt } };
}

function contentFreeCheckpointIdentity(value: MossOfficialMediaCheckpoint) {
  return {
    subject: value.subject,
    invocationId: value.invocationId,
    skillRef: value.skillRef,
    attemptIndex: value.attemptIndex,
    role: value.role,
    descriptor: value.descriptor,
    occurredAt: value.occurredAt,
    threadId: value.threadId,
    turnId: value.turnId,
    requestId: value.requestId,
    toolCallId: value.toolCallId,
    invocationOperationId: value.operationGraph.invocationOperationId,
    attemptOperationId: value.operationGraph.attemptOperationId,
  };
}

const CHECKPOINT_STATES = new Set<MossOfficialMediaCheckpointState>([
  "submission_reserved",
  "submission_ambiguous",
  "submission_rejected",
  "submitted",
  "completed",
  "failed",
  "cancelled",
]);

const CHECKPOINT_KEYS = new Set([
  "version",
  "state",
  "revision",
  "requestDigest",
  "subject",
  "invocationId",
  "skillRef",
  "attemptIndex",
  "role",
  "descriptor",
  "operationGraph",
  "occurredAt",
  "updatedAt",
  "threadId",
  "turnId",
  "requestId",
  "toolCallId",
  "taskId",
  "terminal",
  "submissionFailure",
  "receiptAppend",
]);

function isExactIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Validates a checkpoint using only content-free data. This is intentionally
 * independent of the original prompt so a restarted server can safely poll a
 * provider task that was durably attached before shutdown.
 */
export function assertDurableMossOfficialMediaCheckpoint(
  value: unknown,
): asserts value is MossOfficialMediaCheckpoint {
  const checkpoint = asRecord(value) as unknown as MossOfficialMediaCheckpoint | null;
  if (
    !checkpoint ||
    !hasOnlyKeys(checkpoint, CHECKPOINT_KEYS) ||
    checkpoint.version !== 1 ||
    !CHECKPOINT_STATES.has(checkpoint.state) ||
    !Number.isSafeInteger(checkpoint.revision) ||
    checkpoint.revision < 0 ||
    !Number.isSafeInteger(checkpoint.attemptIndex) ||
    checkpoint.attemptIndex < 0 ||
    !SHA256.test(checkpoint.requestDigest) ||
    !isExactIsoDateTime(checkpoint.occurredAt) ||
    !isExactIsoDateTime(checkpoint.updatedAt) ||
    (checkpoint.role !== "primary" && checkpoint.role !== "retry" && checkpoint.role !== "fallback")
  ) {
    throw new MossOfficialMediaConflictError();
  }

  let subject: UsageEventSubject;
  let descriptor: MossOfficialMediaDescriptor;
  try {
    subject = Schema.decodeUnknownSync(UsageEventSubjectSchema)(checkpoint.subject);
    descriptor = normalizeMediaDescriptor(checkpoint.descriptor);
  } catch {
    throw new MossOfficialMediaConflictError();
  }
  if (
    digest(subject) !== digest(checkpoint.subject) ||
    digest(descriptor) !== digest(checkpoint.descriptor)
  ) {
    throw new MossOfficialMediaConflictError();
  }

  assertExecutionOpaque(checkpoint.invocationId);
  assertExecutionOpaque(checkpoint.skillRef);
  assertExecutionOpaque(checkpoint.subject.accountRef);
  assertExecutionOpaque(checkpoint.subject.providerInstanceId);
  assertExecutionOpaque(checkpoint.threadId);
  assertExecutionOpaque(checkpoint.turnId);
  assertExecutionOpaque(checkpoint.requestId);
  assertExecutionOpaque(checkpoint.toolCallId);
  assertExecutionOpaque(checkpoint.taskId);

  const operationGraph = asRecord(checkpoint.operationGraph);
  if (
    !operationGraph ||
    !hasOnlyKeys(
      operationGraph,
      new Set(["invocationOperationId", "attemptOperationId", "taskOperationId"]),
    )
  ) {
    throw new MossOfficialMediaConflictError();
  }
  const expectedInvocationOperationId = derivedRef("official-media-invocation", {
    subject,
    invocationId: checkpoint.invocationId,
    skillRef: checkpoint.skillRef,
  });
  const expectedAttemptOperationId = derivedRef("official-media-attempt", {
    subject,
    invocationId: checkpoint.invocationId,
    attemptIndex: checkpoint.attemptIndex,
    role: checkpoint.role,
  });
  if (
    checkpoint.operationGraph.invocationOperationId !== expectedInvocationOperationId ||
    checkpoint.operationGraph.attemptOperationId !== expectedAttemptOperationId
  ) {
    throw new MossOfficialMediaConflictError();
  }

  const hasTask = checkpoint.taskId !== undefined;
  const hasTaskOperation = checkpoint.operationGraph.taskOperationId !== undefined;
  const hasTerminal = checkpoint.terminal !== undefined;
  const hasSubmissionFailure = checkpoint.submissionFailure !== undefined;
  if (
    checkpoint.submissionFailure &&
    (!hasOnlyKeys(checkpoint.submissionFailure, new Set(["code", "httpStatus"])) ||
      !TRANSPORT_ERROR_CODES.has(checkpoint.submissionFailure.code) ||
      (checkpoint.submissionFailure.httpStatus !== undefined &&
        (!Number.isSafeInteger(checkpoint.submissionFailure.httpStatus) ||
          checkpoint.submissionFailure.httpStatus < 300 ||
          checkpoint.submissionFailure.httpStatus > 599)))
  ) {
    throw new MossOfficialMediaConflictError();
  }
  if (
    ((checkpoint.state === "submission_reserved" || checkpoint.state === "submission_ambiguous") &&
      (hasTask || hasTaskOperation || hasTerminal || hasSubmissionFailure)) ||
    (checkpoint.state === "submission_rejected" &&
      (hasTask || hasTaskOperation || hasTerminal || !hasSubmissionFailure)) ||
    (checkpoint.state === "submitted" &&
      (!hasTask || !hasTaskOperation || hasTerminal || hasSubmissionFailure)) ||
    ((checkpoint.state === "completed" ||
      checkpoint.state === "failed" ||
      checkpoint.state === "cancelled") &&
      (!hasTask || !hasTaskOperation || !hasTerminal || hasSubmissionFailure))
  ) {
    throw new MossOfficialMediaConflictError();
  }
  if (
    checkpoint.taskId &&
    checkpoint.operationGraph.taskOperationId !==
      taskOperationId(checkpoint.operationGraph.attemptOperationId, checkpoint.taskId)
  ) {
    throw new MossOfficialMediaConflictError();
  }

  if (checkpoint.terminal) {
    const terminal = checkpoint.terminal;
    if (
      !hasOnlyKeys(
        terminal,
        new Set([
          "providerPayloadDigest",
          "actualTimeSeconds",
          "costUsd",
          "creditsCost",
          "artifactRefs",
          "imageOutputCount",
          "videoOutputSeconds",
        ]),
      ) ||
      !SHA256.test(terminal.providerPayloadDigest) ||
      !Array.isArray(terminal.artifactRefs) ||
      terminal.artifactRefs.some((ref) => typeof ref !== "string" || !OPAQUE_REF.test(ref)) ||
      (terminal.actualTimeSeconds !== undefined &&
        !NON_NEGATIVE_DECIMAL.test(terminal.actualTimeSeconds)) ||
      (terminal.costUsd !== undefined && !NON_NEGATIVE_DECIMAL.test(terminal.costUsd)) ||
      (terminal.creditsCost !== undefined && !NON_NEGATIVE_INTEGER.test(terminal.creditsCost)) ||
      (terminal.imageOutputCount !== undefined &&
        !NON_NEGATIVE_INTEGER.test(terminal.imageOutputCount)) ||
      (terminal.videoOutputSeconds !== undefined &&
        !NON_NEGATIVE_DECIMAL.test(terminal.videoOutputSeconds))
    ) {
      throw new MossOfficialMediaConflictError();
    }
    if (checkpoint.state === "completed") {
      if (terminal.artifactRefs.length === 0) {
        throw new MossOfficialMediaConflictError();
      }
      try {
        if (terminal.costUsd !== undefined) decimalUsdToNanoUnits(terminal.costUsd);
      } catch {
        throw new MossOfficialMediaConflictError();
      }
    }
  }

  if (checkpoint.receiptAppend) {
    const receiptAppend = checkpoint.receiptAppend;
    if (
      !hasOnlyKeys(receiptAppend, new Set(["state", "receiptDigest", "eventIds"])) ||
      receiptAppend.state !== "appended" ||
      !SHA256.test(receiptAppend.receiptDigest) ||
      !Array.isArray(receiptAppend.eventIds) ||
      receiptAppend.eventIds.length === 0 ||
      new Set(receiptAppend.eventIds).size !== receiptAppend.eventIds.length ||
      receiptAppend.eventIds.some((eventId) =>
        typeof eventId !== "string" ? true : !OPAQUE_REF.test(eventId),
      ) ||
      (checkpoint.state !== "submission_rejected" &&
        checkpoint.state !== "completed" &&
        checkpoint.state !== "failed" &&
        checkpoint.state !== "cancelled")
    ) {
      throw new MossOfficialMediaConflictError();
    }
    try {
      const expectedReceipt = terminalReceipt(checkpoint);
      if (
        mediaUsageReceiptDigest(expectedReceipt) !== receiptAppend.receiptDigest ||
        digest(expectedReceipt.events.map((event) => event.eventId)) !==
          digest(receiptAppend.eventIds)
      ) {
        throw new MossOfficialMediaConflictError();
      }
    } catch (error) {
      if (error instanceof MossOfficialMediaConflictError) throw error;
      throw new MossOfficialMediaConflictError();
    }
  }
}

function validateCheckpoint(
  checkpoint: MossOfficialMediaCheckpoint,
  expected: MossOfficialMediaCheckpoint,
): void {
  assertDurableMossOfficialMediaCheckpoint(checkpoint);
  if (
    checkpoint.operationGraph.attemptOperationId !== expected.operationGraph.attemptOperationId ||
    checkpoint.requestDigest !== expected.requestDigest ||
    digest(contentFreeCheckpointIdentity(checkpoint)) !==
      digest(contentFreeCheckpointIdentity(expected))
  ) {
    throw new MossOfficialMediaConflictError();
  }
}

function taskOperationId(attemptOperationId: string, taskId: string): string {
  return derivedRef("official-media-task", { attemptOperationId, taskId });
}

function decimalUsdToNanoUnits(value: string): string {
  if (!NON_NEGATIVE_DECIMAL.test(value)) {
    throw new MossOfficialMediaExecutionError("invalid_task_result");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 9) throw new MossOfficialMediaExecutionError("invalid_task_result");
  return (BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0") || "0")).toString();
}

function terminalReceipt(checkpoint: MossOfficialMediaCheckpoint): MediaUsageReceipt {
  const terminal = checkpoint.terminal;
  const taskId = checkpoint.taskId;
  const taskOperation = checkpoint.operationGraph.taskOperationId;
  if (checkpoint.state === "submission_rejected") {
    if (terminal || taskId || taskOperation || !checkpoint.submissionFailure) {
      throw new MossOfficialMediaExecutionError("invalid_checkpoint");
    }
    return buildMediaUsageReceipt({
      subject: checkpoint.subject,
      descriptor: {
        kind: checkpoint.descriptor.kind,
        modelRef: checkpoint.descriptor.model,
        ...(checkpoint.descriptor.kind === "image"
          ? {
              ...(checkpoint.descriptor.size ? { sizeRef: checkpoint.descriptor.size } : {}),
              ...(checkpoint.descriptor.resolution
                ? { resolutionRef: checkpoint.descriptor.resolution }
                : {}),
            }
          : checkpoint.descriptor.resolution
            ? { resolutionRef: checkpoint.descriptor.resolution }
            : {}),
      },
      skill: {
        invocationId: checkpoint.invocationId,
        skillRef: checkpoint.skillRef,
        state: "failed",
      },
      attempt: {
        attemptIndex: checkpoint.attemptIndex,
        role: checkpoint.role,
        state: "failed",
        ...(checkpoint.toolCallId ? { toolCallId: checkpoint.toolCallId } : {}),
      },
      pricing: { kind: "unpriced" },
      source: {
        namespace: "apimart-official-media-submission",
        authority: "local-derived",
      },
      occurredAt: checkpoint.occurredAt,
      observedAt: checkpoint.updatedAt,
      ...(checkpoint.threadId ? { threadId: checkpoint.threadId } : {}),
      ...(checkpoint.turnId ? { turnId: checkpoint.turnId } : {}),
      ...(checkpoint.requestId ? { requestId: checkpoint.requestId } : {}),
      operationIdentity: {
        skillOperationId: checkpoint.operationGraph.invocationOperationId,
        requestOperationId: checkpoint.operationGraph.attemptOperationId,
        requestParentOperationId: checkpoint.operationGraph.invocationOperationId,
      },
    });
  }
  if (!terminal || !taskId || !taskOperation) {
    throw new MossOfficialMediaExecutionError("invalid_checkpoint");
  }
  const state = checkpoint.state;
  if (state !== "completed" && state !== "failed" && state !== "cancelled") {
    throw new MossOfficialMediaExecutionError("invalid_checkpoint");
  }
  const normalizedTerminal = terminalData({
    taskId,
    state,
    providerPayloadDigest: terminal.providerPayloadDigest,
    ...(terminal.actualTimeSeconds ? { actualTimeSeconds: terminal.actualTimeSeconds } : {}),
    ...(terminal.costUsd ? { costUsd: terminal.costUsd } : {}),
    ...(terminal.creditsCost ? { creditsCost: terminal.creditsCost } : {}),
    artifactRefs: terminal.artifactRefs,
    ...(terminal.imageOutputCount ? { imageOutputCount: terminal.imageOutputCount } : {}),
    ...(terminal.videoOutputSeconds ? { videoOutputSeconds: terminal.videoOutputSeconds } : {}),
  });
  if (digest(normalizedTerminal) !== digest(terminal)) {
    throw new MossOfficialMediaConflictError();
  }
  const credits = terminal.creditsCost;
  const creditEntries: UsageCreditEntry[] =
    credits && credits !== "0" ? [{ ledger: "apimart-credit", delta: `-${credits}` }] : [];
  const hasAuthoritativePrice = terminal.costUsd !== undefined || creditEntries.length > 0;
  const descriptor = {
    kind: checkpoint.descriptor.kind,
    modelRef: checkpoint.descriptor.model,
    ...(checkpoint.descriptor.kind === "image"
      ? {
          ...(checkpoint.descriptor.size ? { sizeRef: checkpoint.descriptor.size } : {}),
          ...(checkpoint.descriptor.resolution
            ? { resolutionRef: checkpoint.descriptor.resolution }
            : {}),
        }
      : checkpoint.descriptor.resolution
        ? { resolutionRef: checkpoint.descriptor.resolution }
        : {}),
  } as const;
  return buildMediaUsageReceipt({
    subject: checkpoint.subject,
    descriptor,
    skill: {
      invocationId: checkpoint.invocationId,
      skillRef: checkpoint.skillRef,
      state,
    },
    attempt: {
      attemptIndex: checkpoint.attemptIndex,
      role: checkpoint.role,
      state,
      ...(checkpoint.toolCallId ? { toolCallId: checkpoint.toolCallId } : {}),
      mediaJobId: taskId,
    },
    ...(state === "completed"
      ? {
          observation: {
            ...(terminal.imageOutputCount ? { imageOutputCount: terminal.imageOutputCount } : {}),
            ...(terminal.videoOutputSeconds
              ? { videoOutputSeconds: terminal.videoOutputSeconds }
              : {}),
            ...(terminal.actualTimeSeconds
              ? { providerExecutionSeconds: terminal.actualTimeSeconds }
              : {}),
            ...(terminal.creditsCost ? { providerCredits: terminal.creditsCost } : {}),
          },
          pricing: hasAuthoritativePrice
            ? {
                kind: "authoritative" as const,
                ...(terminal.costUsd
                  ? {
                      money: {
                        currency: "USD" as const,
                        nanoUnits: decimalUsdToNanoUnits(terminal.costUsd),
                        basis: "provider-reported" as const,
                      },
                    }
                  : {}),
                ...(creditEntries.length > 0 ? { credits: creditEntries } : {}),
              }
            : { kind: "unpriced" as const },
        }
      : { pricing: { kind: "unpriced" as const } }),
    source: {
      namespace: "apimart-official-media-task",
      sourceEventId: taskId,
      authority: "provider-reported",
    },
    occurredAt: checkpoint.occurredAt,
    observedAt: checkpoint.updatedAt,
    ...(checkpoint.threadId ? { threadId: checkpoint.threadId } : {}),
    ...(checkpoint.turnId ? { turnId: checkpoint.turnId } : {}),
    ...(checkpoint.requestId ? { requestId: checkpoint.requestId } : {}),
    operationIdentity: {
      skillOperationId: checkpoint.operationGraph.invocationOperationId,
      requestOperationId: taskOperation,
      requestParentOperationId: checkpoint.operationGraph.attemptOperationId,
    },
  });
}

function terminalResult(checkpoint: MossOfficialMediaCheckpoint): MossOfficialMediaExecutionResult {
  if (checkpoint.state === "submission_rejected") {
    if (!checkpoint.submissionFailure) {
      throw new MossOfficialMediaExecutionError("invalid_checkpoint");
    }
    return {
      status: "submission_failed",
      failure: checkpoint.submissionFailure,
      checkpoint,
      receipt: terminalReceipt(checkpoint),
    };
  }
  if (
    checkpoint.state !== "completed" &&
    checkpoint.state !== "failed" &&
    checkpoint.state !== "cancelled"
  ) {
    throw new MossOfficialMediaExecutionError("invalid_checkpoint");
  }
  return { status: checkpoint.state, checkpoint, receipt: terminalReceipt(checkpoint) };
}

function mediaUsageReceiptDigest(receipt: MediaUsageReceipt): string {
  return digest(receipt);
}

function terminalData(task: ApiMartOfficialMediaTask): MossOfficialMediaTerminalData {
  if (!SHA256.test(task.providerPayloadDigest)) {
    throw new MossOfficialMediaExecutionError("invalid_task_result");
  }
  const artifactRefs = [...(task.artifactRefs ?? [])];
  if (artifactRefs.some((ref) => !OPAQUE_REF.test(ref))) {
    throw new MossOfficialMediaExecutionError("invalid_task_result");
  }
  if (
    (task.actualTimeSeconds !== undefined && !NON_NEGATIVE_DECIMAL.test(task.actualTimeSeconds)) ||
    (task.imageOutputCount !== undefined && !NON_NEGATIVE_INTEGER.test(task.imageOutputCount)) ||
    (task.videoOutputSeconds !== undefined && !NON_NEGATIVE_DECIMAL.test(task.videoOutputSeconds))
  ) {
    throw new MossOfficialMediaExecutionError("invalid_task_result");
  }
  if (task.state === "completed") {
    if (artifactRefs.length === 0) {
      throw new MossOfficialMediaExecutionError("invalid_task_result");
    }
    if (task.costUsd !== undefined) decimalUsdToNanoUnits(task.costUsd);
    if (task.creditsCost !== undefined && !NON_NEGATIVE_INTEGER.test(task.creditsCost)) {
      throw new MossOfficialMediaExecutionError("invalid_task_result");
    }
  }
  return {
    providerPayloadDigest: task.providerPayloadDigest,
    ...(task.actualTimeSeconds ? { actualTimeSeconds: task.actualTimeSeconds } : {}),
    ...(task.costUsd ? { costUsd: task.costUsd } : {}),
    ...(task.creditsCost ? { creditsCost: task.creditsCost } : {}),
    artifactRefs,
    ...(task.imageOutputCount ? { imageOutputCount: task.imageOutputCount } : {}),
    ...(task.videoOutputSeconds ? { videoOutputSeconds: task.videoOutputSeconds } : {}),
  };
}

export function createMossOfficialMediaExecutor(options: CreateMossOfficialMediaExecutorOptions) {
  const now = options.now ?? (() => new Date().toISOString());

  const requireDurable = () => {
    if (options.checkpointStore.durability !== "DURABLE") {
      throw new MossOfficialMediaExecutionError("durable_checkpoint_required");
    }
  };

  const cas = async (
    current: MossOfficialMediaCheckpoint,
    next: MossOfficialMediaCheckpoint,
  ): Promise<MossOfficialMediaCheckpoint> => {
    const result = await options.checkpointStore.compareAndSet(
      current.operationGraph.attemptOperationId,
      current.revision,
      next,
    );
    if (result.status === "updated") return result.checkpoint;
    if (result.status === "stale") return result.checkpoint;
    throw new MossOfficialMediaExecutionError("checkpoint_write_failed");
  };

  const persistKnownTask = async (
    initial: MossOfficialMediaCheckpoint,
    providerTaskId: string,
  ): Promise<MossOfficialMediaCheckpoint> => {
    let current = initial;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      validateCheckpoint(current, initial);
      if (current.taskId) {
        if (current.taskId !== providerTaskId) throw new MossOfficialMediaConflictError();
        return current;
      }
      if (current.state !== "submission_reserved" && current.state !== "submission_ambiguous") {
        throw new MossOfficialMediaConflictError();
      }
      const next: MossOfficialMediaCheckpoint = {
        ...current,
        state: "submitted",
        revision: current.revision + 1,
        updatedAt: now(),
        taskId: providerTaskId,
        operationGraph: {
          ...current.operationGraph,
          taskOperationId: taskOperationId(
            current.operationGraph.attemptOperationId,
            providerTaskId,
          ),
        },
      };
      const result = await options.checkpointStore.compareAndSet(
        current.operationGraph.attemptOperationId,
        current.revision,
        next,
      );
      if (result.status === "missing") {
        throw new MossOfficialMediaExecutionError("checkpoint_write_failed");
      }
      current = result.checkpoint;
      validateCheckpoint(current, initial);
      if (result.status === "updated") {
        if (current.taskId !== providerTaskId || current.state !== "submitted") {
          throw new MossOfficialMediaConflictError();
        }
        return current;
      }
    }
    throw new MossOfficialMediaExecutionError("checkpoint_write_failed");
  };

  const finish = async (
    checkpoint: MossOfficialMediaCheckpoint,
    task: ApiMartOfficialMediaTask,
  ): Promise<MossOfficialMediaExecutionResult> => {
    if (task.taskId !== checkpoint.taskId || !checkpoint.taskId) {
      throw new MossOfficialMediaConflictError();
    }
    if (task.state !== "completed" && task.state !== "failed" && task.state !== "cancelled") {
      return { status: task.state, checkpoint };
    }
    const terminal = terminalData(task);
    if (
      checkpoint.terminal &&
      (checkpoint.state === "completed" ||
        checkpoint.state === "failed" ||
        checkpoint.state === "cancelled")
    ) {
      if (
        checkpoint.state !== task.state ||
        checkpoint.terminal.providerPayloadDigest !== terminal.providerPayloadDigest
      ) {
        throw new MossOfficialMediaConflictError();
      }
      return terminalResult(checkpoint);
    }
    const next: MossOfficialMediaCheckpoint = {
      ...checkpoint,
      state: task.state,
      revision: checkpoint.revision + 1,
      updatedAt: now(),
      terminal,
    };
    const persisted = await cas(checkpoint, next);
    validateCheckpoint(persisted, checkpoint);
    if (
      persisted.state === "completed" ||
      persisted.state === "failed" ||
      persisted.state === "cancelled"
    ) {
      if (
        persisted.state !== task.state ||
        persisted.terminal?.providerPayloadDigest !== terminal.providerPayloadDigest
      ) {
        throw new MossOfficialMediaConflictError();
      }
      return terminalResult(persisted);
    }
    throw new MossOfficialMediaExecutionError("checkpoint_write_failed");
  };

  const poll = async (
    checkpoint: MossOfficialMediaCheckpoint,
  ): Promise<MossOfficialMediaExecutionResult> => {
    if (!checkpoint.taskId) throw new MossOfficialMediaExecutionError("invalid_checkpoint");
    const task = await options.transport.getTask(checkpoint.taskId);
    if (task.taskId !== checkpoint.taskId) throw new MossOfficialMediaConflictError();
    if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") {
      return finish(checkpoint, task);
    }
    return { status: task.state, checkpoint };
  };

  const submitReserved = async (
    checkpoint: MossOfficialMediaCheckpoint,
    submission: {
      readonly media: MossOfficialMediaDescriptor;
      readonly prompt: string;
    },
  ): Promise<MossOfficialMediaExecutionResult> => {
    const persistAmbiguous = async () => {
      const ambiguous: MossOfficialMediaCheckpoint = {
        ...checkpoint,
        state: "submission_ambiguous",
        revision: checkpoint.revision + 1,
        updatedAt: now(),
      };
      const persisted = await cas(checkpoint, ambiguous);
      validateCheckpoint(persisted, checkpoint);
      if (persisted.state !== "submission_reserved" && persisted.state !== "submission_ambiguous") {
        throw new MossOfficialMediaConflictError();
      }
      return {
        status: "needs_reconciliation" as const,
        reasonCode: persisted.state,
        checkpoint: persisted,
      };
    };
    const persistRejected = async (error: MossOfficialMediaTransportError) => {
      const rejected: MossOfficialMediaCheckpoint = {
        ...checkpoint,
        state: "submission_rejected",
        revision: checkpoint.revision + 1,
        updatedAt: now(),
        submissionFailure: {
          code: error.code,
          ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
        },
      };
      const persisted = await cas(checkpoint, rejected);
      validateCheckpoint(persisted, checkpoint);
      if (persisted.state !== "submission_rejected") {
        throw new MossOfficialMediaConflictError();
      }
      return terminalResult(persisted);
    };
    let submitted: { readonly taskId: string };
    try {
      submitted = await options.transport.submit(submission.media, submission.prompt);
    } catch (error) {
      if (
        error instanceof MossOfficialMediaTransportError &&
        !error.submissionMayHaveBeenAccepted
      ) {
        return persistRejected(error);
      }
      return persistAmbiguous();
    }
    if (!OPAQUE_REF.test(submitted.taskId)) {
      return persistAmbiguous();
    }
    const persisted = await persistKnownTask(checkpoint, submitted.taskId);
    if (persisted.state === "submitted" && persisted.taskId === submitted.taskId) {
      return { status: "submitted", checkpoint: persisted };
    }
    if (
      (persisted.state === "completed" ||
        persisted.state === "failed" ||
        persisted.state === "cancelled") &&
      persisted.taskId === submitted.taskId
    ) {
      return terminalResult(persisted);
    }
    throw new MossOfficialMediaConflictError();
  };

  const startOrResume = async (
    request: MossOfficialMediaExecutionRequest,
  ): Promise<MossOfficialMediaExecutionResult> => {
    requireDurable();
    const prepared = prepareRequest(request, now());
    const reservation = await options.checkpointStore.reserve(prepared.checkpoint);
    const checkpoint = reservation.checkpoint;
    validateCheckpoint(checkpoint, prepared.checkpoint);
    if (reservation.status === "inserted") {
      if (checkpoint.state !== "submission_reserved" || checkpoint.revision !== 0) {
        throw new MossOfficialMediaConflictError();
      }
      return submitReserved(checkpoint, prepared.submission);
    }
    if (checkpoint.state === "submission_reserved" || checkpoint.state === "submission_ambiguous") {
      return { status: "needs_reconciliation", reasonCode: checkpoint.state, checkpoint };
    }
    if (checkpoint.state === "submitted") return poll(checkpoint);
    return terminalResult(checkpoint);
  };

  const attachTaskId = async (
    request: MossOfficialMediaExecutionRequest,
    providerTaskId: string,
  ): Promise<MossOfficialMediaCheckpoint> => {
    requireDurable();
    if (!OPAQUE_REF.test(providerTaskId)) {
      throw new MossOfficialMediaConflictError();
    }
    const prepared = prepareRequest(request, now()).checkpoint;
    const current = await options.checkpointStore.load(prepared.operationGraph.attemptOperationId);
    if (!current) throw new MossOfficialMediaExecutionError("checkpoint_missing");
    validateCheckpoint(current, prepared);
    if (current.taskId) {
      if (current.taskId !== providerTaskId) throw new MossOfficialMediaConflictError();
      return current;
    }
    if (current.state !== "submission_reserved" && current.state !== "submission_ambiguous") {
      throw new MossOfficialMediaConflictError();
    }
    const persisted = await persistKnownTask(current, providerTaskId);
    validateCheckpoint(persisted, prepared);
    if (persisted.taskId !== providerTaskId) throw new MossOfficialMediaConflictError();
    return persisted;
  };

  const reconcileTask = async (
    request: MossOfficialMediaExecutionRequest,
  ): Promise<MossOfficialMediaExecutionResult> => {
    requireDurable();
    const prepared = prepareRequest(request, now()).checkpoint;
    const checkpoint = await options.checkpointStore.load(
      prepared.operationGraph.attemptOperationId,
    );
    if (!checkpoint) throw new MossOfficialMediaExecutionError("checkpoint_missing");
    validateCheckpoint(checkpoint, prepared);
    if (checkpoint.state === "submission_rejected") return terminalResult(checkpoint);
    if (!checkpoint.taskId) {
      return {
        status: "needs_reconciliation",
        reasonCode:
          checkpoint.state === "submission_ambiguous"
            ? "submission_ambiguous"
            : "submission_reserved",
        checkpoint,
      };
    }
    const task = await options.transport.getTask(checkpoint.taskId);
    if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") {
      return finish(checkpoint, task);
    }
    if (
      checkpoint.state === "completed" ||
      checkpoint.state === "failed" ||
      checkpoint.state === "cancelled"
    ) {
      throw new MossOfficialMediaConflictError();
    }
    return { status: task.state, checkpoint };
  };

  const reconcileCheckpoint = async (
    attemptOperationId: string,
  ): Promise<MossOfficialMediaExecutionResult> => {
    requireDurable();
    if (!OPAQUE_REF.test(attemptOperationId)) {
      throw new MossOfficialMediaConflictError();
    }
    const checkpoint = await options.checkpointStore.load(attemptOperationId);
    if (!checkpoint) throw new MossOfficialMediaExecutionError("checkpoint_missing");
    assertDurableMossOfficialMediaCheckpoint(checkpoint);
    if (checkpoint.operationGraph.attemptOperationId !== attemptOperationId) {
      throw new MossOfficialMediaConflictError();
    }
    if (
      checkpoint.state === "submission_rejected" ||
      checkpoint.state === "completed" ||
      checkpoint.state === "failed" ||
      checkpoint.state === "cancelled"
    ) {
      return terminalResult(checkpoint);
    }
    if (!checkpoint.taskId) {
      return {
        status: "needs_reconciliation",
        reasonCode:
          checkpoint.state === "submission_ambiguous"
            ? "submission_ambiguous"
            : "submission_reserved",
        checkpoint,
      };
    }
    return poll(checkpoint);
  };

  const acknowledgeLoadedReceipt = async (
    initial: MossOfficialMediaCheckpoint,
    receipt: MediaUsageReceipt,
  ): Promise<MossOfficialMediaCheckpoint> => {
    let current = initial;
    const incomingDigest = mediaUsageReceiptDigest(receipt);
    const incomingEventIds = receipt.events.map((event) => event.eventId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      assertDurableMossOfficialMediaCheckpoint(current);
      if (
        current.state !== "submission_rejected" &&
        current.state !== "completed" &&
        current.state !== "failed" &&
        current.state !== "cancelled"
      ) {
        throw new MossOfficialMediaExecutionError("invalid_checkpoint");
      }
      const expectedReceipt = terminalReceipt(current);
      if (mediaUsageReceiptDigest(expectedReceipt) !== incomingDigest) {
        throw new MossOfficialMediaConflictError();
      }
      const receiptAppend = {
        state: "appended" as const,
        receiptDigest: incomingDigest,
        eventIds: incomingEventIds,
      };
      if (current.receiptAppend) {
        if (digest(current.receiptAppend) !== digest(receiptAppend)) {
          throw new MossOfficialMediaConflictError();
        }
        return current;
      }
      const next: MossOfficialMediaCheckpoint = {
        ...current,
        revision: current.revision + 1,
        receiptAppend,
      };
      const result = await options.checkpointStore.compareAndSet(
        current.operationGraph.attemptOperationId,
        current.revision,
        next,
      );
      if (result.status === "missing") {
        throw new MossOfficialMediaExecutionError("checkpoint_write_failed");
      }
      current = result.checkpoint;
      if (result.status === "updated") {
        assertDurableMossOfficialMediaCheckpoint(current);
        return current;
      }
    }
    throw new MossOfficialMediaExecutionError("checkpoint_write_failed");
  };

  const acknowledgeReceipt = async (
    request: MossOfficialMediaExecutionRequest,
    receipt: MediaUsageReceipt,
  ): Promise<MossOfficialMediaCheckpoint> => {
    requireDurable();
    const prepared = prepareRequest(request, now()).checkpoint;
    const current = await options.checkpointStore.load(prepared.operationGraph.attemptOperationId);
    if (!current) throw new MossOfficialMediaExecutionError("checkpoint_missing");
    validateCheckpoint(current, prepared);
    const acknowledged = await acknowledgeLoadedReceipt(current, receipt);
    validateCheckpoint(acknowledged, prepared);
    return acknowledged;
  };

  const acknowledgeCheckpointReceipt = async (
    attemptOperationId: string,
    receipt: MediaUsageReceipt,
  ): Promise<MossOfficialMediaCheckpoint> => {
    requireDurable();
    if (!OPAQUE_REF.test(attemptOperationId)) {
      throw new MossOfficialMediaConflictError();
    }
    const current = await options.checkpointStore.load(attemptOperationId);
    if (!current) throw new MossOfficialMediaExecutionError("checkpoint_missing");
    assertDurableMossOfficialMediaCheckpoint(current);
    if (current.operationGraph.attemptOperationId !== attemptOperationId) {
      throw new MossOfficialMediaConflictError();
    }
    return acknowledgeLoadedReceipt(current, receipt);
  };

  return {
    startOrResume,
    attachTaskId,
    reconcileTask,
    reconcileCheckpoint,
    acknowledgeReceipt,
    acknowledgeCheckpointReceipt,
  } as const;
}
