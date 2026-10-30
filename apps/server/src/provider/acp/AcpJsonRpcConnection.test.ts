// FILE: AcpJsonRpcConnection.test.ts
// Purpose: Verifies ACP session negotiation, lifecycle, and event normalization.
// Layer: Provider ACP runtime tests

import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, describe, expect, it as runIt, vi } from "vitest";

import { collectSessionConfigOptionValues, findSessionConfigOption } from "./AcpRuntimeModel.ts";
import {
  AcpSessionRuntime,
  type AcpProtocolLogEvent,
  type AcpSessionRequestLogEvent,
  type AcpSessionRuntimeShape,
} from "./AcpSessionRuntime.ts";
import { forkViaAcpRuntime } from "./acpFork.ts";
import * as WindowsSnapshot from "../../platform/windowsProcessSnapshot.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const bunExe = process.execPath;

function nativeFailureCategories(cause: Cause.Cause<unknown>) {
  const seen = new WeakSet<object>();
  const inspect = (value: unknown, depth = 0): unknown => {
    if (typeof value !== "object" || value === null || depth > 6 || seen.has(value))
      return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const fields = Object.fromEntries(
      ["_tag", "name", "kind", "code", "operation", "method"].flatMap((key) =>
        typeof record[key] === "string" ? [[key, record[key]]] : [],
      ),
    );
    return {
      ...fields,
      ...(value instanceof Error && /^Windows process snapshot failed \(/u.test(value.message)
        ? { detail: value.message }
        : {}),
      ...(record.cause ? { cause: inspect(record.cause, depth + 1) } : {}),
    };
  };
  return cause.reasons.map((reason) => ({
    reason: reason._tag,
    ...(reason._tag === "Fail" ? { error: inspect(reason.error) } : {}),
    ...(reason._tag === "Die" ? { defect: inspect(reason.defect) } : {}),
  }));
}

let restoreNativeObserverDiagnostics = () => {};
beforeEach(() => {
  if (process.platform !== "win32") return;
  const createObserver = WindowsSnapshot.createWindowsTeardownProcessSnapshotObserver;
  const spy = vi
    .spyOn(WindowsSnapshot, "createWindowsTeardownProcessSnapshotObserver")
    .mockImplementation((options) => {
      const observer = createObserver(options);
      const prepare = observer.prepareWithin;
      if (!prepare) return observer;
      return {
        ...observer,
        prepareWithin: async (timeoutMs, signal) => {
          try {
            await prepare(timeoutMs, signal);
          } catch (cause) {
            console.info(
              "Owned ACP native observer preparation failure",
              JSON.stringify({
                deadlineMs: timeoutMs,
                failure: observer.lastFailure?.(),
                phase: observer.phase?.(),
              }),
            );
            throw cause;
          }
        },
      };
    });
  restoreNativeObserverDiagnostics = () => spy.mockRestore();
});
afterEach(() => restoreNativeObserverDiagnostics());

describe("AcpSessionRuntime", () => {
  it.effect("merges custom initialize client capabilities into the ACP handshake", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const initializeStarted = requestEvents.find(
        (event) => event.method === "initialize" && event.status === "started",
      );
      expect(initializeStarted?.payload).toMatchObject({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { parameterizedModelPicker: true },
        },
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("forwards provider session metadata when creating a session", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const sessionStarted = requestEvents.find(
        (event) => event.method === "session/new" && event.status === "started",
      );
      expect(sessionStarted?.payload).toMatchObject({
        _meta: {
          "x.ai/hooks": {
            PreToolUse: [{ matcher: "*", hookCallbackIds: ["moss-plan-guard"] }],
          },
        },
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          sessionMeta: {
            "x.ai/hooks": {
              PreToolUse: [{ matcher: "*", hookCallbackIds: ["moss-plan-guard"] }],
            },
          },
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("retries one matching fresh session setup failure", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.sessionId).toBe("mock-session-1");
      expect(
        requestEvents.filter(
          (event) => event.method === "session/new" && event.status === "started",
        ),
      ).toHaveLength(2);
      expect(
        requestEvents.filter(
          (event) => event.method === "initialize" && event.status === "started",
        ),
      ).toHaveLength(1);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              MOSS_ACP_FAIL_SESSION_NEW_ONCE: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
          freshSessionRetry: {
            shouldRetry: (error) =>
              error._tag === "AcpRequestError" &&
              typeof error.data === "object" &&
              error.data !== null &&
              (error.data as { readonly code?: unknown }).code === "FS_NOT_FOUND",
          },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  runIt(
    "discards the first probe session and fences orphan updates for on-demand auth",
    async () => {
      const requestEvents: Array<AcpSessionRequestLogEvent> = [];
      let runtimeForProbe: AcpSessionRuntimeShape | undefined;
      let probeEnqueuedCount = 0;
      const program = Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        runtimeForProbe = runtime;
        const started = yield* runtime.start().pipe(Effect.timeout("2 seconds"));
        expect(started.sessionId).toBe("mock-session-1");

        const newSessionStarts = requestEvents.filter(
          (event) => event.method === "session/new" && event.status === "started",
        );
        expect(newSessionStarts.length).toBe(2);
        expect(requestEvents.some((event) => event.method === "authenticate")).toBe(true);
        // Simulate the discarded probe session, let its orphan update arrive, then
        // measure enqueue production. Under the Moss contract the unique lifetime
        // event consumer is held until teardown, so the probe measure happens
        // without a transient getEvents subscription.
        const epoch = yield* runtime.getSessionEpoch();
        Object.assign(epoch, { activeSessionId: Option.some("mock-session-probe") });
        yield* Effect.sleep("100 millis");

        // The final session's bounded state is present, but nothing from the
        // discarded probe session leaked through.
        const commands = yield* runtime.getAvailableCommands;
        expect(commands).toEqual([{ name: "compact", description: "Compact the current context" }]);

        // Give any orphan update a moment to arrive, then consume the event stream.
        yield* Effect.sleep("200 millis");
        const eventsChunk = yield* Stream.runCollect(runtime.getEvents()).pipe(
          Effect.timeoutOption("500 millis"),
        );
        const events = Option.isSome(eventsChunk) ? Array.from(eventsChunk.value) : [];
        expect(
          events.some((event) => event._tag === "ContentDelta" && event.text === "orphan"),
        ).toBe(false);
        // The discarded probe session's notifications are fenced at intake, so the
        // lifetime consumer legitimately sees nothing: the probe never leaks into
        // the final session's event stream.
        probeEnqueuedCount = yield* runtime.sessionUpdatesEnqueuedCount;
        expect(probeEnqueuedCount).toBe(events.length);
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: bunExe,
              args: [mockAgentPath],
              env: {
                VITEST: "true",
                MOSS_ACP_ADVERTISE_AUTH_METHODS: "1",
                MOSS_ACP_REQUIRE_AUTH_FOR_SESSION: "1",
                MOSS_ACP_EMIT_ORPHAN_UPDATE: "1",
                MOSS_ACP_EMIT_AVAILABLE_COMMANDS: "1",
                MOSS_ACP_ORPHAN_UPDATE_DELAY_MS: "50",
                MOSS_ACP_FINAL_SESSION_DELAY_MS: "150",
              },
            },
            cwd: process.cwd(),
            clientInfo: { name: "moss-test", version: "0.0.0" },
            authMethodId: "test-key",
            authPolicy: "on-demand",
            authSetupHeuristic: (initializeResult, setupResult) => {
              const modelOption = findSessionConfigOption(setupResult.configOptions ?? [], "model");
              const allowedModels =
                modelOption?.type === "select" ? collectSessionConfigOptionValues(modelOption) : [];
              return allowedModels.length === 0 && (initializeResult.authMethods?.length ?? 0) > 0;
            },
            requestLogger: (event) =>
              Effect.sync(() => {
                requestEvents.push(event);
              }),
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );

      await Effect.runPromise(program);
    },
  );

  it.effect("suppresses late load replay before an immediate first prompt", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const started = yield* runtime.start();
        expect(started.sessionId).toBe("mock-session-1");

        // Resumed sessions drop session/update until a consumer attaches, so the
        // events stream must be taken before prompting (mirrors the adapters,
        // which fork the drain right after start()). Under the Moss contract the
        // unique lifetime consumer must not be released mid-test, so collect
        // through a drain that only ends with the runtime.
        const collected: Array<{ readonly _tag: string }> = [];
        yield* Stream.runForEach(runtime.getEvents(), (event) =>
          Effect.sync(() => {
            collected.push(event);
          }),
        ).pipe(Effect.forkChild);
        // Let the drain's acquire register the consumer before prompting so the
        // prompt's plan/message updates classify live instead of dropping.
        yield* Effect.sleep("50 millis");
        const promptResult = yield* runtime.prompt({
          prompt: [{ type: "text", text: "hi" }],
        });
        expect(promptResult).toMatchObject({ stopReason: "end_turn" });
        expect(yield* runtime.getModeState).toMatchObject({ currentModeId: "code" });

        // The session/load replay chunks are dropped; only the immediate first
        // prompt's legitimate events arrive after the quiet gate opens.
        // The runtime surfaces mode transitions as ModeChanged events; replay's
        // mode write may land anywhere in the window, so compare the transcript
        // events with mode events filtered out.
        const transcriptTags = () =>
          collected.map((note) => note._tag).filter((tag) => tag !== "ModeChanged");
        yield* Effect.gen(function* () {
          for (
            let attempt = 0;
            attempt < 50 && (transcriptTags().length < 4 || transcriptTags()[0] !== "PlanUpdated");
            attempt += 1
          ) {
            yield* Effect.sleep("20 millis");
          }
        });
        const notes = transcriptTags().slice(0, 4);
        if (process.env.DEBUG_ACP_TEST === "1") {
          console.error("COLLECTED", JSON.stringify(collected.map((note) => note._tag)));
        }
        expect(notes).toEqual([
          "PlanUpdated",
          "AssistantItemStarted",
          "ContentDelta",
          "AssistantItemCompleted",
        ]);
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: bunExe,
              args: [mockAgentPath],
              env: {
                VITEST: "true",
                MOSS_ACP_LOAD_REPLAY_DELAYS_MS: "0,0",
                MOSS_ACP_LOAD_REPLAY_MODE_ID: "code",
                MOSS_ACP_REJECT_PROMPT_DURING_LOAD_REPLAY: "1",
              },
            },
            cwd: process.cwd(),
            resumeSessionId: "mock-session-1",
            loadReplayPolicy: {
              quietMs: 20,
              hardTimeoutMs: 200,
            },
            clientInfo: { name: "moss-test", version: "0.0.0" },
            authMethodId: "test",
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("settles load replay before checking whether a mode write is a no-op", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return TestClock.withLive(
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* runtime.start();

        // The load response starts in ask mode, then replay reports code mode.
        // Waiting before reading retained state makes this ask request a real
        // write instead of incorrectly treating it as an early no-op.
        yield* runtime.setMode("ask");

        const modeRequest = requestEvents.find(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        );
        expect(modeRequest?.payload).toMatchObject({ configId: "mode", value: "ask" });
        expect(yield* runtime.getModeState).toMatchObject({ currentModeId: "ask" });
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: bunExe,
              args: [mockAgentPath],
              env: {
                VITEST: "true",
                MOSS_ACP_LOAD_REPLAY_DELAYS_MS: "10,25",
                MOSS_ACP_LOAD_REPLAY_MODE_ID: "code",
              },
            },
            cwd: process.cwd(),
            resumeSessionId: "mock-session-1",
            loadReplayPolicy: {
              quietMs: 300,
              hardTimeoutMs: 3_000,
            },
            clientInfo: { name: "moss-test", version: "0.0.0" },
            authMethodId: "test",
            requestLogger: (event) =>
              Effect.sync(() => {
                requestEvents.push(event);
              }),
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      ),
    );
  });

  it.effect("joins the accepted load replay prefix before applying session configuration", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const notificationEntered = yield* Deferred.make<void>();
        const releaseNotification = yield* Deferred.make<void>();
        const prefixDrainWaiting = yield* Deferred.make<void>();
        const program = Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime;
          yield* runtime.handleSessionUpdate((notification) =>
            notification.update.sessionUpdate === "available_commands_update"
              ? Deferred.succeed(notificationEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseNotification)),
                )
              : Effect.void,
          );

          const start = yield* Effect.forkScoped(runtime.start());
          const startFinished = Fiber.await(start).pipe(
            Effect.flatMap((exit) =>
              Exit.isFailure(exit)
                ? Effect.failCause(exit.cause)
                : Effect.succeed("start-finished" as const),
            ),
          );
          const enteredBeforeStart = yield* Effect.raceFirst(
            Deferred.await(notificationEntered).pipe(Effect.as("notification-entered" as const)),
            startFinished,
          );
          expect(enteredBeforeStart).toBe("notification-entered");

          // This waiter is registered only after the load response is received.
          // The child writer has finished; the held parent callback has not.
          const beforeRelease = yield* Effect.raceFirst(
            Deferred.await(prefixDrainWaiting).pipe(Effect.as("prefix-drain-waiting" as const)),
            startFinished,
          );
          expect(beforeRelease).toBe("prefix-drain-waiting");
          expect(start.pollUnsafe()).toBeUndefined();

          yield* Deferred.succeed(releaseNotification, undefined);
          yield* Fiber.join(start);
          yield* runtime.setModel("composer-2");

          expect(yield* runtime.getConfigOptions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: "model", currentValue: "composer-2" }),
            ]),
          );
        }).pipe(
          Effect.ensuring(Deferred.succeed(releaseNotification, undefined)),
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: bunExe,
                args: [mockAgentPath],
                env: {
                  VITEST: "true",
                  MOSS_ACP_LOAD_REPLAY_DELAYS_MS: "10,25",
                  MOSS_ACP_REJECT_CONFIG_DURING_LOAD_REPLAY: "1",
                  MOSS_ACP_LOAD_RESPONSE_AFTER_REPLAY_WRITES: "1",
                  MOSS_ACP_LOAD_REPLAY_AVAILABLE_COMMANDS: "1",
                },
              },
              cwd: process.cwd(),
              resumeSessionId: "mock-session-1",
              loadReplayPolicy: {
                quietMs: 20,
                hardTimeoutMs: 200,
              },
              clientInfo: { name: "moss-test", version: "0.0.0" },
              authMethodId: "test",
              sessionUpdateDrainTestHooks: {
                onWaiterCountChange: (count) => {
                  if (count > 0) {
                    Effect.runSync(Deferred.succeed(prefixDrainWaiting, undefined));
                  }
                },
              },
            }),
          ),
          Effect.scoped,
          Effect.provide(NodeServices.layer),
        );
        yield* program;
      }),
    ),
  );

  it.effect("settles load replay before reading available commands", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* runtime.start();

        expect(yield* runtime.getAvailableCommands).toEqual([
          { name: "compact", description: "Compact the current context" },
        ]);
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: bunExe,
              args: [mockAgentPath],
              env: {
                VITEST: "true",
                MOSS_ACP_LOAD_REPLAY_DELAYS_MS: "10,25",
                // The load response drains this bounded state before gate settlement;
                // native timer delays do not guarantee parent-side receipt.
                MOSS_ACP_LOAD_REPLAY_COMMANDS_BEFORE_RESPONSE: "1",
              },
            },
            cwd: process.cwd(),
            resumeSessionId: "mock-session-1",
            loadReplayPolicy: {
              quietMs: 20,
              hardTimeoutMs: 200,
            },
            clientInfo: { name: "moss-test", version: "0.0.0" },
            authMethodId: "test",
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("joins replay state application before concurrent command readers return", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const applicationReached = yield* Deferred.make<void>();
        const continueApplication = yield* Deferred.make<void>();
        const methods: string[] = [];
        const program = Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime;
          yield* runtime.start();
          const first = yield* Effect.forkScoped(runtime.getAvailableCommands);
          yield* Deferred.await(applicationReached).pipe(Effect.timeout("5 seconds"));
          const secondEntered = yield* Deferred.make<void>();
          const second = yield* Effect.forkScoped(
            Deferred.succeed(secondEntered, undefined).pipe(
              Effect.andThen(runtime.getAvailableCommands),
            ),
          );
          yield* Deferred.await(secondEntered);
          yield* Effect.yieldNow;
          const secondBeforeRelease = second.pollUnsafe();
          expect(
            secondBeforeRelease === undefined,
            JSON.stringify({
              secondEntered: true,
              completion: secondBeforeRelease !== undefined ? secondBeforeRelease._tag : "pending",
              commands:
                secondBeforeRelease !== undefined && Exit.isSuccess(secondBeforeRelease)
                  ? secondBeforeRelease.value
                  : undefined,
            }),
          ).toBe(true);
          expect(first.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(continueApplication, undefined);
          const expected = [{ name: "compact", description: "Compact the current context" }];
          expect(yield* Fiber.join(first)).toEqual(expected);
          expect(yield* Fiber.join(second)).toEqual(expected);
          expect(methods).toContain("session/load");
        }).pipe(
          Effect.ensuring(Deferred.succeed(continueApplication, undefined)),
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: bunExe,
                args: [mockAgentPath],
                env: {
                  VITEST: "true",
                  MOSS_ACP_LOAD_REPLAY_DELAYS_MS: "0",
                  MOSS_ACP_LOAD_REPLAY_AVAILABLE_COMMANDS: "1",
                },
              },
              cwd: process.cwd(),
              resumeSessionId: "mock-session-1",
              loadReplayPolicy: { quietMs: 20, hardTimeoutMs: 200 },
              clientInfo: { name: "moss-test", version: "0.0.0" },
              authMethodId: "test",
              __testBeforeLoadReplayStateApply: Deferred.succeed(
                applicationReached,
                undefined,
              ).pipe(Effect.andThen(Deferred.await(continueApplication))),
              requestLogger: (event) =>
                Effect.sync(() => {
                  methods.push(event.method);
                }),
            }),
          ),
          Effect.scoped,
          Effect.provide(NodeServices.layer),
        );
        yield* program;
      }),
    ),
  );

  it.effect(
    "retains a replay update whose defer decision resumes after the state was claimed",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const deferReached = yield* Deferred.make<void>();
          const continueDefer = yield* Deferred.make<void>();
          const deferFinished = yield* Deferred.make<void>();
          const program = Effect.gen(function* () {
            const runtime = yield* AcpSessionRuntime;
            yield* runtime.start();
            yield* Deferred.await(deferReached).pipe(Effect.timeout("5 seconds"));
            // This completes the original claim while the actual bounded update
            // is paused after observing suppression but before its defer decision.
            expect(yield* runtime.getAvailableCommands).toEqual([]);
            yield* Deferred.succeed(continueDefer, undefined);
            yield* Deferred.await(deferFinished).pipe(Effect.timeout("5 seconds"));
            expect(
              yield* runtime.getAvailableCommands,
              "Late bounded replay update must remain visible after claimed state drained",
            ).toEqual([{ name: "compact", description: "Compact the current context" }]);
          }).pipe(
            Effect.ensuring(Deferred.succeed(continueDefer, undefined)),
            Effect.provide(
              AcpSessionRuntime.layer({
                spawn: {
                  command: bunExe,
                  args: [mockAgentPath],
                  env: {
                    VITEST: "true",
                    MOSS_ACP_LOAD_REPLAY_DELAYS_MS: "0",
                    MOSS_ACP_LOAD_REPLAY_AVAILABLE_COMMANDS: "1",
                  },
                },
                cwd: process.cwd(),
                resumeSessionId: "mock-session-1",
                loadReplayPolicy: { quietMs: 20, hardTimeoutMs: 200 },
                clientInfo: { name: "moss-test", version: "0.0.0" },
                authMethodId: "test",
                __testLoadReplayStateDefer: (phase) =>
                  phase === "before"
                    ? Deferred.succeed(deferReached, undefined).pipe(
                        Effect.andThen(Deferred.await(continueDefer)),
                      )
                    : Deferred.succeed(deferFinished, undefined).pipe(Effect.asVoid),
              }),
            ),
            Effect.scoped,
            Effect.provide(NodeServices.layer),
          );
          yield* program;
        }),
      ),
  );

  it.effect("forwards provider session metadata when loading a session", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionSetupMethod).toBe("load");
      expect(
        requestEvents.find((event) => event.method === "session/load" && event.status === "started")
          ?.payload,
      ).toMatchObject({ _meta: { reconnectPolicy: "keep-hooks" } });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          sessionMeta: { reconnectPolicy: "keep-hooks" },
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("completes two consecutive prompts on the same session", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionId).toBe("mock-session-1");

      const eventsFiber = yield* Stream.runCollect(Stream.take(runtime.getEvents(), 8)).pipe(
        Effect.forkChild,
      );
      const first = yield* runtime.prompt({ prompt: [{ type: "text", text: "first" }] });
      expect(first).toMatchObject({ stopReason: "end_turn" });

      const enqueuedAfterFirst = yield* runtime.sessionUpdatesEnqueuedCount;
      expect(enqueuedAfterFirst).toBeGreaterThan(0);

      const second = yield* runtime.prompt({ prompt: [{ type: "text", text: "second" }] });
      expect(second).toMatchObject({ stopReason: "end_turn" });

      const enqueuedAfterSecond = yield* runtime.sessionUpdatesEnqueuedCount;
      expect(enqueuedAfterSecond).toBeGreaterThan(enqueuedAfterFirst);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      expect(events.filter((event) => event._tag === "AssistantItemCompleted").length).toBe(2);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  runIt("resumes across a runtime restart and accepts a follow-up prompt", async () => {
    const layerFor = (resumeSessionId?: string) =>
      AcpSessionRuntime.layer({
        spawn: {
          command: bunExe,
          args: [mockAgentPath],
          env: { VITEST: "true", MOSS_ACP_SUPPORT_SESSION_RESUME: "1" },
        },
        cwd: process.cwd(),
        ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
        clientInfo: { name: "moss-test", version: "0.0.0" },
        authMethodId: "test",
      });

    // First server lifetime: fresh session plus one completed turn.
    const firstSessionId = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const started = yield* runtime.start();
        const result = yield* runtime.prompt({ prompt: [{ type: "text", text: "before" }] });
        expect(result).toMatchObject({ stopReason: "end_turn" });
        return started.sessionId;
      }).pipe(Effect.provide(layerFor()), Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    // Second server lifetime: resume from the persisted cursor and prompt again.
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const started = yield* runtime.start();
        expect(started.sessionSetupMethod).toBe("resume");
        expect(started.sessionId).toBe(firstSessionId);
        const eventsFiber = yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)).pipe(
          Effect.forkChild,
        );
        const result = yield* runtime.prompt({ prompt: [{ type: "text", text: "after" }] });
        expect(result).toMatchObject({ stopReason: "end_turn" });
        const events = Array.from(yield* Fiber.join(eventsFiber));
        expect(events.some((event) => event._tag === "AssistantItemCompleted")).toBe(true);
      }).pipe(
        Effect.provide(layerFor(firstSessionId)),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      ),
    );
  });

  it.effect("prefers session/resume when the agent advertises it", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionSetupMethod).toBe("resume");
      expect(requestEvents.some((event) => event.method === "session/resume")).toBe(true);
      expect(requestEvents.some((event) => event.method === "session/load")).toBe(false);
      expect(
        requestEvents.find(
          (event) => event.method === "session/resume" && event.status === "started",
        )?.payload,
      ).toMatchObject({ _meta: { reconnectPolicy: "keep-hooks" } });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: { VITEST: "true", MOSS_ACP_SUPPORT_SESSION_RESUME: "1" },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          sessionMeta: { reconnectPolicy: "keep-hooks" },
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("does not call session/load when the agent does not advertise it", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start().pipe(Effect.exit);
      expect(Exit.isFailure(started)).toBe(true);
      expect(requestEvents.some((event) => event.method === "session/load")).toBe(false);
      expect(requestEvents.some((event) => event.method === "session/new")).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: { VITEST: "true", MOSS_ACP_SUPPORT_SESSION_LOAD: "0" },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("resolves semantic mode config ids and exposes commands and forks", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      expect(yield* runtime.supportsSessionFork).toBe(true);
      yield* runtime.setMode("code");
      const commands = yield* runtime.getAvailableCommands;
      const forked = yield* runtime.forkSession({ cwd: process.cwd(), mcpServers: [] });

      expect(commands).toEqual([{ name: "compact", description: "Compact the current context" }]);
      expect(forked.sessionId).toBe("mock-session-fork-1");
      const modeRequest = requestEvents.find(
        (event) => event.method === "session/set_config_option" && event.status === "started",
      );
      expect(modeRequest?.payload).toMatchObject({
        configId: "autonomy_level",
        value: "code",
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              MOSS_ACP_SUPPORT_SESSION_FORK: "1",
              MOSS_ACP_EMIT_AVAILABLE_COMMANDS: "1",
              MOSS_ACP_MODE_CONFIG_ID: "autonomy_level",
            },
          },
          cwd: process.cwd(),
          clientCapabilities: { _meta: { parameterizedModelPicker: true } },
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("rejects fork cursors when the ACP agent cannot reopen sessions", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      expect(yield* runtime.supportsSessionFork).toBe(true);
      expect(yield* runtime.supportsSessionRecovery).toBe(false);

      const error = yield* forkViaAcpRuntime({
        provider: "test",
        runtime,
        targetCwd: process.cwd(),
        unsupportedIssue: "fork unsupported",
        requestTimeoutMs: 1_000,
        timeoutError: (method) =>
          new ProviderAdapterRequestError({
            provider: "test",
            method,
            detail: "timed out",
          }),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProviderAdapterValidationError);
      expect(error.message).toContain("cannot reopen the forked session");
      expect(requestEvents.some((event) => event.method === "session/fork")).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              MOSS_ACP_SUPPORT_SESSION_FORK: "1",
              MOSS_ACP_SUPPORT_SESSION_LOAD: "0",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("forks a loaded session after replay settles without an event consumer", () => {
    const startedAt = Date.now();
    const trace: Array<Record<string, unknown>> = [];
    const note = (fields: Record<string, unknown>) => {
      trace.push({ elapsedMs: Date.now() - startedAt, ...fields });
    };
    return TestClock.withLive(
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* runtime.start();
        note({ phase: "start-returned" });
        note({ phase: "fork-call-before-runtime-gate" });

        const result = yield* forkViaAcpRuntime({
          provider: "test",
          runtime,
          targetCwd: process.cwd(),
          unsupportedIssue: "fork unsupported",
          requestTimeoutMs: 1_000,
          timeoutError: (method) =>
            new ProviderAdapterRequestError({
              provider: "test",
              method,
              detail: "timed out",
            }),
        });

        expect(result.sessionId).toBe("mock-session-fork-1");
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: bunExe,
              args: [mockAgentPath],
              env: {
                VITEST: "true",
                MOSS_ACP_SUPPORT_SESSION_FORK: "1",
                MOSS_ACP_LOAD_REPLAY_DELAYS_MS: "10,25",
                MOSS_ACP_REJECT_FORK_DURING_LOAD_REPLAY: "1",
                MOSS_ACP_LOAD_RESPONSE_AFTER_REPLAY_WRITES: "1",
              },
            },
            cwd: process.cwd(),
            resumeSessionId: "mock-session-1",
            loadReplayPolicy: {
              quietMs: 20,
              hardTimeoutMs: 200,
            },
            clientInfo: { name: "moss-test", version: "0.0.0" },
            authMethodId: "test",
            requestLogger: (event) =>
              Effect.sync(() => {
                note({ phase: "request", method: event.method, status: event.status });
              }),
            protocolLogging: {
              logIncoming: true,
              logger: (event) =>
                Effect.sync(() => {
                  if (event.direction !== "incoming" || event.stage !== "decoded") return;
                  const message = event.payload as {
                    method?: unknown;
                    params?: { update?: { sessionUpdate?: unknown } };
                  };
                  note({
                    phase: "incoming-decoded",
                    method: typeof message.method === "string" ? message.method : undefined,
                    update:
                      typeof message.params?.update?.sessionUpdate === "string"
                        ? message.params.update.sessionUpdate
                        : undefined,
                  });
                }),
            },
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.onError((cause) =>
          Effect.sync(() => {
            console.info(
              "Owned ACP fork replay timing",
              JSON.stringify({
                trace,
                causes: nativeFailureCategories(cause),
              }),
            );
          }),
        ),
      ),
    );
  });

  it.effect("preserves the fork RPC timeout after replay reaches its hard cap", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* runtime.start();

        const result = yield* forkViaAcpRuntime({
          provider: "test",
          runtime,
          targetCwd: process.cwd(),
          unsupportedIssue: "fork unsupported",
          requestTimeoutMs: 100,
          timeoutError: (method) =>
            new ProviderAdapterRequestError({
              provider: "test",
              method,
              detail: "timed out",
            }),
        });

        expect(result.sessionId).toBe("mock-session-fork-1");
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: bunExe,
              args: [mockAgentPath],
              env: {
                VITEST: "true",
                MOSS_ACP_SUPPORT_SESSION_FORK: "1",
                MOSS_ACP_LOAD_REPLAY_DELAYS_MS: "0,50,100,150,199",
              },
            },
            cwd: process.cwd(),
            resumeSessionId: "mock-session-1",
            loadReplayPolicy: {
              quietMs: 1_000,
              hardTimeoutMs: 200,
            },
            clientInfo: { name: "moss-test", version: "0.0.0" },
            authMethodId: "test",
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect(
    "assigns distinct fallback assistant item ids across separate runtime instances",
    () => {
      const runtimeLayer = AcpSessionRuntime.layer({
        spawn: {
          command: bunExe,
          args: [mockAgentPath],
        },
        cwd: process.cwd(),
        resumeSessionId: "mock-session-1",
        clientInfo: { name: "moss-test", version: "0.0.0" },
        authMethodId: "test",
      });

      const collectFallbackAssistantItemId = Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* runtime.start();
        const eventsFiber = yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)).pipe(
          Effect.forkChild,
        );
        yield* runtime.prompt({
          prompt: [{ type: "text", text: "hi" }],
        });
        const notes = Array.from(yield* Fiber.join(eventsFiber));
        const delta = notes.find((note) => note._tag === "ContentDelta");
        expect(delta?._tag).toBe("ContentDelta");
        return delta?._tag === "ContentDelta" ? delta.itemId : undefined;
      }).pipe(Effect.provide(runtimeLayer), Effect.scoped, Effect.provide(NodeServices.layer));

      return TestClock.withLive(
        Effect.gen(function* () {
          const firstItemId = yield* collectFallbackAssistantItemId;
          const secondItemId = yield* collectFallbackAssistantItemId;
          const fallbackIdPattern = /^assistant:mock-session-1:[0-9a-f]{8}:segment:0$/;
          expect(firstItemId).toMatch(fallbackIdPattern);
          expect(secondItemId).toMatch(fallbackIdPattern);
          expect(firstItemId).not.toBe(secondItemId);
        }),
      );
    },
  );

  it.effect("starts a session, prompts, and emits normalized events against the mock agent", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.initializeResult).toMatchObject({ protocolVersion: 1 });
      expect(started.sessionId).toBe("mock-session-1");

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes).toHaveLength(4);
      expect(notes.map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const planUpdate = notes.find((note) => note._tag === "PlanUpdated");
      expect(planUpdate?._tag).toBe("PlanUpdated");
      if (planUpdate?._tag === "PlanUpdated") {
        expect(planUpdate.payload.plan).toHaveLength(2);
      }
      const assistantStart = notes[1];
      const assistantDelta = notes[2];
      if (
        assistantStart?._tag === "AssistantItemStarted" &&
        assistantDelta?._tag === "ContentDelta"
      ) {
        expect(assistantDelta.itemId).toBe(assistantStart.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("segments assistant text around ACP tool calls", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 7)));
      expect(notes.map((note) => note._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
        "ToolCallUpdated",
        "ToolCallUpdated",
        "AssistantItemStarted",
        "ContentDelta",
      ]);

      const firstStarted = notes[0];
      const firstDelta = notes[1];
      const firstCompleted = notes[2];
      const secondStarted = notes[5];
      const secondDelta = notes[6];
      expect(firstStarted?._tag).toBe("AssistantItemStarted");
      expect(firstCompleted?._tag).toBe("AssistantItemCompleted");
      expect(secondStarted?._tag).toBe("AssistantItemStarted");
      if (
        firstStarted?._tag === "AssistantItemStarted" &&
        firstDelta?._tag === "ContentDelta" &&
        firstCompleted?._tag === "AssistantItemCompleted" &&
        secondStarted?._tag === "AssistantItemStarted" &&
        secondDelta?._tag === "ContentDelta"
      ) {
        expect(firstDelta.itemId).toBe(firstStarted.itemId);
        expect(firstCompleted.itemId).toBe(firstStarted.itemId);
        expect(secondStarted.itemId).not.toBe(firstStarted.itemId);
        expect(secondDelta.itemId).toBe(secondStarted.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              MOSS_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("preserves upstream assistant message ids across ACP tool-call segments", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 11)));
      const contentDeltas = notes.filter((note) => note._tag === "ContentDelta");
      expect(contentDeltas.map((note) => note.itemId)).toEqual([
        "upstream-answer",
        "upstream-answer",
        "upstream-followup",
      ]);
      expect(contentDeltas.map((note) => note.text)).toEqual([
        "before tool",
        " after tool",
        "separate answer",
      ]);
      expect(
        notes.filter((note) => note._tag === "AssistantItemStarted").map((note) => note.itemId),
      ).toEqual(["upstream-answer", "upstream-answer", "upstream-followup"]);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              MOSS_ACP_EMIT_UPSTREAM_ASSISTANT_MESSAGE_IDS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("emits generic placeholder tool lifecycle updates", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 3)));
      expect(notes.map((note) => note._tag)).toEqual([
        "ToolCallUpdated",
        "ToolCallUpdated",
        "ToolCallUpdated",
      ]);
      const toolCall = notes[0];
      expect(toolCall?._tag).toBe("ToolCallUpdated");
      if (toolCall?._tag === "ToolCallUpdated") {
        expect(toolCall.toolCall.status).toBe("pending");
        expect(toolCall.toolCall.title).toBe("Reading");
      }
      const completedToolCall = notes[2];
      expect(completedToolCall?._tag).toBe("ToolCallUpdated");
      if (completedToolCall?._tag === "ToolCallUpdated") {
        expect(completedToolCall.toolCall.status).toBe("completed");
        expect(completedToolCall.toolCall.title).toBe("Read");
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              MOSS_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("does not open assistant segments for reasoning chunks before tool calls", () => {
    const requestMethods: string[] = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 3)));
      expect(notes.map((note) => note._tag)).toEqual([
        "ContentDelta",
        "ToolCallUpdated",
        "ToolCallUpdated",
      ]);
      const reasoningDelta = notes[0];
      expect(reasoningDelta?._tag).toBe("ContentDelta");
      if (reasoningDelta?._tag === "ContentDelta") {
        expect(reasoningDelta.streamKind).toBe("reasoning_text");
        expect(reasoningDelta.itemId).toBeUndefined();
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              MOSS_ACP_EMIT_REASONING_THEN_TOOL_CALL: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestMethods.push(event.method);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.onError((cause) =>
        Effect.sync(() => {
          console.info(
            "Owned ACP native failure diagnostic",
            JSON.stringify({
              causes: nativeFailureCategories(cause),
              mockMethods: requestMethods,
            }),
          );
        }),
      ),
    );
  });

  it.effect("logs ACP requests from the shared runtime", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.setModel("composer-2");
      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "succeeded",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "succeeded",
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.onError((cause) =>
        Effect.sync(() => {
          console.info(
            "Owned ACP native failure diagnostic",
            JSON.stringify({
              causes: nativeFailureCategories(cause),
              mockMethods: requestEvents.map((event) => event.method),
            }),
          );
        }),
      ),
    );
  });

  it.effect("skips no-op session config writes when the requested value is already active", () => {
    const requestEvents: Array<AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.setConfigOption("model", "default");
      yield* runtime.setMode("ask");

      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("emits low-level ACP protocol logs for raw and decoded messages", () => {
    const protocolEvents: Array<AcpProtocolLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "decoded"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "decoded"),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
          protocolLogging: {
            logIncoming: true,
            logOutgoing: true,
            logger: (event) =>
              Effect.sync(() => {
                protocolEvents.push(event);
              }),
          },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("rejects invalid config option values before sending session/set_config_option", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "acp-runtime-"));
    const requestLogPath = path.join(tempDir, "requests.ndjson");
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      const error = yield* runtime.setModel("composer-2[fast=false]").pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.code).toBe(-32602);
        expect(error.message).toContain(
          'Invalid value "composer-2[fast=false]" for session config option "model"',
        );
        expect(error.message).toContain("composer-2[fast=true]");
      }

      const recordedRequests = readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: { value?: unknown } });
      expect(
        recordedRequests.some(
          (message) =>
            message.method === "session/set_config_option" &&
            message.params?.value === "composer-2[fast=false]",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: bunExe,
            args: [mockAgentPath],
            env: {
              VITEST: "true",
              MOSS_ACP_REQUEST_LOG_PATH: requestLogPath,
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "moss-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(tempDir, { recursive: true, force: true }))),
    );
  });
});
