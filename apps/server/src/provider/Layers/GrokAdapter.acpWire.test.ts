// FILE: GrokAdapter.acpWire.test.ts
// Purpose: Replays recorded Grok ACP frames through the live adapter.
//          1.0.62: official session/update + retry_state notifications.
//          0.2.x only: vendor session/update kinds and `_x.ai/hooks/run`.
// Layer: Provider adapter tests
// Depends on: in-memory ChildProcessSpawner; no real grok binary.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Layer, Queue, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  grokAgentMessageChunk,
  grokAgentThoughtChunk,
  grokExtNotificationFrame,
  grokExtRequestFrame,
  grokHaoMessageChunk,
  grokHaoThoughtChunk,
  grokHookRunRequestFrame,
  grokPendingInteraction,
  grokPromptCompleteEndTurn,
  grokRetryStateNotification,
  grokSessionUpdateFrame,
  grokToolCallDeltaChunk,
  grokTurnCompletedUpdate,
  grokUserMessageChunk,
  grokWrappedAgentMessageNotification,
  GROK_WIRE_SESSION_ID,
} from "../acp/testing/grokAcpWireFixtures.ts";
import { GrokAdapter, type GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { makeGrokAdapterLive } from "./GrokAdapter.ts";

const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const decodeLines = (chunk: Uint8Array) =>
  new TextDecoder()
    .decode(chunk)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const waitForEvent = (
  events: ProviderRuntimeEvent[],
  match: (event: ProviderRuntimeEvent) => boolean,
  timeoutMs: number,
  label: string,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = events.find(match);
      if (hit) return hit;
      yield* Effect.sleep(50);
    }
    return yield* Effect.fail(
      new Error(
        `timed out waiting for ${label}; seen: ${events.map((event) => event.type).join(", ") || "(none)"}`,
      ),
    );
  });

const makeGrokWireSpawner = (hookMethod: string) => {
  const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
  const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());
  const hookResults: Array<Record<string, unknown>> = [];
  const send = (value: unknown) => Queue.offer(agentToClient, encode(value));
  let hookWaiter: { readonly id: string; readonly resolve: () => void } | undefined;

  const handleMessage = (message: Record<string, unknown>) => {
    if (!("method" in message) && "id" in message) {
      if (hookWaiter && message.id === hookWaiter.id) {
        hookResults.push(message);
        hookWaiter.resolve();
        hookWaiter = undefined;
      }
      return;
    }
    const method = message.method;
    const id = message.id;
    if (method === "initialize") {
      void Effect.runPromise(
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
            authMethods: [{ id: "cached_token", name: "cached_token" }],
            _meta: { grokShell: true, agentVersion: "0.2.112" },
          },
        }),
      );
      return;
    }
    if (method === "authenticate") {
      void Effect.runPromise(send({ jsonrpc: "2.0", id, result: {} }));
      return;
    }
    if (method === "session/new" || method === "session/load") {
      void Effect.runPromise(
        send({ jsonrpc: "2.0", id, result: { sessionId: GROK_WIRE_SESSION_ID } }),
      );
      return;
    }
    if (method !== "session/prompt") return;
    void Effect.runPromise(
      Effect.gen(function* () {
        yield* send(grokSessionUpdateFrame(grokUserMessageChunk));
        yield* send(grokSessionUpdateFrame(grokToolCallDeltaChunk));
        yield* send(grokSessionUpdateFrame(grokPendingInteraction));
        const hookId = "hook-1";
        const hookDone = new Promise<void>((resolve) => {
          hookWaiter = { id: hookId, resolve };
        });
        yield* send(grokHookRunRequestFrame(hookId, hookMethod));
        yield* Effect.promise(() => hookDone);
        yield* send(grokSessionUpdateFrame(grokAgentThoughtChunk));
        yield* send(grokSessionUpdateFrame(grokAgentMessageChunk));
        yield* send(
          grokExtNotificationFrame(
            "_x.ai/session_notification",
            grokWrappedAgentMessageNotification,
          ),
        );
        yield* send(grokSessionUpdateFrame(grokTurnCompletedUpdate));
        yield* send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      }),
    );
  };

  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0x7fff_fffd),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.sync(() => {
              for (const message of decodeLines(chunk)) handleMessage(message);
            }),
          ),
          stdout: Stream.fromQueue(agentToClient),
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.never,
        }),
      ),
    ),
  );

  return {
    hookResults,
    spawnerLayer,
    shutdown: () =>
      Effect.runPromise(
        Effect.all([Queue.shutdown(clientToAgent), Queue.shutdown(agentToClient)], {
          concurrency: "unbounded",
        }),
      ),
  };
};

const withAdapter = (
  hookMethod: string,
  run: (
    adapter: GrokAdapterShape,
    events: ProviderRuntimeEvent[],
    hookResults: ReadonlyArray<Record<string, unknown>>,
  ) => Effect.Effect<void, unknown>,
) => {
  const { hookResults, spawnerLayer, shutdown } = makeGrokWireSpawner(hookMethod);
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "grok-acp-wire-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const layer = makeGrokAdapterLive().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, configLayer, spawnerLayer)),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* GrokAdapter;
        const events: ProviderRuntimeEvent[] = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ).pipe(Effect.forkScoped);
        yield* run(adapter, events, hookResults);
        yield* adapter.stopAll();
      }).pipe(Effect.provide(layer)),
    ),
  ).finally(() => shutdown());
};

const handshakeInitialize = (
  send: (value: unknown) => Effect.Effect<boolean>,
  message: Record<string, unknown>,
  agentVersion: string,
) => {
  if (message.method === "initialize") {
    void Effect.runPromise(
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [{ id: "cached_token", name: "cached_token" }],
          _meta: { agentVersion },
        },
      }),
    );
    return true;
  }
  if (message.method === "authenticate") {
    void Effect.runPromise(send({ jsonrpc: "2.0", id: message.id, result: {} }));
    return true;
  }
  if (message.method === "session/new" || message.method === "session/load") {
    void Effect.runPromise(
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: GROK_WIRE_SESSION_ID },
      }),
    );
    return true;
  }
  return false;
};

const withScriptedPrompt = (
  prefix: string,
  agentVersion: string,
  onPrompt: (input: {
    readonly send: (value: unknown) => Effect.Effect<boolean>;
    readonly promptId: unknown;
    readonly waitForClientResult: (id: string) => Promise<Record<string, unknown>>;
  }) => Effect.Effect<void>,
  run: (
    adapter: GrokAdapterShape,
    events: ProviderRuntimeEvent[],
    clientResults: ReadonlyArray<Record<string, unknown>>,
  ) => Effect.Effect<void, unknown>,
) => {
  const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
  const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());
  const send = (value: unknown) => Queue.offer(agentToClient, encode(value));
  const clientResults: Array<Record<string, unknown>> = [];
  const waiters = new Map<string, (message: Record<string, unknown>) => void>();
  const waitForClientResult = (id: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiters.set(id, resolve);
    });
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0x7fff_fffa),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.sync(() => {
              for (const message of decodeLines(chunk)) {
                if (!("method" in message) && "id" in message) {
                  const id = String(message.id);
                  clientResults.push(message);
                  waiters.get(id)?.(message);
                  waiters.delete(id);
                  continue;
                }
                if (handshakeInitialize(send, message, agentVersion)) return;
                if (message.method !== "session/prompt") return;
                void Effect.runPromise(
                  onPrompt({
                    send,
                    promptId: message.id,
                    waitForClientResult,
                  }),
                );
              }
            }),
          ),
          stdout: Stream.fromQueue(agentToClient),
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.never,
        }),
      ),
    ),
  );
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const layer = makeGrokAdapterLive().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, configLayer, spawnerLayer)),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* GrokAdapter;
        const events: ProviderRuntimeEvent[] = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ).pipe(Effect.forkScoped);
        yield* run(adapter, events, clientResults);
        yield* adapter.stopAll();
      }).pipe(Effect.provide(layer)),
    ),
  ).finally(() =>
    Effect.runPromise(
      Effect.all([Queue.shutdown(clientToAgent), Queue.shutdown(agentToClient)], {
        concurrency: "unbounded",
      }),
    ),
  );
};

describe("GrokAdapter recorded ACP wire", () => {
  it.each(["_x.ai/hooks/run", "x.ai/hooks/run"] as const)(
    "projects assistant text through Grok vendor frames when hooks use %s",
    async (hookMethod) => {
      await withAdapter(hookMethod, (adapter, events, hookResults) =>
        Effect.gen(function* () {
          const threadId = ThreadId.makeUnsafe(`grok-wire-${hookMethod.replaceAll("/", "-")}`);
          yield* adapter.startSession({
            provider: "grok",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            modelSelection: { provider: "grok", model: "grok-4.6" },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "你好，回一句短回复",
            modelSelection: { provider: "grok", model: "grok-4.6" },
          });
          const completed = yield* waitForEvent(
            events,
            (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
            10_000,
            "turn.completed",
          );
          if (completed.type !== "turn.completed") {
            return yield* Effect.fail(new Error("unexpected event type"));
          }
          expect(completed.payload.state).toBe("completed");
          const assistantText = events
            .filter(
              (event) =>
                event.type === "content.delta" &&
                event.turnId === turn.turnId &&
                event.payload.streamKind === "assistant_text",
            )
            .map((event) =>
              event.type === "content.delta" && typeof event.payload.delta === "string"
                ? event.payload.delta
                : "",
            )
            .join("");
          expect(assistantText).toContain("收到，我在。");
          expect(assistantText).toContain("补充一句。");
          expect(hookResults).toHaveLength(1);
          expect(hookResults[0]).toMatchObject({ result: {} });
          expect(hookResults[0]).not.toHaveProperty("error");
        }),
      );
    },
  );

  it("emits a willRetry warning when Grok 1.0.62 sends retry_state", async () => {
    const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
    const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());
    const send = (value: unknown) => Queue.offer(agentToClient, encode(value));
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(0x7fff_fffb),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.forEach((chunk: Uint8Array) =>
              Effect.sync(() => {
                for (const message of decodeLines(chunk)) {
                  if (message.method === "initialize") {
                    void Effect.runPromise(
                      send({
                        jsonrpc: "2.0",
                        id: message.id,
                        result: {
                          protocolVersion: 1,
                          agentCapabilities: {},
                          authMethods: [{ id: "cached_token", name: "cached_token" }],
                          _meta: { agentVersion: "1.0.62" },
                        },
                      }),
                    );
                    return;
                  }
                  if (message.method === "authenticate") {
                    void Effect.runPromise(send({ jsonrpc: "2.0", id: message.id, result: {} }));
                    return;
                  }
                  if (message.method === "session/new") {
                    void Effect.runPromise(
                      send({
                        jsonrpc: "2.0",
                        id: message.id,
                        result: { sessionId: GROK_WIRE_SESSION_ID },
                      }),
                    );
                    return;
                  }
                  if (message.method === "session/prompt") {
                    void Effect.runPromise(
                      Effect.gen(function* () {
                        yield* send(
                          grokExtNotificationFrame(
                            "_x.ai/session_notification",
                            grokRetryStateNotification,
                          ),
                        );
                        yield* send(grokSessionUpdateFrame(grokAgentMessageChunk));
                        yield* send({
                          jsonrpc: "2.0",
                          id: message.id,
                          result: { stopReason: "end_turn" },
                        });
                      }),
                    );
                  }
                }
              }),
            ),
            stdout: Stream.fromQueue(agentToClient),
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        ),
      ),
    );
    const configLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "grok-acp-retry-state-",
    }).pipe(Layer.provide(NodeServices.layer));
    const layer = makeGrokAdapterLive().pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, configLayer, spawnerLayer)),
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* GrokAdapter;
            const events: ProviderRuntimeEvent[] = [];
            yield* Stream.runForEach(adapter.streamEvents, (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ).pipe(Effect.forkScoped);
            const threadId = ThreadId.makeUnsafe("grok-wire-retry-state");
            yield* adapter.startSession({
              provider: "grok",
              threadId,
              cwd: process.cwd(),
              runtimeMode: "approval-required",
              modelSelection: { provider: "grok", model: "grok-4.6" },
            });
            const turn = yield* adapter.sendTurn({
              threadId,
              input: "hi",
              modelSelection: { provider: "grok", model: "grok-4.6" },
            });
            const warning = yield* waitForEvent(
              events,
              (event) => event.type === "runtime.warning" && event.turnId === turn.turnId,
              10_000,
              "runtime.warning retry_state",
            );
            if (warning.type !== "runtime.warning") {
              return yield* Effect.fail(new Error("unexpected event type"));
            }
            expect(warning.payload.willRetry).toBe(true);
            expect(warning.payload.message).toBe("Retrying: connection timed out (3/15)");
            expect(warning.payload.streamRetry).toBeUndefined();
            const completed = yield* waitForEvent(
              events,
              (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
              10_000,
              "turn.completed",
            );
            if (completed.type !== "turn.completed") {
              return yield* Effect.fail(new Error("unexpected event type"));
            }
            expect(completed.payload.state).toBe("completed");
            yield* adapter.stopAll();
          }).pipe(Effect.provide(layer)),
        ),
      );
    } finally {
      await Effect.runPromise(
        Effect.all([Queue.shutdown(clientToAgent), Queue.shutdown(agentToClient)], {
          concurrency: "unbounded",
        }),
      );
    }
  });

  it("fails the turn with the upstream API message instead of spinning", async () => {
    const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
    const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());
    const send = (value: unknown) => Queue.offer(agentToClient, encode(value));
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(0x7fff_fffc),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.forEach((chunk: Uint8Array) =>
              Effect.sync(() => {
                for (const message of decodeLines(chunk)) {
                  if (message.method === "initialize") {
                    void Effect.runPromise(
                      send({
                        jsonrpc: "2.0",
                        id: message.id,
                        result: {
                          protocolVersion: 1,
                          agentCapabilities: {},
                          authMethods: [{ id: "cached_token", name: "cached_token" }],
                        },
                      }),
                    );
                    return;
                  }
                  if (message.method === "authenticate") {
                    void Effect.runPromise(send({ jsonrpc: "2.0", id: message.id, result: {} }));
                    return;
                  }
                  if (message.method === "session/new") {
                    void Effect.runPromise(
                      send({
                        jsonrpc: "2.0",
                        id: message.id,
                        result: { sessionId: GROK_WIRE_SESSION_ID },
                      }),
                    );
                    return;
                  }
                  if (message.method === "session/prompt") {
                    void Effect.runPromise(
                      send({
                        jsonrpc: "2.0",
                        id: message.id,
                        error: {
                          code: -32603,
                          message: "Internal error",
                          data: {
                            message:
                              "API error (status 403 Forbidden): permission-denied: Your newly created team doesn't have any credits or licenses yet",
                            http_status: 403,
                          },
                        },
                      }),
                    );
                  }
                }
              }),
            ),
            stdout: Stream.fromQueue(agentToClient),
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        ),
      ),
    );
    const configLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "grok-acp-api-error-",
    }).pipe(Layer.provide(NodeServices.layer));
    const layer = makeGrokAdapterLive().pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, configLayer, spawnerLayer)),
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* GrokAdapter;
            const events: ProviderRuntimeEvent[] = [];
            yield* Stream.runForEach(adapter.streamEvents, (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ).pipe(Effect.forkScoped);
            const threadId = ThreadId.makeUnsafe("grok-wire-api-error");
            yield* adapter.startSession({
              provider: "grok",
              threadId,
              cwd: process.cwd(),
              runtimeMode: "approval-required",
              modelSelection: { provider: "grok", model: "grok-4.6" },
            });
            const turn = yield* adapter.sendTurn({
              threadId,
              input: "hi",
              modelSelection: { provider: "grok", model: "grok-4.6" },
            });
            const completed = yield* waitForEvent(
              events,
              (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
              10_000,
              "failed turn.completed",
            );
            if (completed.type !== "turn.completed") {
              return yield* Effect.fail(new Error("unexpected event type"));
            }
            expect(completed.payload.state).toBe("failed");
            expect(completed.payload.errorMessage).toContain("permission-denied");
            expect(completed.payload.errorMessage).toContain("403");
            yield* adapter.stopAll();
          }).pipe(Effect.provide(layer)),
        ),
      );
    } finally {
      await Effect.runPromise(
        Effect.all([Queue.shutdown(clientToAgent), Queue.shutdown(agentToClient)], {
          concurrency: "unbounded",
        }),
      );
    }
  });

  it("does not mark a 1.0.52 finished reply as Interrupted after prompt_complete request + cancelled result", async () => {
    await withScriptedPrompt(
      "grok-acp-1-0-52-complete-",
      "1.0.52",
      ({ send, promptId, waitForClientResult }) =>
        Effect.gen(function* () {
          yield* send(grokSessionUpdateFrame(grokHaoThoughtChunk));
          yield* send(grokSessionUpdateFrame(grokHaoMessageChunk));
          const completeId = "prompt-complete-52";
          const acked = waitForClientResult(completeId);
          yield* send(
            grokExtRequestFrame(
              completeId,
              "_x.ai/session/prompt_complete",
              grokPromptCompleteEndTurn,
            ),
          );
          yield* Effect.promise(() => acked);
          yield* send(grokSessionUpdateFrame(grokTurnCompletedUpdate));
          yield* send({
            jsonrpc: "2.0",
            id: promptId,
            result: { stopReason: "cancelled" },
          });
        }),
      (adapter, events, clientResults) =>
        Effect.gen(function* () {
          const threadId = ThreadId.makeUnsafe("grok-wire-1-0-52-complete");
          yield* adapter.startSession({
            provider: "grok",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            modelSelection: { provider: "grok", model: "grok-4.7" },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "只回复一个字：好",
            modelSelection: { provider: "grok", model: "grok-4.7" },
          });
          const completed = yield* waitForEvent(
            events,
            (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
            10_000,
            "1.0.52 turn.completed",
          );
          if (completed.type !== "turn.completed") {
            return yield* Effect.fail(new Error("unexpected event type"));
          }
          expect(completed.payload.state).toBe("completed");
          expect(completed.payload.stopReason).toBe("end_turn");
          const assistantText = events
            .filter(
              (event) =>
                event.type === "content.delta" &&
                event.turnId === turn.turnId &&
                event.payload.streamKind === "assistant_text",
            )
            .map((event) =>
              event.type === "content.delta" && typeof event.payload.delta === "string"
                ? event.payload.delta
                : "",
            )
            .join("");
          expect(assistantText).toContain("好");
          expect(clientResults.some((message) => message.id === "prompt-complete-52")).toBe(true);
          expect(
            clientResults.find((message) => message.id === "prompt-complete-52"),
          ).toMatchObject({ result: {} });
        }),
    );
  });

  it("keeps a 1.0.62 official end_turn reply completed", async () => {
    await withScriptedPrompt(
      "grok-acp-1-0-62-complete-",
      "1.0.62",
      ({ send, promptId }) =>
        Effect.gen(function* () {
          yield* send(grokSessionUpdateFrame(grokHaoThoughtChunk));
          yield* send(grokSessionUpdateFrame(grokHaoMessageChunk));
          yield* send(
            grokExtNotificationFrame("_x.ai/session/prompt_complete", grokPromptCompleteEndTurn),
          );
          yield* send(
            grokExtNotificationFrame("_x.ai/session_notification", grokTurnCompletedUpdate),
          );
          yield* send({
            jsonrpc: "2.0",
            id: promptId,
            result: { stopReason: "end_turn" },
          });
        }),
      (adapter, events) =>
        Effect.gen(function* () {
          const threadId = ThreadId.makeUnsafe("grok-wire-1-0-62-complete");
          yield* adapter.startSession({
            provider: "grok",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            modelSelection: { provider: "grok", model: "grok-4.7" },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "只回复一个字：好",
            modelSelection: { provider: "grok", model: "grok-4.7" },
          });
          const completed = yield* waitForEvent(
            events,
            (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
            10_000,
            "1.0.62 turn.completed",
          );
          if (completed.type !== "turn.completed") {
            return yield* Effect.fail(new Error("unexpected event type"));
          }
          expect(completed.payload.state).toBe("completed");
          expect(completed.payload.stopReason).toBe("end_turn");
        }),
    );
  });

  it("still records a user Stop as cancelled", async () => {
    await withScriptedPrompt(
      "grok-acp-user-stop-",
      "1.0.52",
      ({ send }) =>
        Effect.gen(function* () {
          yield* send(grokSessionUpdateFrame(grokHaoThoughtChunk));
          yield* send(grokSessionUpdateFrame(grokHaoMessageChunk));
        }),
      (adapter, events) =>
        Effect.gen(function* () {
          const threadId = ThreadId.makeUnsafe("grok-wire-user-stop");
          yield* adapter.startSession({
            provider: "grok",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            modelSelection: { provider: "grok", model: "grok-4.7" },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "只回复一个字：好",
            modelSelection: { provider: "grok", model: "grok-4.7" },
          });
          yield* waitForEvent(
            events,
            (event) =>
              event.type === "content.delta" &&
              event.turnId === turn.turnId &&
              event.payload.streamKind === "assistant_text",
            10_000,
            "assistant text before stop",
          );
          yield* adapter.interruptTurn(threadId, turn.turnId);
          const completed = yield* waitForEvent(
            events,
            (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
            10_000,
            "user-stop turn.completed",
          );
          if (completed.type !== "turn.completed") {
            return yield* Effect.fail(new Error("unexpected event type"));
          }
          expect(completed.payload.state).toBe("cancelled");
          expect(completed.payload.stopReason).toBe("cancelled");
        }),
    );
  });
});
