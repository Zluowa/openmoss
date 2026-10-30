import type * as Acp from "@agentclientprotocol/sdk";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KIMI_ACP_AGENT_SPEC,
  MINIMAX_ACP_AGENT_SPEC,
  ZCODE_ACP_AGENT_SPEC,
  type AcpAgentSpec,
} from "./AcpAgentSpec.ts";
import {
  type AcpAgentRuntimeInput,
  acpAgentFailureDetail,
  applyAcpAgentModelSelection,
  classifyAcpAgentFailure,
  applyAcpAgentSessionConfiguration,
  buildAcpAgentSpawnInput,
  makeAcpAgentRuntime,
  parseAcpAgentModels,
  prepareAcpAgentRuntimeSettings,
  resolveAcpAgentAuthMethodId,
  resolveAcpAgentSessionModeId,
} from "./AcpAgentSupport.ts";
import { AcpRequestError } from "./AcpErrors.ts";
import type { AcpSessionModeState } from "./AcpRuntimeModel.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
} from "./AcpSessionRuntime.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const modelOption = (
  current: string,
  values: ReadonlyArray<string>,
  id = "model",
): Acp.SessionConfigOption => ({
  type: "select",
  id,
  name: "Model",
  category: "model",
  currentValue: current,
  options: values.map((value) => ({ value, name: value.toUpperCase() })),
});

const thoughtOption = (
  id: string,
  current: string,
  values: ReadonlyArray<string>,
): Acp.SessionConfigOption => ({
  type: "select",
  id,
  name: "Thinking",
  category: "thought_level",
  currentValue: current,
  options: values.map((value) => ({ value, name: value })),
});

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

const passThroughError = ({ cause }: { cause: unknown }) => cause as Error;

function fakeConfigurableRuntime(input: {
  readonly configOptions?: ReadonlyArray<Acp.SessionConfigOption>;
  readonly modeState?: AcpSessionModeState;
}) {
  const calls: Array<{ method: string; args: ReadonlyArray<unknown> }> = [];
  let configOptions = input.configOptions ?? [];
  let modeState = input.modeState;
  const runtime = {
    start: () => Effect.succeed({ sessionId: "session-1" }),
    request: (method: string, payload: unknown) =>
      Effect.sync(() => {
        calls.push({ method, args: [payload] });
        return {};
      }),
    getConfigOptions: Effect.sync(() => configOptions),
    setConfigOption: (configId: string, value: string | boolean) =>
      Effect.sync(() => {
        calls.push({ method: "setConfigOption", args: [configId, value] });
        configOptions = selectConfigOption(configOptions, configId, String(value));
        return {} as Acp.SetSessionConfigOptionResponse;
      }),
    getModeState: Effect.sync(() => modeState),
    setMode: (modeId: string) =>
      Effect.sync(() => {
        calls.push({ method: "setMode", args: [modeId] });
        if (modeState) modeState = { ...modeState, currentModeId: modeId };
        return {} as Acp.SetSessionModeResponse;
      }),
  } as unknown as Pick<
    AcpSessionRuntimeShape,
    "start" | "request" | "getConfigOptions" | "setConfigOption" | "getModeState" | "setMode"
  >;
  return { runtime, calls };
}

describe("buildAcpAgentSpawnInput", () => {
  it.each([
    [KIMI_ACP_AGENT_SPEC, "kimi", ["acp"]],
    [MINIMAX_ACP_AGENT_SPEC, "mcode", ["acp"]],
    [ZCODE_ACP_AGENT_SPEC, "zcode-acp-server", []],
  ])("launches %s through its own login without injected keys", (spec, command, args) => {
    vi.stubEnv("MOSS_ACCESS_TOKEN", "server-secret");
    vi.stubEnv("HOME", "/Users/me");
    const spawn = buildAcpAgentSpawnInput(spec, {}, "/workspace");
    expect(spawn.command).toBe(command);
    expect(spawn.args).toEqual(args);
    expect(spawn.cwd).toBe("/workspace");
    expect(spawn.inheritedMossKeys).toBeUndefined();
    expect(spawn.env?.MOSS_ACCESS_TOKEN).toBeUndefined();
    expect(spawn.env?.HOME).toBe("/Users/me");
    for (const key of ["KIMI_CODE_HOME", "MINIMAX_DATA_DIR", "ZCODE_HOME", "KIMI_MODEL_API_KEY"])
      expect(spawn.env?.[key]).toBeUndefined();
  });

  it("gives the ZCode bridge Moss's mode and status defaults, letting the instance override", () => {
    const defaults = buildAcpAgentSpawnInput(ZCODE_ACP_AGENT_SPEC, {}, "/workspace");
    expect(defaults.env).toMatchObject({
      ZCODE_ACP_MODE: "build",
      ZCODE_ACP_SHOW_COMPLETION_STATUS: "0",
    });
    const overridden = buildAcpAgentSpawnInput(
      ZCODE_ACP_AGENT_SPEC,
      { binaryPath: "/opt/zcode/dist/cli.js", environment: { ZCODE_ACP_MODE: "edit" } },
      "/workspace",
    );
    expect(overridden.command).toBe("/opt/zcode/dist/cli.js");
    expect(overridden.env?.ZCODE_ACP_MODE).toBe("edit");
    expect(overridden.env?.ZCODE_ACP_SHOW_COMPLETION_STATUS).toBe("0");
  });

  it("forwards instance environment, explicit homes and configured MOSS_ keys only", () => {
    const spawn = buildAcpAgentSpawnInput(
      KIMI_ACP_AGENT_SPEC,
      {
        binaryPath: "/custom/kimi",
        homePath: "/profiles/kimi-work",
        environment: { KIMI_DISABLE_TELEMETRY: "1", MOSS_SCOPED_KEY: "configured" },
      },
      "/workspace",
    );
    expect(spawn.command).toBe("/custom/kimi");
    expect(spawn.inheritedMossKeys).toEqual(["MOSS_SCOPED_KEY"]);
    expect(spawn.env).toMatchObject({
      KIMI_DISABLE_TELEMETRY: "1",
      MOSS_SCOPED_KEY: "configured",
      KIMI_CODE_HOME: "/profiles/kimi-work",
    });
  });
});

describe("resolveAcpAgentAuthMethodId", () => {
  it("turns an on-demand auth challenge into a sign-in instruction instead of authenticating", async () => {
    const failed = await Effect.runPromise(
      resolveAcpAgentAuthMethodId(KIMI_ACP_AGENT_SPEC)({
        protocolVersion: 1,
        authMethods: [{ id: "login", name: "Login with Kimi account" }],
      }).pipe(Effect.flip),
    );
    expect(failed).toBeInstanceOf(AcpRequestError);
    expect(failed.message).toContain("kimi login");
    expect((failed as AcpRequestError).data).toMatchObject({
      reason: "credentials_missing",
      authMethods: ["login"],
    });
  });

  it("authenticates ZCode up front with its built-in credentials method", async () => {
    expect(
      await Effect.runPromise(
        resolveAcpAgentAuthMethodId(ZCODE_ACP_AGENT_SPEC)({
          protocolVersion: 1,
          authMethods: [{ id: "zcode-credentials", name: "ZCode built-in credentials" }],
        }),
      ),
    ).toBe("zcode-credentials");
    const failed = await Effect.runPromise(
      resolveAcpAgentAuthMethodId(ZCODE_ACP_AGENT_SPEC)({ protocolVersion: 1 }).pipe(Effect.flip),
    );
    expect((failed as AcpRequestError).data).toMatchObject({ reason: "compatibility_mismatch" });
  });
});

describe("makeAcpAgentRuntime", () => {
  it.each([
    [KIMI_ACP_AGENT_SPEC, "on-demand"],
    [MINIMAX_ACP_AGENT_SPEC, "on-demand"],
    [ZCODE_ACP_AGENT_SPEC, "always"],
  ])("wires %s into the shared ACP runtime with its auth policy", async (spec, authPolicy) => {
    let options!: AcpSessionRuntimeOptions;
    vi.spyOn(AcpSessionRuntime, "layer").mockImplementation((value) => {
      options = value;
      return Layer.succeed(AcpSessionRuntime, {} as AcpSessionRuntimeShape);
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* makeAcpAgentRuntime({
          spec,
          settings: {},
          childProcessSpawner: {},
          cwd: "/workspace",
          clientInfo: { name: "test", version: "0" },
          startupTimeouts: { totalMs: 5_000 },
        } as AcpAgentRuntimeInput);
      }).pipe(Effect.scoped),
    );
    expect(options.provider).toBe(spec.kind);
    expect(options.authPolicy).toBe(authPolicy);
    expect(options.spawn.command).toBe(spec.command);
    expect(options.clientCapabilities).toEqual({ elicitation: { form: {} } });
    expect(options.startupTimeouts).toMatchObject({ ...spec.startupTimeouts, totalMs: 5_000 });
    expect(options.resolveAuthMethodId).toBeTypeOf("function");
  });
});

describe("prepareAcpAgentRuntimeSettings", () => {
  it("refuses the reserved managed instance without its managed configuration", async () => {
    await expect(
      Effect.runPromise(prepareAcpAgentRuntimeSettings(KIMI_ACP_AGENT_SPEC, {}, "kimi_moss")),
    ).rejects.toThrow("Managed Kimi Code configuration is missing");
    expect(
      await Effect.runPromise(
        prepareAcpAgentRuntimeSettings(KIMI_ACP_AGENT_SPEC, { binaryPath: "/k" }, "kimi_work"),
      ),
    ).toEqual({ binaryPath: "/k" });
    const withoutHooks: AcpAgentSpec = { ...KIMI_ACP_AGENT_SPEC };
    delete (withoutHooks as { managed?: unknown }).managed;
    await expect(
      Effect.runPromise(prepareAcpAgentRuntimeSettings(withoutHooks, {}, "kimi_moss")),
    ).rejects.toThrow("Managed Kimi Code is not available");
  });

  it("lets a spec's managed hooks claim the reserved instance and prepare its home", async () => {
    const prepared: string[] = [];
    const spec: AcpAgentSpec = {
      ...KIMI_ACP_AGENT_SPEC,
      managed: {
        readConfig: (settings) =>
          settings.environment?.MOSS_KIMI_MANAGED
            ? {
                realm: "cn",
                gatewayBaseUrl: "https://gateway.test/v1",
                homePath: "/state/kimi/cn",
                models: ["kimi-k3"],
              }
            : undefined,
        prepareHome: async (config) => {
          prepared.push(config.homePath);
        },
        buildSpawnEnvironment: () => ({
          environment: { KIMI_CODE_HOME: "/state/kimi/cn" },
          inheritedMossKeys: [],
        }),
        listModels: () => ({ models: [] }),
      },
    };
    const settings = { environment: { MOSS_KIMI_MANAGED: "{}" } };
    expect(
      await Effect.runPromise(prepareAcpAgentRuntimeSettings(spec, settings, "kimi_moss")),
    ).toMatchObject({ managed: { realm: "cn" } });
    expect(prepared).toEqual(["/state/kimi/cn"]);
    expect(
      await Effect.runPromise(
        prepareAcpAgentRuntimeSettings(spec, settings, "kimi_moss", { materializeHome: false }),
      ),
    ).toMatchObject({ managed: { realm: "cn" } });
    expect(prepared).toEqual(["/state/kimi/cn"]);
    await expect(
      Effect.runPromise(prepareAcpAgentRuntimeSettings(spec, settings, "kimi")),
    ).rejects.toThrow("reserved Moss instance");
    await expect(
      Effect.runPromise(prepareAcpAgentRuntimeSettings(spec, {}, "kimi_moss")),
    ).rejects.toThrow("configuration is missing");
  });
});

describe("applyAcpAgentModelSelection", () => {
  it("selects through the advertised model option and skips an unchanged value", async () => {
    const { runtime, calls } = fakeConfigurableRuntime({
      configOptions: [
        modelOption("kimi-k2.6", ["kimi-k2.6", "kimi-k2.7-code"]),
        thoughtOption("thinking", "off", ["off", "low", "high"]),
      ],
    });
    await Effect.runPromise(
      applyAcpAgentModelSelection({
        spec: KIMI_ACP_AGENT_SPEC,
        runtime,
        selection: { model: "kimi-k2.7-code", reasoningEffort: "high" },
      }),
    );
    await Effect.runPromise(
      applyAcpAgentModelSelection({
        spec: KIMI_ACP_AGENT_SPEC,
        runtime,
        selection: { model: "kimi-k2.7-code", reasoningEffort: "high" },
      }),
    );
    expect(calls).toEqual([
      { method: "setConfigOption", args: ["model", "kimi-k2.7-code"] },
      { method: "setConfigOption", args: ["thinking", "high"] },
    ]);
  });

  it("falls back to the legacy session/set_model request only where the CLI implements it", async () => {
    const kimi = fakeConfigurableRuntime({ configOptions: [] });
    await Effect.runPromise(
      applyAcpAgentModelSelection({
        spec: KIMI_ACP_AGENT_SPEC,
        runtime: kimi.runtime,
        selection: { model: "moss/kimi-k3" },
      }),
    );
    expect(kimi.calls).toEqual([
      { method: "session/set_model", args: [{ sessionId: "session-1", modelId: "moss/kimi-k3" }] },
    ]);
    const minimax = fakeConfigurableRuntime({ configOptions: [] });
    const failed = await Effect.runPromise(
      applyAcpAgentModelSelection({
        spec: MINIMAX_ACP_AGENT_SPEC,
        runtime: minimax.runtime,
        selection: { model: "m:minimax:MiniMax-M3:u" },
      }).pipe(Effect.flip),
    );
    expect(failed.message).toContain("did not advertise a model option");
    expect(minimax.calls).toEqual([]);
  });
});

describe("resolveAcpAgentSessionModeId", () => {
  const zcodeModes: AcpSessionModeState = {
    currentModeId: "yolo",
    availableModes: ["plan", "build", "edit", "guarded", "yolo"].map((id) => ({ id, name: id })),
  };
  const kimiModes: AcpSessionModeState = {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
      { id: "auto", name: "Auto" },
      { id: "yolo", name: "YOLO" },
    ],
  };

  it("moves ZCode off its yolo default and onto build, or plan for plan turns", () => {
    expect(
      resolveAcpAgentSessionModeId({
        spec: ZCODE_ACP_AGENT_SPEC,
        modeState: zcodeModes,
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toBe("build");
    expect(
      resolveAcpAgentSessionModeId({
        spec: ZCODE_ACP_AGENT_SPEC,
        modeState: zcodeModes,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
    ).toBe("plan");
    expect(
      resolveAcpAgentSessionModeId({
        spec: ZCODE_ACP_AGENT_SPEC,
        modeState: {
          currentModeId: "yolo",
          availableModes: [
            { id: "guarded", name: "Guarded" },
            { id: "yolo", name: "Yolo" },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toBeUndefined();
  });

  it("keeps Kimi on its ask mode for every runtime mode, using plan only for plan turns", () => {
    for (const runtimeMode of ["approval-required", "auto", "full-access"] as const) {
      expect(
        resolveAcpAgentSessionModeId({
          spec: KIMI_ACP_AGENT_SPEC,
          modeState: kimiModes,
          runtimeMode,
          interactionMode: "default",
        }),
      ).toBe("default");
    }
    expect(
      resolveAcpAgentSessionModeId({
        spec: KIMI_ACP_AGENT_SPEC,
        modeState: { ...kimiModes, currentModeId: "yolo" },
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    ).toBe("plan");
  });

  it("falls back to MiniMax's default mode when plan is not advertised", () => {
    expect(
      resolveAcpAgentSessionModeId({
        spec: MINIMAX_ACP_AGENT_SPEC,
        modeState: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
    ).toBe("default");
  });
});

describe("applyAcpAgentSessionConfiguration", () => {
  it("pins MiniMax's process-wide permission mode and switches only changed modes", async () => {
    const { runtime, calls } = fakeConfigurableRuntime({
      configOptions: [
        modelOption("m:minimax:MiniMax-M3:u", ["m:minimax:MiniMax-M3:u"]),
        {
          type: "select",
          id: "permissionMode",
          name: "Permission mode",
          category: "_permission",
          currentValue: "bypassPermissions",
          options: ["default", "auto", "bypassPermissions"].map((value) => ({
            value,
            name: value,
          })),
        },
      ],
      modeState: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
    });
    const mapError = passThroughError;
    await Effect.runPromise(
      applyAcpAgentSessionConfiguration({
        spec: MINIMAX_ACP_AGENT_SPEC,
        runtime,
        runtimeMode: "full-access",
        interactionMode: "plan",
        modelSelection: { model: "m:minimax:MiniMax-M3:u" },
        mapError,
      }),
    );
    await Effect.runPromise(
      applyAcpAgentSessionConfiguration({
        spec: MINIMAX_ACP_AGENT_SPEC,
        runtime,
        runtimeMode: "full-access",
        interactionMode: "default",
        modelSelection: { model: "m:minimax:MiniMax-M3:u" },
        configuredModel: { model: "m:minimax:MiniMax-M3:u" },
        mapError,
      }),
    );
    expect(calls).toEqual([
      { method: "setConfigOption", args: ["permissionMode", "default"] },
      { method: "setMode", args: ["plan"] },
      { method: "setMode", args: ["default"] },
    ]);
  });

  it("refuses an agent that only offers approval-bypassing modes", async () => {
    const { runtime } = fakeConfigurableRuntime({
      modeState: { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "Yolo" }] },
    });
    const failed = await Effect.runPromise(
      applyAcpAgentSessionConfiguration({
        spec: ZCODE_ACP_AGENT_SPEC,
        runtime,
        runtimeMode: "full-access",
        interactionMode: "default",
        modelSelection: undefined,
        mapError: ({ cause }) => cause,
      }).pipe(Effect.flip),
    );
    expect(failed.message).toContain("refuses to run it unrestricted");
  });
});

describe("parseAcpAgentModels", () => {
  it("exposes the CLI's model values as slugs with its display names and current thought levels", () => {
    const models = parseAcpAgentModels(ZCODE_ACP_AGENT_SPEC, {
      sessionId: "s",
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "builtin:bigmodel-coding-plan\\glm-5.3",
          options: [
            { value: "builtin:bigmodel-coding-plan\\glm-5.3", name: "GLM-5.3" },
            { value: "builtin:bigmodel-coding-plan\\glm-5.3-flash", name: "GLM-5.3 Flash" },
            { value: "builtin:bigmodel-coding-plan\\glm-5.3", name: "duplicate" },
          ],
        },
        thoughtOption("thought", "high", ["low", "high", "max"]),
        {
          type: "select",
          id: "mode",
          name: "Mode",
          category: "mode",
          currentValue: "build",
          options: [{ value: "build", name: "Build" }],
        },
      ],
    });
    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["builtin:bigmodel-coding-plan\\glm-5.3", "GLM-5.3"],
      ["builtin:bigmodel-coding-plan\\glm-5.3-flash", "GLM-5.3 Flash"],
    ]);
    expect(models[0]?.supportedReasoningEfforts?.map((effort) => effort.value)).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(models[1]?.supportedReasoningEfforts).toEqual([]);
  });

  it("falls back to the legacy availableModels catalog", () => {
    expect(
      parseAcpAgentModels(KIMI_ACP_AGENT_SPEC, {
        sessionId: "s",
        models: {
          currentModelId: "a",
          availableModels: [
            { modelId: "a", name: "A" },
            { modelId: "", name: "" },
          ],
        },
      } as unknown as Acp.NewSessionResponse),
    ).toEqual([{ slug: "a", name: "A" }]);
  });
});

describe("acpAgentFailureDetail", () => {
  it("leads with the classified hint and keeps the agent's wording for everything else", () => {
    expect(
      acpAgentFailureDetail(
        KIMI_ACP_AGENT_SPEC,
        new AcpRequestError({ code: -32000, errorMessage: "Authentication required" }),
      ),
    ).toMatch(/^Kimi Code is not signed in\. Run `kimi login`.*\(Authentication required\)$/u);
    // Moss's own typed sign-in failure renders without raw reason codes.
    const signedOut = acpAgentFailureDetail(
      MINIMAX_ACP_AGENT_SPEC,
      new AcpRequestError({
        code: -32602,
        errorMessage: `MiniMax Code is not signed in. ${MINIMAX_ACP_AGENT_SPEC.signIn.hint}`,
        data: { authMethods: ["minimax-code-login"], reason: "credentials_missing" },
      }),
    );
    expect(signedOut).toBe(`MiniMax Code is not signed in. ${MINIMAX_ACP_AGENT_SPEC.signIn.hint}`);
    expect(
      classifyAcpAgentFailure(
        MINIMAX_ACP_AGENT_SPEC,
        new AcpRequestError({
          code: -32602,
          errorMessage: "x",
          data: { reason: "credentials_missing" },
        }),
      )?.reason,
    ).toBe("credentials_missing");
    expect(
      acpAgentFailureDetail(
        MINIMAX_ACP_AGENT_SPEC,
        new AcpRequestError({ code: -32603, errorMessage: "Internal error", data: "boom" }),
      ),
    ).toBe("Internal error boom (JSON-RPC -32603)");
  });
});
