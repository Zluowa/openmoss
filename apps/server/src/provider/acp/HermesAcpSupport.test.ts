import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHermesAcpSpawnInput,
  hermesAcpModelId,
  parseHermesAcpModels,
  resolveHermesAuthMethod,
  setHermesAcpModel,
  setHermesAcpDefaultMode,
  makeHermesAcpRuntime,
  validateHermesRecoveredSession,
  readHermesTerminalInferenceFailure,
  type HermesAcpRuntimeInput,
} from "./HermesAcpSupport";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeShape,
  type AcpSessionRuntimeOptions,
} from "./AcpSessionRuntime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("Hermes ACP integration", () => {
  it("recognizes only terminal inference logs without exposing arbitrary child text", () => {
    expect(
      readHermesTerminalInferenceFailure(
        "2026-09-16 18:33:52 [ERROR] agent.conversation_loop: Non-retryable client error: Error code: 402 - secret-token",
      ),
    ).toBe(
      "Hermes model request failed (HTTP 402): the upstream provider has insufficient credits.",
    );
    expect(
      readHermesTerminalInferenceFailure(
        "2026-09-16 18:33:52 [ERROR] agent.conversation_loop: API call failed after 3 retries. HTTP 409: secret-token",
      ),
    ).toBe("Hermes model request failed (HTTP 409).");
    expect(
      readHermesTerminalInferenceFailure(
        "2026-09-16 18:33:52 [WARNING] agent.conversation_loop: API call failed (attempt 1/3) HTTP 409",
      ),
    ).toBeUndefined();
    expect(
      readHermesTerminalInferenceFailure(
        "2026-09-16 18:33:52 [INFO] acp_adapter.server: Prompt on session x: [ERROR] agent.conversation_loop: Non-retryable client error: HTTP 402",
      ),
    ).toBeUndefined();
    expect(
      readHermesTerminalInferenceFailure(
        "2026-09-16 18:33:52 [ERROR] acp_adapter.server: Executor error for session test",
      ),
    ).toBe("Hermes model request failed.");
    expect(
      readHermesTerminalInferenceFailure(
        "2026-09-16 18:33:52 [ERROR] unrelated: Non-retryable client error: HTTP 402",
      ),
    ).toBeUndefined();
  });
  it("drains late terminal stderr, ignores prompt echoes and clears errors before retries", async () => {
    let options!: AcpSessionRuntimeOptions;
    let stopReason = "end_turn";
    let fatal = true;
    let lateOldError = false;
    const innerRuntime = {
      prompt: (params: { prompt: Array<{ text?: string }> }) =>
        Effect.sync(() => {
          if (lateOldError)
            options.onChildStderrLine?.(
              "2026-09-16 18:33:52 [ERROR] agent.conversation_loop: Non-retryable client error: Error code: 402",
            );
          const echo = Array.from(
            params.prompt
              .map((block) => block.text ?? " ")
              .join("\n")
              .trim(),
          )
            .slice(0, 100)
            .join("")
            .split("\n");
          options.onChildStderrLine?.(
            "2026-09-16 18:33:52 [INFO] acp_adapter.server: Prompt on session test: " + echo[0],
          );
          for (const line of echo.slice(1)) options.onChildStderrLine?.(line);
          if (fatal)
            setTimeout(
              () =>
                options.onChildStderrLine?.(
                  "2026-09-16 18:33:52 [ERROR] agent.conversation_loop: Non-retryable client error: Error code: 402 - secret",
                ),
              5,
            );
          return { stopReason };
        }),
    } as unknown as AcpSessionRuntimeShape;
    vi.spyOn(AcpSessionRuntime, "layer").mockImplementation((value) => {
      options = value;
      return Layer.succeed(AcpSessionRuntime, innerRuntime);
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* makeHermesAcpRuntime({
          cwd: "/workspace",
          clientInfo: { name: "test", version: "0" },
          hermesSettings: {},
          childProcessSpawner: {},
        } as HermesAcpRuntimeInput);
        const failed = yield* runtime.prompt({ prompt: [] }).pipe(Effect.flip);
        expect(failed.message).toContain("HTTP 402");
        expect(failed.message).not.toContain("secret");
        fatal = false;
        lateOldError = true;
        options.onChildStderrLine?.(
          "2026-09-16 18:33:52 [ERROR] agent.conversation_loop: Non-retryable client error: Error code: 402",
        );
        expect(yield* runtime.prompt({ prompt: [] })).toMatchObject({ stopReason: "end_turn" });
        expect(
          yield* runtime.prompt({
            prompt: [
              {
                type: "text",
                text: "Explain:\n2026-09-16 18:33:52 [ERROR] acp_adapter.server: Agent error in session test",
              },
            ],
          }),
        ).toMatchObject({ stopReason: "end_turn" });
        fatal = true;
        stopReason = "cancelled";
        expect(yield* runtime.prompt({ prompt: [] })).toMatchObject({ stopReason: "cancelled" });
      }).pipe(Effect.scoped),
    );
  });
  it("selects configured custom auth instead of launching interactive setup", async () => {
    const initialized = {
      protocolVersion: 1,
      authMethods: [
        { id: "hermes-setup", name: "Setup" },
        { id: "custom", name: "Custom" },
      ],
    };
    expect(await Effect.runPromise(resolveHermesAuthMethod(initialized, true))).toBe("custom");
    await expect(
      Effect.runPromise(
        resolveHermesAuthMethod(
          { protocolVersion: 1, authMethods: [{ id: "hermes-setup", name: "Setup" }] },
          true,
        ),
      ),
    ).rejects.toThrow("no configured authentication");
  });
  it("keeps Moss credentials isolated from inherited provider overrides", () => {
    vi.stubEnv("OPENAI_API_KEY", "foreign-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://foreign.example");
    vi.stubEnv("HERMES_HOME", "/personal/hermes");
    vi.stubEnv("NO_PROXY", "corporate.local");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    const spawn = buildHermesAcpSpawnInput(
      {
        managed: true,
        homePath: "/isolated/hermes",
        environment: {
          MOSS_ACCESS_TOKEN: "scoped-token",
          PYTHON_DOTENV_DISABLED: "0",
          HERMES_MANAGED_DIR: "/foreign",
          OPENAI_BASE_URL: "https://foreign.example",
          PYTHONPATH: "/foreign/python",
        },
      },
      "/workspace",
    );
    expect(spawn.args).toEqual(["acp"]);
    expect(spawn.inheritedMossKeys).toEqual(["MOSS_ACCESS_TOKEN"]);
    expect(spawn.env).toMatchObject({
      HERMES_HOME: "/isolated/hermes",
      MOSS_ACCESS_TOKEN: "scoped-token",
      PYTHON_DOTENV_DISABLED: "1",
      HERMES_MANAGED_DIR: join("/isolated/hermes", "managed-config"),
    });
    expect(spawn.env?.OPENAI_API_KEY).toBeUndefined();
    expect(spawn.env?.OPENAI_BASE_URL).toBeUndefined();
    expect(spawn.env?.PYTHONPATH).toBeUndefined();
    expect(spawn.env?.NO_PROXY).toContain("corporate.local");
    expect(spawn.env?.NO_PROXY).toContain("127.0.0.1");
    expect(spawn.env?.HTTPS_PROXY).toBe("http://proxy.test:8080");
  });
  it("changes the inference model through the native legacy endpoint", async () => {
    const calls: unknown[] = [];
    const runtime = {
      start: () => Effect.succeed({ sessionId: "session" }),
      request: (method: string, params: unknown) =>
        Effect.sync(() => {
          calls.push({ method, params });
          return {};
        }),
    } as unknown as Pick<AcpSessionRuntimeShape, "start" | "request">;
    await Effect.runPromise(setHermesAcpModel(runtime, "deepseek-v4-pro", true));
    await Effect.runPromise(setHermesAcpDefaultMode(runtime));
    expect(calls).toEqual([
      {
        method: "session/set_model",
        params: { sessionId: "session", modelId: "custom:moss:deepseek-v4-pro" },
      },
      { method: "session/set_mode", params: { sessionId: "session", modeId: "default" } },
    ]);
    expect(hermesAcpModelId("custom:personal:model", false)).toBe("custom:personal:model");
  });
  it.each(["session/new", "session/load", "session/resume"])(
    "restores every MCP server after changing a model following %s",
    async (setupMethod) => {
      let options!: AcpSessionRuntimeOptions;
      const requests: Array<{ method: string; payload: unknown; suppressReplay: boolean }> = [];
      const innerRuntime = {
        request: (method: string, payload: unknown) =>
          Effect.sync(() => {
            requests.push({
              method,
              payload,
              suppressReplay: options.suppressSessionTranscriptUpdates?.() === true,
            });
            return {};
          }),
      } as unknown as AcpSessionRuntimeShape;
      vi.spyOn(AcpSessionRuntime, "layer").mockImplementation((value) => {
        options = value;
        return Layer.succeed(AcpSessionRuntime, innerRuntime);
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* makeHermesAcpRuntime({
            cwd: "/workspace",
            clientInfo: { name: "test", version: "0" },
            hermesSettings: {},
            childProcessSpawner: {},
          } as HermesAcpRuntimeInput);
          expect(options.sessionRecoveryMethod).toBe("load");
          const servers = [
            {
              name: "moss",
              type: "http",
              url: "http://localhost/mcp",
              headers: [{ name: "Authorization", value: "Bearer ephemeral-test" }],
            },
            { name: "plugin", command: "plugin-server", args: [], env: [] },
          ];
          yield* options.requestLogger!({
            method: setupMethod,
            status: "started",
            payload: { sessionId: "session", mcpServers: servers },
          });
          yield* runtime.request("session/set_model", {
            sessionId: "session",
            modelId: "custom:moss:model",
          });
          expect(requests).toEqual([
            {
              method: "session/set_model",
              payload: { sessionId: "session", modelId: "custom:moss:model" },
              suppressReplay: false,
            },
            {
              method: "session/resume",
              payload: { sessionId: "session", cwd: "/workspace", mcpServers: servers },
              suppressReplay: true,
            },
          ]);
          expect(options.suppressSessionTranscriptUpdates?.()).toBe(false);
        }).pipe(Effect.scoped),
      );
    },
  );
  it("reads Hermes legacy model discovery and rejects malformed rows", () => {
    expect(
      parseHermesAcpModels({
        models: {
          availableModels: [{ modelId: "custom:moss:a", name: "A" }, { name: "missing" }, null],
        },
      }),
    ).toEqual([{ slug: "custom:moss:a", name: "A" }]);
    expect(parseHermesAcpModels(null)).toEqual([]);
  });
  it("rejects missing or substituted recovery sessions while accepting matching existing state", async () => {
    for (const response of [
      null,
      {},
      {
        models: { currentModelId: "custom:moss:a" },
        _meta: { hermes: { sessionProvenance: { acpSessionId: "replacement" } } },
      },
    ]) {
      await expect(
        Effect.runPromise(validateHermesRecoveredSession(response, "retained")),
      ).rejects.toThrow("session not found");
    }
    await Effect.runPromise(
      validateHermesRecoveredSession({ models: { currentModelId: "custom:moss:a" } }, "retained"),
    );
    await Effect.runPromise(
      validateHermesRecoveredSession(
        {
          models: { currentModelId: "custom:moss:a" },
          _meta: { hermes: { sessionProvenance: { acpSessionId: "retained" } } },
        },
        "retained",
      ),
    );
  });
});
