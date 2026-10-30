import { randomUUID } from "node:crypto";

import type {
  RealtimeVoiceAppendSpeechInput,
  RealtimeVoiceAppendTextInput,
  RealtimeVoiceClaimInput,
  RealtimeVoiceClaimResult,
  RealtimeVoiceCommandResult,
  RealtimeVoiceDescriptor,
  RealtimeVoiceEvent,
  RealtimeVoiceId,
  RealtimeVoiceListVoicesResult,
  RealtimeVoiceReportClientStateInput,
  RealtimeVoiceResolveScreenContextInput,
  RealtimeVoiceStartInput,
  RealtimeVoiceStartResult,
  RealtimeVoiceState,
  RealtimeVoiceStopInput,
  RealtimeVoiceStopReason,
  RealtimeVoiceToolName,
  RealtimeVoiceTransportPreference,
  RealtimeVoiceUsage,
  RealtimeVoiceQuotaSnapshot,
} from "@synara/contracts";

import {
  RealtimeVoiceRelayError,
  type RelayControlConnection,
  type RealtimeVoiceRelayClientShape,
} from "./relayClient";

const PRESENTATION_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;
const SCREEN_CONTEXT_TIMEOUT_MS = 15_000;
const MAX_SCREEN_CONTEXT_IMAGE_DATA_URL_CHARS = 1_000_000;
const MAX_CONTINUITY_ITEMS = 40;
const MAX_CONTINUITY_ITEM_CHARS = 8_000;
const MAX_CONTINUITY_BYTES = 8_192 * 4;
const MAX_HANDOFF_SPEECH_CHARS = 2_000;
const MAX_PENDING_SPEECH_HANDOFFS = 8;
const SPEECH_HANDOFF_TRANSCRIPT_TTL_MS = 2 * 60_000;
const REALTIME_INLINE_DIRECTIVE = "::codex-realtime-inline{}";
const REALTIME_RESPONSE_CHANNEL_PREFIX = /^\[(STATUS|ATTENTION|COMMENTARY|COMPLETE|ANALYSIS)\]/u;
const DEFAULT_VOICE: RealtimeVoiceId = "maple";
const MIN_CONFIGURABLE_IDLE_TIMEOUT_MS = 5_000;
const MAX_CONFIGURABLE_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MIN_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SESSION_AGE_TO_MAX_IDLE_MS = 5 * 60_000;
const BACKGROUND_WORK_RECHECK_MS = 1_000;
const BACKGROUND_WORK_PROBE_FAILURE_BACKOFF_MS = 1_000;
const MAX_BACKGROUND_WORK_PROBE_FAILURES = 3;
const JPEG_DATA_URL_PATTERN = /^data:image\/jpeg;base64,[a-z0-9+/]+={0,2}$/iu;

interface RealtimeVoiceContinuityItem {
  readonly role: "user" | "assistant";
  readonly text: string;
}

interface PendingSpeechHandoff {
  readonly normalizedText: string;
  readonly expiresAtMs: number;
}

export interface RealtimeVoiceTranscriptWriter {
  write(input: {
    readonly sessionId: string;
    readonly threadId: string;
    readonly itemId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly createdAt: string;
  }): Promise<void>;
}

export interface RealtimeVoiceThreadItem {
  readonly threadId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface RealtimeVoiceStartFailureDiagnostic {
  readonly rootCode: string | null;
  readonly rootStatus: number | null;
  readonly classifiedCode: string;
}

function bridgedAssistantSpeechText(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;

  const channel = REALTIME_RESPONSE_CHANNEL_PREFIX.exec(normalized);
  if (channel?.[1] === "ANALYSIS") return null;
  const speech = (channel ? normalized.slice(channel[0].length) : normalized).trim();
  if (speech.startsWith(REALTIME_INLINE_DIRECTIVE)) return null;
  return speech ? speech.slice(0, MAX_HANDOFF_SPEECH_CHARS).trim() || null : null;
}

function normalizeSpeechHandoffText(text: string): string {
  return text
    .trim()
    .replaceAll(/\s+/gu, " ")
    .replace(/[。.!！?？]+$/u, "")
    .trim()
    .toLowerCase();
}

export const REALTIME_VOICE_DESCRIPTORS = [
  { id: "arbor", displayName: "Arbor", description: "Easygoing and versatile" },
  { id: "breeze", displayName: "Breeze", description: "Animated and earnest" },
  { id: "cove", displayName: "Cove", description: "Composed and direct" },
  { id: "ember", displayName: "Ember", description: "Confident and optimistic" },
  { id: "juniper", displayName: "Juniper", description: "Open and upbeat" },
  { id: "maple", displayName: "Maple", description: "Cheerful and candid" },
  { id: "sol", displayName: "Sol", description: "Savvy and relaxed" },
  { id: "spruce", displayName: "Spruce", description: "Calm and affirming" },
  { id: "vale", displayName: "Vale", description: "Bright and inquisitive" },
] as const satisfies readonly RealtimeVoiceDescriptor[];

export class RealtimeVoiceRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "RealtimeVoiceRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

const LOGIN_REQUIRED_CODES = new Set([
  "AUTHENTICATION_REQUIRED",
  "INVALID_CREDENTIALS",
  "SESSION_EXPIRED",
  "UNAUTHORIZED",
  "VOICE_ACCOUNT_AUTHENTICATION_REQUIRED",
]);
const ACCOUNT_RECOVERY_REQUIRED_CODES = new Set(["VOICE_ACCOUNT_RECOVERY_REQUIRED"]);
const ENTITLEMENT_REQUIRED_CODES = new Set([
  "ENTITLEMENT_REQUIRED",
  "MODEL_NOT_ALLOWED",
  "VOICE_NOT_ALLOWED",
  "VOICE_QUOTA_NOT_CONFIGURED",
]);
const REGION_UNAVAILABLE_CODES = new Set([
  "CLOUD_REGION_MISMATCH",
  "CN_REALTIME_EGRESS_PROXY_REQUIRED",
  "CONTROL_PLANE_REGION_MISMATCH",
  "GLOBAL_REALTIME_EGRESS_PROXY_FORBIDDEN",
  "MOSS_CLOUD_REGION_NOT_CONFIGURED",
  "UPSTREAM_MEDIA_ROUTE_ATTESTATION_MISMATCH",
  "UPSTREAM_MEDIA_ROUTE_ATTESTATION_MISSING",
]);
const SERVICE_CREDITS_EXHAUSTED_CODES = new Set([
  "OPENAI_CREDITS_EXHAUSTED",
  "OPENAI_SIDEBAND_CREDITS_EXHAUSTED",
]);
const UPSTREAM_UNAVAILABLE_CODES = new Set([
  "AUTHENTICATION_SERVICE_UNAVAILABLE",
  "AUTH_SERVICE_UNAVAILABLE",
  "CONTROL_PLANE_INVALID_RESPONSE",
  "CONTROL_PLANE_UNAVAILABLE",
  "NOT_CONFIGURED",
  "OPENAI_CALL_ID_INVALID",
  "OPENAI_CALL_ID_MISSING",
  "OPENAI_CALL_REJECTED",
  "OPENAI_CALL_UNAVAILABLE",
  "OPENAI_CREDITS_EXHAUSTED",
  "OPENAI_SIDEBAND_CREDITS_EXHAUSTED",
  "OPENAI_SDP_INVALID",
  "OPENAI_SDP_UNAVAILABLE",
  "PROVIDER_ERROR",
  "REALTIME_RELAY_INVALID_RESPONSE",
  "REALTIME_RELAY_NOT_CONFIGURED",
  "REALTIME_RELAY_SESSION_MISMATCH",
  "REALTIME_RELAY_UNAVAILABLE",
  "REALTIME_RELAY_URL_INVALID",
]);

function structuredErrorCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || Array.isArray(cause)) return null;
  try {
    const code = (cause as Readonly<Record<string, unknown>>).code;
    if (typeof code !== "string" || !/^[a-z0-9_]{1,120}$/iu.test(code)) return null;
    return code.toUpperCase();
  } catch {
    return null;
  }
}

function structuredErrorStatus(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null || Array.isArray(cause)) return null;
  try {
    const status = (cause as Readonly<Record<string, unknown>>).status;
    return typeof status === "number" &&
      Number.isSafeInteger(status) &&
      status >= 400 &&
      status <= 599
      ? status
      : null;
  } catch {
    return null;
  }
}

function startError(code: string, message: string, retryable: boolean): RealtimeVoiceRuntimeError {
  return new RealtimeVoiceRuntimeError(code, message, retryable);
}

/**
 * Converts relay/account failures into the stable renderer-facing voice error contract.
 * Never copy an upstream message: relay bodies, origins, credentials, and provider details
 * remain server-only even when a relay returns an unexpected code or status.
 */
export function classifyRealtimeVoiceStartError(cause: unknown): RealtimeVoiceRuntimeError {
  if (cause instanceof RealtimeVoiceRuntimeError && cause.code.startsWith("VOICE_")) return cause;

  const code = structuredErrorCode(cause);
  const status =
    cause instanceof RealtimeVoiceRelayError ? cause.status : structuredErrorStatus(cause);

  if (code && ACCOUNT_RECOVERY_REQUIRED_CODES.has(code)) {
    return startError(
      "VOICE_ACCOUNT_RECOVERY_REQUIRED",
      "Realtime Voice is waiting for Moss account recovery to finish.",
      true,
    );
  }
  if (code && LOGIN_REQUIRED_CODES.has(code)) {
    return startError(
      "VOICE_LOGIN_REQUIRED",
      "Sign in to your Moss account to start Realtime Voice.",
      false,
    );
  }
  if (code === "EMAIL_NOT_VERIFIED") {
    return startError(
      "VOICE_ACCOUNT_VERIFICATION_REQUIRED",
      "Verify your Moss account email before starting Realtime Voice.",
      false,
    );
  }
  if (code && ENTITLEMENT_REQUIRED_CODES.has(code)) {
    return startError(
      "VOICE_ENTITLEMENT_REQUIRED",
      "Realtime Voice is not included for this Moss account.",
      false,
    );
  }
  if (code === "VOICE_SESSION_QUOTA_EXHAUSTED") {
    return startError(
      "VOICE_QUOTA_EXHAUSTED",
      "Your Realtime Voice session quota has been reached.",
      false,
    );
  }
  if (code === "VOICE_SESSION_CONFLICT") {
    return startError(
      "VOICE_SESSION_CONFLICT",
      "Another Realtime Voice session is still active. End it or wait for it to close, then try again.",
      true,
    );
  }
  if (code === "INSUFFICIENT_CREDITS") {
    return startError(
      "VOICE_CREDITS_EXHAUSTED",
      "This Moss account does not have enough credits to start Realtime Voice.",
      false,
    );
  }
  if (code && REGION_UNAVAILABLE_CODES.has(code)) {
    return startError(
      "VOICE_REGION_UNAVAILABLE",
      "Realtime Voice is not available through the configured Moss region right now.",
      false,
    );
  }
  if (
    code === "OPENAI_RATE_LIMITED" ||
    code === "OPENAI_SIDEBAND_RATE_LIMITED" ||
    code === "RATE_LIMITED"
  ) {
    return startError(
      "VOICE_RATE_LIMITED",
      "Realtime Voice is receiving too many requests. Wait a moment and try again.",
      true,
    );
  }
  if (code && SERVICE_CREDITS_EXHAUSTED_CODES.has(code)) {
    return startError(
      "VOICE_SERVICE_CREDITS_EXHAUSTED",
      "Moss voice service credits are temporarily unavailable. Try again later or contact support.",
      false,
    );
  }
  if (
    code === "ACCOUNT_DISABLED" ||
    code === "FORBIDDEN" ||
    code === "PERMISSION_DENIED" ||
    code === "VOICE_RESERVATION_DENIED"
  ) {
    return startError(
      "VOICE_PERMISSION_DENIED",
      "This Moss account does not have permission to start Realtime Voice.",
      false,
    );
  }
  if (code && UPSTREAM_UNAVAILABLE_CODES.has(code)) {
    return startError(
      "VOICE_UPSTREAM_UNAVAILABLE",
      "The Realtime Voice service is temporarily unavailable. Try again shortly.",
      true,
    );
  }

  if (status === 401) {
    return startError(
      "VOICE_LOGIN_REQUIRED",
      "Sign in to your Moss account to start Realtime Voice.",
      false,
    );
  }
  if (status === 402) {
    return startError(
      "VOICE_CREDITS_EXHAUSTED",
      "This Moss account does not have enough credits to start Realtime Voice.",
      false,
    );
  }
  if (status === 403) {
    return startError(
      "VOICE_PERMISSION_DENIED",
      "This Moss account does not have permission to start Realtime Voice.",
      false,
    );
  }
  if (status === 421) {
    return startError(
      "VOICE_REGION_UNAVAILABLE",
      "Realtime Voice is not available through the configured Moss region right now.",
      false,
    );
  }
  if (status === 429) {
    return startError(
      "VOICE_RATE_LIMITED",
      "Realtime Voice is receiving too many requests. Wait a moment and try again.",
      true,
    );
  }
  if (status !== null && status >= 500) {
    return startError(
      "VOICE_UPSTREAM_UNAVAILABLE",
      "The Realtime Voice service is temporarily unavailable. Try again shortly.",
      true,
    );
  }

  return startError("VOICE_START_FAILED", "Realtime Voice could not start. Try again.", true);
}

export interface RealtimeVoiceToolExecutor {
  execute(input: {
    readonly sessionId: string;
    readonly threadId: string;
    readonly callId: string;
    readonly name: RealtimeVoiceToolName;
    readonly arguments: unknown;
  }): Promise<unknown>;
}

export interface RealtimeVoiceIdlePolicy {
  readonly minIdleTimeoutMs?: number;
  readonly maxIdleTimeoutMs?: number;
  readonly sessionAgeToMaxIdleMs?: number;
}

interface NormalizedRealtimeVoiceIdlePolicy {
  readonly minIdleTimeoutMs: number;
  readonly maxIdleTimeoutMs: number;
  readonly sessionAgeToMaxIdleMs: number;
}

interface RelayWorkState {
  readonly responseRequestInFlight: boolean;
  readonly responseInFlight: boolean;
  readonly settlementOperationsInFlight: number;
  readonly pendingResponse: boolean;
  readonly pendingTranscriptionCount: number;
  readonly pendingToolCount: number;
}

const NO_RELAY_WORK: RelayWorkState = {
  responseRequestInFlight: false,
  responseInFlight: false,
  settlementOperationsInFlight: 0,
  pendingResponse: false,
  pendingTranscriptionCount: 0,
  pendingToolCount: 0,
};

interface RealtimeVoiceRuntimeOptions {
  readonly relay: RealtimeVoiceRelayClientShape;
  readonly preferredTransport?: RealtimeVoiceTransportPreference;
  readonly getAccessToken: () => Promise<string>;
  readonly toolExecutor: RealtimeVoiceToolExecutor;
  readonly publish: (event: RealtimeVoiceEvent) => void;
  readonly onStartFailure?: (diagnostic: RealtimeVoiceStartFailureDiagnostic) => void;
  readonly transcriptWriter?: RealtimeVoiceTranscriptWriter;
  readonly hasActiveBackgroundWork?: (input: {
    readonly sessionId: string;
    readonly threadId: string;
  }) => boolean | Promise<boolean>;
  readonly idlePolicy?: RealtimeVoiceIdlePolicy;
  readonly now?: () => number;
  readonly makeId?: () => string;
}

/** Server-resolved, authority-bound route. Never construct this from renderer input. */
export interface RealtimeVoiceRuntimeRoute {
  readonly authorityId: string;
  readonly relay: RealtimeVoiceRelayClientShape;
  readonly preferredTransport: RealtimeVoiceTransportPreference;
  readonly accessToken: string;
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function normalizeIdlePolicy(
  policy: RealtimeVoiceIdlePolicy | undefined,
): NormalizedRealtimeVoiceIdlePolicy {
  const minIdleTimeoutMs = clampInteger(
    policy?.minIdleTimeoutMs,
    DEFAULT_MIN_IDLE_TIMEOUT_MS,
    MIN_CONFIGURABLE_IDLE_TIMEOUT_MS,
    MAX_CONFIGURABLE_IDLE_TIMEOUT_MS,
  );
  const maxIdleTimeoutMs = clampInteger(
    policy?.maxIdleTimeoutMs,
    DEFAULT_MAX_IDLE_TIMEOUT_MS,
    minIdleTimeoutMs,
    MAX_CONFIGURABLE_IDLE_TIMEOUT_MS,
  );
  return {
    minIdleTimeoutMs,
    maxIdleTimeoutMs,
    sessionAgeToMaxIdleMs: clampInteger(
      policy?.sessionAgeToMaxIdleMs,
      DEFAULT_SESSION_AGE_TO_MAX_IDLE_MS,
      1,
      24 * 60 * 60_000,
    ),
  };
}

function idleTimeoutForSessionAge(
  sessionAgeMs: number,
  policy: NormalizedRealtimeVoiceIdlePolicy,
): number {
  if (policy.maxIdleTimeoutMs <= policy.minIdleTimeoutMs) return policy.minIdleTimeoutMs;
  const progress = Math.max(0, Math.min(1, sessionAgeMs / policy.sessionAgeToMaxIdleMs));
  return Math.round(
    policy.minIdleTimeoutMs + (policy.maxIdleTimeoutMs - policy.minIdleTimeoutMs) * progress,
  );
}

function inactiveState(): RealtimeVoiceState {
  return {
    phase: "inactive",
    sessionId: null,
    threadId: null,
    ownerClaimId: null,
    source: null,
    voice: null,
    requestedModel: null,
    actualModel: null,
    activity: null,
    barrier: {
      requestAccepted: false,
      backendStarted: false,
      webRtcConnected: false,
      dataSessionInitialized: false,
    },
    inputMuted: false,
    outputMuted: false,
    error: null,
  };
}

function copyState(state: RealtimeVoiceState): RealtimeVoiceState {
  return { ...state, barrier: { ...state.barrier } };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function isToolName(value: unknown): value is RealtimeVoiceToolName {
  return (
    value === "send_to_agent" ||
    value === "capture_screen_context" ||
    value === "speak_to_user" ||
    value === "end_realtime_voice_call" ||
    value === "send_realtime_voice_feedback"
  );
}

function isStopReason(value: unknown): value is RealtimeVoiceStopReason {
  return (
    value === "user" ||
    value === "model" ||
    value === "inactivity" ||
    value === "quota" ||
    value === "server-closed" ||
    value === "surface-unmounted" ||
    value === "startup-failed" ||
    value === "error"
  );
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseUsage(value: Readonly<Record<string, unknown>>): RealtimeVoiceUsage | null {
  const inputTextTokens = nonNegativeSafeInteger(value.inputTextTokens);
  const inputCachedTextTokens = nonNegativeSafeInteger(value.inputCachedTextTokens);
  const inputAudioTokens = nonNegativeSafeInteger(value.inputAudioTokens);
  const inputCachedAudioTokens = nonNegativeSafeInteger(value.inputCachedAudioTokens);
  const inputImageTokens = nonNegativeSafeInteger(value.inputImageTokens);
  const inputCachedImageTokens = nonNegativeSafeInteger(value.inputCachedImageTokens);
  const outputTextTokens = nonNegativeSafeInteger(value.outputTextTokens);
  const outputAudioTokens = nonNegativeSafeInteger(value.outputAudioTokens);
  const costNanoUsd = nonNegativeSafeInteger(value.costNanoUsd);
  if (
    inputTextTokens === null ||
    inputCachedTextTokens === null ||
    inputAudioTokens === null ||
    inputCachedAudioTokens === null ||
    inputImageTokens === null ||
    inputCachedImageTokens === null ||
    outputTextTokens === null ||
    outputAudioTokens === null ||
    costNanoUsd === null
  ) {
    return null;
  }
  return {
    inputTextTokens,
    inputCachedTextTokens,
    inputAudioTokens,
    inputCachedAudioTokens,
    inputImageTokens,
    inputCachedImageTokens,
    outputTextTokens,
    outputAudioTokens,
    costNanoUsd,
  };
}

function parseQuota(value: Readonly<Record<string, unknown>>): RealtimeVoiceQuotaSnapshot | null {
  const planLimitNanoUsd =
    value.planLimitNanoUsd === null ? null : nonNegativeSafeInteger(value.planLimitNanoUsd);
  const planUsedNanoUsd = nonNegativeSafeInteger(value.planUsedNanoUsd);
  const planReservedNanoUsd = nonNegativeSafeInteger(value.planReservedNanoUsd);
  const creditBalance = nonNegativeSafeInteger(value.creditBalance);
  const estimatedMinutesRemaining =
    value.estimatedMinutesRemaining === null
      ? null
      : nonNegativeSafeInteger(value.estimatedMinutesRemaining);
  if (
    (planLimitNanoUsd === null && value.planLimitNanoUsd !== null) ||
    planUsedNanoUsd === null ||
    planReservedNanoUsd === null ||
    creditBalance === null ||
    (estimatedMinutesRemaining === null && value.estimatedMinutesRemaining !== null) ||
    (value.periodEnd !== null && typeof value.periodEnd !== "string")
  ) {
    return null;
  }
  return {
    periodEnd: typeof value.periodEnd === "string" ? value.periodEnd : null,
    planLimitNanoUsd,
    planUsedNanoUsd,
    planReservedNanoUsd,
    creditBalance,
    estimatedMinutesRemaining,
  };
}

export class RealtimeVoiceRuntime {
  #relay: RealtimeVoiceRelayClientShape;
  #preferredTransport: RealtimeVoiceTransportPreference;
  readonly #getAccessToken: () => Promise<string>;
  readonly #toolExecutor: RealtimeVoiceToolExecutor;
  readonly #publish: (event: RealtimeVoiceEvent) => void;
  readonly #onStartFailure: (diagnostic: RealtimeVoiceStartFailureDiagnostic) => void;
  readonly #transcriptWriter: RealtimeVoiceTranscriptWriter | null;
  readonly #hasActiveBackgroundWork: NonNullable<
    RealtimeVoiceRuntimeOptions["hasActiveBackgroundWork"]
  >;
  readonly #idlePolicy: NormalizedRealtimeVoiceIdlePolicy;
  readonly #now: () => number;
  readonly #makeId: () => string;
  #state = inactiveState();
  #generation = 0;
  #claimExpiresAt: number | null = null;
  #claimedAuthorityId: string | null = null;
  #claimTimer: NodeJS.Timeout | null = null;
  #startupTimer: NodeJS.Timeout | null = null;
  #stopTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #startAbort: AbortController | null = null;
  #accessToken: string | null = null;
  #control: RelayControlConnection | null = null;
  #pendingScreenContext = new Map<string, { sessionId: string; timer: NodeJS.Timeout }>();
  readonly #pendingLocalToolCallIds = new Set<string>();
  #relayWorkState: RelayWorkState = NO_RELAY_WORK;
  #sessionStartedAtMs: number | null = null;
  #lastIdleActivityAtMs: number | null = null;
  #idleActivityVersion = 0;
  #backgroundWorkWasActive = false;
  #backgroundWorkProbeFailures = 0;
  #pendingStopReason: RealtimeVoiceStopReason | null = null;
  readonly #continuityByThread = new Map<string, RealtimeVoiceContinuityItem[]>();
  readonly #persistedTranscriptKeys = new Set<string>();
  readonly #pendingTranscriptKeys = new Set<string>();
  readonly #pendingSpeechHandoffs: PendingSpeechHandoff[] = [];
  #continuitySentSessionId: string | null = null;
  #localTextSequence = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: RealtimeVoiceRuntimeOptions) {
    this.#relay = options.relay;
    this.#preferredTransport = options.preferredTransport ?? "webrtc";
    this.#getAccessToken = options.getAccessToken;
    this.#toolExecutor = options.toolExecutor;
    this.#publish = options.publish;
    this.#onStartFailure = options.onStartFailure ?? (() => undefined);
    this.#transcriptWriter = options.transcriptWriter ?? null;
    this.#hasActiveBackgroundWork =
      options.hasActiveBackgroundWork ??
      (() => Promise.reject(new Error("REALTIME_VOICE_BACKGROUND_WORK_PROBE_UNAVAILABLE")));
    this.#idlePolicy = normalizeIdlePolicy(options.idlePolicy);
    this.#now = options.now ?? Date.now;
    this.#makeId = options.makeId ?? randomUUID;
  }

  listVoices(
    preferredTransport: RealtimeVoiceTransportPreference = this.#preferredTransport,
  ): RealtimeVoiceListVoicesResult {
    return {
      defaultVoice: DEFAULT_VOICE,
      preferredTransport,
      voices: [...REALTIME_VOICE_DESCRIPTORS],
    };
  }

  getState(): RealtimeVoiceState {
    return copyState(this.#state);
  }

  async claim(
    input: RealtimeVoiceClaimInput,
    route?: RealtimeVoiceRuntimeRoute,
  ): Promise<RealtimeVoiceClaimResult> {
    return this.#serialize(() => {
      if (this.#state.phase !== "inactive" && this.#state.phase !== "failed") {
        throw new RealtimeVoiceRuntimeError(
          "VOICE_SESSION_CONFLICT",
          "Realtime Voice is already active in another Moss surface.",
        );
      }
      this.#clearAllTimers();
      this.#resetIdleTracking();
      if (route) {
        this.#relay = route.relay;
        this.#preferredTransport = route.preferredTransport;
        this.#claimedAuthorityId = route.authorityId;
      } else {
        this.#claimedAuthorityId = null;
      }
      const generation = ++this.#generation;
      this.#persistedTranscriptKeys.clear();
      this.#pendingTranscriptKeys.clear();
      this.#pendingSpeechHandoffs.splice(0);
      this.#localTextSequence = 0;
      const ownerClaimId = this.#makeId();
      this.#state = {
        ...inactiveState(),
        phase: "reserving",
        threadId: input.threadId,
        ownerClaimId,
        source: input.source,
        barrier: { ...inactiveState().barrier, requestAccepted: true },
      };
      this.#continuitySentSessionId = null;
      this.#publishState();
      const expiresAt = this.#now() + PRESENTATION_TIMEOUT_MS;
      this.#claimExpiresAt = expiresAt;
      this.#state = { ...this.#state, phase: "presenting" };
      this.#publishState();
      this.#claimTimer = setTimeout(() => {
        this.#enqueue(() => {
          if (generation !== this.#generation || this.#state.ownerClaimId !== ownerClaimId) return;
          this.#fail(
            "PRESENTATION_TIMEOUT",
            "Voice presentation timed out before media was ready.",
          );
        });
      }, PRESENTATION_TIMEOUT_MS);
      this.#claimTimer.unref?.();
      return { ownerClaimId, expiresAt, preferredTransport: this.#preferredTransport };
    });
  }

  async releaseClaim(ownerClaimId: string): Promise<RealtimeVoiceCommandResult> {
    return this.#serialize(() => {
      if (this.#state.ownerClaimId !== ownerClaimId || this.#state.sessionId !== null) {
        return { accepted: false };
      }
      this.#generation += 1;
      this.#reset(true);
      return { accepted: true };
    });
  }

  async start(
    input: RealtimeVoiceStartInput,
    route?: RealtimeVoiceRuntimeRoute,
  ): Promise<RealtimeVoiceStartResult> {
    const prepared = await this.#serialize(() => {
      if (
        this.#state.phase !== "presenting" ||
        this.#state.ownerClaimId !== input.ownerClaimId ||
        this.#state.threadId !== input.threadId ||
        this.#state.source !== input.source ||
        this.#claimExpiresAt === null ||
        this.#claimExpiresAt <= this.#now()
      ) {
        throw new RealtimeVoiceRuntimeError(
          "VOICE_CLAIM_INVALID",
          "The Realtime Voice launch reservation expired or belongs to another surface.",
        );
      }
      if (route) {
        if (
          this.#claimedAuthorityId !== route.authorityId ||
          route.preferredTransport !== this.#preferredTransport
        ) {
          throw new RealtimeVoiceRuntimeError(
            "VOICE_AUTHORITY_CHANGED",
            "The Realtime Voice account authority changed during launch.",
            true,
          );
        }
        this.#relay = route.relay;
      }
      if (input.transport.type !== this.#preferredTransport) {
        throw new RealtimeVoiceRuntimeError(
          "VOICE_TRANSPORT_MISMATCH",
          "This Moss region requires a different Realtime Voice media transport.",
        );
      }
      if (this.#claimTimer) clearTimeout(this.#claimTimer);
      this.#claimTimer = null;
      const generation = ++this.#generation;
      const sessionId = this.#makeId();
      const voice = input.voice ?? DEFAULT_VOICE;
      const abort = new AbortController();
      this.#startAbort = abort;
      this.#state = {
        ...this.#state,
        phase: "starting",
        sessionId,
        voice,
        requestedModel: null,
        actualModel: null,
        activity: null,
        error: null,
        barrier: {
          requestAccepted: true,
          backendStarted: false,
          webRtcConnected: false,
          dataSessionInitialized: false,
        },
      };
      this.#publishState();
      this.#scheduleStartupTimeout(generation, sessionId);
      return { generation, sessionId, voice, abort };
    });

    let accessToken: string | null = null;
    // A successful start response is not proof that the relay did not create a
    // session when parsing/transport validation failed locally. Track the
    // attempt separately so those ambiguous failures still release the
    // provider reservation below.
    let relayAttempted = false;
    try {
      accessToken = route?.accessToken ?? (await this.#getAccessToken());
      const authenticatedToken = accessToken;
      await this.#serialize(() => {
        if (prepared.generation === this.#generation) this.#accessToken = authenticatedToken;
      });
      relayAttempted = true;
      const result = await this.#relay.startCall({
        accessToken: authenticatedToken,
        sessionId: prepared.sessionId,
        transport: input.transport,
        voice: prepared.voice,
        outputModality: input.outputModality,
        signal: prepared.abort.signal,
      });

      const accepted = await this.#serialize(() => {
        if (
          prepared.generation !== this.#generation ||
          this.#state.sessionId !== prepared.sessionId ||
          this.#state.phase === "stopping"
        ) {
          return false;
        }
        if (result.sessionId !== prepared.sessionId) {
          throw new RealtimeVoiceRuntimeError(
            "REALTIME_RELAY_SESSION_MISMATCH",
            "The Realtime relay returned a mismatched session.",
          );
        }
        this.#state = { ...this.#state, requestedModel: result.requestedModel };
        this.#control = this.#relay.connectControl({
          accessToken: authenticatedToken,
          controlPath: result.controlPath,
          onOpen: () => this.#enqueue(() => this.#handleControlOpen(prepared.sessionId)),
          onEvent: (event) =>
            this.#enqueue(() => this.#handleRelayEvent(prepared.sessionId, event)),
          onError: () =>
            this.#enqueue(() =>
              this.#handleControlFailure(prepared.sessionId, "REALTIME_CONTROL_ERROR"),
            ),
          onClose: () =>
            this.#enqueue(() =>
              this.#handleControlFailure(prepared.sessionId, "REALTIME_CONTROL_CLOSED"),
            ),
        });
        this.#publishState();
        return true;
      });

      if (!accepted) {
        throw new RealtimeVoiceRuntimeError(
          "VOICE_START_SUPERSEDED",
          "The Realtime Voice start was superseded.",
          true,
        );
      }
      return {
        sessionId: result.sessionId,
        transport: result.transport,
        requestedModel: result.requestedModel,
      };
    } catch (cause) {
      const startFailure = classifyRealtimeVoiceStartError(cause);
      try {
        this.#onStartFailure({
          rootCode: structuredErrorCode(cause),
          rootStatus:
            cause instanceof RealtimeVoiceRelayError ? cause.status : structuredErrorStatus(cause),
          classifiedCode: startFailure.code,
        });
      } catch {
        // Diagnostics must never replace the sanitized runtime failure.
      }
      if (accessToken && (relayAttempted || prepared.generation !== this.#generation)) {
        await this.#relay
          .stopCall({ accessToken, sessionId: prepared.sessionId })
          .catch(() => undefined);
      }
      await this.#serialize(() => {
        if (prepared.generation !== this.#generation) return;
        this.#fail(startFailure.code, startFailure.message, startFailure.retryable);
      });
      throw startFailure;
    } finally {
      await this.#serialize(() => {
        if (this.#startAbort === prepared.abort) this.#startAbort = null;
      });
    }
  }

  async reportClientState(input: RealtimeVoiceReportClientStateInput): Promise<RealtimeVoiceState> {
    return this.#serialize(() => {
      this.#requireSession(input.sessionId);
      this.#state = {
        ...this.#state,
        inputMuted: input.inputMuted,
        outputMuted: input.outputMuted,
        barrier: {
          ...this.#state.barrier,
          webRtcConnected: input.webRtcConnected,
          dataSessionInitialized: input.dataSessionInitialized,
        },
      };
      this.#promoteIfActive();
      this.#publishState();
      return copyState(this.#state);
    });
  }

  async appendText(input: RealtimeVoiceAppendTextInput): Promise<RealtimeVoiceCommandResult> {
    return this.#serialize(() => {
      this.#requireSession(input.sessionId);
      this.#sendControl({ type: "append_text", role: input.role, text: input.text });
      if (input.role === "user") {
        this.#persistFinalTranscript({
          sessionId: input.sessionId,
          itemId: `local-text-${++this.#localTextSequence}`,
          role: "user",
          text: input.text,
          createdAt: this.#createdAt(),
        });
      }
      this.#recordContinuity(input.role, input.text);
      this.#markIdleActivity();
      return { accepted: true };
    });
  }

  /**
   * Mirror a completed ordinary task item into the live voice conversation.
   * User text stays silent; finalized assistant text follows Codex's speech
   * handoff semantics. The generated speech transcript is presentation-only,
   * because the authoritative assistant item already exists in the task.
   */
  async appendThreadItem(input: RealtimeVoiceThreadItem): Promise<boolean> {
    return this.#serialize(() => {
      const text = input.text.trim();
      if (
        !text ||
        this.#state.phase !== "active" ||
        this.#state.threadId !== input.threadId ||
        this.#state.sessionId === null ||
        this.#control === null
      ) {
        return false;
      }
      this.#sendControl({
        type: "append_text",
        role: input.role,
        text,
        requestResponse: false,
      });
      if (input.role === "assistant") {
        const speechText = bridgedAssistantSpeechText(text);
        if (speechText) {
          this.#sendControl({
            type: "append_speech",
            text: speechText,
            persistTranscriptToThread: false,
          });
          this.#pendingSpeechHandoffs.push({
            normalizedText: normalizeSpeechHandoffText(speechText),
            expiresAtMs: this.#now() + SPEECH_HANDOFF_TRANSCRIPT_TTL_MS,
          });
          if (this.#pendingSpeechHandoffs.length > MAX_PENDING_SPEECH_HANDOFFS) {
            this.#pendingSpeechHandoffs.shift();
          }
        }
      }
      this.#recordContinuity(input.role, text);
      this.#markIdleActivity();
      return true;
    });
  }

  async resolveScreenContext(
    input: RealtimeVoiceResolveScreenContextInput,
  ): Promise<RealtimeVoiceCommandResult> {
    return this.#serialize(() => {
      this.#requireSession(input.sessionId);
      const pending = this.#pendingScreenContext.get(input.callId);
      if (!pending || pending.sessionId !== input.sessionId) return { accepted: false };

      const reason = input.reason === null ? null : boundedString(input.reason, 500);
      const capturedAt = input.capturedAt === null ? null : boundedString(input.capturedAt, 160);
      const sourceAppName =
        input.sourceAppName === null ? null : boundedString(input.sourceAppName, 500);
      const sourceBundleIdentifier =
        input.sourceBundleIdentifier === null
          ? null
          : boundedString(input.sourceBundleIdentifier, 500);
      const sourceWindowTitle =
        input.sourceWindowTitle === null ? null : boundedString(input.sourceWindowTitle, 1_000);
      const imageDataUrl =
        input.imageDataUrl !== null &&
        input.imageDataUrl.length <= MAX_SCREEN_CONTEXT_IMAGE_DATA_URL_CHARS &&
        JPEG_DATA_URL_PATTERN.test(input.imageDataUrl)
          ? input.imageDataUrl
          : null;
      if (input.accepted && !imageDataUrl) {
        throw new RealtimeVoiceRuntimeError(
          "VOICE_SCREEN_CONTEXT_INVALID",
          "The captured screen context was missing a bounded JPEG image.",
        );
      }
      if (!input.accepted && !reason) {
        throw new RealtimeVoiceRuntimeError(
          "VOICE_SCREEN_CONTEXT_INVALID",
          "A rejected screen-context request must include a reason.",
        );
      }

      clearTimeout(pending.timer);
      this.#pendingScreenContext.delete(input.callId);
      this.#pendingLocalToolCallIds.delete(input.callId);
      this.#sendControl({
        type: "tool_result",
        callId: input.callId,
        output: {
          accepted: input.accepted,
          reason,
          capturedAt,
          sourceAppName,
          sourceBundleIdentifier,
          sourceWindowTitle,
        },
        imageDataUrl,
      });
      this.#markIdleActivity();
      return { accepted: true };
    });
  }

  async appendSpeech(input: RealtimeVoiceAppendSpeechInput): Promise<RealtimeVoiceCommandResult> {
    return this.#serialize(() => {
      this.#requireSession(input.sessionId);
      this.#sendControl({ type: "append_speech", text: input.text });
      this.#markIdleActivity();
      return { accepted: true };
    });
  }

  async stop(input: RealtimeVoiceStopInput): Promise<RealtimeVoiceCommandResult> {
    return this.#serialize(() => {
      if (this.#state.phase === "inactive") return { accepted: false };
      if (input.sessionId && input.sessionId !== this.#state.sessionId) return { accepted: false };
      const reason = input.reason ?? "user";
      this.#beginStop(reason);
      return { accepted: true };
    });
  }

  async dispose(): Promise<void> {
    await this.#serialize(() => {
      if (this.#state.phase !== "inactive") this.#beginStop("server-closed");
      this.#clearAllTimers();
      this.#control?.close();
      this.#control = null;
    });
  }

  #serialize<A>(operation: () => A | Promise<A>): Promise<A> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #enqueue(operation: () => void | Promise<void>): void {
    void this.#serialize(operation).catch(() => {
      void this.#serialize(() =>
        this.#fail("VOICE_RUNTIME_ERROR", "Realtime Voice stopped unexpectedly."),
      );
    });
  }

  #createdAt(): string {
    return new Date(this.#now()).toISOString();
  }

  #publishState(): void {
    this.#publish({
      type: "state",
      sessionId: this.#state.sessionId,
      threadId: this.#state.threadId,
      createdAt: this.#createdAt(),
      state: copyState(this.#state),
    });
  }

  #publishError(code: string, message: string, recoverable: boolean): void {
    this.#publish({
      type: "error",
      sessionId: this.#state.sessionId,
      threadId: this.#state.threadId,
      createdAt: this.#createdAt(),
      code,
      message,
      recoverable,
    });
  }

  #scheduleStartupTimeout(generation: number, sessionId: string): void {
    if (this.#startupTimer) clearTimeout(this.#startupTimer);
    this.#startupTimer = setTimeout(() => {
      this.#enqueue(() => {
        if (
          generation !== this.#generation ||
          this.#state.sessionId !== sessionId ||
          this.#state.phase === "active"
        ) {
          return;
        }
        this.#beginStop("startup-failed");
        this.#publishError(
          "VOICE_START_TIMEOUT",
          "Realtime Voice did not pass all connection checks in time.",
          true,
        );
      });
    }, STARTUP_TIMEOUT_MS);
    this.#startupTimer.unref?.();
  }

  #promoteIfActive(): void {
    if (this.#state.phase !== "starting" && this.#state.phase !== "active") return;
    const barrier = this.#state.barrier;
    if (
      barrier.requestAccepted &&
      barrier.backendStarted &&
      barrier.webRtcConnected &&
      barrier.dataSessionInitialized &&
      this.#state.actualModel !== null
    ) {
      const wasActive = this.#state.phase === "active";
      if (this.#startupTimer) clearTimeout(this.#startupTimer);
      this.#startupTimer = null;
      this.#state = {
        ...this.#state,
        phase: "active",
        activity: this.#state.activity ?? "listening",
      };
      if (!wasActive) {
        const now = this.#now();
        this.#sessionStartedAtMs = now;
        this.#lastIdleActivityAtMs = now;
        this.#idleActivityVersion += 1;
        this.#backgroundWorkWasActive = false;
        this.#scheduleIdleCheck();
      }
    }
  }

  #handleControlOpen(sessionId: string): void {
    if (this.#state.sessionId !== sessionId || this.#state.phase === "stopping") return;
    // The sideband-connected snapshot is the authoritative backend gate.
  }

  #handleControlFailure(sessionId: string, code: string): void {
    if (this.#state.sessionId !== sessionId || this.#state.phase === "inactive") return;
    if (this.#state.phase === "stopping") return;
    this.#publishError(code, "The Realtime Voice control channel disconnected.", true);
    this.#beginStop("error");
  }

  #handleRelayEvent(sessionId: string, value: unknown): void {
    if (this.#state.sessionId !== sessionId || this.#state.phase === "inactive") return;
    const event = asRecord(value);
    const type = boundedString(event?.type, 120);
    if (!event || !type) return;
    if (boundedString(event.sessionId, 200) !== sessionId && type !== "relay.snapshot") return;

    if (type === "work-state") {
      const settlementOperationsInFlight = nonNegativeSafeInteger(
        event.settlementOperationsInFlight,
      );
      const pendingTranscriptionCount = nonNegativeSafeInteger(event.pendingTranscriptionCount);
      const pendingToolCount = nonNegativeSafeInteger(event.pendingToolCount);
      if (
        typeof event.responseRequestInFlight !== "boolean" ||
        typeof event.responseInFlight !== "boolean" ||
        settlementOperationsInFlight === null ||
        typeof event.pendingResponse !== "boolean" ||
        pendingTranscriptionCount === null ||
        pendingToolCount === null
      ) {
        return;
      }
      this.#relayWorkState = {
        responseRequestInFlight: event.responseRequestInFlight,
        responseInFlight: event.responseInFlight,
        settlementOperationsInFlight,
        pendingResponse: event.pendingResponse,
        pendingTranscriptionCount,
        pendingToolCount,
      };
      this.#markIdleActivity();
      if (
        this.#pendingStopReason === "inactivity" &&
        this.#state.phase === "stopping" &&
        this.#hasKnownWorkInFlight()
      ) {
        this.#resumeAfterDeferredInactivityStop();
      }
      return;
    }
    if (type === "relay.snapshot") {
      if (event.sidebandConnected === true) {
        this.#state = {
          ...this.#state,
          barrier: { ...this.#state.barrier, backendStarted: true },
        };
      }
      const actualModel = boundedString(event.actualModel, 160);
      if (actualModel) this.#state = { ...this.#state, actualModel };
      this.#promoteIfActive();
      if (event.sidebandConnected === true) this.#sendContinuity(sessionId);
      this.#publishState();
      return;
    }
    if (type === "state" && event.backendStarted === true) {
      this.#state = {
        ...this.#state,
        barrier: { ...this.#state.barrier, backendStarted: true },
      };
      this.#promoteIfActive();
      this.#sendContinuity(sessionId);
      this.#publishState();
      return;
    }
    if (type === "session") {
      const actualModel = boundedString(event.actualModel, 160);
      if (!actualModel) return;
      this.#state = {
        ...this.#state,
        actualModel,
        barrier: { ...this.#state.barrier, backendStarted: true },
      };
      this.#publish({
        type: "session",
        sessionId,
        threadId: this.#state.threadId,
        createdAt: this.#createdAt(),
        actualModel,
      });
      this.#promoteIfActive();
      this.#sendContinuity(sessionId);
      this.#publishState();
      return;
    }
    if (type === "activity") {
      const activity = event.activity;
      if (activity !== "listening" && activity !== "thinking" && activity !== "speaking") return;
      this.#state = { ...this.#state, activity };
      this.#markIdleActivity();
      this.#publish({
        type: "activity",
        sessionId,
        threadId: this.#state.threadId,
        createdAt: this.#createdAt(),
        activity,
      });
      this.#publishState();
      return;
    }
    if (type === "transcript") {
      const role = event.role;
      const itemId = boundedString(event.itemId, 200);
      const delta = typeof event.delta === "string" ? event.delta : null;
      const createdAt = this.#createdAt();
      if (
        !itemId ||
        (role !== "user" && role !== "assistant") ||
        delta === null ||
        delta.length > 32_768
      )
        return;
      this.#markIdleActivity();
      this.#publish({
        type: "transcript",
        sessionId,
        threadId: this.#state.threadId,
        createdAt,
        itemId,
        role,
        delta,
        done: event.done === true,
      });
      if (event.done === true) {
        const legacySpeechHandoff =
          role === "assistant" && this.#consumePendingSpeechHandoff(delta);
        if (event.persistToThread !== false && !legacySpeechHandoff) {
          this.#recordContinuity(role, delta);
          this.#persistFinalTranscript({ sessionId, itemId, role, text: delta, createdAt });
        }
      }
      return;
    }
    if (type === "usage") {
      const responseId = boundedString(event.responseId, 200);
      const usageRecord = asRecord(event.usage);
      const quotaRecord = asRecord(event.quota);
      const usage = usageRecord ? parseUsage(usageRecord) : null;
      const quota = quotaRecord ? parseQuota(quotaRecord) : null;
      if (!responseId || !usage || !quota) return;
      this.#publish({
        type: "usage",
        sessionId,
        threadId: this.#state.threadId,
        createdAt: this.#createdAt(),
        responseId,
        usage,
        quota,
      });
      return;
    }
    if (type === "quota-warning") {
      const quotaRecord = asRecord(event.quota);
      const quota = quotaRecord ? parseQuota(quotaRecord) : null;
      if (!quota) return;
      this.#publish({
        type: "quota-warning",
        sessionId,
        threadId: this.#state.threadId,
        createdAt: this.#createdAt(),
        quota,
        willStopAfterCurrentResponse: event.willStopAfterCurrentResponse === true,
      });
      return;
    }
    if (type === "tool-request") {
      const callId = boundedString(event.callId, 200);
      const name = event.name;
      if (!callId || !isToolName(name) || !this.#state.threadId) return;
      this.#pendingLocalToolCallIds.add(callId);
      this.#markIdleActivity();
      this.#publish({
        type: "tool-request",
        sessionId,
        threadId: this.#state.threadId,
        createdAt: this.#createdAt(),
        callId,
        name,
        arguments: event.arguments,
      });
      this.#executeTool({
        sessionId,
        threadId: this.#state.threadId,
        callId,
        name,
        arguments: event.arguments,
      });
      return;
    }
    if (type === "error") {
      const code = boundedString(event.code, 120) ?? "REALTIME_RELAY_ERROR";
      const message =
        boundedString(event.message, 1_000) ?? "The Realtime relay reported an error.";
      this.#publishError(code, message, event.recoverable === true);
      return;
    }
    if (type === "closed") {
      const reason = isStopReason(event.reason) ? event.reason : "server-closed";
      this.#finishClosed(reason);
    }
  }

  #executeTool(input: Parameters<RealtimeVoiceToolExecutor["execute"]>[0]): void {
    if (input.name === "capture_screen_context") {
      const previous = this.#pendingScreenContext.get(input.callId);
      if (previous) clearTimeout(previous.timer);
      const timer = setTimeout(() => {
        this.#enqueue(() => {
          const pending = this.#pendingScreenContext.get(input.callId);
          if (!pending || pending.sessionId !== input.sessionId) return;
          this.#pendingScreenContext.delete(input.callId);
          this.#pendingLocalToolCallIds.delete(input.callId);
          if (this.#state.sessionId !== input.sessionId || this.#state.phase === "inactive") return;
          try {
            this.#sendControl({
              type: "tool_result",
              callId: input.callId,
              output: { accepted: false, reason: "screen_context_timeout" },
              imageDataUrl: null,
            });
          } catch {
            // Session cleanup owns a disconnected control channel.
          }
          this.#markIdleActivity();
        });
      }, SCREEN_CONTEXT_TIMEOUT_MS);
      timer.unref?.();
      this.#pendingScreenContext.set(input.callId, { sessionId: input.sessionId, timer });
      return;
    }
    void this.#toolExecutor
      .execute(input)
      .then((output) =>
        this.#serialize(() => {
          if (this.#state.sessionId !== input.sessionId || this.#state.phase === "inactive") return;
          this.#pendingLocalToolCallIds.delete(input.callId);
          this.#sendControl({ type: "tool_result", callId: input.callId, output });
          if (input.name === "speak_to_user") {
            const argumentsRecord = asRecord(input.arguments);
            const message = boundedString(argumentsRecord?.message, 2_000);
            if (message) this.#sendControl({ type: "append_speech", text: message });
          }
          if (input.name === "end_realtime_voice_call") this.#beginStop("model");
          else this.#markIdleActivity();
        }),
      )
      .catch(() =>
        this.#serialize(() => {
          if (this.#state.sessionId !== input.sessionId || this.#state.phase === "inactive") return;
          this.#pendingLocalToolCallIds.delete(input.callId);
          this.#sendControl({
            type: "tool_result",
            callId: input.callId,
            output: { accepted: false, error: "LOCAL_TOOL_FAILED" },
          });
          this.#markIdleActivity();
        }),
      );
  }

  #sendControl(command: unknown): void {
    if (!this.#control) {
      throw new RealtimeVoiceRuntimeError(
        "REALTIME_CONTROL_NOT_READY",
        "Realtime Voice is still connecting.",
        true,
      );
    }
    this.#control.send(command);
  }

  #recordContinuity(role: "user" | "assistant", value: string): void {
    const threadId = this.#state.threadId;
    if (!threadId) return;
    const text = value.trim().replaceAll(/\s+/gu, " ").slice(0, MAX_CONTINUITY_ITEM_CHARS);
    if (!text) return;
    const current = this.#continuityByThread.get(threadId) ?? [];
    const previous = current.at(-1);
    if (previous?.role === role && previous.text === text) return;
    const next = [...current, { role, text }].slice(-MAX_CONTINUITY_ITEMS);
    while (
      next.length > 1 &&
      next.reduce((total, item) => total + Buffer.byteLength(item.text), 0) >
        MAX_CONTINUITY_BYTES * 2
    ) {
      next.shift();
    }
    this.#continuityByThread.set(threadId, next);
  }

  #consumePendingSpeechHandoff(value: string): boolean {
    const now = this.#now();
    for (let index = this.#pendingSpeechHandoffs.length - 1; index >= 0; index -= 1) {
      if ((this.#pendingSpeechHandoffs[index]?.expiresAtMs ?? 0) < now) {
        this.#pendingSpeechHandoffs.splice(index, 1);
      }
    }
    const normalizedText = normalizeSpeechHandoffText(value);
    if (!normalizedText) return false;
    const matchIndex = this.#pendingSpeechHandoffs.findIndex(
      (handoff) => handoff.normalizedText === normalizedText,
    );
    if (matchIndex < 0) return false;
    this.#pendingSpeechHandoffs.splice(matchIndex, 1);
    return true;
  }

  #persistFinalTranscript(input: {
    readonly sessionId: string;
    readonly itemId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly createdAt: string;
  }): void {
    const transcriptWriter = this.#transcriptWriter;
    if (!transcriptWriter || !this.#state.threadId) return;
    const text = input.text.trim();
    if (!text) return;
    const key = `${input.sessionId}:${input.role}:${input.itemId}`;
    if (this.#persistedTranscriptKeys.has(key) || this.#pendingTranscriptKeys.has(key)) return;
    const generation = this.#generation;
    const threadId = this.#state.threadId;
    this.#pendingTranscriptKeys.add(key);
    const transcript = {
      sessionId: input.sessionId,
      threadId,
      itemId: input.itemId,
      role: input.role,
      text,
      createdAt: input.createdAt,
    } as const;
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await transcriptWriter.write(transcript);
          this.#pendingTranscriptKeys.delete(key);
          if (this.#generation === generation) this.#persistedTranscriptKeys.add(key);
          return;
        } catch {
          // The writer uses a stable command/message ID, so bounded retries are
          // idempotent even when the first dispatch committed before disconnecting.
        }
      }
      this.#pendingTranscriptKeys.delete(key);
      this.#enqueue(() => {
        if (this.#generation !== generation) return;
        this.#publish({
          type: "error",
          sessionId: input.sessionId,
          threadId,
          createdAt: this.#createdAt(),
          code: "VOICE_TRANSCRIPT_PERSIST_FAILED",
          message: "Realtime Voice could not save the final transcript to this thread.",
          recoverable: true,
        });
      });
    })();
  }

  #sendContinuity(sessionId: string): void {
    if (
      this.#continuitySentSessionId === sessionId ||
      this.#state.sessionId !== sessionId ||
      !this.#state.threadId
    ) {
      return;
    }
    const stored = this.#continuityByThread.get(this.#state.threadId) ?? [];
    const items: Array<{ role: "system" | "user" | "assistant"; text: string }> = [];
    let bytes = 0;
    let dropped = false;
    for (let index = stored.length - 1; index >= 0; index -= 1) {
      const item = stored[index];
      if (!item) continue;
      const itemBytes = Buffer.byteLength(item.text);
      if (bytes + itemBytes > MAX_CONTINUITY_BYTES) {
        dropped = true;
        continue;
      }
      items.unshift(item);
      bytes += itemBytes;
    }
    if (dropped) {
      items.unshift({ role: "system", text: "Earlier voice continuity was truncated." });
    }
    this.#continuitySentSessionId = sessionId;
    if (items.length > 0) this.#sendControl({ type: "append_context", items });
  }

  #requireSession(sessionId: string): void {
    if (
      this.#state.sessionId !== sessionId ||
      (this.#state.phase !== "starting" && this.#state.phase !== "active")
    ) {
      throw new RealtimeVoiceRuntimeError(
        "VOICE_SESSION_NOT_ACTIVE",
        "The Realtime Voice session is not active.",
      );
    }
  }

  #hasKnownWorkInFlight(): boolean {
    const relay = this.#relayWorkState;
    return (
      this.#pendingLocalToolCallIds.size > 0 ||
      this.#pendingScreenContext.size > 0 ||
      relay.responseRequestInFlight ||
      relay.responseInFlight ||
      relay.settlementOperationsInFlight > 0 ||
      relay.pendingResponse ||
      relay.pendingTranscriptionCount > 0 ||
      relay.pendingToolCount > 0
    );
  }

  #markIdleActivity(): void {
    if (this.#sessionStartedAtMs !== null) this.#lastIdleActivityAtMs = this.#now();
    this.#idleActivityVersion += 1;
    this.#backgroundWorkProbeFailures = 0;
    this.#scheduleIdleCheck();
  }

  #idleDelayMs(): number | null {
    if (this.#sessionStartedAtMs === null) return null;
    const now = this.#now();
    const timeout = idleTimeoutForSessionAge(
      Math.max(0, now - this.#sessionStartedAtMs),
      this.#idlePolicy,
    );
    return Math.max(0, (this.#lastIdleActivityAtMs ?? this.#sessionStartedAtMs) + timeout - now);
  }

  #scheduleIdleCheck(delayOverrideMs?: number): void {
    this.#clearIdleTimer();
    const sessionId = this.#state.sessionId;
    if (
      !sessionId ||
      this.#state.phase !== "active" ||
      this.#state.activity !== "listening" ||
      this.#hasKnownWorkInFlight()
    ) {
      return;
    }
    const calculatedDelay = this.#idleDelayMs();
    if (calculatedDelay === null) return;
    const delay = Math.max(
      0,
      delayOverrideMs ??
        (this.#backgroundWorkWasActive ? BACKGROUND_WORK_RECHECK_MS : calculatedDelay),
    );
    const generation = this.#generation;
    const timer = setTimeout(() => {
      if (this.#idleTimer === timer) this.#idleTimer = null;
      this.#enqueue(() => this.#evaluateIdleStop(generation, sessionId));
    }, delay);
    this.#idleTimer = timer;
    timer.unref?.();
  }

  #evaluateIdleStop(generation: number, sessionId: string): void {
    if (
      generation !== this.#generation ||
      this.#state.sessionId !== sessionId ||
      this.#state.phase !== "active" ||
      this.#state.activity !== "listening" ||
      this.#hasKnownWorkInFlight() ||
      !this.#state.threadId
    ) {
      return;
    }

    const activityVersion = this.#idleActivityVersion;
    const threadId = this.#state.threadId;
    void Promise.resolve()
      .then(() => this.#hasActiveBackgroundWork({ sessionId, threadId }))
      .then(
        (hasBackgroundWork) =>
          this.#enqueue(() =>
            this.#finishIdleProbe(generation, sessionId, activityVersion, hasBackgroundWork),
          ),
        () =>
          this.#enqueue(() => this.#finishIdleProbeFailure(generation, sessionId, activityVersion)),
      );
  }

  #finishIdleProbe(
    generation: number,
    sessionId: string,
    activityVersion: number,
    hasBackgroundWork: boolean,
  ): void {
    if (
      generation !== this.#generation ||
      activityVersion !== this.#idleActivityVersion ||
      this.#state.sessionId !== sessionId ||
      this.#state.phase !== "active" ||
      this.#state.activity !== "listening" ||
      this.#hasKnownWorkInFlight()
    ) {
      return;
    }
    this.#backgroundWorkProbeFailures = 0;
    if (hasBackgroundWork) {
      this.#backgroundWorkWasActive = true;
      this.#scheduleIdleCheck(BACKGROUND_WORK_RECHECK_MS);
      return;
    }
    if (this.#backgroundWorkWasActive) {
      this.#backgroundWorkWasActive = false;
      this.#markIdleActivity();
      return;
    }
    const delay = this.#idleDelayMs();
    if (delay === null) return;
    if (delay > 0) {
      this.#scheduleIdleCheck(delay);
      return;
    }
    this.#beginStop("inactivity");
  }

  #finishIdleProbeFailure(generation: number, sessionId: string, activityVersion: number): void {
    if (
      generation !== this.#generation ||
      activityVersion !== this.#idleActivityVersion ||
      this.#state.sessionId !== sessionId ||
      this.#state.phase !== "active" ||
      this.#state.activity !== "listening" ||
      this.#hasKnownWorkInFlight()
    ) {
      return;
    }
    this.#backgroundWorkProbeFailures += 1;
    if (this.#backgroundWorkProbeFailures >= MAX_BACKGROUND_WORK_PROBE_FAILURES) {
      this.#publishError(
        "VOICE_IDLE_WORK_PROBE_FAILED",
        "Realtime Voice could not confirm background task state before ending for inactivity.",
        true,
      );
      this.#beginStop("inactivity");
      return;
    }
    this.#scheduleIdleCheck(
      BACKGROUND_WORK_PROBE_FAILURE_BACKOFF_MS * 2 ** (this.#backgroundWorkProbeFailures - 1),
    );
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #resetIdleTracking(): void {
    this.#clearIdleTimer();
    this.#sessionStartedAtMs = null;
    this.#lastIdleActivityAtMs = null;
    this.#idleActivityVersion += 1;
    this.#backgroundWorkWasActive = false;
    this.#backgroundWorkProbeFailures = 0;
    this.#pendingStopReason = null;
    this.#relayWorkState = NO_RELAY_WORK;
    this.#pendingLocalToolCallIds.clear();
  }

  #resumeAfterDeferredInactivityStop(): void {
    if (this.#pendingStopReason !== "inactivity" || this.#state.phase !== "stopping") return;
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = null;
    this.#generation += 1;
    this.#pendingStopReason = null;
    this.#state = { ...this.#state, phase: "active", activity: "listening" };
    this.#publishState();
    this.#markIdleActivity();
  }

  #beginStop(reason: RealtimeVoiceStopReason): void {
    if (this.#state.phase === "inactive" || this.#state.phase === "stopping") return;
    this.#clearIdleTimer();
    this.#idleActivityVersion += 1;
    this.#generation += 1;
    this.#pendingStopReason = reason;
    this.#startAbort?.abort();
    this.#startAbort = null;
    this.#state = { ...this.#state, phase: "stopping" };
    this.#publishState();
    let controlSent = false;
    try {
      this.#control?.send({ type: "stop", reason });
      controlSent = this.#control !== null;
    } catch {
      // The authenticated DELETE fallback below remains available.
    }
    if (this.#accessToken && this.#state.sessionId && (reason !== "inactivity" || !controlSent)) {
      void this.#relay
        .stopCall({
          accessToken: this.#accessToken,
          sessionId: this.#state.sessionId,
        })
        .catch(() => undefined);
    }
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = setTimeout(() => {
      this.#enqueue(() => this.#finishClosed(reason));
    }, STOP_TIMEOUT_MS);
    this.#stopTimer.unref?.();
  }

  #finishClosed(reason: RealtimeVoiceStopReason): void {
    const sessionId = this.#state.sessionId;
    const threadId = this.#state.threadId;
    this.#publish({ type: "closed", sessionId, threadId, createdAt: this.#createdAt(), reason });
    this.#reset(true);
  }

  #fail(code: string, message: string, recoverable = true): void {
    this.#clearAllTimers();
    this.#resetIdleTracking();
    this.#control?.close();
    this.#control = null;
    this.#state = {
      ...this.#state,
      phase: "failed",
      activity: null,
      error: message,
      ownerClaimId: null,
    };
    this.#claimExpiresAt = null;
    this.#publishError(code, message, recoverable);
    this.#publishState();
  }

  #reset(publish: boolean): void {
    this.#clearAllTimers();
    this.#resetIdleTracking();
    this.#control?.close();
    this.#control = null;
    this.#accessToken = null;
    this.#claimedAuthorityId = null;
    this.#startAbort = null;
    this.#claimExpiresAt = null;
    this.#continuitySentSessionId = null;
    this.#persistedTranscriptKeys.clear();
    this.#pendingTranscriptKeys.clear();
    this.#pendingSpeechHandoffs.splice(0);
    this.#localTextSequence = 0;
    this.#state = inactiveState();
    if (publish) this.#publishState();
  }

  #clearAllTimers(): void {
    if (this.#claimTimer) clearTimeout(this.#claimTimer);
    if (this.#startupTimer) clearTimeout(this.#startupTimer);
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#clearIdleTimer();
    this.#claimTimer = null;
    this.#startupTimer = null;
    this.#stopTimer = null;
    for (const pending of this.#pendingScreenContext.values()) clearTimeout(pending.timer);
    this.#pendingScreenContext.clear();
  }
}
