import { Schema } from "effect";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const RealtimeVoiceId = Schema.Literals([
  "arbor",
  "breeze",
  "cove",
  "ember",
  "juniper",
  "maple",
  "sol",
  "spruce",
  "vale",
]);
export type RealtimeVoiceId = typeof RealtimeVoiceId.Type;

export const RealtimeVoiceDescriptor = Schema.Struct({
  id: RealtimeVoiceId,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type RealtimeVoiceDescriptor = typeof RealtimeVoiceDescriptor.Type;

export const RealtimeVoiceLaunchSource = Schema.Literals([
  "composer-new",
  "composer-existing",
  "global-hotkey",
  "avatar-overlay",
]);
export type RealtimeVoiceLaunchSource = typeof RealtimeVoiceLaunchSource.Type;

export const RealtimeVoiceOutputModality = Schema.Literals(["audio", "text"]);
export type RealtimeVoiceOutputModality = typeof RealtimeVoiceOutputModality.Type;

export const RealtimeVoiceTransportPreference = Schema.Literals(["webrtc", "websocket-pcm16"]);
export type RealtimeVoiceTransportPreference = typeof RealtimeVoiceTransportPreference.Type;

// Browser SDP uses significant CRLF line endings, including a trailing CRLF.
// Keep it byte-for-byte intact while bounding the RPC payload.
const RealtimeVoiceSdp = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128 * 1_024),
  Schema.isPattern(/\S/u),
);

export const RealtimeVoiceWebRtcStartTransport = Schema.Struct({
  type: Schema.Literal("webrtc"),
  sdp: RealtimeVoiceSdp,
});

export const RealtimeVoiceWebSocketPcm16StartTransport = Schema.Struct({
  type: Schema.Literal("websocket-pcm16"),
});

export const RealtimeVoiceStartTransport = Schema.Union([
  RealtimeVoiceWebRtcStartTransport,
  RealtimeVoiceWebSocketPcm16StartTransport,
]);
export type RealtimeVoiceStartTransport = typeof RealtimeVoiceStartTransport.Type;

export const RealtimeVoiceWebSocketPcm16Transport = Schema.Struct({
  type: Schema.Literal("websocket-pcm16"),
  url: TrimmedNonEmptyString,
  protocol: Schema.Literal("moss-realtime-pcm16-v1"),
  ticket: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
  encoding: Schema.Literal("pcm16"),
  sampleRate: Schema.Literal(24_000),
});
export type RealtimeVoiceWebSocketPcm16Transport = typeof RealtimeVoiceWebSocketPcm16Transport.Type;

export const RealtimeVoiceTransport = Schema.Union([
  RealtimeVoiceWebRtcStartTransport,
  RealtimeVoiceWebSocketPcm16Transport,
]);
export type RealtimeVoiceTransport = typeof RealtimeVoiceTransport.Type;

export const RealtimeVoiceListVoicesInput = Schema.Struct({});
export type RealtimeVoiceListVoicesInput = typeof RealtimeVoiceListVoicesInput.Type;

export const RealtimeVoiceListVoicesResult = Schema.Struct({
  defaultVoice: RealtimeVoiceId,
  preferredTransport: RealtimeVoiceTransportPreference,
  voices: Schema.Array(RealtimeVoiceDescriptor),
});
export type RealtimeVoiceListVoicesResult = typeof RealtimeVoiceListVoicesResult.Type;

export const RealtimeVoiceClaimInput = Schema.Struct({
  threadId: ThreadId,
  source: RealtimeVoiceLaunchSource,
});
export type RealtimeVoiceClaimInput = typeof RealtimeVoiceClaimInput.Type;

export const RealtimeVoiceClaimResult = Schema.Struct({
  ownerClaimId: TrimmedNonEmptyString,
  expiresAt: NonNegativeInt,
  preferredTransport: RealtimeVoiceTransportPreference,
});
export type RealtimeVoiceClaimResult = typeof RealtimeVoiceClaimResult.Type;

export const RealtimeVoiceReleaseClaimInput = Schema.Struct({
  ownerClaimId: TrimmedNonEmptyString,
});
export type RealtimeVoiceReleaseClaimInput = typeof RealtimeVoiceReleaseClaimInput.Type;

export const RealtimeVoiceStartInput = Schema.Struct({
  ownerClaimId: TrimmedNonEmptyString,
  threadId: ThreadId,
  source: RealtimeVoiceLaunchSource,
  voice: Schema.NullOr(RealtimeVoiceId),
  transport: RealtimeVoiceStartTransport,
  outputModality: RealtimeVoiceOutputModality,
});
export type RealtimeVoiceStartInput = typeof RealtimeVoiceStartInput.Type;

export const RealtimeVoiceStartResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  transport: RealtimeVoiceTransport,
  requestedModel: TrimmedNonEmptyString,
  expiresAt: Schema.optional(NonNegativeInt),
});
export type RealtimeVoiceStartResult = typeof RealtimeVoiceStartResult.Type;

export const RealtimeVoiceAppendTextInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  role: Schema.Literals(["user", "assistant"]),
  text: TrimmedNonEmptyString,
});
export type RealtimeVoiceAppendTextInput = typeof RealtimeVoiceAppendTextInput.Type;

export const RealtimeVoiceAppendSpeechInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
});
export type RealtimeVoiceAppendSpeechInput = typeof RealtimeVoiceAppendSpeechInput.Type;

export const RealtimeVoiceStopReason = Schema.Literals([
  "user",
  "model",
  "inactivity",
  "quota",
  "server-closed",
  "surface-unmounted",
  "startup-failed",
  "error",
]);
export type RealtimeVoiceStopReason = typeof RealtimeVoiceStopReason.Type;

export const RealtimeVoiceStopInput = Schema.Struct({
  sessionId: Schema.optional(TrimmedNonEmptyString),
  reason: Schema.optional(RealtimeVoiceStopReason),
});
export type RealtimeVoiceStopInput = typeof RealtimeVoiceStopInput.Type;

export const RealtimeVoiceCommandResult = Schema.Struct({
  accepted: Schema.Boolean,
});
export type RealtimeVoiceCommandResult = typeof RealtimeVoiceCommandResult.Type;

export const RealtimeVoiceGetStateInput = Schema.Struct({});
export type RealtimeVoiceGetStateInput = typeof RealtimeVoiceGetStateInput.Type;

export const RealtimeVoiceSubscribeInput = Schema.Struct({});
export type RealtimeVoiceSubscribeInput = typeof RealtimeVoiceSubscribeInput.Type;

export const RealtimeVoiceReportClientStateInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  webRtcConnected: Schema.Boolean,
  dataSessionInitialized: Schema.Boolean,
  inputMuted: Schema.Boolean,
  outputMuted: Schema.Boolean,
});
export type RealtimeVoiceReportClientStateInput = typeof RealtimeVoiceReportClientStateInput.Type;

export const RealtimeVoiceResolveScreenContextInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  callId: TrimmedNonEmptyString,
  accepted: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  capturedAt: Schema.NullOr(Schema.String),
  sourceAppName: Schema.NullOr(Schema.String),
  sourceBundleIdentifier: Schema.NullOr(Schema.String),
  sourceWindowTitle: Schema.NullOr(Schema.String),
  imageDataUrl: Schema.NullOr(Schema.String),
});
export type RealtimeVoiceResolveScreenContextInput =
  typeof RealtimeVoiceResolveScreenContextInput.Type;

export const RealtimeVoicePhase = Schema.Literals([
  "inactive",
  "reserving",
  "presenting",
  "starting",
  "active",
  "stopping",
  "failed",
]);
export type RealtimeVoicePhase = typeof RealtimeVoicePhase.Type;

export const RealtimeVoiceActivity = Schema.Literals(["listening", "thinking", "speaking"]);
export type RealtimeVoiceActivity = typeof RealtimeVoiceActivity.Type;

export const RealtimeVoiceActivationBarrier = Schema.Struct({
  requestAccepted: Schema.Boolean,
  backendStarted: Schema.Boolean,
  webRtcConnected: Schema.Boolean,
  dataSessionInitialized: Schema.Boolean,
});
export type RealtimeVoiceActivationBarrier = typeof RealtimeVoiceActivationBarrier.Type;

export const RealtimeVoiceUsage = Schema.Struct({
  inputTextTokens: NonNegativeInt,
  inputCachedTextTokens: NonNegativeInt,
  inputAudioTokens: NonNegativeInt,
  inputCachedAudioTokens: NonNegativeInt,
  inputImageTokens: NonNegativeInt,
  inputCachedImageTokens: NonNegativeInt,
  outputTextTokens: NonNegativeInt,
  outputAudioTokens: NonNegativeInt,
  costNanoUsd: NonNegativeInt,
});
export type RealtimeVoiceUsage = typeof RealtimeVoiceUsage.Type;

export const RealtimeVoiceQuotaSnapshot = Schema.Struct({
  periodEnd: Schema.NullOr(Schema.String),
  planLimitNanoUsd: Schema.NullOr(NonNegativeInt),
  planUsedNanoUsd: NonNegativeInt,
  planReservedNanoUsd: NonNegativeInt,
  creditBalance: NonNegativeInt,
  estimatedMinutesRemaining: Schema.NullOr(NonNegativeInt),
});
export type RealtimeVoiceQuotaSnapshot = typeof RealtimeVoiceQuotaSnapshot.Type;

export const RealtimeVoiceState = Schema.Struct({
  phase: RealtimeVoicePhase,
  sessionId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  ownerClaimId: Schema.NullOr(Schema.String),
  source: Schema.NullOr(RealtimeVoiceLaunchSource),
  voice: Schema.NullOr(RealtimeVoiceId),
  requestedModel: Schema.NullOr(Schema.String),
  actualModel: Schema.NullOr(Schema.String),
  activity: Schema.NullOr(RealtimeVoiceActivity),
  barrier: RealtimeVoiceActivationBarrier,
  inputMuted: Schema.Boolean,
  outputMuted: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type RealtimeVoiceState = typeof RealtimeVoiceState.Type;

const RealtimeVoiceEventBase = {
  sessionId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  createdAt: TrimmedNonEmptyString,
} as const;

export const RealtimeVoiceStateEvent = Schema.Struct({
  type: Schema.Literal("state"),
  ...RealtimeVoiceEventBase,
  state: RealtimeVoiceState,
});

export const RealtimeVoiceSessionEvent = Schema.Struct({
  type: Schema.Literal("session"),
  ...RealtimeVoiceEventBase,
  actualModel: TrimmedNonEmptyString,
  expiresAt: Schema.optional(NonNegativeInt),
});

export const RealtimeVoiceTranscriptEvent = Schema.Struct({
  type: Schema.Literal("transcript"),
  ...RealtimeVoiceEventBase,
  itemId: TrimmedNonEmptyString,
  role: Schema.Literals(["user", "assistant"]),
  delta: Schema.String,
  done: Schema.Boolean,
});

export const RealtimeVoiceActivityEvent = Schema.Struct({
  type: Schema.Literal("activity"),
  ...RealtimeVoiceEventBase,
  activity: RealtimeVoiceActivity,
});

export const RealtimeVoiceUsageEvent = Schema.Struct({
  type: Schema.Literal("usage"),
  ...RealtimeVoiceEventBase,
  responseId: TrimmedNonEmptyString,
  usage: RealtimeVoiceUsage,
  quota: RealtimeVoiceQuotaSnapshot,
});

export const RealtimeVoiceQuotaWarningEvent = Schema.Struct({
  type: Schema.Literal("quota-warning"),
  ...RealtimeVoiceEventBase,
  quota: RealtimeVoiceQuotaSnapshot,
  willStopAfterCurrentResponse: Schema.Boolean,
});

export const RealtimeVoiceToolName = Schema.Literals([
  "send_to_agent",
  "capture_screen_context",
  "speak_to_user",
  "end_realtime_voice_call",
  "send_realtime_voice_feedback",
]);
export type RealtimeVoiceToolName = typeof RealtimeVoiceToolName.Type;

export const RealtimeVoiceToolRequestEvent = Schema.Struct({
  type: Schema.Literal("tool-request"),
  ...RealtimeVoiceEventBase,
  callId: TrimmedNonEmptyString,
  name: RealtimeVoiceToolName,
  arguments: Schema.Unknown,
});

export const RealtimeVoiceErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  ...RealtimeVoiceEventBase,
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  recoverable: Schema.Boolean,
});

export const RealtimeVoiceClosedEvent = Schema.Struct({
  type: Schema.Literal("closed"),
  ...RealtimeVoiceEventBase,
  reason: RealtimeVoiceStopReason,
});

export const RealtimeVoiceEvent = Schema.Union([
  RealtimeVoiceStateEvent,
  RealtimeVoiceSessionEvent,
  RealtimeVoiceActivityEvent,
  RealtimeVoiceTranscriptEvent,
  RealtimeVoiceUsageEvent,
  RealtimeVoiceQuotaWarningEvent,
  RealtimeVoiceToolRequestEvent,
  RealtimeVoiceErrorEvent,
  RealtimeVoiceClosedEvent,
]);
export type RealtimeVoiceEvent = typeof RealtimeVoiceEvent.Type;
