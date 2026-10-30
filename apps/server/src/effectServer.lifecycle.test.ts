import { Deferred, Effect, Exit, Scope, Semaphore } from "effect";
import { describe, expect, it } from "vitest";

import { MossAccountServiceError } from "./account/mossAccountErrors";
import {
  closeServerRuntimePipeline,
  completeServerStartupAdmission,
  MOSS_CLOUD_ACCOUNT_STARTUP_RESTORE_TIMEOUT_MS,
  MOSS_PHONE_ACCOUNT_STARTUP_RESTORE_TIMEOUT_MS,
  restoreMossAccountsOnStartup,
  restoreMossCloudAccountOnStartup,
  startServerRuntimePipeline,
} from "./effectServer.ts";
import { makeServerReadiness } from "./server/readiness";

describe("Moss account startup restoration", () => {
  it("gives phone Auth cold starts more time than legacy cloud maintenance", () => {
    expect(MOSS_CLOUD_ACCOUNT_STARTUP_RESTORE_TIMEOUT_MS).toBe(5_000);
    expect(MOSS_PHONE_ACCOUNT_STARTUP_RESTORE_TIMEOUT_MS).toBe(15_000);
    expect(MOSS_PHONE_ACCOUNT_STARTUP_RESTORE_TIMEOUT_MS).toBeGreaterThan(
      MOSS_CLOUD_ACCOUNT_STARTUP_RESTORE_TIMEOUT_MS,
    );
  });

  it("admits unrelated work after timeout and promotes account health when slow phone restoration succeeds", async () => {
    const releasePhone = Deferred.makeUnsafe<void>();
    const accountReady = Deferred.makeUnsafe<void>();
    const readiness = await Effect.runPromise(makeServerReadiness);
    await Effect.runPromise(
      Effect.all([
        readiness.markHttpListening,
        readiness.markPushBusReady,
        readiness.markKeybindingsReady,
        readiness.markTerminalSubscriptionsReady,
        readiness.markOrchestrationSubscriptionsReady,
      ]),
    );

    const restorationScope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const initial = await Effect.runPromise(
        Scope.provide(
          restoreMossAccountsOnStartup(
            {
              mossCloudAccount: {
                restore: () => Effect.void,
              },
              mossPhoneAccount: {
                getSession: () => Deferred.await(releasePhone).pipe(Effect.as({} as never)),
                getAccessToken: () => Effect.succeed("unused-token"),
              },
            },
            5,
            {
              onState: (state) =>
                state.state === "ready"
                  ? readiness.markAccountStartupReady.pipe(
                      Effect.andThen(Deferred.succeed(accountReady, undefined)),
                      Effect.asVoid,
                    )
                  : readiness.markAccountStartupDegraded(state.code),
            },
          ),
          restorationScope,
        ),
      );

      expect(initial).toEqual({
        state: "degraded",
        code: "phone_restore_timeout",
        recoveryRequired: true,
      });
      expect(await Effect.runPromise(readiness.getSnapshot)).toMatchObject({
        startupReady: true,
        accountStartupState: "degraded",
        accountStartupCode: "phone_restore_timeout",
        accountRecoveryRequired: true,
      });

      await Effect.runPromise(Deferred.succeed(releasePhone, undefined));
      await Effect.runPromise(Deferred.await(accountReady));

      expect(await Effect.runPromise(readiness.getSnapshot)).toMatchObject({
        startupReady: true,
        accountStartupState: "ready",
        accountStartupCode: null,
        accountRecoveryRequired: false,
      });
    } finally {
      await Effect.runPromise(Scope.close(restorationScope, Exit.void));
    }
  });

  it("does not let a slow cloud refresh block a locally restored phone session", async () => {
    const releaseCloud = Deferred.makeUnsafe<void>();
    let phoneRestoreCompleted = false;
    const initial = await Effect.runPromise(
      Effect.scoped(
        restoreMossAccountsOnStartup(
          {
            mossCloudAccount: {
              restore: () => Deferred.await(releaseCloud),
            },
            mossPhoneAccount: {
              getSession: () =>
                Effect.sync(() => {
                  phoneRestoreCompleted = true;
                  return {} as never;
                }),
              getAccessToken: () => Effect.succeed("unused-token"),
            },
          },
          5,
        ),
      ),
    );

    expect(phoneRestoreCompleted).toBe(true);
    expect(initial).toEqual({ state: "ready", code: null, recoveryRequired: false });
  });

  it("skips CN gateway reconcile on cold start without a phone session (login path reconciles later)", async () => {
    let activateCalls = 0;
    const initial = await Effect.runPromise(
      Effect.scoped(
        restoreMossAccountsOnStartup(
          {
            mossCloudAccount: { restore: () => Effect.void },
            mossPhoneAccount: {
              restoreSession: () =>
                Effect.fail(
                  new MossAccountServiceError({
                    code: "authentication_required",
                    message: "no phone session",
                  }),
                ),
              activateRealm: () =>
                Effect.sync(() => {
                  activateCalls += 1;
                  return { activeRealm: "cn" } as never;
                }),
              getSession: () => Effect.succeed({ authenticated: false } as never),
              getAccessToken: () =>
                Effect.fail(
                  new MossAccountServiceError({
                    code: "authentication_required",
                    message: "no phone session",
                  }),
                ),
            },
          },
          50,
        ),
      ),
    );

    expect(initial).toEqual({ state: "ready", code: null, recoveryRequired: false });
    // Allow any mistakenly forked reconcile fiber a turn to run.
    await Effect.runPromise(Effect.sleep(20));
    expect(activateCalls).toBe(0);
  });

  it("admits a locally validated phone session while CN gateway reconciliation runs in the background", async () => {
    const releaseGateway = Deferred.makeUnsafe<void>();
    const gatewayStarted = Deferred.makeUnsafe<void>();
    let gatewayReconciliationStarted = false;
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const initial = await Effect.runPromise(
        Scope.provide(
          restoreMossAccountsOnStartup(
            {
              mossCloudAccount: { restore: () => Effect.void },
              mossPhoneAccount: {
                restoreSession: () => Effect.void,
                activateRealm: (_input) =>
                  Effect.sync(() => {
                    gatewayReconciliationStarted = true;
                    return { activeRealm: "cn" } as never;
                  }).pipe(
                    Effect.andThen(Deferred.succeed(gatewayStarted, undefined)),
                    Effect.andThen(Deferred.await(releaseGateway)),
                    Effect.as({ activeRealm: "cn" as const }),
                  ),
                getSession: () => Effect.succeed({} as never),
                getAccessToken: () => Effect.succeed("unused-token"),
              },
            },
            250,
          ),
          scope,
        ),
      );

      expect(initial).toEqual({ state: "ready", code: null, recoveryRequired: false });
      await Effect.runPromise(Deferred.await(gatewayStarted));
      expect(gatewayReconciliationStarted).toBe(true);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("interrupts a timed-out CN gateway reconciliation so logout can proceed", async () => {
    const reconciliationStarted = Deferred.makeUnsafe<void>();
    const reconciliationInterrupted = Deferred.makeUnsafe<void>();
    const lifecycleSemaphore = Semaphore.makeUnsafe(1);
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const initial = await Effect.runPromise(
        Scope.provide(
          restoreMossAccountsOnStartup(
            {
              mossCloudAccount: { restore: () => Effect.void },
              mossPhoneAccount: {
                restoreSession: () => Effect.void,
                activateRealm: () =>
                  lifecycleSemaphore.withPermits(1)(
                    Deferred.succeed(reconciliationStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(Deferred.succeed(reconciliationInterrupted, undefined)),
                    ),
                  ),
                getSession: () => Effect.succeed({} as never),
                getAccessToken: () => Effect.succeed("unused-token"),
              },
            },
            250,
          ),
          scope,
        ),
      );

      expect(initial).toEqual({ state: "ready", code: null, recoveryRequired: false });
      await Effect.runPromise(Deferred.await(reconciliationStarted));
      await Effect.runPromise(Deferred.await(reconciliationInterrupted));

      // This is the logout-equivalent assertion: a second lifecycle operation
      // can acquire the same semaphore after timeout interruption.
      await Effect.runPromise(lifecycleSemaphore.withPermits(1)(Effect.void));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("keeps startup ready when post-restore CN gateway reconciliation is rate limited", async () => {
    const reconciliationStarted = Deferred.makeUnsafe<void>();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const initial = await Effect.runPromise(
        Scope.provide(
          restoreMossAccountsOnStartup(
            {
              mossCloudAccount: { restore: () => Effect.void },
              mossPhoneAccount: {
                restoreSession: () => Effect.void,
                activateRealm: () =>
                  Deferred.succeed(reconciliationStarted, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new MossAccountServiceError({
                          code: "authentication_service_unavailable",
                          message: "CN model gateway returned HTTP 429",
                        }),
                      ),
                    ),
                  ),
                getSession: () => Effect.succeed({} as never),
                getAccessToken: () => Effect.succeed("unused-token"),
              },
            },
            25,
          ),
          scope,
        ),
      );

      expect(initial).toEqual({
        state: "ready",
        code: null,
        recoveryRequired: false,
      });
      await Effect.runPromise(Deferred.await(reconciliationStarted));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("retries a fast transient phone restoration and validates its server-only token", async () => {
    let attempts = 0;
    let tokenChecks = 0;
    const result = await Effect.runPromise(
      Effect.scoped(
        restoreMossAccountsOnStartup(
          {
            mossCloudAccount: { restore: () => Effect.void },
            mossPhoneAccount: {
              getSession: () =>
                Effect.suspend(() => {
                  attempts += 1;
                  if (attempts === 1) {
                    return Effect.fail(
                      new MossAccountServiceError({
                        code: "authentication_service_unavailable",
                        message: "temporary fixture",
                      }),
                    );
                  }
                  return Effect.succeed({ authenticated: true } as never);
                }),
              getAccessToken: () =>
                Effect.sync(() => {
                  tokenChecks += 1;
                  return "server-only-token";
                }),
            },
          },
          50,
          { retryDelaysMs: [0] },
        ),
      ),
    );

    expect(result).toEqual({ state: "ready", code: null, recoveryRequired: false });
    expect(attempts).toBe(2);
    expect(tokenChecks).toBe(1);
  });

  it("reclaims the managed CN realm when a phone session survives a competing cloud restore", async () => {
    const activated: string[] = [];
    let sessionChecks = 0;
    let tokenChecks = 0;
    const result = await Effect.runPromise(
      Effect.scoped(
        restoreMossAccountsOnStartup(
          {
            // The cloud restore is intentionally concurrent; the phone realm
            // must become authoritative once its durable session is restored.
            mossCloudAccount: { restore: () => Effect.void },
            mossPhoneAccount: {
              getSession: () =>
                Effect.sync(() => {
                  sessionChecks += 1;
                  return { authenticated: true } as never;
                }),
              getAccessToken: () =>
                Effect.sync(() => {
                  tokenChecks += 1;
                  return "server-only-token";
                }),
              activateRealm: (input) =>
                Effect.sync(() => {
                  activated.push(input?.realm ?? "unset");
                  return { activeRealm: "cn" } as never;
                }),
            },
          },
          50,
        ),
      ),
    );

    expect(result).toEqual({ state: "ready", code: null, recoveryRequired: false });
    expect(activated).toEqual(["cn"]);
    expect(sessionChecks).toBe(0);
    expect(tokenChecks).toBe(0);
  });

  it("preserves a selected Global cloud realm when phone startup reconciliation races restore", async () => {
    const releaseCloud = Deferred.makeUnsafe<void>();
    const activated: string[] = [];
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const initial = await Effect.runPromise(
        Scope.provide(
          restoreMossAccountsOnStartup(
            {
              mossCloudAccount: {
                restore: () => Deferred.await(releaseCloud),
                getState: () => Effect.succeed({ activeRealm: "global" } as never),
              },
              mossPhoneAccount: {
                restoreSession: () => Effect.void,
                activateRealm: (input) =>
                  Effect.sync(() => {
                    activated.push(input?.realm ?? "unset");
                    return { activeRealm: "cn" } as never;
                  }),
                getSession: () => Effect.succeed({} as never),
                getAccessToken: () => Effect.succeed("unused-token"),
              },
            },
            50,
          ),
          scope,
        ),
      );

      expect(initial).toEqual({ state: "ready", code: null, recoveryRequired: false });
      await Effect.runPromise(Effect.sleep(10));
      expect(activated).toEqual([]);

      await Effect.runPromise(Deferred.succeed(releaseCloud, undefined));
      await Effect.runPromise(Effect.sleep(20));
      expect(activated).toEqual([]);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("keeps startup ready while a cloud realm restore remains unresolved", async () => {
    const activated: string[] = [];
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const initial = await Effect.runPromise(
        Scope.provide(
          restoreMossAccountsOnStartup(
            {
              mossCloudAccount: {
                restore: () => Effect.never,
                getState: () => Effect.succeed({ activeRealm: "global" } as never),
              },
              mossPhoneAccount: {
                restoreSession: () => Effect.void,
                activateRealm: () =>
                  Effect.sync(() => {
                    activated.push("cn");
                    return { activeRealm: "cn" } as never;
                  }),
                getSession: () => Effect.succeed({} as never),
                getAccessToken: () => Effect.succeed("unused-token"),
              },
            },
            50,
          ),
          scope,
        ),
      );

      expect(initial).toEqual({ state: "ready", code: null, recoveryRequired: false });
      await Effect.runPromise(Effect.sleep(10));
      expect(activated).toEqual([]);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("reports degraded when restored metadata has no live server token", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        restoreMossAccountsOnStartup(
          {
            mossCloudAccount: { restore: () => Effect.void },
            mossPhoneAccount: {
              getSession: () => Effect.succeed({ authenticated: true } as never),
              getAccessToken: () =>
                Effect.fail(
                  new MossAccountServiceError({
                    code: "authentication_service_unavailable",
                    message: "temporary fixture",
                  }),
                ),
            },
          },
          50,
          { retryDelaysMs: [], lateRetryDelayMs: 60_000 },
        ),
      ),
    );

    expect(result).toEqual({
      state: "degraded",
      code: "phone_restore_failed",
      recoveryRequired: true,
    });
  });

  it("keeps retrying a degraded phone restoration until Auth answers, then reconciles the gateway", async () => {
    let restoreAttempts = 0;
    const activated: string[] = [];
    const promoted = Deferred.makeUnsafe<void>();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const initial = await Effect.runPromise(
        Scope.provide(
          restoreMossAccountsOnStartup(
            {
              mossCloudAccount: { restore: () => Effect.void },
              mossPhoneAccount: {
                getSession: () => Effect.succeed({ authenticated: true } as never),
                getAccessToken: () => Effect.succeed("unused"),
                restoreSession: () =>
                  Effect.suspend(() => {
                    restoreAttempts += 1;
                    // Down at boot and for the first two late attempts.
                    return restoreAttempts <= 3
                      ? Effect.fail(
                          new MossAccountServiceError({
                            code: "authentication_service_unavailable",
                            message: "temporary fixture",
                          }),
                        )
                      : Effect.void;
                  }),
                activateRealm: (input) =>
                  Effect.sync(() => {
                    activated.push(input?.realm ?? "cn");
                    return { activeRealm: "cn" } as never;
                  }),
              },
            },
            50,
            {
              retryDelaysMs: [],
              lateRetryDelayMs: 0,
              lateRetryBackoffMs: [0],
              lateRetryIntervalMs: 0,
              onState: (state) =>
                state.state === "ready"
                  ? Deferred.succeed(promoted, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            },
          ),
          scope,
        ),
      );
      expect(initial).toMatchObject({ state: "degraded", code: "phone_restore_failed" });

      await Effect.runPromise(Deferred.await(promoted));
      await Effect.runPromise(Effect.sleep(10));
      expect(restoreAttempts).toBe(4);
      expect(activated).toEqual(["cn"]);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("does not block the legacy cloud-only helper when restoration never settles", async () => {
    let restoreStarted = false;

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const releaseRestore = yield* Deferred.make<void>();
          return yield* restoreMossCloudAccountOnStartup(
            {
              restore: () =>
                Effect.sync(() => {
                  restoreStarted = true;
                }).pipe(Effect.andThen(Deferred.await(releaseRestore))),
            },
            5,
          );
        }),
      ),
    );

    expect(restoreStarted).toBe(true);
    expect(result).toBe("timed_out");
  });

  it("reports cloud restore success and runs a late-completion callback only after a timeout", async () => {
    const completed = await Effect.runPromise(
      Effect.scoped(restoreMossCloudAccountOnStartup({ restore: () => Effect.void }, 50)),
    );
    expect(completed).toBe("completed");

    const releaseRestore = Deferred.makeUnsafe<void>();
    const lateCompletion = Deferred.makeUnsafe<void>();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const timedOut = await Effect.runPromise(
        Scope.provide(
          restoreMossCloudAccountOnStartup({ restore: () => Deferred.await(releaseRestore) }, 5, {
            onLateCompletion: () => Deferred.succeed(lateCompletion, undefined).pipe(Effect.asVoid),
          }),
          scope,
        ),
      );
      expect(timedOut).toBe("timed_out");
      expect(await Effect.runPromise(Deferred.poll(lateCompletion))).toBeUndefined();
      await Effect.runPromise(Deferred.succeed(releaseRestore, undefined));
      await Effect.runPromise(Deferred.await(lateCompletion));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("cancels a timed-out cloud restore with its server scope", async () => {
    const interrupted = Deferred.makeUnsafe<void>();
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(
      Scope.provide(
        restoreMossCloudAccountOnStartup(
          {
            restore: () =>
              Effect.never.pipe(
                Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
              ),
          },
          5,
        ),
        scope,
      ),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await Effect.runPromise(Deferred.await(interrupted));
  });

  it("reports an explicit degraded admission state when phone restoration never settles", async () => {
    let phoneRestoreStarted = false;
    const readiness = await Effect.runPromise(makeServerReadiness);
    await Effect.runPromise(
      Effect.all([
        readiness.markHttpListening,
        readiness.markPushBusReady,
        readiness.markKeybindingsReady,
        readiness.markTerminalSubscriptionsReady,
        readiness.markOrchestrationSubscriptionsReady,
      ]),
    );
    const initial = await Effect.runPromise(
      Effect.scoped(
        restoreMossAccountsOnStartup(
          {
            mossCloudAccount: { restore: () => Effect.void },
            mossPhoneAccount: {
              getSession: () =>
                Effect.sync(() => {
                  phoneRestoreStarted = true;
                }).pipe(Effect.andThen(Effect.never)),
              getAccessToken: () => Effect.succeed("unused-token"),
            },
          },
          5,
          {
            onState: (state) =>
              state.state === "ready"
                ? readiness.markAccountStartupReady
                : readiness.markAccountStartupDegraded(state.code),
          },
        ),
      ),
    );

    expect(phoneRestoreStarted).toBe(true);
    expect(initial).toEqual({
      state: "degraded",
      code: "phone_restore_timeout",
      recoveryRequired: true,
    });
    expect(await Effect.runPromise(readiness.getSnapshot)).toMatchObject({
      startupReady: true,
      accountStartupState: "degraded",
      accountStartupCode: "phone_restore_timeout",
      accountRecoveryRequired: true,
    });
  });

  it("cancels a pending restoration with the server scope instead of leaking a detached fiber", async () => {
    const interrupted = Deferred.makeUnsafe<void>();
    const restorationScope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(
      Scope.provide(
        restoreMossAccountsOnStartup(
          {
            mossCloudAccount: { restore: () => Effect.void },
            mossPhoneAccount: {
              getSession: () =>
                Effect.never.pipe(
                  Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
                ),
              getAccessToken: () => Effect.succeed("unused-token"),
            },
          },
          5,
        ),
        restorationScope,
      ),
    );

    await Effect.runPromise(Scope.close(restorationScope, Exit.void));
    await Effect.runPromise(Deferred.await(interrupted));
  });

  it("does not admit commands or publish ready before account readiness", async () => {
    const accountReady = Deferred.makeUnsafe<void>();
    const order: string[] = [];
    const admission = Effect.runPromise(
      completeServerStartupAdmission({
        awaitServerReady: Deferred.await(accountReady),
        markCommandReady: Effect.sync(() => order.push("command-ready")),
        publishReady: Effect.sync(() => order.push("lifecycle-ready")),
      }),
    );

    await Promise.resolve();
    expect(order).toEqual([]);

    await Effect.runPromise(Deferred.succeed(accountReady, undefined));
    await admission;
    expect(order).toEqual(["command-ready", "lifecycle-ready"]);
  });

  it("admits unrelated commands after typed account degradation completes startup", async () => {
    const readiness = await Effect.runPromise(makeServerReadiness);
    await Effect.runPromise(
      Effect.all([
        readiness.markHttpListening,
        readiness.markPushBusReady,
        readiness.markKeybindingsReady,
        readiness.markTerminalSubscriptionsReady,
        readiness.markOrchestrationSubscriptionsReady,
        readiness.markAccountStartupDegraded("phone_restore_failed"),
      ]),
    );
    const order: string[] = [];

    await Effect.runPromise(
      completeServerStartupAdmission({
        awaitServerReady: readiness.awaitServerReady,
        markCommandReady: Effect.sync(() => order.push("command-ready")),
        publishReady: Effect.sync(() => order.push("lifecycle-ready")),
      }),
    );

    expect(order).toEqual(["command-ready", "lifecycle-ready"]);
    expect(await Effect.runPromise(readiness.getSnapshot)).toMatchObject({
      startupReady: true,
      accountStartupState: "degraded",
      accountRecoveryRequired: true,
    });
  });
});

describe("server runtime pipeline shutdown", () => {
  it("persists accepted provider terminal work before the engine stops", async () => {
    const order: string[] = [];
    let terminalAccepted = false;
    let terminalPersisted = false;
    let attachmentsDrained = false;
    const subscriptionsScope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(
      Scope.addFinalizer(
        subscriptionsScope,
        Effect.sync(() => {
          expect(terminalAccepted).toBe(true);
          terminalPersisted = true;
          order.push("reactors-drained-and-persisted");
        }),
      ),
    );

    await Effect.runPromise(
      closeServerRuntimePipeline({
        orchestrationEngine: {
          quiesce: Effect.sync(() => order.push("engine-quiesced")),
          drain: Effect.sync(() => order.push("admitted-commands-drained")),
          stop: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            expect(attachmentsDrained).toBe(true);
            order.push("engine-stopped");
          }),
        },
        providerService: {
          closeRuntimeEvents: Effect.sync(() => {
            terminalAccepted = true;
            order.push("provider-terminal-events-fenced");
          }),
        },
        managedAttachmentCleanup: {
          drain: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            attachmentsDrained = true;
            order.push("managed-attachments-drained");
          }),
        },
        subscriptionsScope,
      }),
    );

    expect(order).toEqual([
      "engine-quiesced",
      "admitted-commands-drained",
      "provider-terminal-events-fenced",
      "reactors-drained-and-persisted",
      "managed-attachments-drained",
      "engine-stopped",
    ]);
  });
});
describe("server runtime pipeline startup", () => {
  it("settles restart-orphaned turns before background reactors start", async () => {
    const order: string[] = [];
    const reactor = (name: string) => ({
      start: () => Effect.sync(() => void order.push(`${name}-started`)),
    });
    const subscriptionsScope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(
      startServerRuntimePipeline({
        orchestrationReactor: {
          start: Effect.sync(() => void order.push("runtime-journal-replayed")),
          reconcileSettledOpenTurns: Effect.sync(() => void order.push("open-turn-ledger-pruned")),
        },
        reconcileRestartStuckTurns: Effect.sync(() => void order.push("restart-turns-settled")),
        reactors: [reactor("automation-scheduler"), reactor("provider-runtime-reconciler")],
        subscriptionsScope,
      }),
    );

    expect(order).toEqual([
      "runtime-journal-replayed",
      "restart-turns-settled",
      "open-turn-ledger-pruned",
      "automation-scheduler-started",
      "provider-runtime-reconciler-started",
    ]);
  });
});
