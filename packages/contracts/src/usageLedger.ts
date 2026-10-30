import { Schema } from "effect";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance";

function usageLedgerClosedStruct<Fields extends Schema.Struct.Fields>(fields: Fields) {
  return Schema.Struct(fields).annotate({ parseOptions: { onExcessProperty: "error" } });
}

const OPAQUE_USAGE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const SIGNED_NON_ZERO_INTEGER_PATTERN = /^(?:-[1-9][0-9]*|[1-9][0-9]*)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Opaque, content-free identity used by the usage ledger. Values deliberately
 * exclude whitespace and path separators so account and operation references
 * cannot accidentally become user content or local filesystem paths.
 */
export const UsageLedgerOpaqueRef = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.isPattern(OPAQUE_USAGE_REF_PATTERN),
);
export type UsageLedgerOpaqueRef = typeof UsageLedgerOpaqueRef.Type;

export const UsageLedgerPayloadDigest = Schema.String.check(Schema.isPattern(SHA256_PATTERN));
export type UsageLedgerPayloadDigest = typeof UsageLedgerPayloadDigest.Type;

export const UsageLedgerNonNegativeInteger = Schema.String.check(
  Schema.isPattern(NON_NEGATIVE_INTEGER_PATTERN),
);
export type UsageLedgerNonNegativeInteger = typeof UsageLedgerNonNegativeInteger.Type;

export const UsageLedgerNonNegativeDecimal = Schema.String.check(
  Schema.isPattern(NON_NEGATIVE_DECIMAL_PATTERN),
);
export type UsageLedgerNonNegativeDecimal = typeof UsageLedgerNonNegativeDecimal.Type;

export const UsageLedgerCreditDelta = Schema.String.check(
  Schema.isPattern(SIGNED_NON_ZERO_INTEGER_PATTERN),
);
export type UsageLedgerCreditDelta = typeof UsageLedgerCreditDelta.Type;

export const UsageTokenMetric = Schema.Literals([
  "input_text_token",
  "input_cached_text_token",
  "input_cache_write_token",
  "output_text_token",
  "reasoning_output_token",
  "input_audio_token",
  "input_cached_audio_token",
  "output_audio_token",
  "input_image_token",
  "input_cached_image_token",
  "output_image_token",
]);
export type UsageTokenMetric = typeof UsageTokenMetric.Type;

export const UsageCountMetric = Schema.Literals(["image_output_count", "request_count"]);
export type UsageCountMetric = typeof UsageCountMetric.Type;

export const UsageSecondMetric = Schema.Literals([
  "video_input_second",
  "video_output_second",
  "provider_execution_second",
]);
export type UsageSecondMetric = typeof UsageSecondMetric.Type;

export const UsageFrameMetric = Schema.Literal("video_frame");
export type UsageFrameMetric = typeof UsageFrameMetric.Type;

export const UsageCreditMetric = Schema.Literal("provider_credit");
export type UsageCreditMetric = typeof UsageCreditMetric.Type;

export const UsageTokenMeter = usageLedgerClosedStruct({
  metric: UsageTokenMetric,
  unit: Schema.Literal("token"),
  quantity: UsageLedgerNonNegativeInteger,
});
export type UsageTokenMeter = typeof UsageTokenMeter.Type;

export const UsageCountMeter = usageLedgerClosedStruct({
  metric: UsageCountMetric,
  unit: Schema.Literal("count"),
  quantity: UsageLedgerNonNegativeInteger,
});
export type UsageCountMeter = typeof UsageCountMeter.Type;

export const UsageSecondMeter = usageLedgerClosedStruct({
  metric: UsageSecondMetric,
  unit: Schema.Literal("second"),
  quantity: UsageLedgerNonNegativeDecimal,
});
export type UsageSecondMeter = typeof UsageSecondMeter.Type;

export const UsageFrameMeter = usageLedgerClosedStruct({
  metric: UsageFrameMetric,
  unit: Schema.Literal("frame"),
  quantity: UsageLedgerNonNegativeInteger,
});
export type UsageFrameMeter = typeof UsageFrameMeter.Type;

export const UsageProviderCreditMeter = usageLedgerClosedStruct({
  metric: UsageCreditMetric,
  unit: Schema.Literal("credit"),
  quantity: UsageLedgerNonNegativeInteger,
});
export type UsageProviderCreditMeter = typeof UsageProviderCreditMeter.Type;

export const UsageMeter = Schema.Union([
  UsageTokenMeter,
  UsageCountMeter,
  UsageSecondMeter,
  UsageFrameMeter,
  UsageProviderCreditMeter,
]);
export type UsageMeter = typeof UsageMeter.Type;

export const UsageMeters = Schema.Array(UsageMeter).check(Schema.isMaxLength(256));
export type UsageMeters = typeof UsageMeters.Type;

export const NonEmptyUsageMeters = Schema.Array(UsageMeter).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
export type NonEmptyUsageMeters = typeof NonEmptyUsageMeters.Type;

export const UsageCostBasis = Schema.Literals([
  "provider-reported",
  "rate-card-calculated",
  "estimated",
  "reservation-fallback",
]);
export type UsageCostBasis = typeof UsageCostBasis.Type;

export const UsageMoney = usageLedgerClosedStruct({
  currency: Schema.Literal("USD"),
  nanoUnits: UsageLedgerNonNegativeInteger,
  basis: UsageCostBasis,
  priceCardId: Schema.optionalKey(UsageLedgerOpaqueRef),
});
export type UsageMoney = typeof UsageMoney.Type;

export const UsageBillableCostBasis = Schema.Literals([
  "provider-reported",
  "rate-card-calculated",
  "reservation-fallback",
]);
export type UsageBillableCostBasis = typeof UsageBillableCostBasis.Type;

/** A monetary receipt that may mutate billing. Estimates are shadow data only. */
export const UsageBillableMoney = usageLedgerClosedStruct({
  currency: Schema.Literal("USD"),
  nanoUnits: UsageLedgerNonNegativeInteger,
  basis: UsageBillableCostBasis,
  priceCardId: Schema.optionalKey(UsageLedgerOpaqueRef),
});
export type UsageBillableMoney = typeof UsageBillableMoney.Type;

export const UsageCreditEntry = usageLedgerClosedStruct({
  ledger: UsageLedgerOpaqueRef,
  delta: UsageLedgerCreditDelta,
  conversionPolicyId: Schema.optionalKey(UsageLedgerOpaqueRef),
});
export type UsageCreditEntry = typeof UsageCreditEntry.Type;

export const UsageCreditEntries = Schema.Array(UsageCreditEntry).check(Schema.isMaxLength(32));
export type UsageCreditEntries = typeof UsageCreditEntries.Type;

export const UsageWindowCycleKind = Schema.Literals([
  "fixed",
  "rolling",
  "provider-defined",
  "unknown",
]);
export type UsageWindowCycleKind = typeof UsageWindowCycleKind.Type;

export const UsageWindowStartBasis = Schema.Literals(["provider", "derived", "unknown"]);
export type UsageWindowStartBasis = typeof UsageWindowStartBasis.Type;

export const UsageWindowField = Schema.Literals([
  "sourceWindowId",
  "sourceRole",
  "cycleKind",
  "durationSeconds",
  "periodStart",
  "periodEnd",
  "resetsAt",
  "startBasis",
  "revision",
]);
export type UsageWindowField = typeof UsageWindowField.Type;

/**
 * Provider-defined quota-window identity. `sourceRole` and duration may be
 * displayed as "5h" or "7d" by a projection, but no natural-week meaning is
 * encoded here. `fieldMask` makes sparse provider updates replay-safe.
 */
export const UsageWindow = usageLedgerClosedStruct({
  windowKey: UsageLedgerOpaqueRef,
  sourceWindowId: Schema.optionalKey(UsageLedgerOpaqueRef),
  sourceRole: Schema.optionalKey(UsageLedgerOpaqueRef),
  cycleKind: UsageWindowCycleKind,
  durationSeconds: Schema.optionalKey(PositiveInt),
  periodStart: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  periodEnd: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  resetsAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  startBasis: UsageWindowStartBasis,
  revision: Schema.optionalKey(UsageLedgerOpaqueRef),
  fieldMask: Schema.Array(UsageWindowField).check(Schema.isMaxLength(16)),
});
export type UsageWindow = typeof UsageWindow.Type;

export const UsageQuotaWindowSnapshot = usageLedgerClosedStruct({
  window: UsageWindow,
  usedMeters: UsageMeters,
  limitMeters: UsageMeters,
  remainingMeters: UsageMeters,
  usedPercent: Schema.optionalKey(
    Schema.NullOr(
      Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100)),
    ),
  ),
});
export type UsageQuotaWindowSnapshot = typeof UsageQuotaWindowSnapshot.Type;

export const UsageEventSubject = usageLedgerClosedStruct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  accountRef: UsageLedgerOpaqueRef,
  entitlementRef: Schema.optionalKey(UsageLedgerOpaqueRef),
});
export type UsageEventSubject = typeof UsageEventSubject.Type;

export const UsageOperationGraph = usageLedgerClosedStruct({
  operationId: UsageLedgerOpaqueRef,
  parentOperationId: Schema.optionalKey(UsageLedgerOpaqueRef),
  threadId: Schema.optionalKey(UsageLedgerOpaqueRef),
  turnId: Schema.optionalKey(UsageLedgerOpaqueRef),
  requestId: Schema.optionalKey(UsageLedgerOpaqueRef),
  responseId: Schema.optionalKey(UsageLedgerOpaqueRef),
  toolCallId: Schema.optionalKey(UsageLedgerOpaqueRef),
  skillInvocationId: Schema.optionalKey(UsageLedgerOpaqueRef),
  mediaJobId: Schema.optionalKey(UsageLedgerOpaqueRef),
});
export type UsageOperationGraph = typeof UsageOperationGraph.Type;

export const UsageEventAuthority = Schema.Literals([
  "provider-reported",
  "gateway-measured",
  "rate-card-calculated",
  "local-derived",
  "estimated",
]);
export type UsageEventAuthority = typeof UsageEventAuthority.Type;

export const UsageEventSource = usageLedgerClosedStruct({
  namespace: UsageLedgerOpaqueRef,
  adapterVersion: UsageLedgerOpaqueRef,
  sourceEventId: Schema.optionalKey(UsageLedgerOpaqueRef),
  sequence: Schema.optionalKey(UsageLedgerNonNegativeInteger),
  authority: UsageEventAuthority,
});
export type UsageEventSource = typeof UsageEventSource.Type;

export const UsageDeltaPayload = usageLedgerClosedStruct({
  meters: NonEmptyUsageMeters,
});
export type UsageDeltaPayload = typeof UsageDeltaPayload.Type;

export const UsageCounterSnapshotPayload = usageLedgerClosedStruct({
  seriesId: UsageLedgerOpaqueRef,
  epochId: UsageLedgerOpaqueRef,
  revision: Schema.optionalKey(UsageLedgerOpaqueRef),
  counterMode: Schema.Literal("cumulative"),
  meters: NonEmptyUsageMeters,
});
export type UsageCounterSnapshotPayload = typeof UsageCounterSnapshotPayload.Type;

export const UsageContextSnapshotPayload = usageLedgerClosedStruct({
  seriesId: UsageLedgerOpaqueRef,
  epochId: UsageLedgerOpaqueRef,
  revision: Schema.optionalKey(UsageLedgerOpaqueRef),
  meters: NonEmptyUsageMeters,
  contextLimitTokens: Schema.NullOr(UsageLedgerNonNegativeInteger),
});
export type UsageContextSnapshotPayload = typeof UsageContextSnapshotPayload.Type;

export const UsageQuotaSnapshotPayload = usageLedgerClosedStruct({
  windows: Schema.Array(UsageQuotaWindowSnapshot).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
});
export type UsageQuotaSnapshotPayload = typeof UsageQuotaSnapshotPayload.Type;

export const UsageBillingReservationPayload = usageLedgerClosedStruct({
  reservedMeters: UsageMeters,
  money: Schema.NullOr(UsageMoney),
  credits: UsageCreditEntries,
  expiresAt: Schema.NullOr(IsoDateTime),
});
export type UsageBillingReservationPayload = typeof UsageBillingReservationPayload.Type;

export const UsageMeasurementBasis = Schema.Literals([
  "provider-reported",
  "gateway-measured",
  "reservation-fallback",
  "unknown",
]);
export type UsageMeasurementBasis = typeof UsageMeasurementBasis.Type;

export const UsageBillingSettlementPayload = usageLedgerClosedStruct({
  meters: UsageMeters,
  money: Schema.NullOr(UsageBillableMoney),
  credits: UsageCreditEntries,
  measurementBasis: UsageMeasurementBasis,
  settlesReservationEventId: Schema.optionalKey(UsageLedgerOpaqueRef),
});
export type UsageBillingSettlementPayload = typeof UsageBillingSettlementPayload.Type;

export const UsageBillingAdjustmentPayload = usageLedgerClosedStruct({
  relatesToEventId: UsageLedgerOpaqueRef,
  direction: Schema.Literals(["charge", "refund", "correction"]),
  meters: UsageMeters,
  money: Schema.NullOr(UsageBillableMoney),
  credits: UsageCreditEntries,
  reasonCode: UsageLedgerOpaqueRef,
});
export type UsageBillingAdjustmentPayload = typeof UsageBillingAdjustmentPayload.Type;

export const UsageOperationType = Schema.Literals([
  "provider-turn",
  "tool-call",
  "skill-invocation",
  "image-generation",
  "video-generation",
  "audio-session",
]);
export type UsageOperationType = typeof UsageOperationType.Type;

export const UsageOperationLifecyclePayload = usageLedgerClosedStruct({
  operationType: UsageOperationType,
  state: Schema.Literals(["started", "completed", "failed", "cancelled"]),
  attributionOnly: Schema.Boolean,
  billingOwnerEventId: Schema.optionalKey(UsageLedgerOpaqueRef),
}).check(
  Schema.makeFilter((value) => {
    if (
      value.operationType === "skill-invocation" &&
      (!value.attributionOnly || value.billingOwnerEventId !== undefined)
    ) {
      return {
        path: ["billingOwnerEventId"],
        message: "skill invocations are attribution-only and cannot own billing",
      };
    }
    if (value.attributionOnly && value.billingOwnerEventId !== undefined) {
      return {
        path: ["billingOwnerEventId"],
        message: "attribution-only operations cannot own billing",
      };
    }
    return true;
  }),
);
export type UsageOperationLifecyclePayload = typeof UsageOperationLifecyclePayload.Type;

const UnifiedUsageEventBase = {
  schemaVersion: Schema.Literal(1),
  eventId: UsageLedgerOpaqueRef,
  idempotencyKey: UsageLedgerOpaqueRef,
  payloadDigest: UsageLedgerPayloadDigest,
  occurredAt: IsoDateTime,
  observedAt: IsoDateTime,
  subject: UsageEventSubject,
  operation: UsageOperationGraph,
  source: UsageEventSource,
  redaction: Schema.Literal("content-free-v1"),
} as const;

export const UsageDeltaEvent = usageLedgerClosedStruct({
  ...UnifiedUsageEventBase,
  kind: Schema.Literal("usage.delta"),
  payload: UsageDeltaPayload,
});

export const UsageCounterSnapshotEvent = usageLedgerClosedStruct({
  ...UnifiedUsageEventBase,
  kind: Schema.Literal("usage.counter-snapshot"),
  payload: UsageCounterSnapshotPayload,
});

export const UsageContextSnapshotEvent = usageLedgerClosedStruct({
  ...UnifiedUsageEventBase,
  kind: Schema.Literal("context.snapshot"),
  payload: UsageContextSnapshotPayload,
});

export const UsageQuotaSnapshotEvent = usageLedgerClosedStruct({
  ...UnifiedUsageEventBase,
  kind: Schema.Literal("quota.snapshot"),
  payload: UsageQuotaSnapshotPayload,
});

export const UsageBillingReservationEvent = usageLedgerClosedStruct({
  ...UnifiedUsageEventBase,
  kind: Schema.Literal("billing.reservation"),
  payload: UsageBillingReservationPayload,
});

export const UsageBillingSettlementEvent = usageLedgerClosedStruct({
  ...UnifiedUsageEventBase,
  kind: Schema.Literal("billing.settlement"),
  payload: UsageBillingSettlementPayload,
});

export const UsageBillingAdjustmentEvent = usageLedgerClosedStruct({
  ...UnifiedUsageEventBase,
  kind: Schema.Literal("billing.adjustment"),
  payload: UsageBillingAdjustmentPayload,
});

export const UsageOperationLifecycleEvent = usageLedgerClosedStruct({
  ...UnifiedUsageEventBase,
  kind: Schema.Literal("operation.lifecycle"),
  payload: UsageOperationLifecyclePayload,
});

export const UnifiedUsageEvent = Schema.Union([
  UsageDeltaEvent,
  UsageCounterSnapshotEvent,
  UsageContextSnapshotEvent,
  UsageQuotaSnapshotEvent,
  UsageBillingReservationEvent,
  UsageBillingSettlementEvent,
  UsageBillingAdjustmentEvent,
  UsageOperationLifecycleEvent,
]);
export type UnifiedUsageEvent = typeof UnifiedUsageEvent.Type;

export const UsageLedgerInsertedResult = usageLedgerClosedStruct({
  status: Schema.Literal("inserted"),
  eventId: UsageLedgerOpaqueRef,
});
export type UsageLedgerInsertedResult = typeof UsageLedgerInsertedResult.Type;

export const UsageLedgerIdempotentResult = usageLedgerClosedStruct({
  status: Schema.Literal("idempotent"),
  eventId: UsageLedgerOpaqueRef,
});
export type UsageLedgerIdempotentResult = typeof UsageLedgerIdempotentResult.Type;

export const UsageLedgerIdempotencyConflictResult = usageLedgerClosedStruct({
  status: Schema.Literal("idempotency_conflict"),
  eventId: UsageLedgerOpaqueRef,
  existingDigest: UsageLedgerPayloadDigest,
  incomingDigest: UsageLedgerPayloadDigest,
}).check(
  Schema.makeFilter((value) =>
    value.existingDigest !== value.incomingDigest
      ? true
      : { path: ["incomingDigest"], message: "must differ from existingDigest" },
  ),
);
export type UsageLedgerIdempotencyConflictResult = typeof UsageLedgerIdempotencyConflictResult.Type;

export const UsageLedgerRejectedResult = usageLedgerClosedStruct({
  status: Schema.Literals(["invalid_event", "invalid_payload_digest", "content_disallowed"]),
  reasonCode: UsageLedgerOpaqueRef,
});
export type UsageLedgerRejectedResult = typeof UsageLedgerRejectedResult.Type;

export const UsageLedgerAppendResult = Schema.Union([
  UsageLedgerInsertedResult,
  UsageLedgerIdempotentResult,
  UsageLedgerIdempotencyConflictResult,
  UsageLedgerRejectedResult,
]);
export type UsageLedgerAppendResult = typeof UsageLedgerAppendResult.Type;
