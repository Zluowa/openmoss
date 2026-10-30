// FILE: AcpAgentAdapter.test.ts
// Purpose: Lifecycle contract tests for the generic ACP agent adapter against a fake ACP runtime.
// Layer: Provider adapter tests

import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Acp from "@agentclientprotocol/sdk";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Layer, Queue, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { KIMI_ACP_AGENT_SPEC } from "../acp/AcpAgentSpec.ts";
import { type AcpAgentRuntimeInput, buildAcpAgentSpawnInput } from "../acp/AcpAgentSupport.ts";
import { buildMossManagedAcpAgentProviderInstance } from "../mossManagedAcpAgentEnvironment.ts";
import { AcpRequestError, type AcpError } from "../acp/AcpErrors.ts";
import type { AcpParsedSessionEvent, AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { makeFakeAcpSessionRuntime } from "../acp/testing/fakeAcpSessionRuntime.ts";
import { KimiAdapter } from "../Services/KimiAdapter.ts";
import { ZcodeAdapter } from "../Services/ZcodeAdapter.ts";
import {
  type AcpAgentAdapterLiveOptions,
  makeKimiAdapterLive,
  makeZcodeAdapterLive,
} from "./AcpAgentAdapter.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const KIMI_MODES: AcpSessionModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
    { id: "auto", name: "Auto" },
    { id: "yolo", name: "YOLO" },
  ],
};
const ZCODE_MODES: AcpSessionModeState = {
  currentModeId: "yolo",
  availableModes: ["plan", "build", "edit", "guarded", "yolo"].map((id) => ({ id, name: id })),
};

function selectConfigOption(
  options: ReadonlyArray<Acp.SessionConfigOption>,
  configId: string,
  currentValue: string,
): ReadonlyArray<Acp.SessionConfigOption> {
  return options.map((option) =>
    option.id === configId && option.type === "select"
      ? ({ ...option, currentValue } satisfies Acp.SessionConfigOption)
      : option,
  );
}

interface FakeAgent {
  readonly inputs: AcpAgentRuntimeInput[];
  readonly calls: Array<{ method: string; args: ReadonlyArray<unknown> }>;
  readonly makeRuntime: NonNullable<AcpAgentAdapterLiveOptions["makeRuntime"]>;
}

function makeFakeAgent(input: {
  readonly modes: AcpSessionModeState;
  readonly configOptions?: ReadonlyArray<Acp.SessionConfigOption>;
  readonly startError?: AcpError;
  readonly prompt?: (
    events: Queue.Queue<AcpParsedSessionEvent>,
    enqueue: () => void,
  ) => Effect.Effect<Acp.PromptResponse, AcpError>;
}): FakeAgent {
  const agent: FakeAgent = {
    inputs: [],
    calls: [],
    makeRuntime: (runtimeInput) =>
      Effect.gen(function* () {
        agent.inputs.push(runtimeInput);
        const events = yield* Queue.unbounded<AcpParsedSessionEvent>();
        let enqueued = 0;
        let modes = input.modes;
        let configOptions = input.configOptions ?? [];
        const base = makeFakeAcpSessionRuntime({ sessionId: `native-${runtimeInput.spec.kind}` });
        return {
          ...base,
          start: () =>
            input.startError
              ? Effect.fail(input.startError)
              : Effect.succeed({
                  sessionId: `native-${runtimeInput.spec.kind}`,
                  initializeResult: { protocolVersion: 1 } as Acp.InitializeResponse,
                  sessionSetupResult: {
                    sessionId: `native-${runtimeInput.spec.kind}`,
                    modes,
                    configOptions: [...configOptions],
                  } as Acp.NewSessionResponse,
                  modelConfigId: configOptions.find((option) => option.category === "model")?.id,
                  sessionSetupMethod: "new" as const,
                }),
          getConfigOptions: Effect.sync(() => configOptions),
          setConfigOption: (configId: string, value: string | boolean) =>
            Effect.sync(() => {
              agent.calls.push({ method: "setConfigOption", args: [configId, value] });
              configOptions = selectConfigOption(configOptions, configId, String(value));
              return {} as Acp.SetSessionConfigOptionResponse;
            }),
          getModeState: Effect.sync(() => modes),
          setMode: (modeId: string) =>
            Effect.sync(() => {
              agent.calls.push({ method: "setMode", args: [modeId] });
              modes = { ...modes, currentModeId: modeId };
              return {} as Acp.SetSessionModeResponse;
            }),
          request: (method: string, payload: unknown) =>
            Effect.sync(() => {
              agent.calls.push({ method, args: [payload] });
              return {};
            }),
          prompt: () =>
            input.prompt
              ? input.prompt(events, () => {
                  enqueued += 1;
                })
              : Effect.succeed({ stopReason: "end_turn" } as Acp.PromptResponse),
          sessionUpdatesEnqueuedCount: Effect.sync(() => enqueued),
          getEvents: () => Stream.fromQueue(events),
        } satisfies AcpSessionRuntimeShape;
      }),
  };
  return agent;
}

async function withAdapterCwd() {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "moss-acp-agent-")));
  dirs.push(cwd);
  return cwd;
}

// Each kind's live layer carries its own service tag, so the server layers are
// merged onto the concrete layer instead of a union of factories.
const withServerLayers =
  (cwd: string) =>
  <S, E, R>(layer: Layer.Layer<S, E, R>) =>
    layer.pipe(
      Layer.provideMerge(ServerConfig.layerTest(cwd, path.join(cwd, "server"))),
      Layer.provideMerge(NodeServices.layer),
    );

const collectEvents = <E, R>(
  stream: Stream.Stream<ProviderRuntimeEvent, E, R>,
  into: ProviderRuntimeEvent[],
) =>
  stream.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        into.push(event);
      }),
    ),
    Effect.forkScoped,
  );

const modelOption: Acp.SessionConfigOption = {
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue: "kimi-k2.6",
  options: [
    { value: "kimi-k2.6", name: "Kimi K2.6" },
    { value: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
  ],
};

it("runs a Kimi prompt round-trip through model selection, native modes and runtime events", async () => {
  const cwd = await withAdapterCwd();
  const agent = makeFakeAgent({
    modes: KIMI_MODES,
    configOptions: [modelOption],
    prompt: (events, enqueue) =>
      Effect.gen(function* () {
        enqueue();
        yield* Queue.offer(events, { _tag: "ContentDelta", text: "hello", rawPayload: {} });
        enqueue();
        yield* Queue.offer(events, {
          _tag: "ToolCallUpdated",
          toolCall: { toolCallId: "tool-1", status: "completed", data: {} },
          rawPayload: {},
        });
        return { stopReason: "end_turn" } as Acp.PromptResponse;
      }),
  });
  const events: ProviderRuntimeEvent[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      yield* collectEvents(adapter.streamEvents, events);
      yield* Effect.yieldNow;
      const threadId = ThreadId.makeUnsafe("kimi-thread");
      const instanceId = ProviderInstanceId.makeUnsafe("kimi");
      const modelSelection = { provider: "kimi" as const, instanceId, model: "kimi-k2.7-code" };
      const session = yield* adapter.startSession({
        threadId,
        provider: "kimi",
        providerInstanceId: instanceId,
        cwd,
        runtimeMode: "approval-required",
        modelSelection,
        providerOptions: { kimi: { binaryPath: "/custom/kimi" } },
      });
      expect(session).toMatchObject({
        provider: "kimi",
        status: "ready",
        resumeCursor: { schemaVersion: 1, sessionId: "native-kimi" },
      });
      expect(agent.inputs[0]?.settings).toEqual({ binaryPath: "/custom/kimi" });
      expect(agent.inputs[0]?.spec.kind).toBe("kimi");
      const turn = yield* adapter.sendTurn({ threadId, input: "say hi", modelSelection });
      while (!events.some((event) => event.type === "turn.completed")) yield* Effect.sleep(5);
      expect(events.map((event) => event.type)).toEqual([
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ]);
      expect(events.at(-1)).toMatchObject({
        turnId: turn.turnId,
        payload: { state: "completed", stopReason: "end_turn" },
      });
      expect(events.every((event) => event.providerInstanceId === instanceId)).toBe(true);
      // Plan turns switch to the native plan mode; the next default turn switches back.
      yield* adapter.sendTurn({ threadId, input: "plan it", interactionMode: "plan" });
      while (events.filter((event) => event.type === "turn.completed").length < 2)
        yield* Effect.sleep(5);
      yield* adapter.sendTurn({ threadId, input: "do it" });
      while (events.filter((event) => event.type === "turn.completed").length < 3)
        yield* Effect.sleep(5);
      expect(agent.calls).toEqual([
        { method: "setConfigOption", args: ["model", "kimi-k2.7-code"] },
        { method: "setMode", args: ["plan"] },
        { method: "setMode", args: ["default"] },
      ]);
      const models = yield* adapter.listModels!({ provider: "kimi", instanceId });
      expect(models).toMatchObject({
        source: "kimi.acp",
        models: [
          { slug: "kimi-k2.6", name: "Kimi K2.6" },
          { slug: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
        ],
      });
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        withServerLayers(cwd)(makeKimiAdapterLive({}, { makeRuntime: agent.makeRuntime })),
      ),
      Effect.scoped,
      Effect.timeout("10 seconds"),
    ),
  );
});

it("surfaces a signed-out Kimi startup as a sign-in instruction and refuses the managed id", async () => {
  const cwd = await withAdapterCwd();
  const agent = makeFakeAgent({
    modes: KIMI_MODES,
    startError: new AcpRequestError({ code: -32000, errorMessage: "Authentication required" }),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const threadId = ThreadId.makeUnsafe("kimi-signed-out");
      const failed = yield* adapter
        .startSession({ threadId, provider: "kimi", cwd, runtimeMode: "full-access" })
        .pipe(Effect.flip);
      expect(failed.message).toContain("Kimi Code is not signed in");
      expect(failed.message).toContain("kimi login");
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      const managed = yield* adapter
        .startSession({
          threadId,
          provider: "kimi",
          providerInstanceId: ProviderInstanceId.makeUnsafe("kimi_moss"),
          cwd,
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      expect(managed.message).toContain("Managed Kimi Code configuration is missing");
      expect(agent.inputs).toHaveLength(1);
    }).pipe(
      Effect.provide(
        withServerLayers(cwd)(makeKimiAdapterLive({}, { makeRuntime: agent.makeRuntime })),
      ),
      Effect.scoped,
      Effect.timeout("10 seconds"),
    ),
  );
});

it("runs managed Kimi from its isolated realm home with gateway model ids and no CLI discovery", async () => {
  const cwd = await withAdapterCwd();
  const gateway = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
  vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gateway);
  const agent = makeFakeAgent({
    modes: KIMI_MODES,
    configOptions: [
      {
        ...modelOption,
        currentValue: "kimi-code/k3",
        options: [
          { value: "kimi-code/k3", name: "K3" },
          { value: "moss/kimi-k3", name: "Kimi K3" },
        ],
      },
    ],
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const homePath = path.join(serverConfig.stateDir, "provider-homes", "kimi", "cn");
      const instance = buildMossManagedAcpAgentProviderInstance(KIMI_ACP_AGENT_SPEC, {
        accessToken: "isolated-token",
        gatewayBaseUrl: gateway,
        homePath,
        runtimeGeneration: "generation",
        realm: "cn",
      });
      const environment = Object.fromEntries(
        instance.environment.map((entry) => [entry.name, entry.value]),
      );
      const instanceId = ProviderInstanceId.makeUnsafe("kimi_moss");
      const threadId = ThreadId.makeUnsafe("managed-kimi-thread");
      const modelSelection = { provider: "kimi" as const, instanceId, model: "kimi-k3" };
      const adapter = yield* KimiAdapter;
      const foreignModel = yield* adapter
        .startSession({
          threadId,
          provider: "kimi",
          providerInstanceId: instanceId,
          cwd,
          runtimeMode: "approval-required",
          modelSelection: { ...modelSelection, model: "gpt-5.6-sol" },
          providerOptions: { kimi: { homePath, environment } },
        })
        .pipe(Effect.flip);
      expect(foreignModel.message).toContain("not available in this Moss realm");
      // The launch path must carry the isolated home (the HEAD managed-Hermes failure).
      const withoutHome = yield* adapter
        .startSession({
          threadId,
          provider: "kimi",
          providerInstanceId: instanceId,
          cwd,
          runtimeMode: "approval-required",
          modelSelection,
          providerOptions: { kimi: { environment } },
        })
        .pipe(Effect.flip);
      expect(withoutHome.message).toContain("isolated realm home");
      expect(agent.inputs).toHaveLength(0);
      const session = yield* adapter.startSession({
        threadId,
        provider: "kimi",
        providerInstanceId: instanceId,
        cwd,
        runtimeMode: "approval-required",
        modelSelection,
        providerOptions: { kimi: { homePath, environment } },
      });
      expect(session.providerInstanceId).toBe(instanceId);
      const settings = agent.inputs[0]!.settings;
      expect(settings.managed).toMatchObject({ realm: "cn", homePath, models: ["kimi-k3"] });
      const spawn = buildAcpAgentSpawnInput(KIMI_ACP_AGENT_SPEC, settings, cwd);
      expect(spawn.env).toMatchObject({
        KIMI_CODE_HOME: homePath,
        MOSS_ACCESS_TOKEN: "isolated-token",
      });
      expect(spawn.env?.MOSS_KIMI_CONFIG_CONTENT).toBeUndefined();
      const config = yield* Effect.promise(() =>
        readFile(path.join(homePath, "config.toml"), "utf8"),
      );
      expect(config).not.toContain("isolated-token");
      expect(config).toContain('api_key_env = "MOSS_ACCESS_TOKEN"');
      if (process.platform !== "win32") {
        expect(
          (yield* Effect.promise(() => stat(path.join(homePath, "config.toml")))).mode & 0o777,
        ).toBe(0o600);
      }
      expect(agent.calls).toEqual([{ method: "setConfigOption", args: ["model", "moss/kimi-k3"] }]);
      const rejectedTurn = yield* adapter
        .sendTurn({
          threadId,
          input: "hi",
          modelSelection: { ...modelSelection, model: "deepseek-v4-pro" },
        })
        .pipe(Effect.flip);
      expect(rejectedTurn.message).toContain("not available in this Moss realm");
      const models = yield* adapter.listModels!({
        provider: "kimi",
        instanceId,
        environment,
        homePath,
        binaryPath: "/must/not/spawn",
      });
      expect(models).toMatchObject({
        source: "moss-managed-kimi",
        models: [{ slug: "kimi-k3", name: "Kimi K3" }],
      });
      expect(agent.inputs).toHaveLength(1);
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        withServerLayers(cwd)(makeKimiAdapterLive({}, { makeRuntime: agent.makeRuntime })),
      ),
      Effect.scoped,
      Effect.timeout("10 seconds"),
    ),
  );
});

it("moves ZCode off yolo at startup and classifies first-prompt backend failures", async () => {
  const cwd = await withAdapterCwd();
  const agent = makeFakeAgent({
    modes: ZCODE_MODES,
    prompt: () =>
      Effect.fail(
        new AcpRequestError({
          code: -32603,
          errorMessage:
            "ZCode turn failed: session/create failed: ZCode backend reader exited (backend dead)",
          data: { type: "zcode_turn_failed" },
        }),
      ),
  });
  const events: ProviderRuntimeEvent[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* ZcodeAdapter;
      yield* collectEvents(adapter.streamEvents, events);
      yield* Effect.yieldNow;
      const threadId = ThreadId.makeUnsafe("zcode-thread");
      yield* adapter.startSession({
        threadId,
        provider: "zcode",
        cwd,
        runtimeMode: "full-access",
        providerOptions: { zcode: { environment: { ZCODE_PROVIDER: "builtin:zai-coding-plan" } } },
      });
      expect(agent.calls).toEqual([{ method: "setMode", args: ["build"] }]);
      expect(agent.inputs[0]?.settings.environment).toEqual({
        ZCODE_PROVIDER: "builtin:zai-coding-plan",
      });
      yield* adapter.sendTurn({ threadId, input: "hello" });
      while (!events.some((event) => event.type === "turn.completed")) yield* Effect.sleep(5);
      const completion = events.find((event) => event.type === "turn.completed")!;
      expect(completion.payload).toMatchObject({ state: "failed" });
      const errorMessage =
        "errorMessage" in completion.payload ? completion.payload.errorMessage : undefined;
      expect(errorMessage).toContain("ZCode desktop app");
      expect(errorMessage).toContain("ZCODE_BIN");
      const sessions = yield* adapter.listSessions();
      expect(sessions[0]).toMatchObject({ status: "error" });
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        withServerLayers(cwd)(makeZcodeAdapterLive({}, { makeRuntime: agent.makeRuntime })),
      ),
      Effect.scoped,
      Effect.timeout("10 seconds"),
    ),
  );
});

it("fails ZCode startup fast when its upfront credential check is rejected", async () => {
  const cwd = await withAdapterCwd();
  const agent = makeFakeAgent({
    modes: ZCODE_MODES,
    startError: new AcpRequestError({
      code: -32000,
      errorMessage:
        "No ZCode credentials found: sign in to the ZCode desktop app, or run zcode-acp setup to save an account, then retry.",
    }),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* ZcodeAdapter;
      const failed = yield* adapter
        .startSession({
          threadId: ThreadId.makeUnsafe("zcode-signed-out"),
          provider: "zcode",
          cwd,
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      expect(failed.message).toContain("ZCode session startup failed");
      expect(failed.message).toContain("No ZCode credentials found");
      expect(failed.message).toContain("zcode-acp setup --provider bigmodel");
    }).pipe(
      Effect.provide(
        withServerLayers(cwd)(makeZcodeAdapterLive({}, { makeRuntime: agent.makeRuntime })),
      ),
      Effect.scoped,
      Effect.timeout("10 seconds"),
    ),
  );
});
