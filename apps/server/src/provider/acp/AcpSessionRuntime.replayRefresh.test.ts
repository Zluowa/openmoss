import { expect, it } from "vitest";
import { Effect, Layer, Queue, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { AcpSessionRuntime } from "./AcpSessionRuntime";
import type { AcpParsedSessionEvent } from "./AcpRuntimeModel";

it.each(["new", "load"] as const)(
  "drops refresh transcript replay after session/%s and preserves subsequent live output",
  async (setupMethod) => {
    const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());
    const encoder = new TextEncoder();
    let suppressTranscript = false;
    const methods: string[] = [];
    const spawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.forEach((chunk: Uint8Array) => {
              const request = JSON.parse(new TextDecoder().decode(chunk));
              methods.push(request.method);
              const frames: unknown[] = [];
              if (request.method === "session/resume" || request.method === "session/prompt")
                frames.push({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "session",
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: {
                        type: "text",
                        text: request.method === "session/resume" ? "old replay" : "live answer",
                      },
                    },
                  },
                });
              frames.push({
                jsonrpc: "2.0",
                id: request.id,
                result:
                  request.method === "initialize"
                    ? {
                        protocolVersion: 1,
                        authMethods: [],
                        agentCapabilities: {
                          loadSession: true,
                          sessionCapabilities: { resume: {} },
                        },
                      }
                    : request.method === "session/new"
                      ? { sessionId: "session" }
                      : request.method === "session/prompt"
                        ? { stopReason: "end_turn" }
                        : {},
              });
              return Queue.offer(
                agentToClient,
                encoder.encode(frames.map((frame) => JSON.stringify(frame) + "\n").join("")),
              );
            }),
            stdout: Stream.fromQueue(agentToClient),
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        ),
      ),
    );
    const events: AcpParsedSessionEvent[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        yield* runtime.start();
        expect(methods).toContain(`session/${setupMethod}`);
        expect(methods).not.toContain("session/resume");
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* runtime.awaitLoadReplayReady;
        suppressTranscript = true;
        yield* runtime.request("session/resume", {
          sessionId: "session",
          cwd: process.cwd(),
          mcpServers: [],
        });
        suppressTranscript = false;
        yield* runtime.prompt({ prompt: [{ type: "text", text: "new question" }] });
        while (!events.some((event) => event._tag === "ContentDelta")) yield* Effect.sleep(5);
        expect(
          events.filter((event) => event._tag === "ContentDelta").map((event) => event.text),
        ).toEqual(["live answer"]);
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: { command: "in-memory-hermes", args: [] },
            cwd: process.cwd(),
            clientInfo: { name: "test", version: "0" },
            authPolicy: "on-demand",
            sessionRecoveryMethod: "load",
            ...(setupMethod === "load" ? { resumeSessionId: "session" } : {}),
            loadReplayPolicy: { quietMs: 0, hardTimeoutMs: 100 },
            suppressSessionTranscriptUpdates: () => suppressTranscript,
            teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
          }).pipe(Layer.provide(spawner)),
        ),
        Effect.scoped,
        Effect.timeout("5 seconds"),
      ),
    );
  },
);
