import { lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Queue, Stream } from "effect";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { ServerConfig } from "../../config";
import { HermesAdapter } from "../Services/HermesAdapter";
import { buildMossManagedHermesProviderInstance } from "../mossManagedHermesEnvironment";
import { makeHermesAdapterLive, classifyHermesPromptTurnCompletion } from "./HermesAdapter";
import type { HermesAcpRuntimeInput } from "../acp/HermesAcpSupport";
import type { AcpParsedSessionEvent } from "../acp/AcpRuntimeModel";
import { AcpRequestError } from "../acp/AcpErrors";

const captured = vi.hoisted(() => ({
  inputs: [] as HermesAcpRuntimeInput[],
  requests: [] as Array<{ method: string; params: unknown }>,
  mode: "normal" as "normal" | "empty" | "fatal" | "tool-only",
}));
vi.mock("../acp/HermesAcpSupport", async (importOriginal) => {
  const original = await importOriginal<typeof import("../acp/HermesAcpSupport")>();
  return {
    ...original,
    makeHermesAcpRuntime: (input: HermesAcpRuntimeInput) =>
      Effect.gen(function* () {
        captured.inputs.push(input);
        const events = yield* Queue.unbounded<AcpParsedSessionEvent>();
        let enqueued = 0;
        return {
          handleExtRequest: () => Effect.void,
          handleRequestPermission: () => Effect.void,
          start: () =>
            Effect.succeed({
              sessionId: "native-hermes",
              initializeResult: { protocolVersion: 1 },
            }),
          request: (method: string, params: unknown) =>
            Effect.sync(() => {
              captured.requests.push({ method, params });
              return {};
            }),
          setMode: () => Effect.void,
          prompt: () =>
            Effect.gen(function* () {
              if (captured.mode === "fatal")
                return yield* new AcpRequestError({
                  code: -32000,
                  errorMessage: "Hermes model request failed (HTTP 402).",
                  data: { hermesNativeContinuationInvalid: true },
                });
              if (captured.mode === "empty") return { stopReason: "end_turn" };
              if (captured.mode === "tool-only") {
                enqueued++;
                yield* Queue.offer(events, {
                  _tag: "ToolCallUpdated",
                  toolCall: { toolCallId: "completed", status: "completed", data: {} },
                  rawPayload: {},
                });
                return { stopReason: "end_turn" };
              }
              // Enqueue more updates than a consumer can finish before prompt resolves.
              for (let index = 0; index < 20; index++) {
                enqueued++;
                yield* Queue.offer(events, {
                  _tag: "ContentDelta",
                  text: `chunk${index}`,
                  rawPayload: {},
                });
              }
              enqueued++;
              yield* Queue.offer(events, {
                _tag: "ToolCallUpdated",
                toolCall: {
                  toolCallId: "failed-tool",
                  status: "failed",
                  detail: "tool failed",
                  data: {},
                },
                rawPayload: {},
              });
              return { stopReason: "cancelled" };
            }),
          sessionUpdatesEnqueuedCount: Effect.sync(() => enqueued),
          awaitExit: Effect.never,
          awaitLoadReplayReady: Effect.void,
          getEvents: () => Stream.fromQueue(events),
          supportsSessionFork: Effect.succeed(true),
          supportsSessionRecovery: Effect.succeed(true),
          forkSession: () => Effect.succeed({ sessionId: "native-hermes-fork" }),
        };
      }),
  };
});

const dirs: string[] = [];
it("requires a visible response or completed action while preserving cancellation", () => {
  expect(
    classifyHermesPromptTurnCompletion({ stopReason: "end_turn", hasOutput: false }),
  ).toMatchObject({ state: "failed", errorMessage: expect.stringContaining("no response") });
  expect(classifyHermesPromptTurnCompletion({ stopReason: "end_turn", hasOutput: true })).toEqual({
    state: "completed",
  });
  expect(classifyHermesPromptTurnCompletion({ stopReason: "cancelled", hasOutput: false })).toEqual(
    { state: "cancelled" },
  );
});
afterEach(async () => {
  captured.inputs.length = 0;
  captured.requests.length = 0;
  captured.mode = "normal";
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it.each(["fatal", "empty", "tool-only"] as const)(
  "classifies %s completion and retires only invalid native cursors",
  async (mode) => {
    captured.mode = mode;
    const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "moss-hermes-failure-")));
    dirs.push(cwd);
    const events: ProviderRuntimeEvent[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* HermesAdapter;
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        const threadId = ThreadId.makeUnsafe("hermes-failure");
        const instanceId = ProviderInstanceId.makeUnsafe("hermes");
        const modelSelection = { provider: "hermes" as const, instanceId, model: "personal-model" };
        yield* adapter.startSession({
          threadId,
          provider: "hermes",
          providerInstanceId: instanceId,
          cwd,
          runtimeMode: "approval-required",
          modelSelection,
        });
        yield* adapter.sendTurn({ threadId, input: "test", modelSelection });
        while (!events.some((event) => event.type === "turn.completed")) yield* Effect.sleep(1);
        const completion = events.find((event) => event.type === "turn.completed")!;
        const sessions = yield* adapter.listSessions();
        if (mode === "tool-only") {
          expect(completion).toMatchObject({ payload: { state: "completed" } });
          expect(completion.raw).toBeUndefined();
          expect(sessions[0]?.resumeCursor).toMatchObject({ sessionId: "native-hermes" });
        } else {
          expect(completion).toMatchObject({
            payload: { state: "failed" },
            raw: {
              messageType: "hermes.native-inference-failed",
              payload: { hermesNativeContinuationInvalid: true },
            },
          });
          expect(sessions[0]).toMatchObject({ status: "error", resumeCursor: null });
        }
      }).pipe(
        Effect.provide(
          makeHermesAdapterLive().pipe(
            Layer.provideMerge(ServerConfig.layerTest(cwd, path.join(cwd, "server"))),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.scoped,
        Effect.timeout("10 seconds"),
      ),
    );
  },
);

it("preserves isolated routing, exact identity, queued turn updates, model selection and stopped-source forks", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "moss-hermes-adapter-")));
  dirs.push(cwd);
  const gateway = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
  vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gateway);
  const events: ProviderRuntimeEvent[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const homePath = path.join(serverConfig.stateDir, "provider-homes", "hermes", "cn");
      const instance = buildMossManagedHermesProviderInstance({
        accessToken: "isolated-token",
        gatewayBaseUrl: gateway,
        homePath,
        runtimeGeneration: "generation",
        realm: "cn",
      });
      const environment = Object.fromEntries(
        instance.environment.map((entry) => [entry.name, entry.value]),
      );
      const instanceId = ProviderInstanceId.makeUnsafe("hermes_moss");
      const threadId = ThreadId.makeUnsafe("managed-hermes-thread");
      const modelSelection = { provider: "hermes" as const, instanceId, model: "deepseek-v4-pro" };
      const providerOptions = { hermes: { homePath, environment } };
      const adapter = yield* HermesAdapter;
      expect(adapter.capabilities.conversationRollback).toBe("restart-session");
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const session = yield* adapter.startSession({
        threadId,
        provider: "hermes",
        providerInstanceId: instanceId,
        lifecycleGeneration: "generation",
        cwd,
        modelSelection,
        providerOptions,
        runtimeMode: "approval-required",
      });
      expect(session.providerInstanceId).toBe(instanceId);
      expect(captured.inputs[0]?.hermesSettings).toMatchObject({
        homePath,
        environment,
        managed: true,
      });
      const config = yield* Effect.promise(() =>
        readFile(path.join(homePath, "config.yaml"), "utf8"),
      );
      expect(config).not.toContain("isolated-token");
      expect(JSON.parse(config).custom_providers[0]).toMatchObject({
        name: "moss",
        base_url: gateway,
        key_env: "MOSS_ACCESS_TOKEN",
      });
      const configEntry = yield* Effect.promise(() => lstat(path.join(homePath, "config.yaml")));
      expect(configEntry.isFile()).toBe(true);
      expect(configEntry.isSymbolicLink()).toBe(false);
      if (process.platform !== "win32") {
        expect(
          (yield* Effect.promise(() => stat(path.join(homePath, "config.yaml")))).mode & 0o777,
        ).toBe(0o600);
      }
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "test",
        attachments: [],
        modelSelection,
      });
      while (!events.some((event) => event.type === "turn.completed")) yield* Effect.sleep(5);
      const content = events.filter((event) => event.type === "content.delta");
      expect(content).toHaveLength(20);
      expect(content.every((event) => event.turnId === turn.turnId)).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "turn.completed", payload: { state: "failed" } });
      expect(captured.requests.filter((request) => request.method === "session/set_model")).toEqual(
        [
          {
            method: "session/set_model",
            params: { sessionId: "native-hermes", modelId: "custom:moss:deepseek-v4-pro" },
          },
        ],
      );
      yield* adapter.stopSession(threadId);
      yield* Effect.yieldNow;
      expect(events.every((event) => event.providerInstanceId === instanceId)).toBe(true);
      const fork = yield* adapter.forkThread!({
        sourceThreadId: threadId,
        threadId: ThreadId.makeUnsafe("fork-target"),
        sourceResumeCursor: session.resumeCursor,
        cwd,
        sourceCwd: cwd,
        modelSelection,
        providerOptions,
        runtimeMode: "approval-required",
      });
      expect(fork.resumeCursor).toMatchObject({ sessionId: "native-hermes-fork" });
      expect(captured.inputs[1]?.hermesSettings).toMatchObject({
        homePath,
        environment,
        managed: true,
      });
      const models = yield* adapter.listModels!({
        provider: "hermes",
        instanceId,
        environment,
        binaryPath: "/must/not/spawn",
      });
      expect(models.source).toBe("moss-managed-hermes");
      expect(models.models).toHaveLength(7);
      expect(captured.inputs).toHaveLength(2);
    }).pipe(
      Effect.provide(
        makeHermesAdapterLive(
          {},
          {
            nativeEventLogger: {
              filePath: "/unused",
              write: () => Effect.sleep(2),
              close: () => Effect.void,
            },
          },
        ).pipe(
          Layer.provideMerge(ServerConfig.layerTest(cwd, path.join(cwd, "server"))),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
      Effect.timeout("10 seconds"),
    ),
  );
});
