import { Deferred, Effect } from "effect";

export interface ServerReadinessSnapshot {
  readonly httpListening: boolean;
  readonly pushBusReady: boolean;
  readonly keybindingsReady: boolean;
  readonly terminalSubscriptionsReady: boolean;
  readonly orchestrationSubscriptionsReady: boolean;
  readonly accountStartupState: "pending" | "ready" | "degraded";
  readonly accountStartupCode: "phone_restore_timeout" | "phone_restore_failed" | null;
  readonly accountRecoveryRequired: boolean;
  readonly startupReady: boolean;
}

export interface ServerReadiness {
  readonly awaitServerReady: Effect.Effect<void>;
  readonly markHttpListening: Effect.Effect<void>;
  readonly markPushBusReady: Effect.Effect<void>;
  readonly markKeybindingsReady: Effect.Effect<void>;
  readonly markTerminalSubscriptionsReady: Effect.Effect<void>;
  readonly markOrchestrationSubscriptionsReady: Effect.Effect<void>;
  readonly markAccountStartupReady: Effect.Effect<void>;
  readonly markAccountStartupDegraded: (
    code: "phone_restore_timeout" | "phone_restore_failed",
  ) => Effect.Effect<void>;
  readonly getSnapshot: Effect.Effect<ServerReadinessSnapshot>;
}

export const makeServerReadiness = Effect.gen(function* () {
  const httpListening = yield* Deferred.make<void>();
  const pushBusReady = yield* Deferred.make<void>();
  const keybindingsReady = yield* Deferred.make<void>();
  const terminalSubscriptionsReady = yield* Deferred.make<void>();
  const orchestrationSubscriptionsReady = yield* Deferred.make<void>();
  const accountStartupReady = yield* Deferred.make<void>();
  const status = {
    httpListening: false,
    pushBusReady: false,
    keybindingsReady: false,
    terminalSubscriptionsReady: false,
    orchestrationSubscriptionsReady: false,
    accountStartupState: "pending" as "pending" | "ready" | "degraded",
    accountStartupCode: null as "phone_restore_timeout" | "phone_restore_failed" | null,
    accountRecoveryRequired: false,
  };

  type ReadyFlag =
    | "httpListening"
    | "pushBusReady"
    | "keybindingsReady"
    | "terminalSubscriptionsReady"
    | "orchestrationSubscriptionsReady";

  const complete = (deferred: Deferred.Deferred<void>, key: ReadyFlag) =>
    Effect.gen(function* () {
      status[key] = true;
      yield* Deferred.succeed(deferred, undefined);
    }).pipe(Effect.asVoid, Effect.orDie);

  return {
    awaitServerReady: Effect.all([
      Deferred.await(httpListening),
      Deferred.await(pushBusReady),
      Deferred.await(keybindingsReady),
      Deferred.await(terminalSubscriptionsReady),
      Deferred.await(orchestrationSubscriptionsReady),
      Deferred.await(accountStartupReady),
    ]).pipe(Effect.asVoid),
    markHttpListening: complete(httpListening, "httpListening"),
    markPushBusReady: complete(pushBusReady, "pushBusReady"),
    markKeybindingsReady: complete(keybindingsReady, "keybindingsReady"),
    markTerminalSubscriptionsReady: complete(
      terminalSubscriptionsReady,
      "terminalSubscriptionsReady",
    ),
    markOrchestrationSubscriptionsReady: complete(
      orchestrationSubscriptionsReady,
      "orchestrationSubscriptionsReady",
    ),
    markAccountStartupReady: Effect.gen(function* () {
      status.accountStartupState = "ready";
      status.accountStartupCode = null;
      status.accountRecoveryRequired = false;
      yield* Deferred.succeed(accountStartupReady, undefined);
    }).pipe(Effect.asVoid, Effect.orDie),
    markAccountStartupDegraded: (code) =>
      Effect.gen(function* () {
        if (status.accountStartupState === "ready") return;
        status.accountStartupState = "degraded";
        status.accountStartupCode = code;
        status.accountRecoveryRequired = true;
        yield* Deferred.succeed(accountStartupReady, undefined);
      }).pipe(Effect.asVoid, Effect.orDie),
    getSnapshot: Effect.sync(() => ({
      ...status,
      startupReady:
        status.httpListening &&
        status.pushBusReady &&
        status.keybindingsReady &&
        status.accountStartupState !== "pending" &&
        status.terminalSubscriptionsReady &&
        status.orchestrationSubscriptionsReady,
    })),
  } satisfies ServerReadiness;
});
