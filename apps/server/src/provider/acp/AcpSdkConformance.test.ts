// Verifies the current Moss ACP boundary against an official-SDK subprocess.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION, client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { afterEach, describe, expect, it as test } from "vitest";

import {
  prepareEffectProcessTree,
  teardownProviderProcessTree,
} from "../supervisedProcessTeardown.ts";
import {
  ACP_PRE_ATTACH_EVENT_CAPACITY,
  ACP_PRE_ATTACH_EVENT_MAX_BYTES,
  type AcpProtocolLogEvent,
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
} from "./AcpSessionRuntime.ts";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/acp-conformance-agent.ts",
);
const officialMockFixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);
const temporaryDirectories: string[] = [];

interface FixtureLogEntry {
  readonly type: string;
  readonly payload: unknown;
}

function createFixtureLog(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "moss-acp-conformance-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "fixture.jsonl");
}

function readFixtureLog(logPath: string): ReadonlyArray<FixtureLogEntry> {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FixtureLogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readJsonLines(logPath: string): ReadonlyArray<Record<string, unknown>> {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

const waitForRealMilliseconds = (milliseconds: number): Effect.Effect<void> =>
  Effect.promise(
    () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)),
  );

function makeReasonlessAbortController(): {
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly listenerAdds: () => number;
  readonly listenerRemoves: () => number;
} {
  type AbortListener = Parameters<AbortSignal["addEventListener"]>[1];

  let aborted = false;
  let registeredAbortListener: AbortListener | undefined;
  let activeAbortListener: AbortListener | undefined;
  let listenerAdds = 0;
  let listenerRemoves = 0;
  const signal = {
    get aborted() {
      return aborted;
    },
    get reason() {
      return undefined;
    },
    addEventListener(...args: Parameters<AbortSignal["addEventListener"]>) {
      if (args[0] !== "abort" || args[1] === null) {
        return;
      }
      listenerAdds += 1;
      registeredAbortListener = args[1];
      activeAbortListener = args[1];
    },
    removeEventListener(...args: Parameters<AbortSignal["removeEventListener"]>) {
      if (args[0] !== "abort" || registeredAbortListener !== args[1]) {
        return;
      }
      listenerRemoves += 1;
      if (activeAbortListener === args[1]) {
        activeAbortListener = undefined;
      }
    },
  } as AbortSignal;
  return {
    signal,
    abort: () => {
      if (aborted) {
        return;
      }
      aborted = true;
      const listener = activeAbortListener;
      if (listener === undefined) {
        return;
      }
      if (typeof listener === "function") {
        (listener as unknown as () => void)();
      } else {
        (listener as unknown as { readonly handleEvent: () => void }).handleEvent();
      }
    },
    listenerAdds: () => listenerAdds,
    listenerRemoves: () => listenerRemoves,
  };
}

const waitForFixtureLogType = (logPath: string, type: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (readFixtureLog(logPath).some((entry) => entry.type === type)) {
        return;
      }
      yield* waitForRealMilliseconds(10);
    }
    yield* Effect.sync(() => {
      throw new Error(`Timed out waiting for fixture log entry ${JSON.stringify(type)}`);
    });
  });

function canonicalWireMessage(message: Record<string, unknown>): Record<string, unknown> {
  const { id: _requestId, ...canonical } = message;
  return canonical;
}

function captureByteStream(
  input: ReadableStream<Uint8Array>,
  capture: Uint8Array[],
): ReadableStream<Uint8Array> {
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        capture.push(chunk.slice());
        controller.enqueue(chunk);
      },
    }),
  );
}

function runtimeLayer(
  logPath: string,
  env: Record<string, string> = {},
  protocolLogging?: AcpSessionRuntimeOptions["protocolLogging"],
  teardownProcessTree?: AcpSessionRuntimeOptions["teardownProcessTree"],
  resumeSessionId?: string,
  sessionUpdateDrainTestHooks?: AcpSessionRuntimeOptions["sessionUpdateDrainTestHooks"],
) {
  const makeLayer = (teardown = teardownProcessTree) =>
    AcpSessionRuntime.layer({
      spawn: {
        command: process.execPath,
        args: [fixturePath],
        env: {
          VITEST: "true",
          MOSS_ACP_CONFORMANCE_LOG_PATH: logPath,
          ...env,
        },
      },
      cwd: process.cwd(),
      clientCapabilities: {
        _meta: {
          primitive: "client-meta",
          nested: { source: "moss" },
        },
      },
      clientInfo: { name: "moss-conformance-test", version: "0.0.0" },
      authMethodId: "test",
      authenticateMeta: {
        primitive: 11,
        nested: { source: "moss-auth" },
      },
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(protocolLogging ? { protocolLogging } : {}),
      ...(teardown ? { teardownProcessTree: teardown } : {}),
      ...(sessionUpdateDrainTestHooks ? { sessionUpdateDrainTestHooks } : {}),
    });
  if (!teardownProcessTree) return makeLayer();
  // This wrapper owns the real teardown seam, so it also owns the same native
  // preparation as the default runtime. Layer scope closes the child before
  // disposing the borrowed worker; no process rows are captured during setup.
  return Layer.unwrap(
    Effect.gen(function* () {
      const windowsSnapshotObserver = yield* prepareEffectProcessTree().pipe(Effect.orDie);
      return makeLayer((input, dependencies) =>
        teardownProcessTree(input, {
          ...dependencies,
          ...(windowsSnapshotObserver ? { windowsSnapshotObserver } : {}),
        }),
      );
    }),
  );
}

type ObservedTeardownOutcome = { readonly error?: never } | { readonly error: unknown };

function observeProcessTreeTeardown(): {
  readonly completed: Promise<ObservedTeardownOutcome>;
  readonly teardown: NonNullable<AcpSessionRuntimeOptions["teardownProcessTree"]>;
  readonly calls: () => number;
} {
  let calls = 0;
  // A teardown can fail before the test reaches its await. Own that outcome
  // immediately without creating a detached rejected promise; the await below
  // rethrows the original failure and the runtime finalizer still rejects.
  let markCompleted!: (outcome: ObservedTeardownOutcome) => void;
  const completed = new Promise<ObservedTeardownOutcome>((resolve) => {
    markCompleted = resolve;
  });
  return {
    completed,
    calls: () => calls,
    teardown: async (input, dependencies) => {
      calls += 1;
      try {
        const result = await teardownProviderProcessTree(input, dependencies);
        markCompleted({});
        return result;
      } catch (error) {
        markCompleted({ error });
        throw error;
      }
    },
  };
}

function awaitObservedTeardown(
  observed: ReturnType<typeof observeProcessTreeTeardown>,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        void observed.completed.then((outcome) => {
          signal.removeEventListener("abort", onAbort);
          if ("error" in outcome) reject(outcome.error);
          else resolve();
        });
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.orDie);
}

function isEarlyNewDecodedNotification(event: AcpProtocolLogEvent): boolean {
  if (
    event.direction !== "incoming" ||
    event.stage !== "decoded" ||
    typeof event.payload !== "object" ||
    event.payload === null
  ) {
    return false;
  }
  const payload = event.payload as {
    readonly update?: {
      readonly sessionUpdate?: unknown;
      readonly content?: {
        readonly type?: unknown;
        readonly text?: unknown;
      };
    };
  };
  return (
    payload.update?.sessionUpdate === "agent_message_chunk" &&
    payload.update.content?.type === "text" &&
    payload.update.content.text === "early-new"
  );
}

function isDecodedSessionUpdateNotification(event: AcpProtocolLogEvent): boolean {
  if (
    event.direction !== "incoming" ||
    event.stage !== "decoded" ||
    typeof event.payload !== "object" ||
    event.payload === null
  ) {
    return false;
  }
  const payload = event.payload as {
    readonly update?: {
      readonly sessionUpdate?: unknown;
    };
  };
  return typeof payload.update?.sessionUpdate === "string";
}

function isDecodedNewSessionResponse(event: AcpProtocolLogEvent): boolean {
  if (
    event.direction !== "incoming" ||
    event.stage !== "decoded" ||
    typeof event.payload !== "object" ||
    event.payload === null
  ) {
    return false;
  }
  const payload = event.payload as {
    readonly method?: unknown;
    readonly result?: unknown;
  };
  return payload.method === "session/new" && payload.result !== undefined;
}

function isDecodedPromptResponse(event: AcpProtocolLogEvent): boolean {
  if (
    event.direction !== "incoming" ||
    event.stage !== "decoded" ||
    typeof event.payload !== "object" ||
    event.payload === null
  ) {
    return false;
  }
  const payload = event.payload as {
    readonly method?: unknown;
    readonly result?: unknown;
  };
  return payload.method === "session/prompt" && payload.result !== undefined;
}

function isPostPromptDecodedNotification(event: AcpProtocolLogEvent): boolean {
  if (!isDecodedSessionUpdateNotification(event)) {
    return false;
  }
  const payload = event.payload as {
    readonly update?: {
      readonly content?: {
        readonly type?: unknown;
        readonly text?: unknown;
      };
    };
  };
  return (
    payload.update?.content?.type === "text" &&
    typeof payload.update.content.text === "string" &&
    payload.update.content.text.startsWith("post-prompt-")
  );
}

function isResponseBoundaryDecodedNotification(
  event: AcpProtocolLogEvent,
  label: "first" | "second",
): boolean {
  if (!isDecodedSessionUpdateNotification(event)) {
    return false;
  }
  const payload = event.payload as {
    readonly update?: {
      readonly content?: {
        readonly type?: unknown;
        readonly text?: unknown;
      };
    };
  };
  return (
    payload.update?.content?.type === "text" &&
    payload.update.content.text === `response-boundary-${label}`
  );
}

function isResponseBoundaryDecodedResponse(
  event: AcpProtocolLogEvent,
  label: "first" | "second",
): boolean {
  if (
    event.direction !== "incoming" ||
    event.stage !== "decoded" ||
    typeof event.payload !== "object" ||
    event.payload === null
  ) {
    return false;
  }
  const payload = event.payload as {
    readonly method?: unknown;
    readonly result?: {
      readonly label?: unknown;
    };
  };
  return payload.method === "conformance/response-boundary" && payload.result?.label === label;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("official ACP SDK conformance at the current Moss boundary", () => {
  it.live("negotiates initialize and authentication using official SDK handlers", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started).toMatchObject({
        sessionId: "official-sdk-session-1",
        sessionSetupMethod: "new",
        initializeResult: {
          protocolVersion: 1,
          authMethods: [{ id: "test", name: "Test authentication" }],
        },
      });
      expect(started.initializeResult._meta).toEqual({
        primitive: "initialize-meta",
        nested: { source: "official-sdk" },
      });
      expect(started.sessionSetupResult._meta).toEqual({
        primitive: 7,
        nested: { phase: "new" },
      });

      const entries = readFixtureLog(logPath);
      expect(entries.map((entry) => entry.type)).toEqual([
        "initialize",
        "authenticate",
        "session/new",
      ]);
      expect(entries[0]?.payload).toMatchObject({
        protocolVersion: 1,
        clientInfo: { name: "moss-conformance-test", version: "0.0.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: {
            primitive: "client-meta",
            nested: { source: "moss" },
          },
        },
      });
      expect(entries[1]?.payload).toEqual({
        methodId: "test",
        _meta: {
          primitive: 11,
          nested: { source: "moss-auth" },
        },
      });
    }).pipe(
      Effect.provide(runtimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("preserves early session updates and prompt update ordering", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const earlyUpdateEntered = yield* Deferred.make<void>();
      const releaseEarlyUpdate = yield* Deferred.make<void>();
      const journey = Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* runtime.start().pipe(Effect.timeout("10 seconds"));

        const result = yield* runtime
          .prompt({
            prompt: [{ type: "text", text: "continue" }],
          })
          .pipe(Effect.timeout("10 seconds"));
        const events = Array.from(
          yield* Stream.runCollect(Stream.take(runtime.getEvents(), 7)).pipe(
            Effect.timeout("10 seconds"),
          ),
        );

        expect(result).toEqual({ stopReason: "end_turn" });
        expect(events.map((event) => event._tag)).toEqual([
          "AssistantItemStarted",
          "ContentDelta",
          "AssistantItemCompleted",
          "AssistantItemStarted",
          "ContentDelta",
          "ContentDelta",
          "AssistantItemCompleted",
        ]);
        expect(
          events.flatMap((event) => (event._tag === "ContentDelta" ? [event.text] : [])),
        ).toEqual(["early-new", "prompt-one", "prompt-two"]);
      }).pipe(
        Effect.provide(
          runtimeLayer(
            logPath,
            {},
            {
              logIncoming: true,
              logger: (event) =>
                isEarlyNewDecodedNotification(event)
                  ? Deferred.succeed(earlyUpdateEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseEarlyUpdate)),
                    )
                  : Effect.void,
            },
          ),
        ),
      );

      const journeyFiber = yield* Effect.forkScoped(journey);
      yield* Deferred.await(earlyUpdateEntered).pipe(Effect.timeout("10 seconds"));
      expect(journeyFiber.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(releaseEarlyUpdate, undefined);
      yield* Fiber.join(journeyFiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  });

  it.live(
    "fails a response-boundary drain when the connection closes before an observed update settles",
    () => {
      const logPath = createFixtureLog();
      return Effect.gen(function* () {
        const earlyUpdateEntered = yield* Deferred.make<void>();
        const releaseEarlyUpdate = yield* Deferred.make<void>();
        const newResponseObserved = yield* Deferred.make<void>();
        const start = Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime;
          return yield* runtime.start();
        }).pipe(
          Effect.provide(
            runtimeLayer(
              logPath,
              {
                MOSS_ACP_CONFORMANCE_EXIT_AFTER_NEW_RESPONSE: "1",
              },
              {
                logIncoming: true,
                logger: (event) => {
                  if (isEarlyNewDecodedNotification(event)) {
                    return Deferred.succeed(earlyUpdateEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseEarlyUpdate)),
                    );
                  }
                  return isDecodedNewSessionResponse(event)
                    ? Deferred.succeed(newResponseObserved, undefined).pipe(Effect.asVoid)
                    : Effect.void;
                },
              },
            ),
          ),
        );

        const startFiber = yield* Effect.forkScoped(start);
        yield* Deferred.await(earlyUpdateEntered).pipe(Effect.timeout("10 seconds"));
        yield* Deferred.await(newResponseObserved).pipe(Effect.timeout("10 seconds"));
        const startExit = yield* Fiber.join(startFiber).pipe(
          Effect.timeout("10 seconds"),
          Effect.exit,
          Effect.ensuring(Deferred.succeed(releaseEarlyUpdate, undefined)),
        );

        expect(Exit.isFailure(startExit)).toBe(true);
        if (Exit.isFailure(startExit)) {
          expect(Cause.squash(startExit.cause)).toMatchObject({
            _tag: "AcpTransportError",
          });
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    },
  );

  it.live("retains an undefined session-update failure sentinel", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const error = yield* runtime.start().pipe(Effect.timeout("2 seconds"), Effect.flip);
      expect(error).toMatchObject({
        _tag: "AcpTransportError",
      });
    }).pipe(
      Effect.provide(
        runtimeLayer(
          logPath,
          {},
          {
            logIncoming: true,
            logger: (event) => {
              if (isEarlyNewDecodedNotification(event)) {
                const undefinedFailure: unknown = undefined;
                throw undefinedFailure;
              }
              return Effect.void;
            },
          },
        ),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("lets a consumer attach after a session/new update burst fills the queue", () => {
    const logPath = createFixtureLog();
    const earlyUpdateCount = 2_050;
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start().pipe(Effect.timeout("15 seconds"));

      const events = Array.from(
        yield* Stream.runCollect(Stream.take(runtime.getEvents(), earlyUpdateCount + 1)).pipe(
          Effect.timeout("15 seconds"),
        ),
      );

      expect(events).toHaveLength(earlyUpdateCount + 1);
      expect(events[0]?._tag).toBe("AssistantItemStarted");
      expect(events.slice(1).every((event) => event._tag === "ContentDelta")).toBe(true);
    }).pipe(
      Effect.provide(
        runtimeLayer(logPath, {
          MOSS_ACP_CONFORMANCE_EARLY_UPDATE_COUNT: String(earlyUpdateCount),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("prompts before a consumer attaches after a session/new update burst", () => {
    const logPath = createFixtureLog();
    const earlyUpdateCount = 2_050;
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start().pipe(Effect.timeout("15 seconds"));

      const result = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "continue" }],
        })
        .pipe(Effect.timeout("15 seconds"));
      const events = Array.from(
        yield* Stream.runCollect(Stream.take(runtime.getEvents(), earlyUpdateCount + 6)).pipe(
          Effect.timeout("15 seconds"),
        ),
      );

      expect(result).toEqual({ stopReason: "end_turn" });
      expect(events).toHaveLength(earlyUpdateCount + 6);
      expect(events[0]?._tag).toBe("AssistantItemStarted");
      expect(
        events.slice(1, earlyUpdateCount + 1).every((event) => event._tag === "ContentDelta"),
      ).toBe(true);
      expect(events[earlyUpdateCount + 1]?._tag).toBe("AssistantItemCompleted");
      expect(events[earlyUpdateCount + 2]?._tag).toBe("AssistantItemStarted");
      expect(events[earlyUpdateCount + 5]?._tag).toBe("AssistantItemCompleted");
      expect(
        events.flatMap((event) => (event._tag === "ContentDelta" ? [event.text] : [])).slice(-2),
      ).toEqual(["prompt-one", "prompt-two"]);
    }).pipe(
      Effect.provide(
        runtimeLayer(logPath, {
          MOSS_ACP_CONFORMANCE_EARLY_UPDATE_COUNT: String(earlyUpdateCount),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("preserves updates emitted during and immediately after session/resume", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start().pipe(Effect.timeout("10 seconds"));

      expect(started).toMatchObject({
        sessionId: "official-sdk-session-1",
        sessionSetupMethod: "resume",
      });

      const events = Array.from(
        yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)).pipe(
          Effect.timeout("10 seconds"),
        ),
      );
      expect(events.map((event) => event._tag)).toEqual([
        "ModeChanged",
        "AssistantItemStarted",
        "ContentDelta",
        "ContentDelta",
      ]);
      expect(
        events.flatMap((event) => (event._tag === "ModeChanged" ? [event.modeId] : [])),
      ).toEqual(["resume-mode"]);
      const contentEvents = events.filter((event) => event._tag === "ContentDelta");
      expect(contentEvents.map((event) => event.text)).toEqual(["resume-during", "resume-after"]);
      expect(contentEvents[0]?.itemId).toBe(contentEvents[1]?.itemId);
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toEqual([
        "initialize",
        "authenticate",
        "session/resume",
        "session/resume/post-response-update",
      ]);
    }).pipe(
      Effect.provide(
        runtimeLayer(
          logPath,
          {
            MOSS_ACP_CONFORMANCE_RESUME_UPDATES: "1",
          },
          undefined,
          undefined,
          "official-sdk-session-1",
        ),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live(
    "interrupts an attached resume publish when its lifetime consumer releases over capacity",
    () => {
      const logPath = createFixtureLog();
      const observedTeardown = observeProcessTreeTeardown();
      const resumeUpdateCount = 3_000;
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const consumerFiber = yield* Stream.runHead(runtime.getEvents()).pipe(
          Effect.exit,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        const startFiber = yield* runtime.start().pipe(Effect.exit, Effect.forkChild);
        const consumerExit = yield* Fiber.join(consumerFiber).pipe(Effect.timeout("10 seconds"));
        expect(Exit.isSuccess(consumerExit)).toBe(true);

        const startExit = yield* Fiber.join(startFiber).pipe(Effect.timeout("10 seconds"));
        expect(Exit.isFailure(startExit)).toBe(true);
        if (Exit.isFailure(startExit)) {
          expect(Cause.squash(startExit.cause)).toMatchObject({
            _tag: "AcpTransportError",
            detail: expect.stringContaining("lifetime event consumer"),
          });
        }
        yield* awaitObservedTeardown(observedTeardown).pipe(Effect.timeout("5 seconds"));
        expect(observedTeardown.calls()).toBe(1);
      }).pipe(
        Effect.provide(
          runtimeLayer(
            logPath,
            {
              MOSS_ACP_CONFORMANCE_RESUME_UPDATE_COUNT: String(resumeUpdateCount),
            },
            undefined,
            observedTeardown.teardown,
            "official-sdk-session-1",
          ),
        ),
        Effect.scoped,
        Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
        Effect.provide(NodeServices.layer),
      );
    },
    20_000,
  );

  it.live(
    "does not chase a post-response resume batch beyond the finite causal boundary",
    () => {
      const logPath = createFixtureLog();
      const resumeUpdateCount = 3_000;
      // Keep this later batch below the dispatcher backlog cap: this test
      // isolates the finite response boundary; the next test covers overflow.
      const postResponseUpdateCount = 1_000;
      const takesRequiredToFreeFirstPublish = resumeUpdateCount + 1 - 2_048;
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const firstConsumerPause = yield* Deferred.make<void>();
        const releaseFirstConsumerPause = yield* Deferred.make<void>();
        const secondConsumerPause = yield* Deferred.make<void>();
        const releaseSecondConsumerPause = yield* Deferred.make<void>();
        const burstStarted = yield* Deferred.make<void>();
        const burstComplete = yield* Deferred.make<void>();
        let eventsTaken = 0;
        yield* runtime.handleExtNotification(
          "conformance/resume-post-response-burst-started",
          Schema.Unknown,
          () => Deferred.succeed(burstStarted, undefined).pipe(Effect.asVoid),
        );
        yield* runtime.handleExtNotification(
          "conformance/resume-post-response-burst-complete",
          Schema.Unknown,
          () => Deferred.succeed(burstComplete, undefined).pipe(Effect.asVoid),
        );
        yield* runtime.getEvents().pipe(
          Stream.tap(() =>
            Effect.suspend(() => {
              eventsTaken += 1;
              return eventsTaken === 100
                ? Deferred.succeed(firstConsumerPause, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstConsumerPause)),
                  )
                : eventsTaken === takesRequiredToFreeFirstPublish
                  ? Deferred.succeed(secondConsumerPause, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseSecondConsumerPause)),
                    )
                  : Effect.void;
            }),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        const startFiber = yield* runtime.start().pipe(Effect.forkChild);
        yield* Deferred.await(firstConsumerPause).pipe(Effect.timeout("10 seconds"));
        yield* runtime.notify("conformance/start-resume-post-response-burst", {
          count: postResponseUpdateCount,
        });
        yield* Deferred.await(burstStarted).pipe(Effect.timeout("2 seconds"));
        yield* Deferred.await(burstComplete).pipe(Effect.timeout("10 seconds"));
        yield* Deferred.succeed(releaseFirstConsumerPause, undefined);
        yield* Deferred.await(secondConsumerPause).pipe(Effect.timeout("2 seconds"));
        const started = yield* Fiber.join(startFiber).pipe(Effect.timeout("3 seconds"));
        expect(started).toMatchObject({
          sessionId: "official-sdk-session-1",
          sessionSetupMethod: "resume",
        });
        expect(eventsTaken).toBe(takesRequiredToFreeFirstPublish);
        yield* Deferred.succeed(releaseSecondConsumerPause, undefined);
      }).pipe(
        Effect.provide(
          runtimeLayer(
            logPath,
            {
              MOSS_ACP_CONFORMANCE_RESUME_UPDATE_COUNT: String(resumeUpdateCount),
            },
            undefined,
            undefined,
            "official-sdk-session-1",
          ),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
    },
    20_000,
  );

  it.live(
    "settles start under bounded post-response pressure, then fails closed on an armed live flood",
    () => {
      const logPath = createFixtureLog();
      const observedTeardown = observeProcessTreeTeardown();
      const resumeUpdateCount = 3_000;
      const takesRequiredToFreeFirstPublish = resumeUpdateCount + 1 - 2_048;
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const firstConsumerPause = yield* Deferred.make<void>();
        const releaseFirstConsumerPause = yield* Deferred.make<void>();
        const secondConsumerPause = yield* Deferred.make<void>();
        const releaseSecondConsumerPause = yield* Deferred.make<void>();
        const postResponsePressureReady = yield* Deferred.make<void>();
        let eventsTaken = 0;
        yield* runtime.handleExtNotification(
          "conformance/resume-post-response-flood-started",
          Schema.Unknown,
          () => Deferred.succeed(postResponsePressureReady, undefined).pipe(Effect.asVoid),
        );
        const consumerFiber = yield* runtime.getEvents().pipe(
          Stream.tap(() =>
            Effect.suspend(() => {
              eventsTaken += 1;
              return eventsTaken === 100
                ? Deferred.succeed(firstConsumerPause, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstConsumerPause)),
                  )
                : eventsTaken === takesRequiredToFreeFirstPublish
                  ? Deferred.succeed(secondConsumerPause, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseSecondConsumerPause)),
                    )
                  : Effect.void;
            }),
          ),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        const startFiber = yield* runtime.start().pipe(Effect.forkChild);
        yield* Deferred.await(firstConsumerPause).pipe(Effect.timeout("10 seconds"));
        yield* runtime.notify("conformance/start-resume-post-response-flood", {});
        yield* Deferred.await(postResponsePressureReady).pipe(Effect.timeout("10 seconds"));
        yield* Deferred.succeed(releaseFirstConsumerPause, undefined);
        yield* Deferred.await(secondConsumerPause).pipe(Effect.timeout("2 seconds"));
        const started = yield* Fiber.join(startFiber).pipe(Effect.timeout("3 seconds"));
        expect(started.sessionSetupMethod).toBe("resume");

        // Arm only after start settles; share the original cleanup budget with this write.
        yield* runtime
          .notify("conformance/start-update-flood", {
            prefix: "resume-post-response-forever",
          })
          .pipe(
            Effect.andThen(awaitObservedTeardown(observedTeardown)),
            Effect.timeout("10 seconds"),
          );
        yield* Deferred.succeed(releaseSecondConsumerPause, undefined);
        const consumerExit = yield* Fiber.join(consumerFiber).pipe(
          Effect.timeout("2 seconds"),
          Effect.exit,
        );
        expect(Exit.isFailure(consumerExit)).toBe(true);
        const poisonedRequestError = yield* runtime
          .request("conformance/echo", { source: "continuous-resume-flood" })
          .pipe(Effect.timeout("2 seconds"), Effect.flip);
        expect(poisonedRequestError).toMatchObject({
          _tag: "AcpTransportError",
          detail: expect.stringContaining("bounded live session/update delivery backlog"),
        });
        expect(observedTeardown.calls()).toBe(1);
      }).pipe(
        Effect.provide(
          runtimeLayer(
            logPath,
            {
              MOSS_ACP_CONFORMANCE_RESUME_UPDATE_COUNT: String(resumeUpdateCount),
            },
            undefined,
            observedTeardown.teardown,
            "official-sdk-session-1",
          ),
        ),
        Effect.scoped,
        Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
        Effect.provide(NodeServices.layer),
      );
    },
    20_000,
  );

  it.live(
    "fails closed when causal resume notifications exceed the transaction-wide cap",
    () => {
      const logPath = createFixtureLog();
      const observedTeardown = observeProcessTreeTeardown();
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* Stream.runDrain(runtime.getEvents()).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const error = yield* runtime.start().pipe(Effect.timeout("15 seconds"), Effect.flip);
        expect(error).toMatchObject({
          _tag: "AcpTransportError",
          detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
            // or the upstream memory-budget backlog guards may trip first in a flood).
            expect.stringMatching(
              /bounded startup event buffer|backlog exceeded its memory budget/,
            ),
        });
        yield* awaitObservedTeardown(observedTeardown).pipe(Effect.timeout("5 seconds"));
        expect(observedTeardown.calls()).toBe(1);
      }).pipe(
        Effect.provide(
          runtimeLayer(
            logPath,
            {
              MOSS_ACP_CONFORMANCE_RESUME_UPDATE_COUNT: String(ACP_PRE_ATTACH_EVENT_CAPACITY + 64),
            },
            undefined,
            observedTeardown.teardown,
            "official-sdk-session-1",
          ),
        ),
        Effect.scoped,
        Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
        Effect.provide(NodeServices.layer),
      );
    },
    20_000,
  );

  it.live(
    "fails closed when causal resume notification bytes exceed the transaction-wide cap",
    () => {
      const logPath = createFixtureLog();
      const observedTeardown = observeProcessTreeTeardown();
      const resumeUpdateCount = 3;
      const resumeUpdateTextBytes = 6 * 1024 * 1024;
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* Stream.runDrain(runtime.getEvents()).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const error = yield* runtime.start().pipe(Effect.timeout("15 seconds"), Effect.flip);
        expect(resumeUpdateCount).toBeLessThan(ACP_PRE_ATTACH_EVENT_CAPACITY);
        expect(resumeUpdateCount * resumeUpdateTextBytes).toBeGreaterThan(
          ACP_PRE_ATTACH_EVENT_MAX_BYTES,
        );
        expect(error).toMatchObject({
          _tag: "AcpTransportError",
          detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
            // or the upstream memory-budget backlog guards may trip first in a flood).
            expect.stringMatching(
              /bounded startup event buffer|backlog exceeded its memory budget/,
            ),
        });
        yield* awaitObservedTeardown(observedTeardown).pipe(Effect.timeout("5 seconds"));
        expect(observedTeardown.calls()).toBe(1);
      }).pipe(
        Effect.provide(
          runtimeLayer(
            logPath,
            {
              MOSS_ACP_CONFORMANCE_RESUME_UPDATE_COUNT: String(resumeUpdateCount),
              MOSS_ACP_CONFORMANCE_RESUME_UPDATE_TEXT_BYTES: String(resumeUpdateTextBytes),
            },
            undefined,
            observedTeardown.teardown,
            "official-sdk-session-1",
          ),
        ),
        Effect.scoped,
        Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
        Effect.provide(NodeServices.layer),
      );
    },
    20_000,
  );

  it.live("retains bounded setup state emitted before resume without an event consumer", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start().pipe(Effect.timeout("10 seconds"));

      expect(started).toMatchObject({
        sessionId: "official-sdk-session-1",
        sessionSetupMethod: "resume",
        modelConfigId: "pre-resume-model",
        sessionSetupResult: {
          modes: { currentModeId: "pre-resume-mode" },
          configOptions: [{ id: "pre-resume-model" }],
        },
      });
      expect(yield* runtime.getModeState).toMatchObject({
        currentModeId: "pre-resume-mode",
      });
      expect((yield* runtime.getConfigOptions).map((option) => option.id)).toEqual([
        "pre-resume-model",
      ]);
      expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(0);
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toEqual([
        "initialize",
        "authenticate",
        "session/resume",
      ]);
    }).pipe(
      Effect.provide(
        runtimeLayer(
          logPath,
          {
            MOSS_ACP_CONFORMANCE_PRE_RESUME_CONFIG_UPDATE: "1",
            MOSS_ACP_CONFORMANCE_PRE_RESUME_MODE_UPDATE: "1",
          },
          undefined,
          undefined,
          "official-sdk-session-1",
        ),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("rolls back a failed resume and makes the ambiguous runtime terminal", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const initialEnqueued = yield* runtime.sessionUpdatesEnqueuedCount;
      const firstError = yield* runtime.start().pipe(Effect.timeout("10 seconds"), Effect.flip);
      expect(firstError._tag).toBe("AcpRequestError");
      const enqueuedAfterFailure = yield* runtime.sessionUpdatesEnqueuedCount;
      expect(enqueuedAfterFailure).toBe(0);
      expect(yield* runtime.getModeState).toBeUndefined();
      expect(yield* runtime.getAvailableCommands).toEqual([]);
      expect((yield* runtime.getConfigOptions).map((option) => option.id)).toEqual([
        "pre-resume-model",
      ]);

      const retryError = yield* runtime.start().pipe(Effect.timeout("2 seconds"), Effect.flip);
      expect(retryError).toMatchObject({
        _tag: "AcpTransportError",
        detail: expect.stringContaining("cannot be retried safely"),
      });
      expect(yield* runtime.getAvailableCommands).toEqual([]);
      expect((yield* runtime.getConfigOptions).map((option) => option.id)).toEqual([
        "pre-resume-model",
      ]);
      expect([initialEnqueued, enqueuedAfterFailure]).toEqual([0, 0]);
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toEqual([
        "initialize",
        "authenticate",
        "session/resume",
      ]);
    }).pipe(
      Effect.provide(
        runtimeLayer(
          logPath,
          {
            MOSS_ACP_CONFORMANCE_FAIL_FIRST_RESUME_AFTER_UPDATE: "1",
            MOSS_ACP_CONFORMANCE_PRE_RESUME_CONFIG_UPDATE: "1",
            MOSS_ACP_CONFORMANCE_PRE_RESUME_MODE_UPDATE: "1",
          },
          undefined,
          undefined,
          "official-sdk-session-1",
        ),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("quarantines delayed failed-resume state instead of reopening intake for a retry", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const initialEnqueued = yield* runtime.sessionUpdatesEnqueuedCount;
      const eventsFiber = yield* Stream.runDrain(runtime.getEvents()).pipe(
        Effect.exit,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const firstStartFiber = yield* runtime
        .start()
        .pipe(Effect.timeout("10 seconds"), Effect.flip, Effect.forkChild);
      yield* waitForFixtureLogType(logPath, "session/resume");

      const firstError = yield* Fiber.join(firstStartFiber);
      expect(firstError._tag).toBe("AcpRequestError");
      const enqueuedAfterFailure = yield* runtime.sessionUpdatesEnqueuedCount;
      expect(enqueuedAfterFailure).toBe(initialEnqueued);
      expect(yield* runtime.getModeState).toBeUndefined();
      expect(yield* runtime.getAvailableCommands).toEqual([]);
      expect(yield* runtime.getConfigOptions).toEqual([]);

      const retryError = yield* runtime.start().pipe(Effect.timeout("2 seconds"), Effect.flip);
      expect(retryError).toMatchObject({
        _tag: "AcpTransportError",
        detail: expect.stringContaining("cannot be retried safely"),
      });
      yield* waitForFixtureLogType(logPath, "session/resume/delayed-failed-updates");
      const eventsExit = yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds"));
      expect(Exit.isFailure(eventsExit)).toBe(true);
      if (Exit.isFailure(eventsExit)) {
        expect(Cause.squash(eventsExit.cause)).toMatchObject({
          _tag: "AcpTransportError",
          detail: expect.stringContaining("cannot be retried safely"),
        });
      }
      yield* waitForRealMilliseconds(100);
      const enqueuedAfterDelayedUpdates = yield* runtime.sessionUpdatesEnqueuedCount;
      expect([initialEnqueued, enqueuedAfterFailure, enqueuedAfterDelayedUpdates]).toEqual([
        0, 0, 0,
      ]);
      expect(yield* runtime.getAvailableCommands).toEqual([]);
      expect(yield* runtime.getModeState).toBeUndefined();
      expect(yield* runtime.getConfigOptions).toEqual([]);
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toEqual([
        "initialize",
        "authenticate",
        "session/resume",
        "session/resume/delayed-failed-updates",
      ]);
    }).pipe(
      Effect.provide(
        runtimeLayer(
          logPath,
          {
            MOSS_ACP_CONFORMANCE_FAIL_FIRST_RESUME_AFTER_UPDATE: "1",
            MOSS_ACP_CONFORMANCE_FAIL_FIRST_RESUME_DELAY_MS: "250",
            MOSS_ACP_CONFORMANCE_DELAYED_FAILED_RESUME_UPDATES: "1",
            MOSS_ACP_CONFORMANCE_RESUME_STATE_UPDATES: "1",
          },
          undefined,
          undefined,
          "official-sdk-session-1",
        ),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("retains a current-mode update after session/load while the event gate is closed", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start().pipe(Effect.timeout("10 seconds"));

      expect(started).toMatchObject({
        sessionId: "official-sdk-session-1",
        sessionSetupMethod: "load",
        sessionSetupResult: {
          modes: { currentModeId: "load-mode-before" },
        },
      });
      expect(yield* runtime.getModeState).toMatchObject({
        currentModeId: "load-mode-before",
      });
      expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(0);

      yield* waitForFixtureLogType(logPath, "session/load/post-response-mode-update");
      yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "drain closed-gate mode state" }],
        })
        .pipe(Effect.timeout("10 seconds"));

      expect(yield* runtime.getModeState).toMatchObject({
        currentModeId: "load-mode-after",
      });
      expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(0);
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toEqual([
        "initialize",
        "authenticate",
        "session/load",
        "session/load/post-response-mode-update",
        "session/prompt",
      ]);
    }).pipe(
      Effect.provide(
        runtimeLayer(
          logPath,
          {
            MOSS_ACP_CONFORMANCE_LOAD_MODE_UPDATE_AFTER_RESPONSE: "1",
          },
          undefined,
          undefined,
          "official-sdk-session-1",
        ),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("preserves closed-gate mode admission when getEvents opens before delivery", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const firstModeHandlerStarted = yield* Deferred.make<void>();
      const releaseFirstModeHandler = yield* Deferred.make<void>();
      const modeUpdatesAdmitted = yield* Deferred.make<void>();
      const liveEventSeen = yield* Deferred.make<void>();
      let handledModeUpdates = 0;

      yield* runtime.handleSessionUpdate((notification) =>
        Effect.suspend(() => {
          if (notification.update.sessionUpdate !== "current_mode_update") {
            return Effect.void;
          }
          handledModeUpdates += 1;
          if (handledModeUpdates !== 1) {
            return Effect.void;
          }
          return Deferred.succeed(firstModeHandlerStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstModeHandler)),
            Effect.asVoid,
          );
        }),
      );
      yield* runtime.handleExtNotification(
        "conformance/load-mode-updates-admitted",
        Schema.Unknown,
        () => Deferred.succeed(modeUpdatesAdmitted, undefined).pipe(Effect.asVoid),
      );

      const started = yield* runtime.start().pipe(Effect.timeout("10 seconds"));
      expect(started).toMatchObject({
        sessionSetupMethod: "load",
        sessionSetupResult: {
          modes: { currentModeId: "load-mode-before" },
        },
      });
      yield* Deferred.await(firstModeHandlerStarted).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(modeUpdatesAdmitted).pipe(Effect.timeout("5 seconds"));

      // Admission for both updates happened while the load replay gate was
      // closed. Opening it now must not reclassify the queued second update.
      const eventsFiber = yield* runtime.getEvents().pipe(
        Stream.tap(() => Deferred.succeed(liveEventSeen, undefined)),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      expect(eventsFiber.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(releaseFirstModeHandler, undefined);

      let observedFinalMode = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const modeState = yield* runtime.getModeState;
        if (modeState?.currentModeId === "load-mode-after") {
          observedFinalMode = true;
          break;
        }
        yield* waitForRealMilliseconds(10);
      }
      expect(observedFinalMode).toBe(true);
      expect(handledModeUpdates).toBe(2);
      expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(0);
      yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "prove the load-gate consumer is subscribed" }],
        })
        .pipe(Effect.timeout("10 seconds"));
      yield* Deferred.await(liveEventSeen).pipe(Effect.timeout("2 seconds"));
      expect(eventsFiber.pollUnsafe()).toBeUndefined();
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toEqual([
        "initialize",
        "authenticate",
        "session/load",
        "session/load/mode-admission-race-ready",
        "session/prompt",
      ]);
    }).pipe(
      Effect.provide(
        runtimeLayer(
          logPath,
          {
            MOSS_ACP_CONFORMANCE_LOAD_MODE_ADMISSION_RACE: "1",
          },
          undefined,
          undefined,
          "official-sdk-session-1",
        ),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("drops a session/load replay larger than the fresh-session startup cap", () => {
    const logPath = createFixtureLog();
    const replayUpdateCount = ACP_PRE_ATTACH_EVENT_CAPACITY + 64;
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start().pipe(Effect.timeout("15 seconds"));

      expect(started).toMatchObject({
        sessionId: "official-sdk-session-1",
        sessionSetupMethod: "load",
      });
      expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(0);

      const eventsFiber = yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)).pipe(
        Effect.timeout("15 seconds"),
        Effect.forkChild,
      );
      const promptResult = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "continue" }],
        })
        .pipe(Effect.timeout("15 seconds"));
      const events = Array.from(yield* Fiber.join(eventsFiber));

      expect(promptResult).toEqual({ stopReason: "end_turn" });
      expect(events.map((event) => event._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      expect(
        events.flatMap((event) => (event._tag === "ContentDelta" ? [event.text] : [])),
      ).toEqual(["prompt-one", "prompt-two"]);
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toEqual([
        "initialize",
        "authenticate",
        "session/load",
        "session/prompt",
      ]);
    }).pipe(
      Effect.provide(
        runtimeLayer(
          logPath,
          {
            MOSS_ACP_CONFORMANCE_LOAD_REPLAY_UPDATE_COUNT: String(replayUpdateCount),
          },
          undefined,
          undefined,
          "official-sdk-session-1",
        ),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live(
    "fails closed on an accepted zero-event state flood before session/load responds",
    () => {
      const logPath = createFixtureLog();
      const observedTeardown = observeProcessTreeTeardown();
      const stateUpdateCount = ACP_PRE_ATTACH_EVENT_CAPACITY + 64;
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const error = yield* runtime.start().pipe(Effect.timeout("15 seconds"), Effect.flip);

        // Fail-closed is what matters: either the Moss bounded-startup-buffer guard
        // or the upstream memory-budget backlog guard may trip first in a flood.
        expect(error).toMatchObject({
          _tag: "AcpTransportError",
          detail: expect.stringMatching(
            /bounded startup event buffer|backlog exceeded its memory budget/,
          ),
        });
        yield* awaitObservedTeardown(observedTeardown).pipe(Effect.timeout("5 seconds"));
        expect(observedTeardown.calls()).toBe(1);
        expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(0);
        expect(readFixtureLog(logPath).map((entry) => entry.type)).toContain("session/load");

        const retryError = yield* runtime.start().pipe(Effect.timeout("1 second"), Effect.flip);
        expect(retryError).toBe(error);
      }).pipe(
        Effect.provide(
          runtimeLayer(
            logPath,
            {
              MOSS_ACP_CONFORMANCE_LOAD_REPLAY_UPDATE_COUNT: "1",
              MOSS_ACP_CONFORMANCE_PRE_LOAD_STATE_UPDATE_COUNT: String(stateUpdateCount),
            },
            undefined,
            observedTeardown.teardown,
            "official-sdk-session-1",
          ),
        ),
        Effect.scoped,
        Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
        Effect.provide(NodeServices.layer),
      );
    },
    20_000,
  );

  it.live(
    "keeps getEvents lazy and fails a pre-initialize zero-event state flood boundedly",
    () => {
      const logPath = createFixtureLog();
      const observedTeardown = observeProcessTreeTeardown();
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const unconsumedEvents = runtime.getEvents();

        const error = yield* runtime.start().pipe(Effect.timeout("15 seconds"), Effect.flip);
        expect(error).toMatchObject({
          _tag: "AcpTransportError",
          detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
            // or the upstream memory-budget backlog guards may trip first in a flood).
            expect.stringMatching(
              /bounded startup event buffer|backlog exceeded its memory budget/,
            ),
        });
        yield* awaitObservedTeardown(observedTeardown).pipe(Effect.timeout("5 seconds"));
        expect(observedTeardown.calls()).toBe(1);
        expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(0);

        const streamExit = yield* Stream.runDrain(unconsumedEvents).pipe(
          Effect.timeout("2 seconds"),
          Effect.exit,
        );
        expect(Exit.isFailure(streamExit)).toBe(true);
        if (Exit.isFailure(streamExit)) {
          const streamError = Cause.squash(streamExit.cause) as {
            readonly _tag?: unknown;
            readonly detail?: unknown;
          };
          expect(streamError._tag).toBe("AcpTransportError");
        }

        const retryError = yield* runtime.start().pipe(Effect.timeout("1 second"), Effect.flip);
        expect(retryError).toMatchObject({
          _tag: "AcpTransportError",
          detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
            // or the upstream memory-budget backlog guards may trip first in a flood).
            expect.stringMatching(
              /bounded startup event buffer|backlog exceeded its memory budget/,
            ),
        });
        const poisonedRequestError = yield* runtime
          .request("conformance/echo", { source: "pre-initialize-poison" })
          .pipe(Effect.timeout("1 second"), Effect.flip);
        expect(poisonedRequestError).toMatchObject({
          _tag: "AcpTransportError",
          detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
            // or the upstream memory-budget backlog guards may trip first in a flood).
            expect.stringMatching(
              /bounded startup event buffer|backlog exceeded its memory budget/,
            ),
        });
      }).pipe(
        Effect.provide(
          runtimeLayer(
            logPath,
            {
              MOSS_ACP_CONFORMANCE_PRE_INITIALIZE_STATE_UPDATES_FOREVER: "1",
            },
            undefined,
            observedTeardown.teardown,
          ),
        ),
        Effect.scoped,
        Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
        Effect.provide(NodeServices.layer),
      );
    },
    20_000,
  );

  it.live(
    "fails closed when the unique lifetime event consumer ends after a short subscription",
    () => {
      const logPath = createFixtureLog();
      const observedTeardown = observeProcessTreeTeardown();
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const events = runtime.getEvents();
        const started = yield* runtime.start().pipe(Effect.timeout("15 seconds"));
        const firstEvent = yield* Stream.runHead(events).pipe(Effect.timeout("2 seconds"));

        expect(started.sessionId).toBe("official-sdk-session-1");
        expect(firstEvent).toMatchObject({
          value: {
            _tag: "AssistantItemStarted",
          },
        });
        expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(2);

        const postCancelError = yield* runtime
          .notify("conformance/start-state-update-flood", { startSequence: 0 })
          .pipe(Effect.timeout("1 second"), Effect.flip);
        expect(postCancelError).toMatchObject({
          _tag: "AcpTransportError",
          detail: expect.stringContaining("lifetime event consumer"),
        });
        yield* awaitObservedTeardown(observedTeardown).pipe(Effect.timeout("5 seconds"));
        expect(observedTeardown.calls()).toBe(1);

        const secondExit = yield* Stream.runDrain(runtime.getEvents()).pipe(
          Effect.timeout("2 seconds"),
          Effect.exit,
        );
        expect(Exit.isFailure(secondExit)).toBe(true);
        if (Exit.isFailure(secondExit)) {
          expect(Cause.squash(secondExit.cause)).toMatchObject({
            _tag: "AcpTransportError",
            detail: expect.stringContaining("lifetime event consumer"),
          });
        }
      }).pipe(
        Effect.provide(runtimeLayer(logPath, {}, undefined, observedTeardown.teardown)),
        Effect.scoped,
        Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
        Effect.provide(NodeServices.layer),
      );
    },
    20_000,
  );

  it.live(
    "fails both streams closed when a second event consumer subscribes concurrently",
    () => {
      const logPath = createFixtureLog();
      const observedTeardown = observeProcessTreeTeardown();
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const firstEventSeen = yield* Deferred.make<void>();
        const releaseFirstConsumer = yield* Deferred.make<void>();
        yield* runtime.start().pipe(Effect.timeout("10 seconds"));

        const firstFiber = yield* runtime.getEvents().pipe(
          Stream.tap(() =>
            Deferred.succeed(firstEventSeen, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirstConsumer)),
            ),
          ),
          Stream.runDrain,
          Effect.exit,
          Effect.forkChild,
        );
        yield* Deferred.await(firstEventSeen).pipe(Effect.timeout("2 seconds"));

        const secondFiber = yield* Stream.runHead(runtime.getEvents()).pipe(
          Effect.exit,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* runtime
          .prompt({ prompt: [{ type: "text", text: "continue" }] })
          .pipe(Effect.timeout("2 seconds"), Effect.exit);
        const secondExit = yield* Fiber.join(secondFiber).pipe(Effect.timeout("2 seconds"));
        expect(Exit.isFailure(secondExit)).toBe(true);
        const secondError = Exit.isFailure(secondExit) ? Cause.squash(secondExit.cause) : undefined;
        expect(secondError).toMatchObject({
          _tag: "AcpTransportError",
          detail: expect.stringContaining("lifetime event consumer"),
        });

        yield* awaitObservedTeardown(observedTeardown).pipe(Effect.timeout("5 seconds"));
        expect(observedTeardown.calls()).toBe(1);
        yield* Deferred.succeed(releaseFirstConsumer, undefined);
        const firstExit = yield* Fiber.join(firstFiber).pipe(Effect.timeout("2 seconds"));
        expect(Exit.isFailure(firstExit)).toBe(true);
        if (Exit.isFailure(firstExit)) {
          expect(Cause.squash(firstExit.cause)).toBe(secondError);
        }
      }).pipe(
        Effect.provide(runtimeLayer(logPath, {}, undefined, observedTeardown.teardown)),
        Effect.scoped,
        Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
        Effect.provide(NodeServices.layer),
      );
    },
    20_000,
  );

  it.live("shuts down a lifetime event consumer without hanging or duplicate teardown", () => {
    const logPath = createFixtureLog();
    const observedTeardown = observeProcessTreeTeardown();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const firstEventSeen = yield* Deferred.make<void>();
      yield* runtime.start().pipe(Effect.timeout("10 seconds"));
      yield* runtime.getEvents().pipe(
        Stream.tap(() => Deferred.succeed(firstEventSeen, undefined)),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* Deferred.await(firstEventSeen).pipe(Effect.timeout("2 seconds"));
    }).pipe(
      Effect.provide(runtimeLayer(logPath, {}, undefined, observedTeardown.teardown)),
      Effect.scoped,
      Effect.andThen(awaitObservedTeardown(observedTeardown).pipe(Effect.timeout("5 seconds"))),
      Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
      Effect.provide(NodeServices.layer),
    );
  });

  it.live(
    "fails closed on a finite pre-new zero-event state notification flood",
    () => {
      const logPath = createFixtureLog();
      const observedTeardown = observeProcessTreeTeardown();
      const stateUpdateCount = ACP_PRE_ATTACH_EVENT_CAPACITY + 64;
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const error = yield* runtime.start().pipe(Effect.timeout("15 seconds"), Effect.flip);

        expect(error).toMatchObject({
          _tag: "AcpTransportError",
          detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
            // or the upstream memory-budget backlog guards may trip first in a flood).
            expect.stringMatching(
              /bounded startup event buffer|backlog exceeded its memory budget/,
            ),
        });
        yield* Effect.promise(() => observedTeardown.completed).pipe(Effect.timeout("5 seconds"));
        expect(observedTeardown.calls()).toBe(1);
        expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(0);

        const streamExit = yield* Stream.runDrain(runtime.getEvents()).pipe(
          Effect.timeout("2 seconds"),
          Effect.exit,
        );
        expect(Exit.isFailure(streamExit)).toBe(true);
        if (Exit.isFailure(streamExit)) {
          const streamError = Cause.squash(streamExit.cause) as {
            readonly _tag?: unknown;
            readonly detail?: unknown;
          };
          expect(streamError._tag).toBe("AcpTransportError");
        }

        const retryError = yield* runtime.start().pipe(Effect.timeout("1 second"), Effect.flip);
        expect(retryError).toMatchObject({
          _tag: "AcpTransportError",
          detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
            // or the upstream memory-budget backlog guards may trip first in a flood).
            expect.stringMatching(
              /bounded startup event buffer|backlog exceeded its memory budget/,
            ),
        });
      }).pipe(
        Effect.provide(
          runtimeLayer(
            logPath,
            {
              MOSS_ACP_CONFORMANCE_EARLY_UPDATE_COUNT: "0",
              MOSS_ACP_CONFORMANCE_PRE_NEW_STATE_UPDATE_COUNT: String(stateUpdateCount),
            },
            undefined,
            observedTeardown.teardown,
          ),
        ),
        Effect.scoped,
        Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
        Effect.provide(NodeServices.layer),
      );
    },
    20_000,
  );

  it.live("bounds provisional state even when a consumer attaches before session setup", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const consumer = yield* Stream.runDrain(runtime.getEvents()).pipe(
        Effect.exit,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const error = yield* runtime.start().pipe(Effect.timeout("10 seconds"), Effect.flip);
      expect(error).toMatchObject({
        _tag: "AcpTransportError",
        detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
          // or the upstream memory-budget backlog guards may trip first in a flood).
          expect.stringMatching(/bounded startup event buffer|backlog exceeded its memory budget/),
      });
      expect(Exit.isFailure(yield* Fiber.join(consumer).pipe(Effect.timeout("2 seconds")))).toBe(
        true,
      );
    }).pipe(
      Effect.provide(
        runtimeLayer(logPath, {
          MOSS_ACP_CONFORMANCE_EARLY_UPDATE_COUNT: "0",
          MOSS_ACP_CONFORMANCE_PRE_NEW_STATE_UPDATE_COUNT: String(
            ACP_PRE_ATTACH_EVENT_CAPACITY + 64,
          ),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("fails boundedly when the startup event buffer overflows", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const error = yield* runtime.start().pipe(Effect.timeout("15 seconds"), Effect.flip);

      expect(error._tag).toBe("AcpTransportError");
      if (error._tag === "AcpTransportError") {
        expect(error.detail).toMatch(
          /bounded startup event buffer|backlog exceeded its memory budget/,
        );
      }
    }).pipe(
      Effect.provide(
        runtimeLayer(logPath, {
          MOSS_ACP_CONFORMANCE_EARLY_UPDATE_COUNT: String(ACP_PRE_ATTACH_EVENT_CAPACITY),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("fails closed when updates start only after the session/new response", () => {
    const logPath = createFixtureLog();
    const observedTeardown = observeProcessTreeTeardown();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start().pipe(Effect.timeout("15 seconds"));
      expect(started.sessionId).toBe("official-sdk-session-1");
      expect(yield* runtime.getModeState).toMatchObject({
        currentModeId: "code",
      });
      yield* runtime
        .notify("conformance/start-update-flood", { prefix: "post-new" })
        .pipe(Effect.timeout("2 seconds"));
      yield* Effect.promise(() => observedTeardown.completed).pipe(Effect.timeout("5 seconds"));
      expect(observedTeardown.calls()).toBe(1);

      const promptError = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "continue" }],
        })
        .pipe(Effect.timeout("15 seconds"), Effect.flip);
      expect(promptError).toMatchObject({
        _tag: "AcpTransportError",
        detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
          // or the upstream memory-budget backlog guards may trip first in a flood).
          expect.stringMatching(/bounded startup event buffer|backlog exceeded its memory budget/),
      });
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toContain(
        "conformance/start-update-flood",
      );

      const settledCount = yield* runtime.sessionUpdatesEnqueuedCount;
      yield* waitForRealMilliseconds(50);
      expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(settledCount);

      const streamExit = yield* Stream.runDrain(runtime.getEvents()).pipe(
        Effect.timeout("2 seconds"),
        Effect.exit,
      );
      expect(Exit.isFailure(streamExit)).toBe(true);
      if (Exit.isFailure(streamExit)) {
        const streamError = Cause.squash(streamExit.cause) as {
          readonly _tag?: unknown;
          readonly detail?: unknown;
        };
        expect(streamError._tag).toBe("AcpTransportError");
      }

      const retryStartError = yield* runtime.start().pipe(Effect.timeout("1 second"), Effect.flip);
      expect(retryStartError).toMatchObject({
        _tag: "AcpTransportError",
        detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
          // or the upstream memory-budget backlog guards may trip first in a flood).
          expect.stringMatching(/bounded startup event buffer|backlog exceeded its memory budget/),
      });

      const retryPromptError = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "retry" }],
        })
        .pipe(Effect.timeout("1 second"), Effect.flip);
      expect(retryPromptError).toMatchObject({
        _tag: "AcpTransportError",
        detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
          // or the upstream memory-budget backlog guards may trip first in a flood).
          expect.stringMatching(/bounded startup event buffer|backlog exceeded its memory budget/),
      });

      const rawRequestError = yield* runtime
        .request("conformance/echo", { source: "after-poison" })
        .pipe(Effect.timeout("1 second"), Effect.flip);
      expect(rawRequestError).toMatchObject({
        _tag: "AcpTransportError",
        detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
          // or the upstream memory-budget backlog guards may trip first in a flood).
          expect.stringMatching(/bounded startup event buffer|backlog exceeded its memory budget/),
      });

      const rawNotifyError = yield* runtime
        .notify("conformance/notice", { source: "after-poison" })
        .pipe(Effect.timeout("1 second"), Effect.flip);
      expect(rawNotifyError).toMatchObject({
        _tag: "AcpTransportError",
        detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
          // or the upstream memory-budget backlog guards may trip first in a flood).
          expect.stringMatching(/bounded startup event buffer|backlog exceeded its memory budget/),
      });

      const sameModeError = yield* runtime
        .setMode("code")
        .pipe(Effect.timeout("1 second"), Effect.flip);
      expect(sameModeError).toMatchObject({
        _tag: "AcpTransportError",
        detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
          // or the upstream memory-budget backlog guards may trip first in a flood).
          expect.stringMatching(/bounded startup event buffer|backlog exceeded its memory budget/),
      });

      const invalidDifferentModeError = yield* runtime
        .setMode("not-a-mode")
        .pipe(Effect.timeout("1 second"), Effect.flip);
      expect(invalidDifferentModeError).toMatchObject({
        _tag: "AcpTransportError",
        detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
          // or the upstream memory-budget backlog guards may trip first in a flood).
          expect.stringMatching(/bounded startup event buffer|backlog exceeded its memory budget/),
      });
    }).pipe(
      Effect.provide(runtimeLayer(logPath, {}, undefined, observedTeardown.teardown)),
      Effect.scoped,
      Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("fails closed when updates start only after the session/prompt response", () => {
    const logPath = createFixtureLog();
    const observedTeardown = observeProcessTreeTeardown();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start().pipe(Effect.timeout("10 seconds"));

      const promptResult = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "continue" }],
        })
        .pipe(Effect.timeout("15 seconds"));
      expect(promptResult).toEqual({ stopReason: "end_turn" });

      yield* runtime
        .notify("conformance/start-update-flood", { prefix: "post-prompt" })
        .pipe(Effect.timeout("2 seconds"));
      yield* Effect.promise(() => observedTeardown.completed).pipe(Effect.timeout("5 seconds"));
      expect(observedTeardown.calls()).toBe(1);
      const settledCount = yield* runtime.sessionUpdatesEnqueuedCount;
      yield* waitForRealMilliseconds(50);
      expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(settledCount);
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toContain(
        "conformance/start-update-flood",
      );

      const streamExit = yield* Stream.runDrain(runtime.getEvents()).pipe(
        Effect.timeout("2 seconds"),
        Effect.exit,
      );
      expect(Exit.isFailure(streamExit)).toBe(true);
      if (Exit.isFailure(streamExit)) {
        const streamError = Cause.squash(streamExit.cause) as {
          readonly _tag?: unknown;
          readonly detail?: unknown;
        };
        expect(streamError._tag).toBe("AcpTransportError");
      }

      const retryError = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "retry" }],
        })
        .pipe(Effect.timeout("1 second"), Effect.flip);
      expect(retryError).toMatchObject({
        _tag: "AcpTransportError",
        detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
          // or the upstream memory-budget backlog guards may trip first in a flood).
          expect.stringMatching(/bounded startup event buffer|backlog exceeded its memory budget/),
      });
    }).pipe(
      Effect.provide(runtimeLayer(logPath, {}, undefined, observedTeardown.teardown)),
      Effect.scoped,
      Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("fails start boundedly when overflow happens before session/new responds", () => {
    const logPath = createFixtureLog();
    const observedTeardown = observeProcessTreeTeardown();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const error = yield* runtime.start().pipe(Effect.timeout("15 seconds"), Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpTransportError",
        detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
          // or the upstream memory-budget backlog guards may trip first in a flood).
          expect.stringMatching(/bounded startup event buffer|backlog exceeded its memory budget/),
      });
      yield* Effect.promise(() => observedTeardown.completed).pipe(Effect.timeout("5 seconds"));
      expect(observedTeardown.calls()).toBe(1);
      const settledCount = yield* runtime.sessionUpdatesEnqueuedCount;
      yield* waitForRealMilliseconds(50);
      expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(settledCount);

      const retryError = yield* runtime.start().pipe(Effect.timeout("1 second"), Effect.flip);
      expect(retryError).toMatchObject({
        _tag: "AcpTransportError",
        detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
          // or the upstream memory-budget backlog guards may trip first in a flood).
          expect.stringMatching(/bounded startup event buffer|backlog exceeded its memory budget/),
      });
    }).pipe(
      Effect.provide(
        runtimeLayer(
          logPath,
          {
            MOSS_ACP_CONFORMANCE_PRE_NEW_UPDATES_FOREVER: "1",
          },
          undefined,
          observedTeardown.teardown,
        ),
      ),
      Effect.scoped,
      Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
      Effect.provide(NodeServices.layer),
    );
  });

  for (const flood of ["forever", "finite"] as const) {
    it.live(
      `fails prompt boundedly when overflow happens before session/prompt responds (${flood})`,
      () => {
        const logPath = createFixtureLog();
        const observedTeardown = observeProcessTreeTeardown();
        return Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime;
          yield* runtime.start().pipe(Effect.timeout("10 seconds"));

          const error = yield* runtime
            .prompt({
              prompt: [{ type: "text", text: "continue" }],
            })
            .pipe(Effect.timeout("15 seconds"), Effect.flip);
          // Fail-closed is what matters: either the Moss bounded-startup-buffer guard
          // or the upstream memory-budget backlog guard may trip first in a flood.
          expect(error).toMatchObject({
            _tag: "AcpTransportError",
            detail: expect.stringMatching(
              /bounded startup event buffer|backlog exceeded its memory budget/,
            ),
          });
          yield* Effect.promise(() => observedTeardown.completed).pipe(Effect.timeout("5 seconds"));
          expect(observedTeardown.calls()).toBe(1);
          const settledCount = yield* runtime.sessionUpdatesEnqueuedCount;
          yield* waitForRealMilliseconds(50);
          expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(settledCount);

          const retryError = yield* runtime
            .prompt({
              prompt: [{ type: "text", text: "retry" }],
            })
            .pipe(Effect.timeout("1 second"), Effect.flip);
          // Failure must be checked before closing a retained assistant segment:
          // flushing it into the already-full buffer used to turn this retry into a defect.
          expect(yield* runtime.sessionUpdatesEnqueuedCount).toBe(settledCount);
          expect(retryError).toMatchObject({
            _tag: "AcpTransportError",
            detail: // Any bounded-budget guard satisfies the fail-closed contract (Moss startup buffer
              // or the upstream memory-budget backlog guards may trip first in a flood).
              expect.stringMatching(
                /bounded startup event buffer|backlog exceeded its memory budget/,
              ),
          });
        }).pipe(
          Effect.provide(
            runtimeLayer(
              logPath,
              {
                ...(flood === "forever"
                  ? { MOSS_ACP_CONFORMANCE_PRE_PROMPT_UPDATES_FOREVER: "1" }
                  : {
                      MOSS_ACP_CONFORMANCE_PRE_PROMPT_RESPONSE_UPDATE_COUNT: String(
                        ACP_PRE_ATTACH_EVENT_CAPACITY + 64,
                      ),
                    }),
              },
              undefined,
              observedTeardown.teardown,
            ),
          ),
          Effect.scoped,
          Effect.tap(() => Effect.sync(() => expect(observedTeardown.calls()).toBe(1))),
          Effect.provide(NodeServices.layer),
        );
      },
    );
  }

  it.live(
    "uses the decoded response boundary while an attached consumer drains later updates",
    () => {
      const logPath = createFixtureLog();
      return Effect.gen(function* () {
        const promptResponseObserved = yield* Deferred.make<void>();
        const postPromptUpdateEntered = yield* Deferred.make<void>();
        const releasePostPromptUpdate = yield* Deferred.make<void>();
        let promptResponseWasObserved = false;
        let heldFirstPostPromptUpdate = false;
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime;
          yield* runtime.start().pipe(Effect.timeout("10 seconds"));
          const eventsFiber = yield* Stream.runDrain(runtime.getEvents()).pipe(Effect.forkScoped);
          const promptFiber = yield* runtime
            .prompt({
              prompt: [{ type: "text", text: "continue" }],
            })
            .pipe(Effect.forkScoped);

          yield* Deferred.await(promptResponseObserved).pipe(Effect.timeout("10 seconds"));
          yield* runtime
            .notify("conformance/send-update-burst", { prefix: "post-prompt", count: 64 })
            .pipe(Effect.timeout("2 seconds"));
          yield* Deferred.await(postPromptUpdateEntered).pipe(Effect.timeout("10 seconds"));
          const promptResult = yield* Fiber.join(promptFiber).pipe(
            Effect.timeout("2 seconds"),
            Effect.ensuring(Deferred.succeed(releasePostPromptUpdate, undefined)),
          );
          expect(promptResult).toEqual({
            stopReason: "end_turn",
          });
          expect(eventsFiber.pollUnsafe()).toBeUndefined();
        }).pipe(
          Effect.provide(
            runtimeLayer(
              logPath,
              {},
              {
                logIncoming: true,
                logger: (event) => {
                  if (isDecodedPromptResponse(event)) {
                    return Effect.sync(() => {
                      promptResponseWasObserved = true;
                    }).pipe(
                      Effect.andThen(Deferred.succeed(promptResponseObserved, undefined)),
                      Effect.asVoid,
                    );
                  }
                  if (!heldFirstPostPromptUpdate && isPostPromptDecodedNotification(event)) {
                    heldFirstPostPromptUpdate = true;
                    expect(promptResponseWasObserved).toBe(true);
                    return Deferred.succeed(postPromptUpdateEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(releasePostPromptUpdate)),
                    );
                  }
                  return Effect.void;
                },
              },
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    },
  );

  it.live("enforces the pre-attach byte cap before the event-count cap", () => {
    const logPath = createFixtureLog();
    const earlyUpdateCount = 4;
    const earlyUpdateTextBytes = Math.floor(ACP_PRE_ATTACH_EVENT_MAX_BYTES / 3);
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const error = yield* runtime.start().pipe(Effect.timeout("15 seconds"), Effect.flip);

      expect(earlyUpdateCount).toBeLessThan(ACP_PRE_ATTACH_EVENT_CAPACITY);
      expect(error._tag).toBe("AcpTransportError");
      if (error._tag === "AcpTransportError") {
        expect(error.detail).toMatch(
          /bounded startup event buffer|backlog exceeded its memory budget/,
        );
      }
    }).pipe(
      Effect.provide(
        runtimeLayer(logPath, {
          MOSS_ACP_CONFORMANCE_EARLY_UPDATE_COUNT: String(earlyUpdateCount),
          MOSS_ACP_CONFORMANCE_EARLY_UPDATE_TEXT_BYTES: String(earlyUpdateTextBytes),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("fails pending work when the official-SDK subprocess exits", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      const exit = yield* runtime
        .request("conformance/exit", {})
        .pipe(Effect.timeout("2 seconds"), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(readFixtureLog(logPath).some((entry) => entry.type === "conformance/exit")).toBe(true);
    }).pipe(
      Effect.provide(runtimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("uses the official SDK malformed-line policy without a second parser", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start().pipe(Effect.timeout("2 seconds"));
      expect(started.sessionId).toBe("official-sdk-session-1");
    }).pipe(
      Effect.provide(
        runtimeLayer(logPath, {
          MOSS_ACP_CONFORMANCE_MALFORMED_PREFIX: "1",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("round-trips extension requests and delivers extension notifications", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.notify("conformance/notice", {
        primitive: false,
        nested: { source: "moss-notice" },
      });
      const response = yield* runtime.request("conformance/echo", {
        primitive: 42,
        nested: { source: "moss-request" },
      });

      expect(response).toEqual({
        echo: {
          primitive: 42,
          nested: { source: "moss-request" },
        },
        _meta: {
          primitive: true,
          nested: { source: "official-sdk" },
        },
      });
      expect(
        readFixtureLog(logPath)
          .filter((entry) => entry.type.startsWith("conformance/"))
          .map((entry) => entry.type)
          .toSorted(),
      ).toEqual(["conformance/echo", "conformance/notice"]);
    }).pipe(
      Effect.provide(runtimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live(
    "correlates overlapping same-method requests by request id when responses arrive out of order",
    () => {
      const logPath = createFixtureLog();
      return Effect.gen(function* () {
        const firstEntered = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();
        const secondResponseObserved = yield* Deferred.make<void>();
        const firstUpdateEntered = yield* Deferred.make<void>();
        const releaseFirstUpdate = yield* Deferred.make<void>();
        let heldFirstUpdate = false;

        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime;
          yield* runtime.handleExtNotification(
            "conformance/response-boundary-entered",
            Schema.Struct({ label: Schema.String }),
            ({ label }) =>
              label === "first"
                ? Deferred.succeed(firstEntered, undefined).pipe(Effect.asVoid)
                : Deferred.succeed(secondEntered, undefined).pipe(Effect.asVoid),
          );
          yield* runtime.start().pipe(Effect.timeout("10 seconds"));
          yield* Stream.runDrain(runtime.getEvents()).pipe(Effect.forkScoped);

          const first = yield* runtime
            .request("conformance/response-boundary", { label: "first" })
            .pipe(Effect.forkScoped);
          const second = yield* runtime
            .request("conformance/response-boundary", { label: "second" })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(firstEntered).pipe(Effect.timeout("10 seconds"));
          yield* Deferred.await(secondEntered).pipe(Effect.timeout("10 seconds"));

          yield* runtime.notify("conformance/release-response-boundary", {
            label: "second",
          });
          yield* Deferred.await(secondResponseObserved).pipe(Effect.timeout("2 seconds"));
          expect(yield* Fiber.join(second).pipe(Effect.timeout("2 seconds"))).toEqual({
            label: "second",
          });

          yield* runtime.notify("conformance/release-response-boundary", {
            label: "first",
          });
          yield* Deferred.await(firstUpdateEntered).pipe(Effect.timeout("2 seconds"));
          expect(first.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(releaseFirstUpdate, undefined);
          expect(yield* Fiber.join(first).pipe(Effect.timeout("2 seconds"))).toEqual({
            label: "first",
          });
        }).pipe(
          Effect.provide(
            runtimeLayer(
              logPath,
              {},
              {
                logIncoming: true,
                logger: (event) => {
                  if (isResponseBoundaryDecodedResponse(event, "second")) {
                    return Deferred.succeed(secondResponseObserved, undefined).pipe(Effect.asVoid);
                  }
                  if (!heldFirstUpdate && isResponseBoundaryDecodedNotification(event, "first")) {
                    heldFirstUpdate = true;
                    return Deferred.succeed(firstUpdateEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirstUpdate)),
                    );
                  }
                  return Effect.void;
                },
              },
            ),
          ),
          Effect.ensuring(Deferred.succeed(releaseFirstUpdate, undefined)),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    },
  );

  it.live(
    "cleans a reasonless-abort drain waiter after the response while its accepted update is held",
    () => {
      const logPath = createFixtureLog();
      return Effect.gen(function* () {
        const requestEntered = yield* Deferred.make<void>();
        const updateEntered = yield* Deferred.make<void>();
        const responseObserved = yield* Deferred.make<void>();
        const waiterRegistered = yield* Deferred.make<void>();
        const releaseUpdate = yield* Deferred.make<void>();
        const reasonlessAbort = makeReasonlessAbortController();
        const waiterCounts: number[] = [];
        let holdFirstUpdate = true;
        let armReasonlessSignal = false;

        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime;
          yield* runtime.handleExtNotification(
            "conformance/response-boundary-entered",
            Schema.Struct({ label: Schema.String }),
            ({ label }) =>
              label === "first"
                ? Deferred.succeed(requestEntered, undefined).pipe(Effect.asVoid)
                : Effect.void,
          );
          yield* runtime.start().pipe(Effect.timeout("10 seconds"));
          yield* Stream.runDrain(runtime.getEvents()).pipe(Effect.forkScoped);
          armReasonlessSignal = true;

          const requestFiber = yield* runtime
            .request("conformance/response-boundary", { label: "first" })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(requestEntered).pipe(Effect.timeout("2 seconds"));
          yield* runtime.notify("conformance/release-response-boundary", {
            label: "first",
          });
          yield* Deferred.await(updateEntered).pipe(Effect.timeout("2 seconds"));
          yield* Deferred.await(responseObserved).pipe(Effect.timeout("2 seconds"));
          yield* Deferred.await(waiterRegistered).pipe(Effect.timeout("2 seconds"));

          expect(requestFiber.pollUnsafe()).toBeUndefined();
          expect(reasonlessAbort.signal.reason).toBeUndefined();
          expect(waiterCounts).toEqual([1]);
          expect(reasonlessAbort.listenerAdds()).toBe(1);
          expect(reasonlessAbort.listenerRemoves()).toBe(0);

          reasonlessAbort.abort();
          const requestError = yield* Fiber.join(requestFiber).pipe(
            Effect.timeout("2 seconds"),
            Effect.flip,
          );
          expect(requestError).toMatchObject({
            _tag: "AcpTransportError",
            detail: "ACP session/update drain was aborted",
          });
          expect(waiterCounts).toEqual([1, 0]);
          expect(reasonlessAbort.listenerAdds()).toBe(1);
          expect(reasonlessAbort.listenerRemoves()).toBe(1);

          yield* Deferred.succeed(releaseUpdate, undefined);
          armReasonlessSignal = false;
          expect(
            yield* runtime
              .request("conformance/echo", { source: "after-drain-abort" })
              .pipe(Effect.timeout("2 seconds")),
          ).toMatchObject({
            echo: { source: "after-drain-abort" },
          });
          expect(waiterCounts).toEqual([1, 0]);
          expect(reasonlessAbort.listenerAdds()).toBe(1);
          expect(reasonlessAbort.listenerRemoves()).toBe(1);
        }).pipe(
          Effect.provide(
            runtimeLayer(
              logPath,
              {},
              {
                logIncoming: true,
                logger: (event) => {
                  if (isResponseBoundaryDecodedResponse(event, "first")) {
                    return Deferred.succeed(responseObserved, undefined).pipe(Effect.asVoid);
                  }
                  if (holdFirstUpdate && isResponseBoundaryDecodedNotification(event, "first")) {
                    holdFirstUpdate = false;
                    return Deferred.succeed(updateEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseUpdate)),
                    );
                  }
                  return Effect.void;
                },
              },
              undefined,
              undefined,
              {
                mapSignal: (signal) => (armReasonlessSignal ? reasonlessAbort.signal : signal),
                onWaiterCountChange: (count) => {
                  if (!armReasonlessSignal) {
                    return;
                  }
                  waiterCounts.push(count);
                  if (count === 1) {
                    Deferred.doneUnsafe(waiterRegistered, Effect.succeed(undefined));
                  }
                },
              },
            ),
          ),
          Effect.ensuring(Deferred.succeed(releaseUpdate, undefined)),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    },
    20_000,
  );

  it.live("cancels an in-flight official-SDK prompt with session/cancel", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      yield* runtime.start();
      const ready = yield* Deferred.make<void>();
      yield* runtime.getEvents().pipe(
        Stream.tap((event) =>
          event._tag === "ContentDelta" && event.text === "cancel-ready"
            ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      const prompt = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "wait-for-cancel" }] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(ready).pipe(Effect.timeout("2 seconds"));
      yield* runtime.cancel;
      expect(yield* Fiber.join(prompt)).toEqual({ stopReason: "cancelled" });
      expect(readFixtureLog(logPath).map((entry) => entry.type)).toEqual([
        "initialize",
        "authenticate",
        "session/new",
        "session/prompt",
        "session/cancel",
      ]);
    }).pipe(
      Effect.provide(runtimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.live("cancels an extension request through official-SDK $/cancel_request", () => {
    const logPath = createFixtureLog();
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const ready = yield* Deferred.make<void>();
      const observed = yield* Deferred.make<void>();
      yield* runtime.handleExtNotification("conformance/generic-cancel-ready", Schema.Unknown, () =>
        Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      );
      yield* runtime.handleExtNotification(
        "conformance/generic-cancel-observed",
        Schema.Unknown,
        () => Deferred.succeed(observed, undefined).pipe(Effect.asVoid),
      );
      yield* runtime.start();
      const request = yield* runtime
        .request("conformance/wait-for-generic-cancel", { source: "moss" })
        .pipe(Effect.forkChild);

      yield* Deferred.await(ready);
      yield* Fiber.interrupt(request);
      yield* Deferred.await(observed);
      expect(
        readFixtureLog(logPath)
          .filter((entry) => entry.type.startsWith("conformance/"))
          .map((entry) => entry.type),
      ).toEqual(["conformance/wait-for-generic-cancel", "conformance/generic-cancel-observed"]);
    }).pipe(
      Effect.provide(runtimeLayer(logPath)),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });
});

describe("official ACP SDK client against the official SDK mock agent", () => {
  test("completes initialize, authentication, session, prompt, updates, stop, and teardown", async () => {
    const requestLogPath = createFixtureLog();
    const exitLogPath = createFixtureLog();
    const child = spawn(process.execPath, [officialMockFixturePath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MOSS_ACP_REQUEST_LOG_PATH: requestLogPath,
        MOSS_ACP_EXIT_LOG_PATH: exitLogPath,
        MOSS_ACP_PROMPT_RESPONSE_TEXT: "mock says héllo 👋",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    const agentWireChunks: Uint8Array[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    let workflowCompleted = false;
    try {
      const agentOutput = captureByteStream(
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        agentWireChunks,
      );
      const result = await client({ name: "official-sdk-reverse-conformance" }).connectWith(
        ndJsonStream(Writable.toWeb(child.stdin), agentOutput),
        async (agent) => {
          const initializeResult = await agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "official-sdk-reverse-conformance", version: "1.0.0" },
          });
          const authenticateResult = await agent.request(methods.agent.authenticate, {
            methodId: "test",
          });
          return agent.buildSession("/conformance/repo").withSession(async (session) => {
            const promptResult = session.prompt("reverse compatibility");
            const updates = [];
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") {
                return {
                  initializeResult,
                  authenticateResult,
                  sessionResult: session.newSessionResponse,
                  promptResult: await promptResult,
                  stopResponse: message.response,
                  updates,
                };
              }
              updates.push(message.notification);
            }
          });
        },
      );
      workflowCompleted = true;

      expect(result.initializeResult).toMatchObject({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      });
      expect(result.authenticateResult).toEqual({});
      expect(result.sessionResult.sessionId).toBe("mock-session-1");
      expect(result.promptResult).toEqual({ stopReason: "end_turn" });
      expect(result.stopResponse).toEqual(result.promptResult);
      expect(
        result.updates,
        `Agent wire: ${Buffer.concat(agentWireChunks).toString("utf8")}`,
      ).toEqual([
        {
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "plan",
            entries: [
              {
                content: "Inspect mock ACP state",
                priority: "high",
                status: "completed",
              },
              {
                content: "Implement the requested change",
                priority: "high",
                status: "in_progress",
              },
            ],
          },
        },
        {
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "mock says héllo 👋" },
          },
        },
      ]);

      const rawNotifications = Buffer.concat(agentWireChunks)
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((message) => message.method === "session/update");
      expect(rawNotifications).toEqual(
        result.updates.map((params) => ({
          jsonrpc: "2.0",
          method: "session/update",
          params,
        })),
      );

      const clientWire = readJsonLines(requestLogPath);
      expect(clientWire.map((message) => message.id)).toEqual([0, 1, 2, 3]);
      expect(clientWire.map(canonicalWireMessage)).toEqual([
        {
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "official-sdk-reverse-conformance", version: "1.0.0" },
          },
        },
        {
          jsonrpc: "2.0",
          method: "authenticate",
          params: { methodId: "test" },
        },
        {
          jsonrpc: "2.0",
          method: "session/new",
          params: { cwd: "/conformance/repo", mcpServers: [] },
        },
        {
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            sessionId: "mock-session-1",
            prompt: [{ type: "text", text: "reverse compatibility" }],
          },
        },
      ]);
    } finally {
      // Windows does not deliver a POSIX SIGTERM handler. The official mock
      // already awaits connection.closed, so close its real stdin transport.
      if (workflowCompleted && process.platform === "win32") child.stdin.end();
      else child.kill("SIGTERM");
      const exit = await exited;
      if (workflowCompleted) {
        expect(exit).toEqual({ code: 0, signal: null });
        expect(readFileSync(exitLogPath, "utf8").trim().split("\n")).toEqual(
          process.platform === "win32" ? ["exit:0"] : ["SIGTERM", "exit:0"],
        );
        expect(Buffer.concat(stderrChunks).toString("utf8")).toBe("");
      }
    }
  });
});

describe("official ACP SDK byte-stream characterization", () => {
  test("decodes JSON lines split inside UTF-8 code points and across partial lines", async () => {
    const encoder = new TextEncoder();
    const first = encoder.encode(
      `${JSON.stringify({ jsonrpc: "2.0", method: "conformance/notice", params: { text: "héllo 👋" } })}\n`,
    );
    const second = encoder.encode(
      `${JSON.stringify({ jsonrpc: "2.0", id: "response-1", result: { text: "done ✅" } })}\n`,
    );
    const bytes = new Uint8Array(first.length + second.length);
    bytes.set(first);
    bytes.set(second, first.length);
    const waveStart = bytes.indexOf(0xf0);
    expect(waveStart).toBeGreaterThan(0);
    const splitOffsets = [1, waveStart + 1, waveStart + 3, first.length - 1, first.length + 5];
    const chunks = splitOffsets
      .concat(bytes.length)
      .map((end, index) => bytes.slice(index === 0 ? 0 : splitOffsets[index - 1], end));
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const stream = ndJsonStream(new WritableStream<Uint8Array>(), input);
    const reader = stream.readable.getReader();

    expect((await reader.read()).value).toEqual({
      jsonrpc: "2.0",
      method: "conformance/notice",
      params: { text: "héllo 👋" },
    });
    expect((await reader.read()).value).toEqual({
      jsonrpc: "2.0",
      id: "response-1",
      result: { text: "done ✅" },
    });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test("drains a finite notification burst with explicit count and byte bounds", async () => {
    const notificationCount = 512;
    const encoder = new TextEncoder();
    const lines = Array.from({ length: notificationCount }, (_, sequence) =>
      encoder.encode(
        `${JSON.stringify({ jsonrpc: "2.0", method: "conformance/burst", params: { sequence } })}\n`,
      ),
    );
    const totalBytes = lines.reduce((total, line) => total + line.byteLength, 0);
    let pullCount = 0;
    let received = 0;
    let maxBufferedLead = 0;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        const line = lines[pullCount];
        if (!line) {
          controller.close();
          return;
        }
        pullCount += 1;
        maxBufferedLead = Math.max(maxBufferedLead, pullCount - received);
        controller.enqueue(line);
      },
    });
    const reader = ndJsonStream(new WritableStream<Uint8Array>(), input).readable.getReader();
    let lastSequence = -1;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      received += 1;
      if (!("params" in item.value)) throw new Error("Expected ACP notification params");
      lastSequence = (item.value.params as { sequence: number }).sequence;
    }

    expect(received).toBe(notificationCount);
    expect(lastSequence).toBe(notificationCount - 1);
    expect(pullCount).toBe(notificationCount);
    expect(maxBufferedLead).toBeLessThanOrEqual(4);
    expect(totalBytes).toBeLessThan(64 * 1024);
  });
});
