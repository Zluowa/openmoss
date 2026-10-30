// FILE: mediaUsageReceiptBridge.ts
// Purpose: Builds content-free unified usage receipts for paid media request attempts.
// Layer: Server usage boundary
// Exports: Receipt builder, append boundary, and provider-event image observation adapter

import { createHash } from "node:crypto";

import {
  UnifiedUsageEvent as UnifiedUsageEventSchema,
  type ProviderRuntimeEvent,
  type UnifiedUsageEvent,
  type UsageBillableMoney,
  type UsageCreditEntry,
  type UsageEventSubject,
  type UsageMeter,
} from "@synara/contracts";
import { Schema } from "effect";

const MEDIA_RECEIPT_ADAPTER_VERSION = "v1";
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

export const MEDIA_USAGE_INSTRUMENTATION = {
  receiptBridge: "PRODUCTION_CONTRACT_READY",
  codexBuiltInImageEventAdapter: "LOCAL_CONTRACT_ACCOUNT_SCOPE_REQUIRED",
  codexBuiltInImageProductionPersistence: "NOT_INSTRUMENTED",
  officialVideoSkillsProductionPersistence: "SERVER_COORDINATOR_READY_GATEWAY_BLOCKED",
} as const;

export type MediaUsageKind = "image" | "video";
export type MediaAttemptRole = "primary" | "retry" | "fallback";
export type MediaOperationState = "started" | "completed" | "failed" | "cancelled";

export interface MediaUsageDescriptor {
  readonly kind: MediaUsageKind;
  readonly modelRef?: string;
  readonly sizeRef?: string;
  readonly qualityRef?: string;
  readonly resolutionRef?: string;
}

export interface MediaUsageObservation {
  readonly imageOutputCount?: string;
  readonly outputImageTokens?: string;
  readonly videoInputSeconds?: string;
  readonly videoOutputSeconds?: string;
  readonly videoFrames?: string;
  /** Provider-reported job processing time, distinct from media duration. */
  readonly providerExecutionSeconds?: string;
  readonly providerCredits?: string;
}

export interface ProviderEventMediaUsageScope {
  /** Opaque account identity resolved by an authoritative account boundary. */
  readonly accountRef: string;
  readonly observedAt?: string;
}

export type MediaUsagePricing =
  | { readonly kind: "unpriced" }
  | { readonly kind: "estimated" }
  | {
      readonly kind: "authoritative";
      readonly money?: UsageBillableMoney;
      readonly credits?: ReadonlyArray<UsageCreditEntry>;
    };

export interface MediaSkillInvocation {
  readonly invocationId: string;
  readonly skillRef: string;
  /** Emit only observed skill lifecycle transitions. Attempts must not invent them. */
  readonly state?: MediaOperationState;
}

export interface MediaRequestAttempt {
  readonly attemptIndex: number;
  readonly role: MediaAttemptRole;
  readonly state: MediaOperationState;
  readonly toolCallId?: string;
  readonly mediaJobId?: string;
}

export interface BuildMediaUsageReceiptInput {
  readonly subject: UsageEventSubject;
  readonly descriptor: MediaUsageDescriptor;
  readonly skill?: MediaSkillInvocation;
  readonly attempt: MediaRequestAttempt;
  readonly observation?: MediaUsageObservation;
  readonly pricing: MediaUsagePricing;
  readonly source: {
    readonly namespace: string;
    readonly sourceEventId?: string;
    readonly authority:
      | "provider-reported"
      | "gateway-measured"
      | "rate-card-calculated"
      | "local-derived"
      | "estimated";
  };
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
  /**
   * Optional stable identities supplied by a durable executor. They let an
   * attempt retain one operation across provider task assignment and replay.
   */
  readonly operationIdentity?: {
    readonly skillOperationId?: string;
    readonly requestOperationId: string;
    readonly requestParentOperationId?: string;
  };
}

export type MediaUsageBillingDisposition =
  | "authoritative-settlement"
  | "unpriced-observation"
  | "estimated-observation"
  | "no-usage-observed";

export interface MediaUsageReceipt {
  readonly version: 1;
  readonly descriptor: MediaUsageDescriptor;
  readonly skillOperationId?: string;
  readonly requestOperationId: string;
  readonly billingDisposition: MediaUsageBillingDisposition;
  readonly events: ReadonlyArray<UnifiedUsageEvent>;
}

export type MediaUsageAppendResult =
  | { readonly status: "inserted" | "idempotent"; readonly eventId: string }
  | {
      readonly status: "idempotency_conflict";
      readonly eventId: string;
      readonly existingDigest: string;
      readonly incomingDigest: string;
    }
  | { readonly status: "rejected"; readonly reasonCode: string }
  | { readonly status: "local_contract_only"; readonly eventId: string };

export interface MediaUsageReceiptAppender {
  readonly instrumentationStatus: "DURABLE" | "LOCAL_CONTRACT_ONLY";
  /** Durable implementations must commit the complete receipt transactionally. */
  readonly appendAtomically: (
    events: ReadonlyArray<UnifiedUsageEvent>,
  ) => Promise<ReadonlyArray<MediaUsageAppendResult>>;
}

export class MediaUsageReceiptAppendError extends Error {
  readonly result: Extract<MediaUsageAppendResult, { status: "idempotency_conflict" | "rejected" }>;

  constructor(
    result: Extract<MediaUsageAppendResult, { status: "idempotency_conflict" | "rejected" }>,
  ) {
    super(`media usage receipt append failed closed: ${result.status}`);
    this.name = "MediaUsageReceiptAppendError";
    this.result = result;
  }
}

export const localContractOnlyMediaUsageAppender: MediaUsageReceiptAppender = {
  instrumentationStatus: "LOCAL_CONTRACT_ONLY",
  appendAtomically: async (events) =>
    events.map((event) => ({ status: "local_contract_only", eventId: event.eventId })),
};

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

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

/**
 * Mirrors PostgreSQL `jsonb::text` for the content-free usage payload subset.
 * jsonb orders object keys by UTF-8 byte length, then bytewise. Whitespace is
 * significant because the server-side digest hashes that exact text form.
 */
export function postgresJsonbTextForUsagePayload(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("usage payload numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(postgresJsonbTextForUsagePayload).join(", ")}]`;
  }
  if (!value || typeof value !== "object") {
    throw new Error("usage payload contains an unsupported value");
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, entry]) => entry !== undefined,
  );
  entries.sort(([left], [right]) => {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length - rightBytes.length || Buffer.compare(leftBytes, rightBytes);
  });
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}: ${postgresJsonbTextForUsagePayload(entry)}`)
    .join(", ")}}`;
}

export function postgresUsagePayloadDigest(payload: unknown): string {
  return createHash("sha256").update(postgresJsonbTextForUsagePayload(payload)).digest("hex");
}

function assertOpaqueRef(value: string, name: string): string {
  if (!OPAQUE_REF.test(value)) throw new Error(`${name} must be an opaque content-free reference`);
  return value;
}

function optionalOpaqueRef(value: string | undefined, name: string): string | undefined {
  return value === undefined ? undefined : assertOpaqueRef(value, name);
}

function derivedRef(prefix: string, source: unknown): string {
  return `${prefix}-${sha256(source).slice(0, 40)}`;
}

function assertCount(value: string | undefined, name: string): string | undefined {
  if (value !== undefined && !NON_NEGATIVE_INTEGER.test(value)) {
    throw new Error(`${name} must be a non-negative integer string`);
  }
  return value;
}

function assertDecimal(value: string | undefined, name: string): string | undefined {
  if (value !== undefined && !NON_NEGATIVE_DECIMAL.test(value)) {
    throw new Error(`${name} must be a non-negative decimal string`);
  }
  return value;
}

function observationMeters(observation: MediaUsageObservation | undefined): UsageMeter[] {
  if (!observation) return [];
  const meters: UsageMeter[] = [];
  const imageOutputCount = assertCount(observation.imageOutputCount, "imageOutputCount");
  const outputImageTokens = assertCount(observation.outputImageTokens, "outputImageTokens");
  const videoInputSeconds = assertDecimal(observation.videoInputSeconds, "videoInputSeconds");
  const videoOutputSeconds = assertDecimal(observation.videoOutputSeconds, "videoOutputSeconds");
  const videoFrames = assertCount(observation.videoFrames, "videoFrames");
  const providerExecutionSeconds = assertDecimal(
    observation.providerExecutionSeconds,
    "providerExecutionSeconds",
  );
  const providerCredits = assertCount(observation.providerCredits, "providerCredits");
  if (imageOutputCount !== undefined) {
    meters.push({ metric: "image_output_count", unit: "count", quantity: imageOutputCount });
  }
  if (outputImageTokens !== undefined) {
    meters.push({ metric: "output_image_token", unit: "token", quantity: outputImageTokens });
  }
  if (videoInputSeconds !== undefined) {
    meters.push({ metric: "video_input_second", unit: "second", quantity: videoInputSeconds });
  }
  if (videoOutputSeconds !== undefined) {
    meters.push({ metric: "video_output_second", unit: "second", quantity: videoOutputSeconds });
  }
  if (videoFrames !== undefined) {
    meters.push({ metric: "video_frame", unit: "frame", quantity: videoFrames });
  }
  if (providerExecutionSeconds !== undefined) {
    meters.push({
      metric: "provider_execution_second",
      unit: "second",
      quantity: providerExecutionSeconds,
    });
  }
  if (providerCredits !== undefined) {
    meters.push({ metric: "provider_credit", unit: "credit", quantity: providerCredits });
  }
  return meters;
}

function assertMediaObservationMatchesDescriptor(
  descriptor: MediaUsageDescriptor,
  observation: MediaUsageObservation | undefined,
): void {
  if (!observation) return;
  if (
    descriptor.kind === "image" &&
    (observation.videoInputSeconds !== undefined ||
      observation.videoOutputSeconds !== undefined ||
      observation.videoFrames !== undefined)
  ) {
    throw new Error("image receipts cannot contain video meters");
  }
  if (
    descriptor.kind === "video" &&
    (observation.imageOutputCount !== undefined || observation.outputImageTokens !== undefined)
  ) {
    throw new Error("video receipts cannot contain image output meters");
  }
}

function assertPricingAuthority(input: BuildMediaUsageReceiptInput): void {
  if (input.pricing.kind === "estimated" && input.source.authority !== "estimated") {
    throw new Error("estimated pricing requires estimated source authority");
  }
  if (
    input.pricing.kind === "authoritative" &&
    (input.pricing.money !== undefined || (input.pricing.credits?.length ?? 0) > 0) &&
    input.source.authority !== "provider-reported" &&
    input.source.authority !== "gateway-measured" &&
    input.source.authority !== "rate-card-calculated"
  ) {
    throw new Error("billable settlement requires authoritative source authority");
  }
}

function validateDescriptor(descriptor: MediaUsageDescriptor): MediaUsageDescriptor {
  return {
    kind: descriptor.kind,
    ...(optionalOpaqueRef(descriptor.modelRef, "modelRef")
      ? { modelRef: descriptor.modelRef }
      : {}),
    ...(optionalOpaqueRef(descriptor.sizeRef, "sizeRef") ? { sizeRef: descriptor.sizeRef } : {}),
    ...(optionalOpaqueRef(descriptor.qualityRef, "qualityRef")
      ? { qualityRef: descriptor.qualityRef }
      : {}),
    ...(optionalOpaqueRef(descriptor.resolutionRef, "resolutionRef")
      ? { resolutionRef: descriptor.resolutionRef }
      : {}),
  };
}

function billingDisposition(
  input: BuildMediaUsageReceiptInput,
  meters: ReadonlyArray<UsageMeter>,
): MediaUsageBillingDisposition {
  if (input.attempt.state !== "completed") return "no-usage-observed";
  if (
    input.pricing.kind === "authoritative" &&
    (input.pricing.money !== undefined || (input.pricing.credits?.length ?? 0) > 0)
  ) {
    return "authoritative-settlement";
  }
  if (meters.length === 0) return "no-usage-observed";
  return input.pricing.kind === "estimated" ? "estimated-observation" : "unpriced-observation";
}

function eventBase(input: {
  readonly subject: UsageEventSubject;
  readonly operation: UnifiedUsageEvent["operation"];
  readonly source: BuildMediaUsageReceiptInput["source"];
  readonly sourceEventId?: string;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly eventRole: string;
  readonly payload: unknown;
}) {
  const eventIdentity = {
    subject: input.subject,
    operation: input.operation,
    source: input.source,
    eventRole: input.eventRole,
  };
  return {
    schemaVersion: 1 as const,
    eventId: derivedRef("media-event", eventIdentity),
    idempotencyKey: derivedRef("media-idem", eventIdentity),
    payloadDigest: postgresUsagePayloadDigest(input.payload),
    occurredAt: input.occurredAt,
    observedAt: input.observedAt,
    subject: input.subject,
    operation: input.operation,
    source: {
      namespace: assertOpaqueRef(input.source.namespace, "source namespace"),
      adapterVersion: MEDIA_RECEIPT_ADAPTER_VERSION,
      ...(input.sourceEventId
        ? { sourceEventId: assertOpaqueRef(input.sourceEventId, "sourceEventId") }
        : {}),
      authority: input.source.authority,
    },
    redaction: "content-free-v1" as const,
  };
}

function decodeEvent(event: unknown): UnifiedUsageEvent {
  return Schema.decodeUnknownSync(UnifiedUsageEventSchema)(event);
}

export function buildMediaUsageReceipt(input: BuildMediaUsageReceiptInput): MediaUsageReceipt {
  if (!Number.isSafeInteger(input.attempt.attemptIndex) || input.attempt.attemptIndex < 0) {
    throw new Error("attemptIndex must be a non-negative safe integer");
  }
  const descriptor = validateDescriptor(input.descriptor);
  assertMediaObservationMatchesDescriptor(descriptor, input.observation);
  assertPricingAuthority(input);
  if (input.operationIdentity?.skillOperationId && !input.skill) {
    throw new Error("skillOperationId requires a skill invocation");
  }
  const skillOperationId = input.skill
    ? input.operationIdentity?.skillOperationId
      ? assertOpaqueRef(input.operationIdentity.skillOperationId, "skillOperationId")
      : derivedRef("media-skill", {
          invocationId: assertOpaqueRef(input.skill.invocationId, "skill invocationId"),
          skillRef: assertOpaqueRef(input.skill.skillRef, "skillRef"),
          subject: input.subject,
        })
    : undefined;
  const requestOperationId = input.operationIdentity?.requestOperationId
    ? assertOpaqueRef(input.operationIdentity.requestOperationId, "requestOperationId")
    : derivedRef("media-request", {
        skillOperationId,
        descriptor,
        subject: input.subject,
        attemptIndex: input.attempt.attemptIndex,
        role: input.attempt.role,
        toolCallId: optionalOpaqueRef(input.attempt.toolCallId, "toolCallId"),
        mediaJobId: optionalOpaqueRef(input.attempt.mediaJobId, "mediaJobId"),
      });
  const requestParentOperationId = input.operationIdentity?.requestParentOperationId
    ? assertOpaqueRef(input.operationIdentity.requestParentOperationId, "requestParentOperationId")
    : skillOperationId;
  const operation = {
    operationId: requestOperationId,
    ...(requestParentOperationId ? { parentOperationId: requestParentOperationId } : {}),
    ...(optionalOpaqueRef(input.threadId, "threadId") ? { threadId: input.threadId } : {}),
    ...(optionalOpaqueRef(input.turnId, "turnId") ? { turnId: input.turnId } : {}),
    ...(optionalOpaqueRef(input.requestId, "requestId") ? { requestId: input.requestId } : {}),
    ...(optionalOpaqueRef(input.attempt.toolCallId, "toolCallId")
      ? { toolCallId: input.attempt.toolCallId }
      : {}),
    ...(input.skill ? { skillInvocationId: input.skill.invocationId } : {}),
    ...(optionalOpaqueRef(input.attempt.mediaJobId, "mediaJobId")
      ? { mediaJobId: input.attempt.mediaJobId }
      : {}),
  } satisfies UnifiedUsageEvent["operation"];
  const meters = observationMeters(input.observation);
  const disposition = billingDisposition(input, meters);
  const events: UnifiedUsageEvent[] = [];

  if (input.skill?.state) {
    const payload = {
      operationType: "skill-invocation" as const,
      state: input.skill.state,
      attributionOnly: true,
    };
    events.push(
      decodeEvent({
        ...eventBase({
          subject: input.subject,
          operation: {
            operationId: skillOperationId!,
            ...(optionalOpaqueRef(input.threadId, "threadId") ? { threadId: input.threadId } : {}),
            ...(optionalOpaqueRef(input.turnId, "turnId") ? { turnId: input.turnId } : {}),
            skillInvocationId: input.skill.invocationId,
          },
          source: input.source,
          ...(input.source.sourceEventId ? { sourceEventId: input.source.sourceEventId } : {}),
          occurredAt: input.occurredAt,
          observedAt: input.observedAt,
          eventRole: `skill-${input.skill.state}`,
          payload,
        }),
        kind: "operation.lifecycle",
        payload,
      }),
    );
  }

  const settlementPayload =
    disposition === "authoritative-settlement" && input.pricing.kind === "authoritative"
      ? {
          meters,
          money: input.pricing.money ?? null,
          credits: [...(input.pricing.credits ?? [])],
          measurementBasis:
            input.source.authority === "gateway-measured"
              ? ("gateway-measured" as const)
              : input.source.authority === "rate-card-calculated"
                ? ("gateway-measured" as const)
                : ("provider-reported" as const),
        }
      : undefined;
  const settlementEventId = settlementPayload
    ? derivedRef("media-event", {
        subject: input.subject,
        operation,
        source: input.source,
        eventRole: "billing-settlement",
      })
    : undefined;
  const requestLifecyclePayload = {
    operationType:
      descriptor.kind === "image" ? ("image-generation" as const) : ("video-generation" as const),
    state: input.attempt.state,
    attributionOnly: false,
    ...(settlementEventId ? { billingOwnerEventId: settlementEventId } : {}),
  };
  events.push(
    decodeEvent({
      ...eventBase({
        subject: input.subject,
        operation,
        source: input.source,
        ...(input.source.sourceEventId ? { sourceEventId: input.source.sourceEventId } : {}),
        occurredAt: input.occurredAt,
        observedAt: input.observedAt,
        eventRole: `request-${input.attempt.state}`,
        payload: requestLifecyclePayload,
      }),
      kind: "operation.lifecycle",
      payload: requestLifecyclePayload,
    }),
  );

  if (input.attempt.state === "completed" && meters.length > 0 && !settlementPayload) {
    const payload = { meters };
    events.push(
      decodeEvent({
        ...eventBase({
          subject: input.subject,
          operation,
          source: input.source,
          ...(input.source.sourceEventId ? { sourceEventId: input.source.sourceEventId } : {}),
          occurredAt: input.occurredAt,
          observedAt: input.observedAt,
          eventRole: `usage-${input.pricing.kind}`,
          payload,
        }),
        kind: "usage.delta",
        payload,
      }),
    );
  }

  if (input.attempt.state === "completed" && settlementPayload) {
    events.push(
      decodeEvent({
        ...eventBase({
          subject: input.subject,
          operation,
          source: input.source,
          ...(input.source.sourceEventId ? { sourceEventId: input.source.sourceEventId } : {}),
          occurredAt: input.occurredAt,
          observedAt: input.observedAt,
          eventRole: "billing-settlement",
          payload: settlementPayload,
        }),
        kind: "billing.settlement",
        payload: settlementPayload,
      }),
    );
  }

  return {
    version: 1,
    descriptor,
    ...(skillOperationId ? { skillOperationId } : {}),
    requestOperationId,
    billingDisposition: disposition,
    events,
  };
}

export async function appendMediaUsageReceipt(
  appender: MediaUsageReceiptAppender,
  receipt: MediaUsageReceipt,
): Promise<ReadonlyArray<MediaUsageAppendResult>> {
  const results = await appender.appendAtomically(receipt.events);
  if (results.length !== receipt.events.length) {
    throw new Error("media usage receipt appender returned an incomplete atomic result");
  }
  for (const [index, result] of results.entries()) {
    const event = receipt.events[index];
    if (event && result.status !== "rejected" && result.eventId !== event.eventId) {
      throw new Error("media usage receipt appender returned an event identity mismatch");
    }
    if (result.status === "idempotency_conflict" || result.status === "rejected") {
      throw new MediaUsageReceiptAppendError(result);
    }
  }
  return results;
}

/**
 * Current real provider instrumentation. Codex's normalized completion proves
 * one output image and nothing about model, dimensions, quality, credits, or
 * money. The runtime event also does not prove an account identity, so callers
 * must supply one from an authoritative account boundary. Those missing fields
 * are intentionally not guessed.
 */
export function mediaUsageReceiptFromProviderEvent(
  event: ProviderRuntimeEvent,
  scope?: ProviderEventMediaUsageScope,
): MediaUsageReceipt | null {
  if (
    !scope ||
    !OPAQUE_REF.test(scope.accountRef) ||
    event.provider !== "codex" ||
    event.type !== "item.completed" ||
    event.payload.itemType !== "image_generation" ||
    event.payload.status !== "completed" ||
    !event.providerInstanceId
  ) {
    return null;
  }
  const toolCallId = event.itemId ?? event.providerRefs?.providerItemId;
  if (!toolCallId) return null;

  return buildMediaUsageReceipt({
    subject: {
      provider: "codex",
      providerInstanceId: event.providerInstanceId,
      accountRef: scope.accountRef,
    },
    descriptor: { kind: "image" },
    attempt: {
      attemptIndex: 0,
      role: "primary",
      state: "completed",
      toolCallId,
    },
    observation: { imageOutputCount: "1" },
    pricing: { kind: "unpriced" },
    source: {
      namespace: "codex-image-generation-event",
      sourceEventId: event.eventId,
      authority: "local-derived",
    },
    occurredAt: event.createdAt,
    observedAt: scope.observedAt ?? event.createdAt,
    threadId: event.threadId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.requestId ? { requestId: event.requestId } : {}),
  });
}
