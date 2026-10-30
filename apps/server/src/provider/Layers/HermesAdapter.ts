import { snapshotProviderTurns } from "../snapshotProviderTurns.ts";
/**
 * HermesAdapterLive — Hermes CLI (`hermes acp`) via ACP.
 *
 * @module HermesAdapterLive
 */
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@synara/contracts";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Random,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as Acp from "@agentclientprotocol/sdk";

import { buildAcpMossMcpServers } from "../../agentGateway/mcpInjection.ts";
import {
  type MossHarnessPolicyDeliveryState,
  takeMossHarnessPolicyTextPartForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import {
  acquireAgentGatewaySessionLease,
  awaitAgentGatewayMcpStartupReady,
  cancelAgentGatewayTurn,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  acceptAcpPlanUpdate,
  makeAcpThreadLock,
  readAcpUsdCost,
  resolveAcpTurnInteractionMode,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
  waitForAcpQueuedTurnEventsDrained,
} from "../acp/AcpAdapterSessionSupport.ts";
import type * as AcpErrors from "../acp/AcpErrors.ts";
import { forkViaAcpRuntime } from "../acp/acpFork.ts";
import {
  type AcpSessionRuntimeShape,
  type AcpSessionStartupTimeouts,
} from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
  stampAcpRuntimeEventLifecycleGeneration,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  forkAcpTurnIdleWatchdog,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  makeHermesAcpRuntime,
  resolveHermesRuntimeSettings,
  setHermesAcpModel,
  setHermesAcpDefaultMode,
  parseHermesAcpModels,
  type HermesAcpRuntimeSettings,
} from "../acp/HermesAcpSupport";
import {
  readMossManagedHermesConfig,
  mossManagedHermesModels,
  prepareMossManagedHermesHome,
} from "../mossManagedHermesEnvironment";
import { getMossManagedModelDefinition } from "@synara/shared/mossRealmCatalog";
import { HermesAdapter, type HermesAdapterShape } from "../Services/HermesAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { MossPluginApprovalStore } from "../mossPluginRuntime.ts";

const PROVIDER = "hermes" as const;
const HERMES_NATIVE_FAILURE_RAW = {
  source: "acp.jsonrpc" as const,
  method: "session/prompt",
  messageType: "hermes.native-inference-failed",
  payload: { hermesNativeContinuationInvalid: true },
};

export function classifyHermesPromptTurnCompletion(input: {
  readonly stopReason: string | null | undefined;
  readonly failedToolDetail?: string;
  readonly hasOutput: boolean;
}) {
  const completion = classifyAcpPromptTurnCompletion(input);
  if (completion.state === "completed" && !input.hasOutput) {
    return {
      state: "failed" as const,
      errorMessage:
        input.failedToolDetail ??
        "Hermes returned no response or completed action. The model request may have failed.",
    };
  }
  return completion;
}

export const takeHermesMossHarnessPolicyTextPart = (
  state: MossHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeMossHarnessPolicyTextPartForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable,
  });
const HERMES_RESUME_VERSION = 1 as const;
// Forking a dead source session must first resume it, which may replay
// history, so the fork exchange gets a wider budget than plain requests.
const HERMES_ACP_FORK_TIMEOUT_MS = 30_000;
// Bound each startup phase while allowing Python and MCP initialization.
const HERMES_ACP_STARTUP_TIMEOUTS = {
  initializeMs: 20_000,
  authenticateMs: 30_000,
  sessionSetupMs: 20_000,
  totalMs: 60_000,
} as const satisfies AcpSessionStartupTimeouts;
// Backstop for an alive-but-silent hermes-agent child: if a turn produces no
// ACP activity for this long, force-fail it instead of showing "Working"
// forever. Generous by design; override with MOSS_HERMES_TURN_IDLE_TIMEOUT_MS.
const HERMES_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "MOSS_HERMES_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const HERMES_TURN_WATCHDOG_INTERVAL_MS = 15_000;
const HERMES_PLAN_MODE_PROMPT_PREFIX = [
  "Moss Hermes plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

export interface HermesAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly pluginApprovalStore?: MossPluginApprovalStore;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface HermesSessionContext {
  harnessPolicyDelivered?: boolean;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  readonly managed: boolean;
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly assistantItemTurnIds: Map<string, TurnId>;
  lastPlanFingerprint: string | undefined;
  sessionUpdatesProcessed: number;
  configuredModel: string | undefined;
  readonly allowedModels: ReadonlyArray<string> | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnFailedToolDetail: string | undefined;
  activeTurnHasOutput: boolean;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  // Epoch-ms of the last inbound ACP activity for the active turn; drives the
  // idle-progress watchdog that force-fails a silently hung turn.
  lastTurnActivityAt: number | undefined;
  latestSessionCostUsd: number | undefined;
  // The runtime is registered before load replay settles so stop/restart can
  // close it without waiting for the replay hard cap. Turns wait here until
  // startup configuration has completed under the thread lock.
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  stopped: boolean;
}

function clearHermesActiveTurn(ctx: HermesSessionContext, turnId: TurnId): boolean {
  if (ctx.activeTurnId !== turnId) {
    return false;
  }

  ctx.activeTurnId = undefined;
  ctx.activeTurnFailedToolDetail = undefined;
  ctx.activeTurnHasOutput = false;
  ctx.activePromptFiber = undefined;
  ctx.activeInteractionMode = undefined;
  const { activeTurnId: _activeTurnId, ...session } = ctx.session;
  ctx.session = session;
  return true;
}

function resolveHermesAssistantItemTurnId(
  ctx: HermesSessionContext,
  itemId: string | undefined,
): TurnId | undefined {
  if (itemId === undefined) {
    return ctx.activeTurnId;
  }
  const knownTurnId = ctx.assistantItemTurnIds.get(itemId);
  if (knownTurnId !== undefined) {
    return knownTurnId;
  }
  if (ctx.activeTurnId !== undefined) {
    ctx.assistantItemTurnIds.set(itemId, ctx.activeTurnId);
    return ctx.activeTurnId;
  }
  return ctx.assistantItemTurnIds.get(itemId);
}

function completeHermesAssistantItemTurnId(
  ctx: HermesSessionContext,
  itemId: string,
): TurnId | undefined {
  const turnId = resolveHermesAssistantItemTurnId(ctx, itemId);
  ctx.assistantItemTurnIds.delete(itemId);
  return turnId;
}

function recordHermesSessionCost(
  ctx: HermesSessionContext,
  cost: Acp.Cost | null | undefined,
): void {
  const sessionCostUsd = readAcpUsdCost(cost);
  if (sessionCostUsd === undefined) {
    return;
  }
  ctx.latestSessionCostUsd = sessionCostUsd;
}

// ACP reports session-cumulative cost, so keep it cumulative instead of inventing turn deltas.
function finalizeHermesActiveTurnCost(ctx: HermesSessionContext): {
  readonly cumulativeCostUsd?: number;
} {
  return ctx.latestSessionCostUsd !== undefined
    ? { cumulativeCostUsd: ctx.latestSessionCostUsd }
    : {};
}

function withHermesPlanModePrompt(input: {
  readonly text: string;
  readonly interactionMode?: ProviderInteractionMode;
}): string {
  if (input.interactionMode !== "plan") {
    return input.text;
  }

  const text = input.text.trim();
  return text.length > 0
    ? `${HERMES_PLAN_MODE_PROMPT_PREFIX}\n\nUser request:\n${text}`
    : HERMES_PLAN_MODE_PROMPT_PREFIX;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHermesResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== HERMES_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function describeHermesErrorCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message.trim();
  }
  if (typeof cause === "string") {
    return cause.trim();
  }
  return "";
}

function describeHermesAcpErrorData(data: unknown): string {
  if (typeof data === "string") {
    return data.trim();
  }
  if (!isRecord(data)) {
    return "";
  }
  const detail = data.detail ?? data.details ?? data.message;
  if (typeof detail === "string" && detail.trim()) {
    return detail.trim();
  }
  return JSON.stringify(data).slice(0, 500);
}

// Startup failures are the only signal the user gets about why Hermes did not
// come up, so keep the agent's own wording (JSON-RPC data included) instead of
// the tagged-error class defaults, which carry no detail for transport errors.
function hermesAcpFailureDetail(error: AcpErrors.AcpError): string {
  if (error._tag === "AcpRequestError") {
    const message = error.errorMessage.trim();
    const data = describeHermesAcpErrorData(error.data);
    const detail = [message, data && data !== message ? data : ""].filter(Boolean).join(" — ");
    return detail
      ? `${detail} (JSON-RPC ${String(error.code)})`
      : `Hermes ACP request failed (JSON-RPC ${String(error.code)}).`;
  }
  const causeDetail = describeHermesErrorCause(error.cause);
  const baseDetail =
    error._tag === "AcpTransportError" ? error.detail.trim() : error.message.trim();
  return [baseDetail, causeDetail && causeDetail !== baseDetail ? causeDetail : ""]
    .filter(Boolean)
    .join(" — ");
}

function normalizeHermesAdapterError(error: unknown, threadId: ThreadId): ProviderAdapterError {
  if (
    error instanceof ProviderAdapterValidationError ||
    error instanceof ProviderAdapterSessionNotFoundError ||
    error instanceof ProviderAdapterSessionClosedError ||
    error instanceof ProviderAdapterRequestError ||
    error instanceof ProviderAdapterProcessError
  ) {
    return error;
  }
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection: { readonly model: string } | undefined;
  readonly managed?: boolean;
  readonly configuredModel?: string | undefined;
  readonly mapError: (context: {
    readonly cause: AcpErrors.AcpError;
    readonly method: "session/set_model" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection && input.modelSelection.model !== input.configuredModel)
      yield* setHermesAcpModel(
        input.runtime,
        input.modelSelection.model,
        input.managed === true,
      ).pipe(Effect.mapError((cause) => input.mapError({ cause, method: "session/set_model" })));
    // Moss resolves each native permission request, including Plan-mode denial.
    yield* setHermesAcpDefaultMode(input.runtime).pipe(
      Effect.mapError((cause) => input.mapError({ cause, method: "session/set_mode" })),
    );
  });
}

function resolveHermesSessionCwd(
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
): string | undefined {
  const requestedCwd = inputCwd?.trim();
  if (requestedCwd) {
    return nodePath.resolve(requestedCwd);
  }

  const fallbackCwd = serverConfig.cwd.trim() || serverConfig.homeDir.trim();
  return fallbackCwd ? nodePath.resolve(fallbackCwd) : undefined;
}

export function makeHermesAdapter(
  hermesSettings: HermesAcpRuntimeSettings,
  options?: HermesAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    // Optional so adapter tests can run without the gateway layer; when
    // present, every session gets the moss_* MCP tools.
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const prepareRuntimeSettings = (
      settings: HermesAcpRuntimeSettings,
      instanceId: string | undefined,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const managed = readMossManagedHermesConfig(settings.environment);
          if (!managed) {
            if (instanceId === "hermes_moss")
              throw new Error("Managed Hermes configuration is missing.");
            return settings;
          }
          if (instanceId !== "hermes_moss")
            throw new Error("Managed Hermes configuration requires the reserved Moss instance.");
          const expectedHome = nodePath.join(
            serverConfig.stateDir,
            "provider-homes",
            "hermes",
            managed.realm,
          );
          if (settings.homePath !== expectedHome)
            throw new Error("Managed Hermes requires its isolated realm home.");
          await prepareMossManagedHermesHome(expectedHome, managed);
          return { ...settings, managed: true };
        },
        catch: (cause) =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue:
              cause instanceof Error
                ? cause.message
                : "Unable to prepare the isolated Hermes configuration.",
            cause,
          }),
      });

    const sessions = new Map<ThreadId, HermesSessionContext>();
    const withThreadLock = yield* makeAcpThreadLock();
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const stampRuntimeEventForInstance = (event: ProviderRuntimeEvent): ProviderRuntimeEvent => {
      const providerInstanceId = sessions.get(event.threadId)?.session.providerInstanceId;
      return providerInstanceId && event.providerInstanceId !== providerInstanceId
        ? { ...event, providerInstanceId }
        : event;
    };

    const offerRuntimeEvent = (
      lifecycleGeneration: string | undefined,
      event: ProviderRuntimeEvent,
    ) =>
      PubSub.publish(
        runtimeEventPubSub,
        stampRuntimeEventForInstance(
          stampAcpRuntimeEventLifecycleGeneration(event, lifecycleGeneration),
        ),
      ).pipe(Effect.asVoid);

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | "acp.jsonrpc",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const failHermesTurnAsTimedOut = (ctx: HermesSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (ctx.activeTurnId !== turnId) {
          return;
        }
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
        if (!clearHermesActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeHermesActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `Hermes stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({ id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning("hermes.acp.turn_idle_timeout", {
          threadId: ctx.threadId,
          turnId,
          idleMs,
        });
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: "failed",
            stopReason: null,
            errorMessage: detail,
            ...completedCost,
          },
        });
        // Best-effort: tell the child to abandon the turn, then unwind the
        // pending prompt fiber (its onInterrupt no-ops, the turn is cleared).
        yield* Effect.ignore(ctx.acp.cancel);
        if (promptFiber) {
          yield* Fiber.interrupt(promptFiber);
        }
      });

    const emitPlanUpdate = (
      ctx: HermesSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | "acp.jsonrpc",
      method: string,
    ) =>
      Effect.gen(function* () {
        if (!acceptAcpPlanUpdate(ctx, payload)) return;
        yield* offerRuntimeEvent(
          ctx.lifecycleGeneration,
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<HermesSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const waitForHermesQueuedTurnEventsDrained = (ctx: HermesSessionContext) =>
      waitForAcpQueuedTurnEventsDrained({
        sessionUpdatesEnqueuedCount: ctx.acp.sessionUpdatesEnqueuedCount,
        sessionUpdatesProcessed: () => ctx.sessionUpdatesProcessed,
        maxWaitMs: 2_000,
        pollMs: 10,
      });

    const stopSessionInternal = (ctx: HermesSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId);
        ctx.gatewaySessionLease?.release();
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.succeed(ctx.sessionConfigReady, undefined);
          ctx.sessionConfigReady = undefined;
        }
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (sessions.get(ctx.threadId) === ctx) {
          sessions.delete(ctx.threadId);
        }
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          ...(ctx.session.providerInstanceId
            ? { providerInstanceId: ctx.session.providerInstanceId }
            : {}),
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: HermesAdapterShape["startSession"] = (input) => {
      let registeredCtx: HermesSessionContext | undefined;
      const setup = withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          const cwd = resolveHermesSessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const hermesModelSelection = input.modelSelection;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          const gatewaySessionLease = acquireAgentGatewaySessionLease(
            agentGatewayCredentials,
            input.threadId,
            PROVIDER,
            input,
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred || !gatewaySessionLease
              ? Effect.void
              : Effect.sync(gatewaySessionLease.release),
          );
          let ctx!: HermesSessionContext;

          const resumeSessionId = parseHermesResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const providerHermesOptions = input.providerOptions?.hermes;
          let effectiveHermesSettings = resolveHermesRuntimeSettings(
            providerHermesOptions ?? {},
            hermesSettings,
          );

          const managedConfig = readMossManagedHermesConfig(effectiveHermesSettings.environment);
          if (
            managedConfig &&
            hermesModelSelection &&
            !mossManagedHermesModels(managedConfig.realm).includes(hermesModelSelection.model)
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The model is not available in this Moss realm.",
            });
          }
          effectiveHermesSettings = yield* prepareRuntimeSettings(
            effectiveHermesSettings,
            input.providerInstanceId,
          );

          const acp = yield* makeHermesAcpRuntime({
            hermesSettings: effectiveHermesSettings,
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "Moss", version: "0.0.0" },
            startupTimeouts: HERMES_ACP_STARTUP_TIMEOUTS,
            ...(options?.pluginApprovalStore
              ? { pluginApprovalStore: options.pluginApprovalStore }
              : {}),
            ...(agentGatewayCredentials
              ? {
                  buildMcpServers: (initializeResult) =>
                    buildAcpMossMcpServers({
                      connection: gatewaySessionLease!.connection,
                      initializeResult,
                      stdioProxy: agentGatewayCredentials.stdioProxy,
                      issueStdioBootstrapToken: () =>
                        gatewaySessionLease?.issueStdioBootstrapToken?.() ?? null,
                    }),
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: hermesAcpFailureDetail(cause),
                  cause,
                }),
            ),
          );
          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);
          // Register the session before the replay/configuration fence settles.
          // Teardown resolves this gate so a replaced session cannot strand a turn.
          const sessionConfigReady = yield* Deferred.make<void>();
          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "session/request_permission",
                  params,
                  "acp.jsonrpc",
                );
                const policyOutcome = resolveAcpPermissionPolicy({
                  runtimeMode: input.runtimeMode,
                  interactionMode: ctx?.activeInteractionMode,
                  options: params.options,
                });
                if (policyOutcome !== undefined) {
                  return { outcome: policyOutcome };
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, {
                  decision,
                  kind: permissionRequest.kind,
                });
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                return {
                  outcome:
                    resolved === "cancel"
                      ? ({ outcome: "cancelled" } as const)
                      : (() => {
                          const selectedOptionId = selectAcpPermissionOptionId(
                            resolved,
                            params.options,
                          );
                          return selectedOptionId === undefined
                            ? ({ outcome: "cancelled" } as const)
                            : ({
                                outcome: "selected" as const,
                                optionId: selectedOptionId,
                              } as const);
                        })(),
                };
              }),
            );
            return yield* acp.start();
          }).pipe(
            // Not mapAcpToAdapterError: startup must surface the agent's own
            // failure text (Keychain -32603 data, "Authentication required…",
            // startup timeout step) instead of a generic wrapper message.
            Effect.mapError(
              (error) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/start",
                  detail: `Hermes session startup failed: ${hermesAcpFailureDetail(error)}`,
                  cause: error,
                }),
            ),
          );

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: hermesModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: HERMES_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            managed: managedConfig !== undefined,
            ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            assistantItemTurnIds: new Map(),
            lastPlanFingerprint: undefined,
            sessionUpdatesProcessed: 0,
            configuredModel: undefined,
            allowedModels: managedConfig ? mossManagedHermesModels(managedConfig.realm) : undefined,
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            lastTurnActivityAt: undefined,
            latestSessionCostUsd: undefined,
            activeTurnHasOutput: false,
            sessionConfigReady,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                // Any inbound ACP event proves the child is alive and making
                // progress; reset the idle-progress watchdog clock.
                ctx.lastTurnActivityAt = Date.now();
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    {
                      const turnId = resolveHermesAssistantItemTurnId(ctx, event.itemId);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId,
                          itemId: event.itemId,
                          lifecycle: "item.started",
                        }),
                      );
                    }
                    return;
                  case "AssistantItemCompleted":
                    {
                      const turnId = completeHermesAssistantItemTurnId(ctx, event.itemId);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId,
                          itemId: event.itemId,
                          lifecycle: "item.completed",
                        }),
                      );
                    }
                    return;
                  case "PlanUpdated":
                    if (ctx.activeTurnId && event.payload.plan.length > 0)
                      ctx.activeTurnHasOutput = true;
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    if (ctx.activeTurnId && event.toolCall.status === "completed")
                      ctx.activeTurnHasOutput = true;
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                    if (failedToolDetail !== undefined && ctx.activeTurnId !== undefined) {
                      ctx.activeTurnFailedToolDetail = failedToolDetail;
                    }
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    if (
                      ctx.activeTurnId &&
                      event.streamKind !== "reasoning_text" &&
                      event.text.trim()
                    )
                      ctx.activeTurnHasOutput = true;
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveHermesAssistantItemTurnId(ctx, event.itemId),
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "UsageUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    recordHermesSessionCost(ctx, event.cost);
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpTokenUsageEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        usage: event.usage,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.sessionUpdatesProcessed += 1;
                  }),
                ),
              ),
            ),
            // The drain's lifetime is the session's, not the caller's. Forking it
            // as a child of the fiber that called startSession killed it the moment
            // that fiber returned, so every session/update — assistant text, tool
            // calls, usage — was dropped and the transcript stayed empty.
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = nf;

          sessions.set(input.threadId, ctx);
          registeredCtx = ctx;
          sessionScopeTransferred = true;

          return { ctx, session, started, hermesModelSelection, sessionConfigReady };
        }).pipe(
          Effect.scoped,
          Effect.mapError((error) => normalizeHermesAdapterError(error, input.threadId)),
        ),
      );

      return Effect.gen(function* () {
        const { ctx, session, started, hermesModelSelection, sessionConfigReady } = yield* setup;
        // The replay wait deliberately runs without the per-thread lock. The
        // registered context lets stop/restart close the scope and release the
        // gate immediately instead of waiting for its hard cap.
        yield* ctx.acp.awaitLoadReplayReady.pipe(
          Effect.mapError((cause) =>
            ctx.stopped
              ? new ProviderAdapterSessionNotFoundError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                })
              : mapAcpToAdapterError(PROVIDER, input.threadId, "session/load", cause),
          ),
        );

        yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            if (ctx.stopped || sessions.get(input.threadId) !== ctx) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            yield* applyRequestedSessionConfiguration({
              runtime: ctx.acp,

              managed: ctx.managed,
              runtimeMode: input.runtimeMode,
              interactionMode: undefined,
              modelSelection: hermesModelSelection
                ? {
                    model: hermesModelSelection.model,
                  }
                : undefined,
              mapError: ({ cause, method }) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
            });
            ctx.configuredModel = hermesModelSelection?.model;
            // Hermes connects injected MCP servers asynchronously after
            // session/new. Wait for its tools/list handshake so the first user
            // prompt never runs without the Moss tool catalog; the gate is
            // bounded and never hard-blocks startup.
            yield* awaitAgentGatewayMcpStartupReady(ctx.gatewaySessionLease, PROVIDER);
            yield* Deferred.succeed(sessionConfigReady, undefined);
            ctx.sessionConfigReady = undefined;

            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: started.initializeResult },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "Hermes ACP session ready" },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
          }),
        );

        return session;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) || registeredCtx === undefined
            ? Effect.void
            : Effect.ignore(stopSessionInternal(registeredCtx)),
        ),
        Effect.mapError((error) => normalizeHermesAdapterError(error, input.threadId)),
      );
    };

    const sendTurn: HermesAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.await(ctx.sessionConfigReady);
        }
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const turnModelSelection = input.modelSelection;
        const model = turnModelSelection?.model ?? ctx.session.model;
        if (model !== undefined && ctx.allowedModels && !ctx.allowedModels.includes(model)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "The model is not available in this Moss realm.",
          });
        }
        const resolvedModel = model;
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
        yield* applyRequestedSessionConfiguration({
          runtime: ctx.acp,

          managed: ctx.managed,
          configuredModel: ctx.configuredModel,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode,
          modelSelection:
            model === undefined
              ? undefined
              : {
                  model,
                },
          mapError: ({ cause, method }) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          // No turnId: the notice is emitted before turn.started, so it belongs
          // to the session timeline rather than to an unannounced turn.
        });
        ctx.configuredModel = model;
        const promptParts: Array<Acp.ContentBlock> = [];
        const promptText = appendFileAttachmentsPromptBlock({
          text: input.input?.trim()
            ? withHermesPlanModePrompt({
                text: input.input.trim(),
                interactionMode,
              })
            : undefined,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        });
        if (promptText) {
          promptParts.push({
            type: "text",
            text: promptText,
          });
        }
        promptParts.push(
          ...(yield* loadProviderPromptImageBlocks({
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            provider: PROVIDER,
            method: "session/prompt",
            readFile: fileSystem.readFile,
          })),
        );

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const harnessPolicy = takeHermesMossHarnessPolicyTextPart(
          ctx,
          agentGatewayCredentials !== undefined,
        );
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }

        ctx.activeTurnId = turnId;
        ctx.activeTurnFailedToolDetail = undefined;
        ctx.activeTurnHasOutput = false;
        ctx.activeInteractionMode = interactionMode;
        ctx.lastPlanFingerprint = undefined;
        ctx.lastTurnActivityAt = Date.now();
        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: resolvedModel },
        });

        const runPrompt = ctx.acp.prompt({ prompt: promptParts }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                yield* waitForHermesQueuedTurnEventsDrained(ctx);
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!clearHermesActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeHermesActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                const detail = error.message;
                const nativeFailure =
                  "cause" in error &&
                  isRecord(error.cause) &&
                  isRecord(error.cause.data) &&
                  error.cause.data.hermesNativeContinuationInvalid === true;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso,
                  model: resolvedModel,
                  lastError: detail,
                  ...(nativeFailure ? { resumeCursor: null } : {}),
                };
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  ...(nativeFailure ? { raw: HERMES_NATIVE_FAILURE_RAW } : {}),
                  payload: {
                    state: "failed",
                    stopReason: null,
                    errorMessage: detail,
                    ...completedCost,
                  },
                });
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                yield* waitForHermesQueuedTurnEventsDrained(ctx);
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                const hasOutput = ctx.activeTurnHasOutput;
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!clearHermesActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeHermesActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                ctx.session = {
                  ...sessionWithoutLastError,
                  status: "ready",
                  updatedAt: yield* nowIso,
                  model: resolvedModel,
                };
                const completion = classifyHermesPromptTurnCompletion({
                  stopReason: result.stopReason,
                  hasOutput,
                  ...(failedToolDetail !== undefined ? { failedToolDetail } : {}),
                });
                if (completion.state === "failed")
                  ctx.session = {
                    ...ctx.session,
                    status: "error",
                    lastError: completion.errorMessage,
                    ...(!hasOutput ? { resumeCursor: null } : {}),
                  };
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  ...(completion.state === "failed" && !hasOutput
                    ? { raw: HERMES_NATIVE_FAILURE_RAW }
                    : {}),
                  payload: {
                    state: completion.state,
                    stopReason: result.stopReason ?? null,
                    ...(completion.errorMessage !== undefined
                      ? { errorMessage: completion.errorMessage }
                      : {}),
                    ...(result.usage ? { usage: result.usage } : {}),
                    ...completedCost,
                  },
                });
              }),
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (!clearHermesActiveTurn(ctx, turnId)) {
                return;
              }
              const completedCost = finalizeHermesActiveTurnCost(ctx);
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
              const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
              ctx.session = {
                ...sessionWithoutLastError,
                status: "ready",
                updatedAt: yield* nowIso,
                model: resolvedModel,
              };
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "cancelled",
                  stopReason: "cancelled",
                  ...completedCost,
                },
              });
            }),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(ctx.scope),
        );
        ctx.activePromptFiber = yield* runPrompt;

        // Backstop the forked prompt: if the child goes silent, fail the turn
        // instead of leaving it "Working" forever. Self-terminates when the
        // turn settles; pauses while a human approval is pending.
        yield* forkAcpTurnIdleWatchdog({
          idleTimeoutMs: HERMES_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: HERMES_TURN_WATCHDOG_INTERVAL_MS,
          scope: ctx.scope,
          isTurnActive: () => ctx.activeTurnId === turnId && !ctx.stopped,
          isAwaitingHuman: () => ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
          lastActivityAt: () => ctx.lastTurnActivityAt ?? Date.now(),
          touchActivity: () => {
            ctx.lastTurnActivityAt = Date.now();
          },
          onIdleTimeout: (idleMs) => failHermesTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: HermesAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== ctx.activeTurnId) {
          yield* Effect.logWarning("hermes.acp.stale_interrupt_ignored", {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: ctx.activeTurnId,
          });
          return;
        }
        const activeTurnId = turnId ?? ctx.activeTurnId;
        yield* withAgentGatewayTurnCancellation(
          ctx.gatewaySessionLease,
          activeTurnId,
          Effect.gen(function* () {
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            const activePromptFiber = ctx.activePromptFiber;
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
              ),
            );
            if (activePromptFiber) {
              yield* Fiber.interrupt(activePromptFiber);
            }
          }),
        );
      });

    const respondToRequest: HermesAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: HermesAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "hermes/ask_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: HermesAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: snapshotProviderTurns(ctx.turns) };
      });

    const rollbackThread: HermesAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: snapshotProviderTurns(ctx.turns) };
      });

    const stopSession: HermesAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: HermesAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: HermesAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const getComposerCapabilities: NonNullable<
      HermesAdapterShape["getComposerCapabilities"]
    > = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    const listModels: NonNullable<HermesAdapterShape["listModels"]> = (input) =>
      Effect.gen(function* () {
        const settings = resolveHermesRuntimeSettings(input, hermesSettings);
        const managed = readMossManagedHermesConfig(settings.environment);
        if ((managed !== undefined) !== (String(input.instanceId) === "hermes_moss"))
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "listModels",
            issue:
              "Managed Hermes discovery requires the reserved Moss instance and canonical configuration.",
          });
        if (managed)
          return {
            models: mossManagedHermesModels(managed.realm).map((slug) => ({
              slug,
              name: getMossManagedModelDefinition(slug)?.displayName ?? slug,
            })),
            source: "moss-managed-hermes",
            cached: false,
          } satisfies ProviderListModelsResult;
        const runtime = yield* makeHermesAcpRuntime({
          hermesSettings: settings,
          childProcessSpawner,
          cwd: serverConfig.cwd || serverConfig.homeDir,
          clientInfo: { name: "Moss", version: "0.0.0" },
        });
        const started = yield* runtime.start();
        const models = parseHermesAcpModels(started.sessionSetupResult);
        return { models, source: "hermes.acp", cached: false } satisfies ProviderListModelsResult;
      }).pipe(
        Effect.scoped,
        Effect.mapError((cause) =>
          cause instanceof ProviderAdapterRequestError
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "model/list",
                detail: "Failed to discover Hermes models.",
                cause,
              }),
        ),
      );

    const hermesForkTimeoutError = (method: string): ProviderAdapterRequestError =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Hermes ACP did not respond to ${method} within ${HERMES_ACP_FORK_TIMEOUT_MS / 1000}s.`,
      });

    const forkThread: NonNullable<HermesAdapterShape["forkThread"]> = (input) =>
      Effect.gen(function* () {
        const sourceCwd = resolveHermesSessionCwd(input.sourceCwd ?? input.cwd, serverConfig);
        const targetCwd = resolveHermesSessionCwd(input.cwd ?? input.sourceCwd, serverConfig);
        if (!sourceCwd || !targetCwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue: "A source and target cwd are required to fork a Hermes session.",
          });
        }

        const forkRuntime = (runtime: AcpSessionRuntimeShape) =>
          forkViaAcpRuntime({
            provider: PROVIDER,
            runtime,
            targetCwd,
            unsupportedIssue:
              "This Hermes ACP version does not advertise session/fork; Moss will rebuild the fork from its retained transcript.",
            requestTimeoutMs: HERMES_ACP_FORK_TIMEOUT_MS,
            timeoutError: hermesForkTimeoutError,
          });

        const activeSource = sessions.get(input.sourceThreadId);
        // Forking mid-turn would branch from incomplete in-flight state, so
        // let the retained-transcript fallback handle busy sources.
        if (activeSource?.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue:
              "The source Hermes session has a turn in flight; Moss will rebuild the fork from its retained transcript.",
          });
        }
        const forked = activeSource
          ? yield* forkRuntime(activeSource.acp)
          : yield* Effect.gen(function* () {
              const sourceSessionId = parseHermesResume(input.sourceResumeCursor)?.sessionId;
              if (!sourceSessionId) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "forkThread",
                  issue: "The source Hermes session has no resumable native cursor.",
                });
              }
              const providerHermesOptions = input.providerOptions?.hermes;
              const runtime = yield* makeHermesAcpRuntime({
                hermesSettings: yield* prepareRuntimeSettings(
                  resolveHermesRuntimeSettings(providerHermesOptions ?? {}, hermesSettings),
                  input.modelSelection?.instanceId,
                ),
                childProcessSpawner,
                cwd: sourceCwd,
                resumeSessionId: sourceSessionId,
                clientInfo: { name: "Moss Fork", version: "0.0.0" },
                startupTimeouts: HERMES_ACP_STARTUP_TIMEOUTS,
              });
              yield* runtime.start().pipe(
                Effect.timeoutOption(HERMES_ACP_FORK_TIMEOUT_MS),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(hermesForkTimeoutError("session/resume")),
                    onSome: Effect.succeed,
                  }),
                ),
              );
              return yield* forkRuntime(runtime);
            }).pipe(Effect.scoped);

        // Return only the resume cursor: ProviderService registers the binding under
        // a committed lifecycle lease and the target's first turn resumes it
        // there. Starting the runtime here would capture an undefined
        // lifecycle generation, orphaning the fork's approval requests.
        return {
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: HERMES_RESUME_VERSION,
            sessionId: forked.sessionId,
          },
        };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderAdapterRequestError ||
          cause instanceof ProviderAdapterProcessError ||
          cause instanceof ProviderAdapterSessionClosedError ||
          cause instanceof ProviderAdapterSessionNotFoundError ||
          cause instanceof ProviderAdapterValidationError
            ? cause
            : mapAcpToAdapterError(PROVIDER, input.sourceThreadId, "session/fork", cause),
        ),
      );

    const stopAll = () => settleConcurrentTeardowns(sessions.values(), stopSessionInternal);

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        conversationRollback: "restart-session",
        supportsRuntimeModelList: true,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      forkThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      getComposerCapabilities,
      listModels,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies HermesAdapterShape;
  });
}

export const HermesAdapterLive = Layer.effect(HermesAdapter, makeHermesAdapter({}));

export function makeHermesAdapterLive(
  hermesSettings: HermesAcpRuntimeSettings = {},
  options?: HermesAdapterLiveOptions,
) {
  return Layer.effect(HermesAdapter, makeHermesAdapter(hermesSettings, options));
}
