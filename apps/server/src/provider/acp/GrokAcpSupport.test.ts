import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMossManagedGrokProviderInstance } from "../mossManagedGrokEnvironment.ts";
import { buildAcpSpawnProcessEnv } from "./AcpSessionRuntime.ts";
import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  isGrokSessionStoragePathNotFoundError,
  makeGrokAcpRuntime,
  resolveGrokAcpAuthMethodId,
  resolveGrokAcpAuthMethodIdForEnv,
  runGrokAcpCompactionCommand,
} from "./GrokAcpSupport.ts";

function initializeWithAuthMethods(ids: ReadonlyArray<string>): Acp.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("buildGrokAcpSpawnInput", () => {
  it("builds the default Grok ACP command", () => {
    expect(buildGrokAcpSpawnInput(undefined, "/tmp/project", "approval-required")).toMatchObject({
      command: "grok",
      args: ["--permission-mode", "default", "agent", "--no-leader", "stdio"],
      cwd: "/tmp/project",
      providerEnvironment: { driver: "grok" },
    });
  });

  it("passes model and reasoning effort without process-wide approval overrides", () => {
    const spawn = buildGrokAcpSpawnInput(
      {
        binaryPath: "/usr/local/bin/grok",
        model: "grok-build",
        reasoningEffort: "high",
      },
      "/tmp/project",
      "approval-required",
    );

    expect(spawn).toMatchObject({
      command: "/usr/local/bin/grok",
      args: [
        "--permission-mode",
        "default",
        "agent",
        "--no-leader",
        "-m",
        "grok-build",
        "--reasoning-effort",
        "high",
        "stdio",
      ],
      cwd: "/tmp/project",
      providerEnvironment: { driver: "grok" },
    });
    expect(spawn.args).not.toContain("--always-approve");
  });

  it("passes Grok 4.6 extra-high reasoning effort to the CLI", () => {
    expect(
      buildGrokAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/grok",
          model: "grok-4.6",
          reasoningEffort: "xhigh",
        },
        "/tmp/project",
        "approval-required",
      ).args,
    ).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "--no-leader",
      "-m",
      "grok-4.6",
      "--reasoning-effort",
      "xhigh",
      "stdio",
    ]);
  });

  it("uses Grok's process-scoped approval override only for Full Access", () => {
    expect(buildGrokAcpSpawnInput(undefined, "/tmp/project", "full-access").args).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "--no-leader",
      "--always-approve",
      "stdio",
    ]);
  });
});

describe("isGrokSessionStoragePathNotFoundError", () => {
  it("matches Grok's stable persistence code", () => {
    expect(
      isGrokSessionStoragePathNotFoundError(
        new AcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Path not found.",
          data: { code: "FS_NOT_FOUND", detail: "No such file or directory (os error 2)" },
        }),
      ),
    ).toBe(true);
  });

  it("does not retry other ACP or filesystem failures", () => {
    expect(
      isGrokSessionStoragePathNotFoundError(
        new AcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Permission denied.",
          data: { code: "FS_PERMISSION_DENIED" },
        }),
      ),
    ).toBe(false);
    expect(
      isGrokSessionStoragePathNotFoundError(
        new AcpErrors.AcpTransportError({
          detail: "connection closed",
          cause: new Error("connection closed"),
        }),
      ),
    ).toBe(false);
  });
});

describe("resolveGrokAcpAuthMethodId", () => {
  const previousXaiApiKey = process.env.XAI_API_KEY;
  const previousApiKey = process.env.GROK_CODE_XAI_API_KEY;

  afterEach(() => {
    if (previousXaiApiKey === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = previousXaiApiKey;
    }
    if (previousApiKey === undefined) {
      delete process.env.GROK_CODE_XAI_API_KEY;
    } else {
      process.env.GROK_CODE_XAI_API_KEY = previousApiKey;
    }
  });

  it("prefers the xAI API key auth method when XAI_API_KEY is present", async () => {
    process.env.XAI_API_KEY = "xai-test-key";

    await expect(
      Effect.runPromise(
        resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["cached_token", "xai.api_key"])),
      ),
    ).resolves.toBe("xai.api_key");
  });

  it("still accepts the legacy Grok API key env var", async () => {
    delete process.env.XAI_API_KEY;
    process.env.GROK_CODE_XAI_API_KEY = "xai-test-key";

    await expect(
      Effect.runPromise(
        resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["cached_token", "xai.api_key"])),
      ),
    ).resolves.toBe("xai.api_key");
  });

  it("uses the selected legacy key without inheriting an ambient XAI_API_KEY alias", async () => {
    process.env.XAI_API_KEY = "ambient-account-a";
    delete process.env.GROK_CODE_XAI_API_KEY;

    await expect(
      Effect.runPromise(
        resolveGrokAcpAuthMethodIdForEnv(
          { GROK_CODE_XAI_API_KEY: "selected-account-b" },
          "grok_work",
        )(initializeWithAuthMethods(["cached_token", "xai.api_key"])),
      ),
    ).resolves.toBe("xai.api_key");
  });

  it("falls back to cached token auth when no API key is configured", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;

    await expect(
      Effect.runPromise(
        resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["cached_token", "xai.api_key"])),
      ),
    ).resolves.toBe("cached_token");
  });

  it("identifies an interactive-only advertisement as missing headless credentials", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;

    const error = await Effect.runPromise(
      resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["browser_login"])).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
    expect(error.message).toContain("not authenticated for headless ACP");
    expect(error.message).toContain("browser_login");
  });

  it("explains when an advertised API-key method has no configured key", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;

    const error = await Effect.runPromise(
      resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["xai.api_key"])).pipe(Effect.flip),
    );

    expect(error.message).toContain("XAI_API_KEY is not set");
  });

  it("distinguishes an API-key advertisement mismatch from missing credentials", async () => {
    process.env.XAI_API_KEY = "xai-test-key";

    const error = await Effect.runPromise(
      resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["grok.com"])).pipe(Effect.flip),
    );

    expect(error.message).toContain("did not advertise API-key authentication");
    expect(error.message).toContain("grok.com");
  });

  it("reports unknown or empty auth advertisements as a compatibility mismatch", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;

    const unknownError = await Effect.runPromise(
      resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["future_auth"])).pipe(Effect.flip),
    );
    const emptyError = await Effect.runPromise(
      resolveGrokAcpAuthMethodId(initializeWithAuthMethods([])).pipe(Effect.flip),
    );

    expect(unknownError.message).toContain("advertised: future_auth");
    expect(emptyError.message).toContain("advertised: none");
  });
});

describe("applyGrokAcpModelSelection", () => {
  it("does not call Grok's unsupported ACP config-option method", async () => {
    const calls: Array<
      { type: "model"; value: string } | { type: "config"; id: string; value: string }
    > = [];
    const runtime = {
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      getConfigOptions: Effect.succeed([
        {
          id: "reasoning_effort",
          name: "Reasoning Effort",
          category: "model_config",
          type: "select",
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ] as ReadonlyArray<Acp.SessionConfigOption>),
      setConfigOption: (id: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", id, value: String(value) });
          return { configOptions: [] };
        }),
    };

    await Effect.runPromise(
      applyGrokAcpModelSelection({
        runtime,
        model: "grok-build",
        options: { reasoningEffort: "high" },
        mapError: (context) => context,
      }),
    );

    expect(calls).toEqual([]);
  });
});

describe("runGrokAcpCompactionCommand", () => {
  it("runs Grok's advertised /compact command explicitly in agent mode", async () => {
    const prompts: Array<Omit<Acp.PromptRequest, "sessionId">> = [];
    const runtime = {
      getAvailableCommands: Effect.succeed([
        {
          name: "compact",
          description: "Compress conversation history to save context window",
        },
      ]),
      prompt: (payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          prompts.push(payload);
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    await expect(Effect.runPromise(runGrokAcpCompactionCommand(runtime))).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(prompts).toEqual([
      {
        prompt: [{ type: "text", text: "/compact" }],
        _meta: { mode: "agent" },
      },
    ]);
  });

  it("keeps /compact compatible when an older Grok ACP advertises no commands", async () => {
    const prompts: Array<Omit<Acp.PromptRequest, "sessionId">> = [];
    const runtime = {
      getAvailableCommands: Effect.succeed([]),
      prompt: (payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          prompts.push(payload);
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    await Effect.runPromise(runGrokAcpCompactionCommand(runtime));

    expect(prompts).toHaveLength(1);
  });

  it("fails clearly when Grok advertises commands without /compact", async () => {
    let promptCalled = false;
    const runtime = {
      getAvailableCommands: Effect.succeed([
        {
          name: "review",
          description: "Review changes",
        },
      ]),
      prompt: (_payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          promptCalled = true;
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    const error = await Effect.runPromise(runGrokAcpCompactionCommand(runtime).pipe(Effect.flip));

    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
    expect(error.message).toContain("does not advertise the /compact command");
    expect(promptCalled).toBe(false);
  });
});

describe("managed Grok launch", () => {
  const gateway = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
  const homes: string[] = [];

  const managedSettings = async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "moss-grok-managed-")));
    homes.push(root);
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gateway);
    const instance = buildMossManagedGrokProviderInstance({
      accessToken: "gateway-bearer",
      gatewayBaseUrl: gateway,
      homePath: path.join(root, "cn"),
      runtimeGeneration: "generation",
      realm: "cn",
    });
    return {
      home: path.join(root, "cn"),
      settings: {
        binaryPath: path.join(root, "missing-grok-binary"),
        instanceId: "grok_moss",
        model: "moss/deepseek-v4-flash",
        environment: Object.fromEntries(
          instance.environment.map((entry) => [entry.name, entry.value]),
        ),
      },
    };
  };

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("gives only the gateway credential to the child and never a personal xAI key", async () => {
    const { home, settings } = await managedSettings();
    const spawn = buildGrokAcpSpawnInput(settings, "/tmp/project", "full-access");
    const env = buildAcpSpawnProcessEnv(spawn, {
      PATH: "/usr/bin",
      XAI_API_KEY: "personal-key",
      MOSS_AUTH_TOKEN: "server-secret",
    });

    expect(env.MOSS_ACCESS_TOKEN).toBe("gateway-bearer");
    expect(env.GROK_HOME).toBe(home);
    expect(env.GROK_CAMPAIGNS).toBe("0");
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.MOSS_AUTH_TOKEN).toBeUndefined();
  });

  it("authenticates through the generated config and refuses a personal login", async () => {
    const { settings } = await managedSettings();
    const resolve = resolveGrokAcpAuthMethodIdForEnv(settings.environment, settings.instanceId);

    await expect(
      Effect.runPromise(resolve(initializeWithAuthMethods(["xai.api_key", "grok.com"]))),
    ).resolves.toBe("xai.api_key");
    const refused = await Effect.runPromise(
      resolve(initializeWithAuthMethods(["cached_token", "grok.com"])).pipe(Effect.flip),
    );
    expect(refused.message).toContain("Managed Grok");
  });

  it("writes the generated model config before the CLI starts", async () => {
    const { home, settings } = await managedSettings();
    await Effect.runPromise(
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return yield* makeGrokAcpRuntime({
          grokSettings: settings,
          childProcessSpawner,
          cwd: home,
          runtimeMode: "full-access",
          clientInfo: { name: "test", version: "0" },
        }).pipe(Effect.scoped, Effect.exit);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    const config = await readFile(path.join(home, "config.toml"), "utf8");
    expect(config).toContain('env_key = "MOSS_ACCESS_TOKEN"');
    expect(config).toContain('[model."moss/deepseek-v4-flash"]');
    expect(config).not.toContain("gateway-bearer");
  });
});
