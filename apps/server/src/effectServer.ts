import { ProjectionPendingInteractionRepositoryLive } from "./persistence/Layers/ProjectionPendingInteractions";
import http from "node:http";

import type { ServerSettingsError } from "@synara/contracts";
import {
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
  ServiceMap,
} from "effect";
import { HttpRouter } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { agentGatewayRouteLayer } from "./agentGateway/httpRoute";
import { AgentGatewayCredentials } from "./agentGateway/Services/AgentGatewayCredentials";
import { AutomationRunReactor } from "./automation/Services/AutomationRunReactor";
import { AutomationScheduler } from "./automation/Services/AutomationScheduler";
import { AutomationService } from "./automation/Services/AutomationService";
import { TodoService } from "./todo/Services/TodoService";
import { GuestShareService } from "./guestShare/Services/GuestShareService";
import {
  MossPhoneAccountService,
  type MossPhoneAccountServiceShape,
} from "./account/Services/MossPhoneAccountService";
import { MossCloudAccountService } from "./account/Services/MossCloudAccountService";
import { MossEnterpriseKeyAccount } from "./account/Services/MossEnterpriseKeyAccount";
import { retireMossByokSettings } from "./account/retiredMossByokCleanup";
import type { MossCloudAccountServiceShape } from "./account/Services/MossCloudAccountService";
import { startMossCloudAccountSessionMaintenance } from "./account/Layers/MossCloudAccountService";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState";
import { remoteAccessPolicyError, ServerConfig } from "./config";
import { resolveListeningPort } from "./startupAccess";
import { patchBunWebSocketCloseEventCompatibility } from "./bunWebSocketCompatibility";
import { makeEffectHttpRouteLayer } from "./http";
import { Keybindings } from "./keybindings";
import {
  ManagedAttachmentCleanup,
  type ManagedAttachmentCleanupShape,
} from "./managedAttachmentCleanup";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine";
import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "./orchestration/Services/OrchestrationReactor";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProjectionPendingInteractionRepository } from "./persistence/Services/ProjectionPendingInteractions";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor";
import { ThreadSnoozeReactor } from "./orchestration/Services/ThreadSnoozeReactor";
import {
  claimQuitResumeRecordAtStartup,
  resumeQuitInterruptedChats,
} from "./orchestration/quitResume";
import { reconcileRestartStuckTurns } from "./orchestration/startupTurnReconciliation";
import { ProviderSessionReaper } from "./provider/Services/ProviderSessionReaper";
import { ProviderRuntimeReconciler } from "./provider/Services/ProviderRuntimeReconciler";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { KeepAwakeService } from "./keepAwake";
import { ServerSettingsService } from "./serverSettings";
import { makeServerReadiness } from "./server/readiness";
import { makeServerShutdownController, type ServerShutdownController } from "./serverShutdown";
import { makeBoundedNodeHttpServer } from "./nodeHttpServer";
import { websocketRpcRouteLayer } from "./wsRpc";
import { recoverGitHandoffOperations } from "./gitHandoffOperations";
import { externalMcpRouteLayer } from "./externalMcp/httpRoute";
import { ExternalMcpGateway } from "./externalMcp/Services/ExternalMcpGateway";
import { ExternalMcpService } from "./externalMcp/Services/ExternalMcpService";
import { mcpConnectorsRouteLayer } from "./mcpConnectors/httpRoute";
import { McpConnectors } from "./mcpConnectors/Services/McpConnectors";

export interface ServerShape {
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError | ServerSettingsError,
    | Scope.Scope
    | ServerConfig
    | AgentGatewayCredentials
    | ExternalMcpGateway
    | ExternalMcpService
    | McpConnectors
    | FileSystem.FileSystem
    | Path.Path
    | Keybindings
    | KeepAwakeService
    | ManagedAttachmentCleanup
    | AutomationRunReactor
    | AutomationScheduler
    | AutomationService
    | TodoService
    | GuestShareService
    | MossPhoneAccountService
    | MossCloudAccountService
    | MossEnterpriseKeyAccount
    | ServerLifecycleEvents
    | OrchestrationEngineService
    | OrchestrationReactor
    | ProjectionPendingInteractionRepository
    | ProjectionSnapshotQuery
    | ProviderSessionReaper
    | ProviderRuntimeReconciler
    | ProviderService
    | ServerRuntimeStartup
    | ServerSettingsService
    | ThreadDeletionReactor
    | ThreadSnoozeReactor
    | SqlClient.SqlClient
  >;
  readonly stopSignal: Effect.Effect<void, never>;
}

export class Server extends ServiceMap.Service<Server, ServerShape>()("moss/effectServer/Server") {}

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const MOSS_CLOUD_ACCOUNT_STARTUP_RESTORE_TIMEOUT_MS = 5_000;
// Cloud restore runs in the background, but it must get a bounded opportunity
// to re-assert a persisted Global realm before phone startup claims CN.
export const MOSS_CLOUD_ACCOUNT_REALM_COORDINATION_TIMEOUT_MS = 5_000;
// Phone-session restore validates a durable bearer against the regional Auth
// service.  The first request can include a cold TLS/function start and is
// allowed to take longer than the legacy cloud-account maintenance probe.  A
// five-second shared deadline consistently classified healthy sessions as
// degraded before the Auth request's own 15-second transport deadline could
// complete.
export const MOSS_PHONE_ACCOUNT_STARTUP_RESTORE_TIMEOUT_MS = 15_000;
const MOSS_PHONE_ACCOUNT_STARTUP_RETRY_DELAYS_MS = [250, 750] as const;
const MOSS_PHONE_ACCOUNT_LATE_RETRY_DELAY_MS = 5_000;
// After the first late attempt the server keeps trying on a widening backoff
// for as long as it runs. A single late attempt left a signed-in user without
// the Moss gateway for the whole session when Auth was briefly unreachable at
// boot, and every turn then fell through to whatever personal login remained.
const MOSS_PHONE_ACCOUNT_LATE_RETRY_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000] as const;
const MOSS_PHONE_ACCOUNT_LATE_RETRY_INTERVAL_MS = 300_000;

export type MossAccountStartupRestorationState =
  | {
      readonly state: "ready";
      readonly code: null;
      readonly recoveryRequired: false;
    }
  | {
      readonly state: "degraded";
      readonly code: "phone_restore_timeout" | "phone_restore_failed";
      readonly recoveryRequired: true;
    };

const accountStartupReady = (): MossAccountStartupRestorationState => ({
  state: "ready",
  code: null,
  recoveryRequired: false,
});

const accountStartupDegraded = (
  code: "phone_restore_timeout" | "phone_restore_failed",
): MossAccountStartupRestorationState => ({ state: "degraded", code, recoveryRequired: true });

export function restoreMossAccountsOnStartup(
  input: {
    readonly mossCloudAccount: Pick<MossCloudAccountServiceShape, "restore"> &
      Partial<Pick<MossCloudAccountServiceShape, "getState">>;
    readonly mossPhoneAccount: Pick<MossPhoneAccountServiceShape, "getSession" | "getAccessToken"> &
      Partial<Pick<MossPhoneAccountServiceShape, "restoreSession">> &
      Partial<Pick<MossPhoneAccountServiceShape, "activateRealm">>;
  },
  timeoutMs = MOSS_PHONE_ACCOUNT_STARTUP_RESTORE_TIMEOUT_MS,
  options: {
    readonly onState?: (state: MossAccountStartupRestorationState) => Effect.Effect<void>;
    readonly retryDelaysMs?: ReadonlyArray<number>;
    readonly lateRetryDelayMs?: number;
    readonly lateRetryBackoffMs?: ReadonlyArray<number>;
    readonly lateRetryIntervalMs?: number;
  } = {},
): Effect.Effect<MossAccountStartupRestorationState, never, Scope.Scope> {
  return Effect.gen(function* () {
    const onState = options.onState ?? (() => Effect.void);
    const retryDelaysMs = options.retryDelaysMs ?? MOSS_PHONE_ACCOUNT_STARTUP_RETRY_DELAYS_MS;
    const lateRetryDelaysMs = [
      options.lateRetryDelayMs ?? MOSS_PHONE_ACCOUNT_LATE_RETRY_DELAY_MS,
      ...(options.lateRetryBackoffMs ?? MOSS_PHONE_ACCOUNT_LATE_RETRY_BACKOFF_MS),
    ];
    const lateRetryIntervalMs =
      options.lateRetryIntervalMs ?? MOSS_PHONE_ACCOUNT_LATE_RETRY_INTERVAL_MS;
    const cloudRestorationCompleted = yield* Deferred.make<void>();
    // Cloud account refresh is maintenance for an older account surface. It
    // must not delay a durable phone session from provisioning its managed
    // provider and admitting the user into the product.
    yield* input.mossCloudAccount.restore().pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logWarning("failed to restore Moss cloud account session", {
            code: error.code,
            message: error.message,
          }),
        onSuccess: () => Effect.void,
      }),
      Effect.ensuring(Deferred.succeed(cloudRestorationCompleted, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );

    // Track whether restoreSession actually validated a durable phone session.
    // Cold start without a session returns ready (so the product can admit the
    // user to login) but must NOT call activateRealm — that would log
    // authentication_required and skip the real reconcile that runs after login
    // via verifyPhoneLogin / a later successful restoreSession.
    const phoneSessionValidated = yield* Ref.make(false);

    const restorePhoneAccount = (
      retryIndex = 0,
    ): Effect.Effect<MossAccountStartupRestorationState> =>
      (input.mossPhoneAccount.restoreSession
        ? input.mossPhoneAccount.restoreSession().pipe(
            Effect.tap(() => Ref.set(phoneSessionValidated, true)),
            Effect.as(accountStartupReady()),
          )
        : input.mossPhoneAccount.activateRealm
          ? input.mossPhoneAccount.activateRealm({ realm: "cn" }).pipe(Effect.asVoid)
          : input.mossPhoneAccount
              .getSession()
              .pipe(
                Effect.flatMap((state) =>
                  state.authenticated
                    ? input.mossPhoneAccount.getAccessToken().pipe(Effect.asVoid)
                    : Effect.void,
                ),
              )
      ).pipe(
        Effect.as(accountStartupReady()),
        Effect.catch((error) => {
          if (error.code === "authentication_required" || error.code === "session_expired") {
            return Effect.succeed(accountStartupReady());
          }
          const retryDelayMs = retryDelaysMs[retryIndex];
          if (retryDelayMs !== undefined) {
            return Effect.logWarning("retrying Moss phone account restoration", {
              code: error.code,
              retryIndex: retryIndex + 1,
            }).pipe(
              Effect.andThen(Effect.sleep(Math.max(0, retryDelayMs))),
              Effect.andThen(restorePhoneAccount(retryIndex + 1)),
            );
          }
          return Effect.logWarning("failed to restore Moss phone account session", {
            code: error.code,
            message: error.message,
          }).pipe(Effect.as(accountStartupDegraded("phone_restore_failed")));
        }),
      );

    const reconcilePhoneModelGateway = Effect.gen(function* () {
      if (!input.mossPhoneAccount.restoreSession || !input.mossPhoneAccount.activateRealm) {
        return;
      }
      const validated = yield* Ref.get(phoneSessionValidated);
      if (!validated) {
        return;
      }
      yield* input.mossPhoneAccount
        .activateRealm({ realm: "cn" })
        // The account lifecycle semaphore is shared with logout and explicit
        // realm selection. Bound this maintenance fiber so a stalled catalog
        // cannot hold those user actions indefinitely.
        .pipe(Effect.timeoutOption(timeoutMs))
        .pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.logWarning("failed to reconcile Moss phone model gateway after startup", {
                code: error.code,
                message: error.message,
              }),
            onSuccess: (result) =>
              Option.isSome(result)
                ? Effect.void
                : Effect.logWarning(
                    "timed out reconciling Moss phone model gateway after startup",
                    {
                      timeoutMs,
                    },
                  ),
          }),
        );
    });

    const reconcilePhoneModelGatewayAfterCloud: Effect.Effect<void, never, Scope.Scope> =
      Effect.gen(function* () {
        const cloudGetState = input.mossCloudAccount.getState;
        if (!cloudGetState) {
          yield* reconcilePhoneModelGateway;
          return;
        }

        // The cloud lane is detached so account startup remains responsive. Do
        // not let its later Global restore lose ownership to the CN reconcile.
        const cloudCompleted = yield* Deferred.await(cloudRestorationCompleted).pipe(
          Effect.timeoutOption(MOSS_CLOUD_ACCOUNT_REALM_COORDINATION_TIMEOUT_MS),
        );
        if (Option.isNone(cloudCompleted)) {
          yield* Effect.logWarning(
            "deferred Moss phone model gateway reconciliation while cloud realm restore is pending",
            { timeoutMs: MOSS_CLOUD_ACCOUNT_REALM_COORDINATION_TIMEOUT_MS },
          );
          // Keep this maintenance-only retry in the server scope. It does not
          // affect startup readiness and runs exactly after cloud restore settles.
          yield* Deferred.await(cloudRestorationCompleted).pipe(
            Effect.andThen(reconcilePhoneModelGatewayAfterCloud),
            Effect.forkScoped,
          );
          return;
        }

        const cloudState = yield* cloudGetState().pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.catch((error) =>
            Effect.logWarning("failed to read Moss cloud realm state during phone reconciliation", {
              timeoutMs,
              message: error instanceof Error ? error.message : String(error),
            }).pipe(Effect.as(Option.none())),
          ),
        );
        if (Option.isNone(cloudState)) {
          yield* Effect.logWarning(
            "skipped Moss phone model gateway reconciliation because cloud realm state timed out",
            { timeoutMs },
          );
          return;
        }
        if (cloudState.value.activeRealm === "global") {
          yield* Effect.logDebug(
            "preserved selected Global cloud realm during phone startup reconciliation",
          );
          return;
        }
        yield* reconcilePhoneModelGateway;
      });

    const phoneRestorationCompleted = yield* Deferred.make<MossAccountStartupRestorationState>();
    yield* restorePhoneAccount().pipe(
      Effect.flatMap((state) =>
        Deferred.succeed(phoneRestorationCompleted, state).pipe(Effect.asVoid),
      ),
      Effect.forkScoped,
    );

    const initial = yield* Deferred.await(phoneRestorationCompleted).pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.map((result) =>
        Option.isSome(result) ? result.value : accountStartupDegraded("phone_restore_timeout"),
      ),
    );
    yield* onState(initial);
    // A durable, server-validated phone session is enough to admit the
    // account. Catalog lookup and managed-provider provisioning are a separate
    // maintenance action: run them in the server scope after local recovery so
    // a slow/rate-limited CN gateway cannot hold startup readiness hostage.
    // Skip when cold start had no phone session — verifyPhoneLogin reconciles
    // after login; a later successful restoreSession also triggers reconcile.
    if (initial.state === "ready") {
      yield* reconcilePhoneModelGatewayAfterCloud.pipe(Effect.forkScoped);
    }
    if (initial.state === "degraded") {
      if (initial.code === "phone_restore_timeout") {
        yield* Effect.logWarning("timed out restoring Moss phone account session", { timeoutMs });
      }
      // Degraded account recovery is observable but no longer a permanent
      // global command gate. Keep late attempts alive in the server scope and
      // promote account health once either the timed-out work or a delayed
      // retry obtains a server-validated token.
      const retryUntilReady = (
        attempt: number,
      ): Effect.Effect<MossAccountStartupRestorationState> =>
        Effect.sleep(Math.max(0, lateRetryDelaysMs[attempt] ?? lateRetryIntervalMs)).pipe(
          Effect.andThen(restorePhoneAccount()),
          Effect.flatMap((state) =>
            state.state === "ready" ? Effect.succeed(state) : retryUntilReady(attempt + 1),
          ),
        );
      const lateRestoration =
        initial.code === "phone_restore_timeout"
          ? Deferred.await(phoneRestorationCompleted).pipe(
              Effect.flatMap((state) =>
                state.state === "ready" ? Effect.succeed(state) : retryUntilReady(0),
              ),
            )
          : retryUntilReady(0);
      yield* lateRestoration.pipe(
        Effect.flatMap((state) =>
          state.state === "ready"
            ? onState(state).pipe(
                Effect.andThen(reconcilePhoneModelGatewayAfterCloud.pipe(Effect.forkScoped)),
              )
            : Effect.void,
        ),
        Effect.forkScoped,
      );
    }
    return initial;
  });
}

export function restoreMossCloudAccountOnStartup(
  mossCloudAccount: Pick<MossCloudAccountServiceShape, "restore">,
  timeoutMs = MOSS_CLOUD_ACCOUNT_STARTUP_RESTORE_TIMEOUT_MS,
  options: {
    readonly onLateCompletion?: () => Effect.Effect<void>;
  } = {},
): Effect.Effect<"completed" | "timed_out", never, Scope.Scope> {
  return Effect.gen(function* () {
    const restorationCompleted = yield* Deferred.make<void>();
    yield* mossCloudAccount.restore().pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logWarning("failed to restore Moss cloud account session", {
            code: error.code,
            message: error.message,
          }),
        onSuccess: () => Effect.void,
      }),
      Effect.ensuring(Deferred.succeed(restorationCompleted, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
    const result = yield* Deferred.await(restorationCompleted).pipe(
      Effect.timeoutOption(timeoutMs),
    );
    if (Option.isSome(result)) return "completed" as const;
    yield* Effect.logWarning("timed out restoring Moss cloud account session", { timeoutMs });
    if (options.onLateCompletion) {
      yield* Deferred.await(restorationCompleted).pipe(
        Effect.andThen(options.onLateCompletion()),
        Effect.forkScoped,
      );
    }
    return "timed_out" as const;
  });
}

export function completeServerStartupAdmission(input: {
  readonly awaitServerReady: Effect.Effect<void>;
  readonly markCommandReady: Effect.Effect<void>;
  readonly publishReady: Effect.Effect<void>;
}): Effect.Effect<void> {
  return input.awaitServerReady.pipe(
    Effect.andThen(input.markCommandReady),
    Effect.andThen(input.publishReady),
  );
}

export function closeServerRuntimePipeline(input: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "quiesce" | "drain" | "stop">;
  readonly providerService: Pick<ProviderServiceShape, "closeRuntimeEvents">;
  readonly managedAttachmentCleanup: Pick<ManagedAttachmentCleanupShape, "drain">;
  readonly subscriptionsScope: Scope.Closeable;
}): Effect.Effect<void> {
  return input.orchestrationEngine.quiesce.pipe(
    // Drain already-admitted commands while every subscriber is live. Provider
    // close then fences terminal runtime events into subscriber workers; scope
    // close drains those workers before the engine accepts its final stop.
    Effect.andThen(input.orchestrationEngine.drain),
    Effect.andThen(input.providerService.closeRuntimeEvents),
    Effect.andThen(Scope.close(input.subscriptionsScope, Exit.void)),
    Effect.andThen(input.managedAttachmentCleanup.drain),
    Effect.andThen(input.orchestrationEngine.stop),
  );
}

/**
 * Starts the subscriber pipeline in the order restart recovery depends on.
 *
 * The orchestration reactor starts first: runtime ingestion replays the
 * provider events the previous process journaled but never ingested, so a turn
 * whose terminal event reached the journal completes normally instead of being
 * reported as interrupted. Restart reconciliation then settles the turns whose
 * runtimes died with that process. The remaining reactors start last, because
 * their first pass reads thread state (a heartbeat automation skips a target
 * thread with an active turn, the runtime reconciler settles stale running
 * turns) and a restart-orphaned turn still reads as running until
 * reconciliation settles it.
 */
export function startServerRuntimePipeline<R>(input: {
  readonly orchestrationReactor: Pick<
    OrchestrationReactorShape,
    "start" | "reconcileSettledOpenTurns"
  >;
  readonly reconcileRestartStuckTurns: Effect.Effect<void, never, R>;
  readonly reactors: ReadonlyArray<{
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }>;
  readonly subscriptionsScope: Scope.Scope;
}): Effect.Effect<void, never, R> {
  return Effect.gen(function* () {
    yield* Scope.provide(input.orchestrationReactor.start, input.subscriptionsScope);
    yield* input.reconcileRestartStuckTurns;
    // The reconciliation above terminalizes durable turn projections without a
    // provider terminal event. Remove their replay-ledger rows now so the next
    // process start cannot replay state-dependent commands against the terminal
    // projection.
    yield* input.orchestrationReactor.reconcileSettledOpenTurns;
    for (const reactor of input.reactors) {
      yield* Scope.provide(reactor.start(), input.subscriptionsScope);
    }
  });
}

export const createEffectServer = Effect.fn(function* (
  shutdownController: ServerShutdownController,
) {
  const config = yield* ServerConfig;
  const remotePolicyError = remoteAccessPolicyError(config);
  if (remotePolicyError) {
    return yield* new ServerLifecycleError({
      operation: "validateRemoteAccessPolicy",
      cause: new Error(remotePolicyError),
    });
  }
  const agentGatewayCredentials = yield* AgentGatewayCredentials;
  const automationRunReactor = yield* AutomationRunReactor;
  const automationScheduler = yield* AutomationScheduler;
  const mossPhoneAccount = yield* MossPhoneAccountService;
  const mossCloudAccount = yield* MossCloudAccountService;
  const mossEnterpriseKey = yield* MossEnterpriseKeyAccount;
  const keybindings = yield* Keybindings;
  const managedAttachmentCleanup = yield* ManagedAttachmentCleanup;
  const lifecycleEvents = yield* ServerLifecycleEvents;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const orchestrationReactor = yield* OrchestrationReactor;
  const providerService = yield* ProviderService;
  const providerSessionReaper = yield* ProviderSessionReaper;
  const providerRuntimeReconciler = yield* ProviderRuntimeReconciler;
  const runtimeStartup = yield* ServerRuntimeStartup;
  const serverSettings = yield* ServerSettingsService;
  const keepAwake = yield* KeepAwakeService;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const threadSnoozeReactor = yield* ThreadSnoozeReactor;
  const readiness = yield* makeServerReadiness;

  // Start the runtime before serving config snapshots. This both performs the
  // startup sync and attaches the file watcher; calling only the sync helper
  // leaves live edits invisible until the next server restart.
  yield* keybindings.start.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to start keybindings runtime on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );
  yield* serverSettings.start;
  yield* readiness.markPushBusReady;
  yield* readiness.markKeybindingsReady;

  let nodeServer: http.Server | null = null;
  patchBunWebSocketCloseEventCompatibility();
  // Keep embedded/test callers safe if they construct ServerConfig without
  // passing through the CLI's loopback-default resolution.
  const listenOptions = { host: config.host ?? "127.0.0.1", port: config.port };
  const httpServer = yield* makeBoundedNodeHttpServer(() => {
    nodeServer = http.createServer();
    return nodeServer;
  }, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );

  const routesLayer = Layer.mergeAll(
    makeEffectHttpRouteLayer(readiness, shutdownController),
    websocketRpcRouteLayer,
    agentGatewayRouteLayer,
    externalMcpRouteLayer,
    mcpConnectorsRouteLayer,
  );
  const httpApp = yield* HttpRouter.toHttpEffect(routesLayer);
  yield* httpServer
    .serve(httpApp)
    .pipe(
      Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerServe", cause })),
    );

  const listeningPort = resolveListeningPort(
    (nodeServer as http.Server | null)?.address() ?? null,
    config.port,
  );
  agentGatewayCredentials.setListeningPort(listeningPort);
  yield* persistServerRuntimeState({
    path: config.serverRuntimeStatePath,
    state: makePersistedServerRuntimeState({
      config,
      port: listeningPort,
    }),
  }).pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "persistServerRuntimeState", cause }),
    ),
  );
  yield* Effect.addFinalizer(() => clearPersistedServerRuntimeState(config.serverRuntimeStatePath));
  yield* readiness.markHttpListening;

  // The health route is now listening before account recovery can time out, so
  // a wedged credential store remains diagnosable instead of freezing startup
  // behind an unreachable health endpoint.
  yield* restoreMossAccountsOnStartup(
    {
      mossCloudAccount,
      mossPhoneAccount,
    },
    MOSS_PHONE_ACCOUNT_STARTUP_RESTORE_TIMEOUT_MS,
    {
      onState: (state) =>
        state.state === "ready"
          ? readiness.markAccountStartupReady
          : readiness.markAccountStartupDegraded(state.code),
    },
  );
  yield* retireMossByokSettings(serverSettings).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to remove the retired Moss Key provider", { error }),
    ),
  );
  // An enterprise key needs no Auth refresh; reconcile it in the background so
  // a slow mainland gateway never holds startup readiness.
  yield* mossEnterpriseKey.restore().pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to restore the Moss enterprise key", {
        code: error.code,
        message: error.message,
      }),
    ),
    Effect.forkScoped,
  );

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() =>
    closeServerRuntimePipeline({
      orchestrationEngine,
      providerService,
      managedAttachmentCleanup,
      subscriptionsScope,
    }),
  );
  yield* Scope.provide(
    startMossCloudAccountSessionMaintenance(mossCloudAccount),
    subscriptionsScope,
  );
  yield* startServerRuntimePipeline({
    orchestrationReactor,
    // Heal turns orphaned by the previous process exit (their in-memory runtimes
    // died, so they can never complete on their own) before clients can observe
    // the stale "Working" state.
    reconcileRestartStuckTurns: reconcileRestartStuckTurns.pipe(
      Effect.provide(ProjectionPendingInteractionRepositoryLive),
    ),
    reactors: [
      automationScheduler,
      automationRunReactor,
      threadDeletionReactor,
      threadSnoozeReactor,
      providerSessionReaper,
      providerRuntimeReconciler,
      { start: () => keepAwake.start },
    ],
    subscriptionsScope,
  });
  yield* readiness.markOrchestrationSubscriptionsReady;
  yield* readiness.markTerminalSubscriptionsReady;
  yield* recoverGitHandoffOperations((command) => orchestrationEngine.dispatch(command)).pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "recoverGitHandoffOperations", cause }),
    ),
  );
  // Claim the previous quit's "Resume chats automatically" record while no
  // command (and so no new quit) can run yet; a missing record costs one stat.
  const quitResumeRecord = yield* claimQuitResumeRecordAtStartup;
  yield* runtimeStartup.markCommandReady;
  // The recorded chats get their continuation turn now that the orphaned turns
  // above are settled. Forked so the (rare) dispatch work never delays readiness.
  yield* resumeQuitInterruptedChats(quitResumeRecord).pipe(Effect.forkIn(subscriptionsScope));

  yield* lifecycleEvents.publish({
    type: "welcome",
    payload: {
      cwd: config.cwd,
      homeDir: config.homeDir,
      chatWorkspaceRoot: config.chatWorkspaceRoot,
      studioWorkspaceRoot: config.studioWorkspaceRoot,
      groupsWorkspaceRoot: config.groupsWorkspaceRoot,
      projectName: config.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? config.cwd,
    },
  });
  const completeStartupAdmission = completeServerStartupAdmission({
    awaitServerReady: readiness.awaitServerReady,
    markCommandReady: runtimeStartup.markCommandReady,
    publishReady: Effect.suspend(() =>
      lifecycleEvents
        .publish({
          type: "ready",
          payload: { at: new Date().toISOString() },
        })
        .pipe(Effect.asVoid),
    ),
  });
  const readinessSnapshot = yield* readiness.getSnapshot;
  if (readinessSnapshot.startupReady) {
    yield* completeStartupAdmission;
  } else {
    // Account degradation is published in health but has completed the bounded
    // startup gate, so unrelated/local providers remain usable. Account-owned
    // operations still validate their live credential at their own boundary.
    yield* completeStartupAdmission.pipe(Effect.forkScoped);
  }

  if (!nodeServer) {
    return yield* new ServerLifecycleError({ operation: "httpServerListen" });
  }
  return nodeServer as http.Server;
});

export const ServerLive = Layer.effect(
  Server,
  Effect.gen(function* () {
    const shutdownController = yield* makeServerShutdownController();
    return {
      start: createEffectServer(shutdownController) as ServerShape["start"],
      stopSignal: shutdownController.stopSignal,
    } satisfies ServerShape;
  }),
);
