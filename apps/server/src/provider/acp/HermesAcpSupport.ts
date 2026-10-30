import { Effect, Layer, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as Acp from "@agentclientprotocol/sdk";
import {
  buildProviderChildEnvironment,
  mossManagedChildBaseEnvironment,
  mossManagedChildNoProxy,
} from "../../providerChildEnvironment";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime";
import * as AcpErrors from "./AcpErrors";
import { parseAcpAvailableModels } from "./AcpConfigOptions";
import {
  managedHermesConfigDirectory,
  MOSS_MANAGED_HERMES_CONFIG_ENV_KEY,
  MOSS_MANAGED_HERMES_CREDENTIAL_ENV_KEY,
} from "../mossManagedHermesEnvironment";

export interface HermesAcpRuntimeSettings {
  readonly binaryPath?: string | undefined;
  readonly homePath?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly managed?: boolean | undefined;
}
export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "spawn" | "authMethodId" | "resolveAuthMethodId"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeSettings;
}
export function buildHermesAcpSpawnInput(
  settings: HermesAcpRuntimeSettings,
  cwd: string,
): AcpSpawnInput {
  const noProxy = mossManagedChildNoProxy();
  const environment = {
    ...(settings.managed
      ? {
          [MOSS_MANAGED_HERMES_CONFIG_ENV_KEY]:
            settings.environment?.[MOSS_MANAGED_HERMES_CONFIG_ENV_KEY],
          [MOSS_MANAGED_HERMES_CREDENTIAL_ENV_KEY]:
            settings.environment?.[MOSS_MANAGED_HERMES_CREDENTIAL_ENV_KEY],
          PYTHON_DOTENV_DISABLED: "1",
          HERMES_MANAGED_DIR: settings.homePath
            ? managedHermesConfigDirectory(settings.homePath)
            : undefined,
          NO_PROXY: noProxy,
          no_proxy: noProxy,
        }
      : settings.environment),
    ...(settings.homePath ? { HERMES_HOME: settings.homePath } : {}),
  };
  return {
    command: settings.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(settings.managed ? { inheritedMossKeys: [MOSS_MANAGED_HERMES_CREDENTIAL_ENV_KEY] } : {}),
    env: buildProviderChildEnvironment({
      provider: "hermes",
      ...(settings.managed ? { baseEnv: mossManagedChildBaseEnvironment() } : {}),
      overrides: environment,
      inheritedMossKeys: Object.keys(environment).filter((key) => key.startsWith("MOSS_")),
    }),
  };
}
export function resolveHermesAuthMethod(
  initialize: Acp.InitializeResponse,
  managed = false,
): Effect.Effect<string, AcpErrors.AcpError> {
  const methods = (initialize.authMethods ?? []).map((method) => method.id);
  const selected = managed
    ? methods.find((id) => id === "custom" || id === "custom:moss")
    : methods.find((id) => id !== "hermes-setup" && !id.includes("terminal"));
  return selected
    ? Effect.succeed(selected)
    : Effect.fail(
        new AcpErrors.AcpRequestError({
          code: -32602,
          errorMessage:
            "Hermes has no configured authentication method. Run hermes setup or enable the Moss account.",
        }),
      );
}

/** Hermes 0.17 logs terminal inference failures but drops them from ACP replies. */
export function readHermesTerminalInferenceFailure(line: string): string | undefined {
  if (
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[ERROR\]\s+(?:agent\.conversation_loop:\s+.*(?:Non-retryable client error:|API call failed after \d+ retries\.)|acp_adapter\.server:\s+(?:Agent error in|Executor error for) session\b)/.test(
      line,
    )
  )
    return undefined;
  const status = /(?:HTTP\s+|Error code:\s*)([45]\d{2})\b/.exec(line)?.[1];
  // Never expose arbitrary child log content, which may contain endpoint secrets.
  return status === "402"
    ? "Hermes model request failed (HTTP 402): the upstream provider has insufficient credits."
    : `Hermes model request failed${status ? ` (HTTP ${status})` : ""}.`;
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    let sessionMcpServers: Array<Acp.McpServer> = [];
    let refreshingModelTools = false;
    let promptActive = false;
    let nativePromptStarted = false;
    let promptEcho: string[] = [];
    let promptEchoRemaining: string[] = [];
    let terminalFailure: string | undefined;
    let stderrRevision = 0;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        provider: "hermes",
        sessionRecoveryMethod: "load",
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd),
        resolveAuthMethodId: (initialize) =>
          resolveHermesAuthMethod(initialize, input.hermesSettings.managed),
        suppressSessionTranscriptUpdates: () =>
          refreshingModelTools || input.suppressSessionTranscriptUpdates?.() === true,
        onChildStderrLine: (line) => {
          if (promptActive) {
            stderrRevision++;
            if (promptEchoRemaining.length > 0) {
              // Python's logger echoes user_text[:100] verbatim, including line
              // breaks. Consume those known continuation lines as user data.
              promptEchoRemaining.shift();
            } else {
              const promptLog =
                /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[INFO\] acp_adapter\.server: Prompt on session [^:]+: (.*)$/.exec(
                  line,
                );
              if (promptLog && promptLog[1] === promptEcho[0]) {
                nativePromptStarted = true;
                promptEchoRemaining = promptEcho.slice(1);
              } else if (nativePromptStarted) {
                terminalFailure ??= readHermesTerminalInferenceFailure(line);
              }
            }
          }
          input.onChildStderrLine?.(line);
        },
        requestLogger: (event) =>
          Effect.gen(function* () {
            if (
              event.status === "started" &&
              ["session/new", "session/load", "session/resume"].includes(event.method)
            ) {
              const payload = event.payload;
              if (
                payload &&
                typeof payload === "object" &&
                "mcpServers" in payload &&
                Array.isArray(payload.mcpServers)
              )
                sessionMcpServers = [...payload.mcpServers];
            }
            yield* input.requestLogger?.(event) ?? Effect.void;
          }),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = ServiceMap.getUnsafe(context, AcpSessionRuntime);
    return {
      ...runtime,
      prompt: (params) =>
        Effect.gen(function* () {
          terminalFailure = undefined;
          nativePromptStarted = false;
          promptEchoRemaining = [];
          promptEcho = Array.from(
            params.prompt
              .flatMap((block) =>
                "text" in block && typeof block.text === "string" ? [block.text] : [],
              )
              .join("\n")
              .trim(),
          )
            .slice(0, 100)
            .join("")
            .split(/\r?\n/);
          promptActive = true;
          const result = yield* runtime.prompt(params);
          // ACP stdout and stderr have separate readers. Let already-written
          // terminal diagnostics drain before classifying the stdout end_turn.
          // A bounded quiet period also handles a chunk split over reader ticks;
          // unrelated background logs can never hold completion indefinitely.
          const stderrDeadline = Date.now() + 100;
          do {
            const revision = stderrRevision;
            yield* Effect.sleep(25);
            if (revision === stderrRevision) break;
          } while (Date.now() < stderrDeadline);
          if (terminalFailure && result.stopReason !== "cancelled") {
            return yield* new AcpErrors.AcpRequestError({
              code: -32000,
              errorMessage: terminalFailure,
              data: { hermesNativeContinuationInvalid: true },
            });
          }
          return result;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              promptActive = false;
              terminalFailure = undefined;
            }),
          ),
        ),
      start: () =>
        runtime
          .start()
          .pipe(
            Effect.tap((started) =>
              input.resumeSessionId
                ? validateHermesRecoveredSession(started.sessionSetupResult, input.resumeSessionId)
                : Effect.void,
            ),
          ),
      request: (method: string, payload: unknown) =>
        Effect.gen(function* () {
          const result = yield* runtime.request(method, payload);
          if (
            method === "session/set_model" &&
            sessionMcpServers.length > 0 &&
            payload &&
            typeof payload === "object" &&
            "sessionId" in payload &&
            typeof payload.sessionId === "string"
          ) {
            // Hermes rebuilds its agent on model changes and drops ACP-only MCP toolsets.
            // Resume re-registers the exact startup servers; its synchronous history replay
            // is discarded at the runtime's decoded notification boundary.
            refreshingModelTools = true;
            yield* runtime
              .request("session/resume", {
                sessionId: payload.sessionId,
                cwd: input.cwd,
                mcpServers: sessionMcpServers,
              })
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    refreshingModelTools = false;
                  }),
                ),
              );
          }
          return result;
        }),
    };
  });
export function resolveHermesRuntimeSettings(
  input: HermesAcpRuntimeSettings,
  defaults: HermesAcpRuntimeSettings = {},
): HermesAcpRuntimeSettings {
  return { ...defaults, ...input, environment: input.environment ?? defaults.environment };
}
export function hermesAcpModelId(model: string, managed: boolean): string {
  const normalized = model.trim();
  if (!normalized) throw new Error("Hermes requires a model identifier.");
  return managed ? `custom:moss:${normalized}` : normalized;
}

export function parseHermesAcpModels(response: unknown): Array<{ slug: string; name: string }> {
  return parseAcpAvailableModels(response);
}

export function validateHermesRecoveredSession(
  response: unknown,
  expectedSessionId: string,
): Effect.Effect<void, AcpErrors.AcpError> {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const result = record(response);
  const models = record(result.models);
  const provenanceId = record(record(record(result._meta).hermes).sessionProvenance).acpSessionId;
  if (
    typeof models.currentModelId !== "string" ||
    !models.currentModelId.trim() ||
    (provenanceId !== undefined && provenanceId !== expectedSessionId)
  ) {
    return Effect.fail(
      new AcpErrors.AcpRequestError({
        code: -32002,
        errorMessage:
          "Hermes session not found. Its retained transcript must be restored in a new session.",
      }),
    );
  }
  return Effect.void;
}
export function setHermesAcpModel(
  runtime: Pick<AcpSessionRuntimeShape, "start" | "request">,
  model: string,
  managed: boolean,
) {
  return Effect.gen(function* () {
    const started = yield* runtime.start();
    // Hermes 0.17 implements legacy session/set_model. set_config_option only
    // persists arbitrary UI values and does not change its inference model.
    yield* runtime.request("session/set_model", {
      sessionId: started.sessionId,
      modelId: hermesAcpModelId(model, managed),
    });
  });
}

export function setHermesAcpDefaultMode(
  runtime: Pick<AcpSessionRuntimeShape, "start" | "request">,
) {
  return Effect.gen(function* () {
    const started = yield* runtime.start();
    // Hermes advertises legacy modes. A generic "mode" config option is only
    // saved as UI metadata and would leave a resumed don't-ask policy active.
    yield* runtime.request("session/set_mode", { sessionId: started.sessionId, modeId: "default" });
  });
}
