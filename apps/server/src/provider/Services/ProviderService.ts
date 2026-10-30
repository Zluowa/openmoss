/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  EventId,
  ClaudeCacheObservation,
  ProviderBackgroundTaskInput,
  ProviderForkThreadInput,
  ProviderForkThreadResult,
  ProviderInterruptTurnInput,
  ProviderGetLaunchPlanInput,
  ProviderGetLaunchPlanResult,
  ProviderGetLoopLedgerDashboardSnapshotInput,
  ProviderGetLoopLedgerDashboardSnapshotResult,
  ProviderSubmitPermissionActionInput,
  ProviderSubmitPermissionActionResult,
  ProviderInstanceId,
  ProviderKind,
  MossNormalizedSessionEvent,
  MossSubscribeNormalizedSessionEventsInput,
  ModelSelection,
  RuntimeMode,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderStartReviewInput,
  ProviderSteerTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStartOptions,
  ProviderSteerSubagentInput,
  ProviderStopSessionInput,
  ProviderStopTaskInput,
  ThreadId,
  TurnId,
  ProviderTurnStartResult,
  McpAppResourceReadInput,
  McpAppResourceReadResult,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Deferred, Effect, Stream } from "effect";

import type { ProviderServiceError } from "../Errors.ts";
import type { PersistedProviderRuntimeEvent } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderNextUserMessagePrediction,
  ProviderPredictNextUserMessageInput,
  ProviderTurnDispatchOptions,
} from "./ProviderAdapter.ts";

export type ProviderRuntimeEventPumpStatus = "starting" | "healthy" | "recovering" | "degraded";

export interface ProviderRuntimeEventPumpHealth {
  readonly provider: ProviderKind;
  readonly status: ProviderRuntimeEventPumpStatus;
  readonly consecutiveFailures: number;
  readonly updatedAt: string;
  readonly lastEventAt?: string;
  readonly lastError?: string;
  readonly quarantinedEvents?: number;
  readonly lastQuarantinedEventId?: string;
  readonly lastQuarantinedAt?: string;
}

export interface ProviderSessionStartOutcome {
  readonly session: ProviderSession;
  readonly nativeResumeAttempted: boolean;
  readonly nativeResumeSucceeded: boolean;
  readonly priorTranscriptBootstrapPending: boolean;
}

export interface ProviderSessionStartOutcomeOptions {
  /**
   * Persist a pending transcript bootstrap when this start cannot restore
   * provider-native context, even if no native resume was attempted. A failed
   * native resume always registers it. The caller clears it only after the
   * provider has accepted the bootstrap turn.
   */
  readonly registerPriorTranscriptBootstrapOnFreshStart?: boolean;
  /** Allow a deliberate cross-provider rebind to replace native continuation. */
  readonly abandonOtherProviderContinuation?: boolean;
}

/** Durable identity of one Stop; its authority never transfers to a later turn. */
export interface ProviderRuntimeStopControlReceipt {
  readonly controlRequestId: string;
  readonly observedLifecycleGeneration: string | null;
  readonly turnId: TurnId | null;
  readonly providerThreadId?: string;
  readonly retiredLifecycleGeneration?: string;
}

/** Internal Stop observation, captured with the runtime under its lifecycle lock. */
export interface ProviderRuntimeSessionStopTarget {
  readonly session: ProviderSession | null;
  readonly lifecycleGeneration: string | null;
  readonly stopControlReceipt?: ProviderRuntimeStopControlReceipt;
}

export interface PersistedProviderSessionProfile {
  readonly provider: ProviderKind;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly enableComputerControl: boolean;
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  readonly startClaudeCompaction?: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly cancellation?: Deferred.Deferred<void>;
  }) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;
  /** Signal local compaction preparation cancellation without delivering a provider command. */
  readonly cancelClaudeCompactionDiscovery?: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ProviderServiceError>;
  readonly getClaudeCacheObservation?: (
    threadId: ThreadId,
  ) => Effect.Effect<ClaudeCacheObservation | undefined, ProviderServiceError>;
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Start a provider session and report whether the adapter confirmed that it
   * restored the provider-native session named by the supplied cursor.
   */
  readonly startSessionWithOutcome?: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
    options?: ProviderSessionStartOutcomeOptions,
  ) => Effect.Effect<ProviderSessionStartOutcome, ProviderServiceError>;

  /** Mark a persisted prior-transcript bootstrap as accepted by the provider. */
  readonly completePriorTranscriptBootstrap?: (input: {
    readonly threadId: ThreadId;
    readonly expectedLifecycleGeneration?: string;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
    options?: ProviderTurnDispatchOptions,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /** Read one MCP App resource through the exact provider runtime bound to a thread. */
  readonly readMcpAppResource?: (
    input: McpAppResourceReadInput,
  ) => Effect.Effect<McpAppResourceReadResult, ProviderServiceError>;

  /**
   * Redirect an active provider turn toward a new prompt when supported.
   */
  readonly steerTurn: (
    input: ProviderSteerTurnInput,
    options?: ProviderTurnDispatchOptions,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Start a native provider review run when supported by the routed adapter.
   */
  readonly startReview: (
    input: ProviderStartReviewInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Fork a provider thread natively when the underlying adapter supports it.
   *
   * Returns a persisted provider-native fork binding when available, otherwise
   * `null` so callers can fall back to orchestration-only history.
   */
  readonly forkThread?: (
    input: ProviderForkThreadInput,
  ) => Effect.Effect<ProviderForkThreadResult | null, ProviderServiceError>;

  /** Copy an external native conversation without ever resuming the original. */
  readonly importExternalThread?: (input: {
    readonly threadId: ThreadId;
    readonly provider: "codex" | "claudeAgent";
    readonly externalThreadId: string;
    readonly sourceCwd: string;
    readonly cwd?: string;
    readonly modelSelection: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
    readonly runtimeMode: RuntimeMode;
  }) => Effect.Effect<ProviderForkThreadResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput & {
      /** Internal conditional Stop authority; never part of the wire input. */
      readonly expectedLifecycleGeneration?: string | null;
      readonly controlRequestId?: string;
    },
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider-native background task. No-op when the routed adapter does
   * not support task control.
   */
  readonly stopTask: (input: ProviderStopTaskInput) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Move an in-flight foreground task to the background. No-op when the routed
   * adapter does not support task control.
   */
  readonly backgroundTask: (
    input: ProviderBackgroundTaskInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Deliver a mid-task user message to a running subagent of an active session.
   */
  readonly steerSubagent: (
    input: ProviderSteerSubagentInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop only the live adapter process/session while preserving the persisted
   * provider binding and resume cursor for a subsequent restart.
   */
  readonly stopRuntimeSession?: (input: {
    readonly threadId: ThreadId;
    /** A conditional Stop must not tear down a replacement lifecycle epoch. */
    readonly expectedLifecycleGeneration?: string | null;
    readonly controlRequestId?: string;
  }) => Effect.Effect<void, ProviderServiceError>;

  /** Observe one Stop target atomically; this is not a transport contract. */
  readonly getRuntimeSessionStopTarget?: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ProviderRuntimeSessionStopTarget, ProviderServiceError>;

  /**
   * Stop every normal and discovery Codex runtime bound to one exact account.
   * Live implementations wait for process exit so callers can safely remove
   * that account's writable runtime overlay.
   */
  readonly stopCodexAccountRuntimes?: (input: {
    readonly homePath: string;
    readonly accountId: string;
    readonly runtimeGeneration?: string;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Revoke launch leases captured for one exact provider instance and wait for
   * every pre-fence launch to finish its binding commit or rejected-launch
   * cleanup. Callers must durably disable/remove the instance before invoking
   * this drain so post-fence launches cannot resolve fresh credentials.
   */
  readonly fenceProviderInstanceLaunchesAndWait?: (input: {
    readonly providerInstanceId: ProviderInstanceId;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Whether provider-native background tasks are currently keeping the
   * thread's runtime alive. Restart-oriented recovery paths must check this
   * before stopRuntimeSession: killing the shared subprocess silently
   * terminates those tasks.
   */
  readonly hasLiveRuntimeTasks?: (input: { readonly threadId: ThreadId }) => Effect.Effect<boolean>;

  /**
   * Forget a stale provider-native resume cursor while preserving local routing
   * metadata such as provider options and runtime mode.
   */
  readonly clearSessionResumeCursor?: (input: {
    readonly threadId: ThreadId;
    /** Clear only persisted resume state without stopping a runtime that owns live tasks. */
    readonly preserveActiveRuntime?: boolean;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Check whether a persisted session binding was launched with the current
   * effective options. Returns only a boolean; credential fingerprints remain
   * inside ProviderService and are never exposed to orchestration callers.
   */
  readonly sessionBindingMatchesLaunchOptions?: (input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderKind;
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerOptions?: ProviderStartOptions;
  }) => Effect.Effect<boolean, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /** Read the settings that produced a persisted native resume cursor. */
  readonly getPersistedSessionProfile: (
    threadId: ThreadId,
  ) => Effect.Effect<PersistedProviderSessionProfile | undefined, ProviderServiceError>;

  /**
   * Read static capabilities for a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Trigger provider-native context compaction for a thread.
   */
  readonly compactThread: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Predict the user's next message from the thread's live native runtime. Never starts or
   * recovers a session: `unsupported` asks the caller to use its provider-neutral fallback.
   */
  readonly predictNextUserMessage: (
    threadId: ThreadId,
    input: ProviderPredictNextUserMessageInput,
  ) => Effect.Effect<ProviderNextUserMessagePrediction, ProviderServiceError>;

  /**
   * Read the latest redacted Moss launch plan persisted for a thread.
   *
   * Missing or unparseable plans are returned as `null` so internal UI can show
   * an explicit "no plan" state without depending on raw provider events.
   */
  readonly getLaunchPlan: (
    input: ProviderGetLaunchPlanInput,
  ) => Effect.Effect<ProviderGetLaunchPlanResult, ProviderServiceError>;

  /**
   * Read the generated Moss loop-ledger dashboard snapshot for the current
   * project. UI consumers should use this typed boundary instead of parsing
   * `.moss` ledger files in React.
   */
  readonly getLoopLedgerDashboardSnapshot: (
    input: ProviderGetLoopLedgerDashboardSnapshotInput,
  ) => Effect.Effect<ProviderGetLoopLedgerDashboardSnapshotResult, ProviderServiceError>;

  /**
   * Submit a normalized Moss permission action intent.
   *
   * Returns a safe unsupported result unless the routed provider adapter
   * explicitly declares and implements this normalized action capability.
   */
  readonly submitPermissionAction: (
    input: ProviderSubmitPermissionActionInput,
  ) => Effect.Effect<ProviderSubmitPermissionActionResult, ProviderServiceError>;

  /**
   * Stop provider event producers, drain the lossless fan-out while subscribers
   * are still live, and then close the publication bus. Safe to call repeatedly.
   */
  readonly closeRuntimeEvents: Effect.Effect<void>;

  /**
   * Snapshot the supervised runtime-event pumps. The state is operational
   * evidence for reconciliation and diagnostics, not provider availability.
   */
  readonly getRuntimeEventPumpHealth?: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeEventPumpHealth>
  >;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;

  /**
   * Moss normalized session event stream derived from canonical provider
   * runtime events. Consumers that render cross-provider timelines should use
   * this stream instead of parsing provider-specific raw payloads.
   */
  readonly streamNormalizedEvents: Stream.Stream<MossNormalizedSessionEvent>;

  /**
   * Replay recently normalized Moss session events from the server-local
   * buffer. This is intended for consumers that need to catch up before
   * attaching to `streamNormalizedEvents`.
   */
  readonly getNormalizedEvents: (input?: {
    readonly threadId?: ThreadId | undefined;
    readonly afterEventId?: EventId | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<MossNormalizedSessionEvent>>;

  /**
   * Subscribe to normalized Moss session events for one thread with an initial
   * replay window. The live subscription is acquired before replay is read, so
   * callers do not miss events between catch-up and streaming.
   */
  readonly streamNormalizedEventsWithReplay: (
    input: MossSubscribeNormalizedSessionEventsInput,
  ) => Stream.Stream<MossNormalizedSessionEvent>;

  /**
   * Canonical runtime events paired with their already-durable journal sequence.
   *
   * Durable production services expose this stream so the ingestion worker can
   * drain through the accepted row without appending the same event again.
   * Lightweight/test services may omit it and retain the append-on-ingest path.
   */
  readonly streamPersistedEvents?: Stream.Stream<PersistedProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends ServiceMap.Service<ProviderService, ProviderServiceShape>()(
  "moss/provider/Services/ProviderService",
) {}
