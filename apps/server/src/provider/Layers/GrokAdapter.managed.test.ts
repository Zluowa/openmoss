import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Stream } from "effect";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { ServerConfig } from "../../config";
import { GrokAdapter } from "../Services/GrokAdapter";
import { buildMossManagedGrokProviderInstance } from "../mossManagedGrokEnvironment";
import { makeGrokAdapterLive } from "./GrokAdapter";
import type { GrokAcpRuntimeInput } from "../acp/GrokAcpSupport";

const captured = vi.hoisted(() => ({ inputs: [] as GrokAcpRuntimeInput[] }));
vi.mock("../acp/GrokAcpSupport", async (importOriginal) => {
  const original = await importOriginal<typeof import("../acp/GrokAcpSupport")>();
  return {
    ...original,
    makeGrokAcpRuntime: (input: GrokAcpRuntimeInput) => {
      captured.inputs.push(input);
      return Effect.succeed({
        handleExtRequest: () => Effect.void,
        handleExtNotification: () => Effect.void,
        handleRequestPermission: () => Effect.void,
        start: () =>
          Effect.succeed({ sessionId: "native-grok", initializeResult: { protocolVersion: 1 } }),
        awaitExit: Effect.never,
        awaitLoadReplayReady: Effect.void,
        sessionUpdatesEnqueuedCount: Effect.succeed(0),
        prompt: () => Effect.succeed({ stopReason: "end_turn" }),
        getEvents: () => Stream.never,
        supportsSessionFork: Effect.succeed(true),
        supportsSessionRecovery: Effect.succeed(true),
        forkSession: () => Effect.succeed({ sessionId: "native-grok-fork" }),
      });
    },
  };
});

const dirs: string[] = [];
afterEach(async () => {
  captured.inputs.length = 0;
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("preserves managed identity and environment through startup, events, stopped-source fork and local model discovery", async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "moss-grok-adapter-")));
  dirs.push(cwd);
  const gateway = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
  vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gateway);
  const instance = buildMossManagedGrokProviderInstance({
    accessToken: "isolated-token",
    gatewayBaseUrl: gateway,
    homePath: path.join(cwd, "cn"),
    runtimeGeneration: "generation",
    realm: "cn",
  });
  const environment = Object.fromEntries(
    instance.environment.map((entry) => [entry.name, entry.value]),
  );
  const instanceId = ProviderInstanceId.makeUnsafe("grok_moss");
  const threadId = ThreadId.makeUnsafe("managed-grok-thread");
  const modelSelection = {
    provider: "grok" as const,
    instanceId,
    model: "moss/deepseek-v4-flash",
  };
  const providerOptions = { grok: { binaryPath: "/instance/grok", environment } };
  const events: ProviderRuntimeEvent[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const invalidStart = yield* adapter
        .startSession({
          threadId,
          provider: "grok",
          providerInstanceId: instanceId,
          cwd,
          modelSelection: { ...modelSelection, provider: "claudeAgent" },
          providerOptions,
          runtimeMode: "approval-required",
        })
        .pipe(Effect.flip);
      expect(invalidStart).toMatchObject({ _tag: "ProviderAdapterValidationError" });
      expect(captured.inputs).toHaveLength(0);
      const session = yield* adapter.startSession({
        threadId,
        provider: "grok",
        providerInstanceId: instanceId,
        lifecycleGeneration: "generation",
        cwd,
        modelSelection,
        providerOptions,
        runtimeMode: "approval-required",
      });
      expect(session.providerInstanceId).toBe(instanceId);
      expect(session.model).toBe("moss/deepseek-v4-flash");
      expect(captured.inputs[0]?.grokSettings).toMatchObject({
        instanceId: String(instanceId),
        environment,
        model: "moss/deepseek-v4-flash",
        binaryPath: "/instance/grok",
      });
      const invalidTurn = yield* adapter
        .sendTurn({
          threadId,
          input: "Read-only test prompt",
          modelSelection: { instanceId, model: "moss/glm-5.3", provider: "claudeAgent" },
        })
        .pipe(Effect.flip);
      expect(invalidTurn).toMatchObject({ _tag: "ProviderAdapterValidationError" });
      yield* adapter.sendTurn({
        threadId,
        input: "Read-only test prompt",
        modelSelection: { provider: "grok", instanceId, model: "moss/glm-5.3" },
      });
      yield* Effect.yieldNow;
      expect(events.find((event) => event.type === "turn.started")?.payload).toMatchObject({
        model: "moss/glm-5.3",
      });
      yield* adapter.stopSession(threadId);
      yield* Effect.yieldNow;
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events.every((event) => event.providerInstanceId === instanceId)).toBe(true);
      const invalidFork = yield* adapter.forkThread!({
        sourceThreadId: threadId,
        threadId: ThreadId.makeUnsafe("invalid-fork"),
        sourceResumeCursor: session.resumeCursor,
        cwd,
        modelSelection: { ...modelSelection, provider: "claudeAgent" },
        providerOptions,
        runtimeMode: "approval-required",
      }).pipe(Effect.flip);
      expect(invalidFork).toMatchObject({ _tag: "ProviderAdapterValidationError" });
      expect(captured.inputs).toHaveLength(1);
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
      expect(fork.resumeCursor).toMatchObject({ sessionId: "native-grok-fork" });
      expect(captured.inputs[1]?.grokSettings).toMatchObject({
        instanceId: String(instanceId),
        environment,
        model: "moss/deepseek-v4-flash",
      });
      const models = yield* adapter.listModels!({
        provider: "grok",
        instanceId,
        environment,
        binaryPath: "/must/not/spawn",
      });
      expect(models.source).toBe("moss-managed-grok");
      expect(models.models).toHaveLength(7);
      expect(models.models.every((model) => model.slug.startsWith("moss/"))).toBe(true);
      expect(captured.inputs).toHaveLength(2);
    }).pipe(
      Effect.provide(
        makeGrokAdapterLive({
          binaryPath: "/base/grok",
          environment: { XAI_API_KEY: "native-key" },
        }).pipe(
          Layer.provideMerge(ServerConfig.layerTest(cwd, path.join(cwd, "server"))),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
});
