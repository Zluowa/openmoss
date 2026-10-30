/**
 * AcpAgentAdapterLive — one generic ACP adapter shared by the Kimi Code, MiniMax
 * Code, and ZCode drivers. Everything provider-specific lives in the
 * `AcpAgentSpec` table; this module owns session lifecycle, prompt dispatch,
 * approvals, and runtime-event projection on top of `AcpSessionRuntime`.
 *
 * @module AcpAgentAdapterLive
 */
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
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderAdapterShape,
} from "../Services/ProviderAdapter.ts";
import { KimiAdapter } from "../Services/KimiAdapter.ts";
import { MinimaxAdapter } from "../Services/MinimaxAdapter.ts";
import { ZcodeAdapter } from "../Services/ZcodeAdapter.ts";
import {
  acquireAgentGatewaySessionLease,
  awaitAgentGatewayMcpStartupReady,
  cancelAgentGatewayTurn,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import { snapshotProviderTurns } from "../snapshotProviderTurns.ts";
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
  clearAcpActiveTurn,
  finalizeAcpActiveTurnCost,
  forkAcpAdapterTurnIdleWatchdog,
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
  waitForAcpQueuedTurnEventsDrained,
  withAcpPlanModePrompt,
} from "../acp/AcpAdapterSessionSupport.ts";
import {
  type AcpAgentKind,
  type AcpAgentManagedConfig,
  type AcpAgentRuntimeSettings,
  type AcpAgentSpec,
  KIMI_ACP_AGENT_SPEC,
  MINIMAX_ACP_AGENT_SPEC,
  ZCODE_ACP_AGENT_SPEC,
} from "../acp/AcpAgentSpec.ts";
import {
  type AcpAgentModelSelection,
  acpAgentFailureDetail,
  acpAgentModelListResult,
  applyAcpAgentSessionConfiguration,
  makeAcpAgentRuntime,
  parseAcpAgentModels,
  prepareAcpAgentRuntimeSettings,
  resolveAcpAgentRuntimeSettings,
} from "../acp/AcpAgentSupport.ts";
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  isFormElicitationRequest,
} from "../acp/AcpElicitationSupport.ts";
import { forkViaAcpRuntime } from "../acp/acpFork.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
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
import { resolveAcpTurnIdleTimeoutMs } from "../acp/AcpTurnIdleWatchdog.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { MossPluginApprovalStore } from "../mossPluginRuntime.ts";

const ACP_AGENT_RESUME_VERSION = 1 as const;
// Forking a dead source session must first resume it, so the fork exchange
// gets a wider budget than plain requests.
const ACP_AGENT_FORK_TIMEOUT_MS = 30_000;
const ACP_AGENT_TURN_WATCHDOG_INTERVAL_MS = 15_000;
const ACP_AGENT_DEFAULT_TURN_IDLE_TIMEOUT_MS = 600_000;

export type AcpAgentAdapterShape<Kind extends AcpAgentKind> = Omit<
  ProviderAdapterShape<ProviderAdapterError>,
  "provider"
> & { readonly provider: Kind };

export interface AcpAgentAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly pluginApprovalStore?: MossPluginApprovalStore;
  /** Test seam: replaces the ACP child runtime factory. */
  readonly makeRuntime?: typeof makeAcpAgentRuntime;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface AcpAgentSessionContext {
  harnessPolicyDelivered?: boolean;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  readonly managed: AcpAgentManagedConfig | undefined;
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
  configuredModel: AcpAgentModelSelection | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnFailedToolDetail: string | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  lastTurnActivityAt: number | undefined;
  latestSessionCostUsd: number | undefined;
  // The runtime is registered before load replay settles so stop/restart can
  // close it without waiting for the replay hard cap. Turns wait here until
  // startup configuration has completed under the thread lock.
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAcpAgentResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ACP_AGENT_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function readReasoningEffort(options: unknown): string | undefined {
  return isRecord(options) && typeof options.reasoningEffort === "string"
    ? options.reasoningEffort
    : undefined;
}

function acpAgentModelSelection(
  selection: { readonly model: string; readonly options?: unknown } | undefined,
): AcpAgentModelSelection | undefined {
  if (!selection) return undefined;
  const reasoningEffort = readReasoningEffort(selection.options);
  return { model: selection.model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function resolveAssistantItemTurnId(
  ctx: AcpAgentSessionContext,
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

function completeAssistantItemTurnId(
  ctx: AcpAgentSessionContext,
  itemId: string,
): TurnId | undefined {
  const turnId = resolveAssistantItemTurnId(ctx, itemId);
  ctx.assistantItemTurnIds.delete(itemId);
  return turnId;
}

function normalizeAcpAgentAdapterError(
  provider: AcpAgentKind,
  error: unknown,
  threadId: ThreadId,
): ProviderAdapterError {
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
    provider,
    threadId,
    detail: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

function planModePromptPrefix(spec: AcpAgentSpec): string {
  return [
    `Moss ${spec.displayName} plan mode is active.`,
    "Do not implement or mutate files in this turn.",
    "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
    "When ready, create the final implementation plan.",
  ].join("\n");
}

export function makeAcpAgentAdapter<Kind extends AcpAgentKind>(
  spec: AcpAgentSpec<Kind>,
  defaultSettings: AcpAgentRuntimeSettings = {},
  options?: AcpAgentAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const PROVIDER = spec.kind;
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    // Optional so adapter tests can run without the gateway layer; when
    // present, every session gets the moss_* MCP tools.
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const makeRuntime = options?.makeRuntime ?? makeAcpAgentRuntime;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const turnIdleTimeoutMs = resolveAcpTurnIdleTimeoutMs({
      envVar: spec.turnIdleTimeoutEnvVar,
      defaultMs: ACP_AGENT_DEFAULT_TURN_IDLE_TIMEOUT_MS,
    });
    const planPromptPrefix = planModePromptPrefix(spec);

    const prepareRuntimeSettings = (
      settings: AcpAgentRuntimeSettings,
      instanceId: string | undefined,
      operation: "startSession" | "forkThread" | "listModels",
    ) =>
      prepareAcpAgentRuntimeSettings(spec, settings, instanceId, {
        materializeHome: operation !== "listModels",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation,
              issue: cause.message,
              cause,
            }),
        ),
      );

    const sessions = new Map<ThreadId, AcpAgentSessionContext>();
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

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
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

    const failTurnAsTimedOut = (ctx: AcpAgentSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (ctx.activeTurnId !== turnId) {
          return;
        }
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
        if (!clearAcpActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeAcpActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `${spec.displayName} stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({ id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning(`${PROVIDER}.acp.turn_idle_timeout`, {
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
      ctx: AcpAgentSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
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
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AcpAgentSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const waitForQueuedTurnEventsDrained = (ctx: AcpAgentSessionContext) =>
      waitForAcpQueuedTurnEventsDrained({
        sessionUpdatesEnqueuedCount: ctx.acp.sessionUpdatesEnqueuedCount,
        sessionUpdatesProcessed: () => ctx.sessionUpdatesProcessed,
        maxWaitMs: 2_000,
        pollMs: 10,
      });

    const stopSessionInternal = (ctx: AcpAgentSessionContext) =>
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

    const applySessionConfiguration = (input: {
      readonly ctx: AcpAgentSessionContext;
      readonly interactionMode: ProviderInteractionMode | undefined;
      readonly modelSelection: AcpAgentModelSelection | undefined;
    }) =>
      applyAcpAgentSessionConfiguration({
        spec,
        runtime: input.ctx.acp,
        runtimeMode: input.ctx.session.runtimeMode,
        interactionMode: input.interactionMode,
        modelSelection: input.modelSelection,
        configuredModel: input.ctx.configuredModel,
        managed: input.ctx.managed,
        mapError: ({ cause, method }) =>
          mapAcpToAdapterError(PROVIDER, input.ctx.threadId, method, cause),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (input.modelSelection) input.ctx.configuredModel = input.modelSelection;
          }),
        ),
      );

    const startSession: AcpAgentAdapterShape<Kind>["startSession"] = (input) => {
      let registeredCtx: AcpAgentSessionContext | undefined;
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
          const cwd = resolveAcpSessionCwd({
            inputCwd: input.cwd,
            serverCwd: serverConfig.cwd,
            homeDir: serverConfig.homeDir,
          });
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const modelSelection = acpAgentModelSelection(input.modelSelection);
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
          let ctx!: AcpAgentSessionContext;

          const resumeSessionId = parseAcpAgentResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const settings = yield* prepareRuntimeSettings(
            resolveAcpAgentRuntimeSettings(
              input.providerOptions?.[PROVIDER] ?? {},
              defaultSettings,
            ),
            input.providerInstanceId,
            "startSession",
          );
          const managed = settings.managed;
          if (managed && modelSelection && !managed.models.includes(modelSelection.model)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The model is not available in this Moss realm.",
            });
          }

          const acp = yield* makeRuntime({
            spec,
            settings,
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "Moss", version: "0.0.0" },
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
                  detail: acpAgentFailureDetail(spec, cause),
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
                yield* logNative(input.threadId, "session/request_permission", params);
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
                if (resolved === "cancel") {
                  return { outcome: { outcome: "cancelled" as const } };
                }
                const selectedOptionId = selectAcpPermissionOptionId(resolved, params.options);
                return {
                  outcome:
                    selectedOptionId === undefined
                      ? ({ outcome: "cancelled" } as const)
                      : ({ outcome: "selected" as const, optionId: selectedOptionId } as const),
                };
              }),
            );

            // Kimi Code and ZCode ask questions through form elicitations;
            // non-form requests are declined so a turn can never block on a
            // prompt Moss cannot render.
            yield* acp.handleElicitation((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/elicitation", params);
                if (!isFormElicitationRequest(params)) {
                  return { action: "decline" } satisfies Acp.CreateElicitationResponse;
                }
                const questions = elicitationQuestionsFromRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                pendingUserInputs.set(requestId, { answers });
                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { questions },
                  raw: { source: "acp.jsonrpc", method: "session/elicitation", payload: params },
                });
                const resolved = yield* Deferred.await(answers);
                pendingUserInputs.delete(requestId);
                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { answers: resolved },
                  raw: { source: "acp.jsonrpc", method: "session/elicitation", payload: params },
                });
                return elicitationResponseFromAnswers(params, resolved);
              }).pipe(
                Effect.catch(() =>
                  Effect.succeed({ action: "decline" } as Acp.CreateElicitationResponse),
                ),
              ),
            );
            return yield* acp.start();
          }).pipe(
            // Not mapAcpToAdapterError: startup must surface the agent's own
            // failure text ("Authentication required…", startup timeout step)
            // behind the classified sign-in/install hint.
            Effect.mapError(
              (error) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/start",
                  detail: `${spec.displayName} session startup failed: ${acpAgentFailureDetail(spec, error)}`,
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
            model: modelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: ACP_AGENT_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            managed,
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
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnFailedToolDetail: undefined,
            activeTurnHadAssistantContent: false,
            activeAssistantItemsWithContent: new Set(),
            activePromptFiber: undefined,
            lastTurnActivityAt: undefined,
            latestSessionCostUsd: undefined,
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
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveAssistantItemTurnId(ctx, event.itemId),
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: completeAssistantItemTurnId(ctx, event.itemId),
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    return;
                  case "ToolCallUpdated": {
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
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
                  }
                  case "ContentDelta":
                    if (
                      ctx.activeTurnId &&
                      event.streamKind !== "reasoning_text" &&
                      event.text.trim()
                    ) {
                      ctx.activeTurnHadAssistantContent = true;
                      if (event.itemId) ctx.activeAssistantItemsWithContent.add(event.itemId);
                    }
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveAssistantItemTurnId(ctx, event.itemId),
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "UsageUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    recordAcpSessionCost(ctx, event.cost);
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
            // The drain's lifetime is the session's, not the caller's: forking
            // it as a child of the startSession fiber would kill it the moment
            // that fiber returned and drop every session/update.
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = nf;

          sessions.set(input.threadId, ctx);
          registeredCtx = ctx;
          sessionScopeTransferred = true;

          return { ctx, session, started, modelSelection, sessionConfigReady };
        }).pipe(
          Effect.scoped,
          Effect.mapError((error) =>
            normalizeAcpAgentAdapterError(PROVIDER, error, input.threadId),
          ),
        ),
      );

      return Effect.gen(function* () {
        const { ctx, session, started, modelSelection, sessionConfigReady } = yield* setup;
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
            yield* applySessionConfiguration({ ctx, interactionMode: undefined, modelSelection });
            // Injected MCP servers connect asynchronously after session/new;
            // the bounded gate keeps the Moss tool catalog ahead of the first
            // prompt without hard-blocking startup.
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
              payload: { state: "ready", reason: `${spec.displayName} ACP session ready` },
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
        Effect.mapError((error) => normalizeAcpAgentAdapterError(PROVIDER, error, input.threadId)),
      );
    };

    const sendTurn: AcpAgentAdapterShape<Kind>["sendTurn"] = (input) =>
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
        const turnSelection = acpAgentModelSelection(input.modelSelection);
        const modelSelection =
          turnSelection ??
          ctx.configuredModel ??
          (ctx.session.model !== undefined ? { model: ctx.session.model } : undefined);
        const model = modelSelection?.model;
        if (model !== undefined && ctx.managed && !ctx.managed.models.includes(model)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "The model is not available in this Moss realm.",
          });
        }
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
        yield* applySessionConfiguration({ ctx, interactionMode, modelSelection });
        const promptParts: Array<Acp.ContentBlock> = [];
        const promptText = appendFileAttachmentsPromptBlock({
          text: input.input?.trim()
            ? withAcpPlanModePrompt({
                text: input.input.trim(),
                interactionMode,
                promptPrefix: planPromptPrefix,
              })
            : undefined,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        });
        if (promptText) {
          promptParts.push({ type: "text", text: promptText });
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
        const harnessPolicyState: MossHarnessPolicyDeliveryState = ctx;
        const harnessPolicy = takeMossHarnessPolicyTextPartForProviderSession(harnessPolicyState, {
          provider: PROVIDER,
          scopedGatewayConnectionAvailable: agentGatewayCredentials !== undefined,
        });
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }

        ctx.activeTurnId = turnId;
        ctx.activeTurnFailedToolDetail = undefined;
        ctx.activeTurnHadAssistantContent = false;
        ctx.activeAssistantItemsWithContent.clear();
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
          payload: { model },
        });

        const runPrompt = ctx.acp.prompt({ prompt: promptParts }).pipe(
          Effect.mapError(
            (error) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: acpAgentFailureDetail(spec, error),
                cause: error,
              }),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                yield* waitForQueuedTurnEventsDrained(ctx);
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                const detail = error.message;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso,
                  model,
                  lastError: detail,
                };
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
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
                yield* waitForQueuedTurnEventsDrained(ctx);
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                ctx.session = {
                  ...sessionWithoutLastError,
                  status: "ready",
                  updatedAt: yield* nowIso,
                  model,
                };
                const completion = classifyAcpPromptTurnCompletion({
                  stopReason: result.stopReason,
                  ...(failedToolDetail !== undefined ? { failedToolDetail } : {}),
                });
                if (completion.state === "failed") {
                  ctx.session = {
                    ...ctx.session,
                    status: "error",
                    lastError: completion.errorMessage,
                  };
                }
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
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
              if (!clearAcpActiveTurn(ctx, turnId)) {
                return;
              }
              const completedCost = finalizeAcpActiveTurnCost(ctx);
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
              const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
              ctx.session = {
                ...sessionWithoutLastError,
                status: "ready",
                updatedAt: yield* nowIso,
                model,
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
        yield* forkAcpAdapterTurnIdleWatchdog({
          context: ctx,
          turnId,
          idleTimeoutMs: turnIdleTimeoutMs,
          checkIntervalMs: ACP_AGENT_TURN_WATCHDOG_INTERVAL_MS,
          onIdleTimeout: (idleMs) => failTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: AcpAgentAdapterShape<Kind>["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== ctx.activeTurnId) {
          yield* Effect.logWarning(`${PROVIDER}.acp.stale_interrupt_ignored`, {
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

    const respondToRequest: AcpAgentAdapterShape<Kind>["respondToRequest"] = (
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

    const respondToUserInput: AcpAgentAdapterShape<Kind>["respondToUserInput"] = (
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
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: AcpAgentAdapterShape<Kind>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: snapshotProviderTurns(ctx.turns) };
      });

    const rollbackThread: AcpAgentAdapterShape<Kind>["rollbackThread"] = (threadId, numTurns) =>
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

    const stopSession: AcpAgentAdapterShape<Kind>["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: AcpAgentAdapterShape<Kind>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: AcpAgentAdapterShape<Kind>["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const getComposerCapabilities: NonNullable<
      AcpAgentAdapterShape<Kind>["getComposerCapabilities"]
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

    const listModels: NonNullable<AcpAgentAdapterShape<Kind>["listModels"]> = (input) =>
      Effect.gen(function* () {
        const settings = yield* prepareRuntimeSettings(
          resolveAcpAgentRuntimeSettings(input, defaultSettings),
          input.instanceId,
          "listModels",
        );
        if (settings.managed && spec.managed) {
          return spec.managed.listModels(settings.managed);
        }
        const runtime = yield* makeRuntime({
          spec,
          settings,
          childProcessSpawner,
          cwd: serverConfig.cwd || serverConfig.homeDir,
          clientInfo: { name: "Moss", version: "0.0.0" },
        });
        const started = yield* runtime.start();
        return acpAgentModelListResult(
          spec,
          parseAcpAgentModels(spec, started.sessionSetupResult),
        ) satisfies ProviderListModelsResult;
      }).pipe(
        Effect.scoped,
        Effect.mapError((cause) =>
          cause instanceof ProviderAdapterRequestError ||
          cause instanceof ProviderAdapterValidationError
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "model/list",
                detail: `Failed to discover ${spec.displayName} models: ${acpAgentFailureDetail(spec, cause)}`,
                cause,
              }),
        ),
      );

    const forkTimeoutError = (method: string): ProviderAdapterRequestError =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `${spec.displayName} ACP did not respond to ${method} within ${ACP_AGENT_FORK_TIMEOUT_MS / 1000}s.`,
      });

    const forkThread: NonNullable<AcpAgentAdapterShape<Kind>["forkThread"]> = (input) =>
      Effect.gen(function* () {
        const sourceCwd = resolveAcpSessionCwd({
          inputCwd: input.sourceCwd ?? input.cwd,
          serverCwd: serverConfig.cwd,
          homeDir: serverConfig.homeDir,
        });
        const targetCwd = resolveAcpSessionCwd({
          inputCwd: input.cwd ?? input.sourceCwd,
          serverCwd: serverConfig.cwd,
          homeDir: serverConfig.homeDir,
        });
        if (!sourceCwd || !targetCwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue: `A source and target cwd are required to fork a ${spec.displayName} session.`,
          });
        }

        const forkRuntime = (runtime: AcpSessionRuntimeShape) =>
          forkViaAcpRuntime({
            provider: PROVIDER,
            runtime,
            targetCwd,
            unsupportedIssue: `This ${spec.displayName} ACP version does not advertise session/fork; Moss will rebuild the fork from its retained transcript.`,
            requestTimeoutMs: ACP_AGENT_FORK_TIMEOUT_MS,
            timeoutError: forkTimeoutError,
          });

        const activeSource = sessions.get(input.sourceThreadId);
        // Forking mid-turn would branch from incomplete in-flight state, so
        // let the retained-transcript fallback handle busy sources.
        if (activeSource?.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue: `The source ${spec.displayName} session has a turn in flight; Moss will rebuild the fork from its retained transcript.`,
          });
        }
        const forked = activeSource
          ? yield* forkRuntime(activeSource.acp)
          : yield* Effect.gen(function* () {
              const sourceSessionId = parseAcpAgentResume(input.sourceResumeCursor)?.sessionId;
              if (!sourceSessionId) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "forkThread",
                  issue: `The source ${spec.displayName} session has no resumable native cursor.`,
                });
              }
              const runtime = yield* makeRuntime({
                spec,
                settings: yield* prepareRuntimeSettings(
                  resolveAcpAgentRuntimeSettings(
                    input.providerOptions?.[PROVIDER] ?? {},
                    defaultSettings,
                  ),
                  input.modelSelection?.instanceId,
                  "forkThread",
                ),
                childProcessSpawner,
                cwd: sourceCwd,
                resumeSessionId: sourceSessionId,
                clientInfo: { name: "Moss Fork", version: "0.0.0" },
              });
              yield* runtime.start().pipe(
                Effect.timeoutOption(ACP_AGENT_FORK_TIMEOUT_MS),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(forkTimeoutError("session/resume")),
                    onSome: Effect.succeed,
                  }),
                ),
              );
              return yield* forkRuntime(runtime);
            }).pipe(Effect.scoped);

        // Return only the resume cursor: ProviderService registers the binding
        // under a committed lifecycle lease and the target's first turn resumes
        // it there.
        return {
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: ACP_AGENT_RESUME_VERSION,
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
    } satisfies AcpAgentAdapterShape<Kind>;
  });
}

export function makeKimiAdapterLive(
  settings: AcpAgentRuntimeSettings = {},
  options?: AcpAgentAdapterLiveOptions,
) {
  return Layer.effect(KimiAdapter, makeAcpAgentAdapter(KIMI_ACP_AGENT_SPEC, settings, options));
}

export function makeMinimaxAdapterLive(
  settings: AcpAgentRuntimeSettings = {},
  options?: AcpAgentAdapterLiveOptions,
) {
  return Layer.effect(
    MinimaxAdapter,
    makeAcpAgentAdapter(MINIMAX_ACP_AGENT_SPEC, settings, options),
  );
}

export function makeZcodeAdapterLive(
  settings: AcpAgentRuntimeSettings = {},
  options?: AcpAgentAdapterLiveOptions,
) {
  return Layer.effect(ZcodeAdapter, makeAcpAgentAdapter(ZCODE_ACP_AGENT_SPEC, settings, options));
}
