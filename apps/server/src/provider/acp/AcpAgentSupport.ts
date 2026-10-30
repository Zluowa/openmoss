// FILE: AcpAgentSupport.ts
// Purpose: Runtime glue shared by the generic ACP agent drivers — spawn input, auth, model/mode
//          configuration, and model discovery driven by an AcpAgentSpec.
// Layer: Provider ACP support

import type {
  ProviderInteractionMode,
  ProviderListModelsResult,
  ProviderModelDescriptor,
  RuntimeMode,
} from "@synara/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as Acp from "@agentclientprotocol/sdk";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { resolveRequestedAcpSessionModeId } from "./AcpAdapterSessionSupport.ts";
import {
  type AcpAgentFailure,
  type AcpAgentManagedConfig,
  type AcpAgentRuntimeSettings,
  type AcpAgentSpec,
  acpAgentErrorText,
} from "./AcpAgentSpec.ts";
import {
  availableAuthMethodIds,
  buildAcpModelDescriptor,
  findSelectConfig,
  flattenConfigOptions,
  parseAcpAvailableModels,
} from "./AcpConfigOptions.ts";
import * as AcpErrors from "./AcpErrors.ts";
import type { AcpSessionModeState } from "./AcpRuntimeModel.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export interface AcpAgentResolvedSettings extends AcpAgentRuntimeSettings {
  /** Present only when the spec's managed hooks accepted the instance. */
  readonly managed?: AcpAgentManagedConfig | undefined;
}

export interface AcpAgentRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "spawn" | "authMethodId" | "resolveAuthMethodId" | "authPolicy" | "provider"
> {
  readonly spec: AcpAgentSpec;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly settings: AcpAgentResolvedSettings;
}

export function resolveAcpAgentRuntimeSettings(
  input: AcpAgentRuntimeSettings,
  defaults: AcpAgentRuntimeSettings = {},
): AcpAgentRuntimeSettings {
  return { ...defaults, ...input, environment: input.environment ?? defaults.environment };
}

/**
 * Validates the instance/managed pairing and prepares a managed home. A kind
 * without managed hooks refuses its reserved `<kind>_moss` id so a
 * misconfigured managed instance can never run against the user's own login.
 * `materializeHome: false` only validates (model discovery never spawns the
 * managed CLI, so it has no reason to rewrite its home).
 */
export function prepareAcpAgentRuntimeSettings(
  spec: AcpAgentSpec,
  settings: AcpAgentRuntimeSettings,
  instanceId: string | undefined,
  options: { readonly materializeHome?: boolean } = {},
): Effect.Effect<AcpAgentResolvedSettings, Error> {
  return Effect.tryPromise({
    try: async () => {
      const hooks = spec.managed;
      const managed = hooks?.readConfig(settings);
      if (!managed) {
        if (instanceId === spec.managedInstanceId)
          throw new Error(
            hooks
              ? `Managed ${spec.displayName} configuration is missing.`
              : `Managed ${spec.displayName} is not available; use the ${spec.displayName} login instead.`,
          );
        return settings;
      }
      if (!hooks || instanceId !== spec.managedInstanceId)
        throw new Error(
          `Managed ${spec.displayName} configuration requires the reserved Moss instance.`,
        );
      if (options.materializeHome !== false) await hooks.prepareHome(managed, settings);
      return { ...settings, managed };
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Unable to prepare the ${spec.displayName} configuration.`, { cause }),
  });
}

/**
 * Own-login never injects keys or relocates the CLI's data dir: the child gets
 * the spec defaults, the instance environment, and an explicit `homePath` only.
 * Managed mode replaces the inherited process environment with the hooks'
 * minimal base env plus the generated catalog/token variables.
 */
export function buildAcpAgentSpawnInput(
  spec: AcpAgentSpec,
  settings: AcpAgentResolvedSettings,
  cwd: string,
): AcpSpawnInput {
  const managed =
    settings.managed && spec.managed
      ? spec.managed.buildSpawnEnvironment(settings.managed, settings)
      : undefined;
  const environment = managed
    ? managed.environment
    : {
        ...spec.environmentDefaults,
        ...settings.environment,
        ...(settings.homePath ? spec.homeEnvironment(settings.homePath) : {}),
      };
  const inheritedMossKeys =
    managed?.inheritedMossKeys ?? Object.keys(environment).filter((key) => key.startsWith("MOSS_"));
  return {
    command: settings.binaryPath || spec.command,
    args: spec.args,
    cwd,
    ...(inheritedMossKeys.length > 0 ? { inheritedMossKeys } : {}),
    env: buildProviderChildEnvironment({
      provider: spec.kind,
      ...(managed?.baseEnv ? { baseEnv: managed.baseEnv } : {}),
      overrides: environment,
      inheritedMossKeys,
    }),
  };
}

/**
 * On-demand kinds only reach this after `session/new` reported auth-required,
 * and their `authenticate` cannot sign the user in, so the typed failure is the
 * actionable outcome. Upfront kinds authenticate with the advertised method.
 */
export const resolveAcpAgentAuthMethodId =
  (spec: AcpAgentSpec) =>
  (initializeResult: Acp.InitializeResponse): Effect.Effect<string, AcpErrors.AcpError> => {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    if (spec.auth.policy === "on-demand") {
      return Effect.fail(
        new AcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `${spec.displayName} is not signed in. ${spec.signIn.hint}`,
          data: { authMethods: [...authMethodIds], reason: "credentials_missing" },
        }),
      );
    }
    if (authMethodIds.has(spec.auth.methodId)) {
      return Effect.succeed(spec.auth.methodId);
    }
    return Effect.fail(
      new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `${spec.displayName} did not advertise the ${spec.auth.methodId} authentication method (advertised: ${authMethodIds.size > 0 ? [...authMethodIds].join(", ") : "none"}). Update ${spec.command} and retry.`,
        data: { authMethods: [...authMethodIds], reason: "compatibility_mismatch" },
      }),
    );
  };

export const makeAcpAgentRuntime = (
  input: AcpAgentRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const { spec, settings, childProcessSpawner, ...runtimeOptions } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        provider: spec.kind,
        spawn: buildAcpAgentSpawnInput(spec, settings, input.cwd),
        authPolicy: spec.auth.policy === "on-demand" ? "on-demand" : "always",
        resolveAuthMethodId: resolveAcpAgentAuthMethodId(spec),
        ...(spec.clientCapabilities ? { clientCapabilities: spec.clientCapabilities } : {}),
        ...(spec.startupTimeouts || input.startupTimeouts
          ? { startupTimeouts: { ...spec.startupTimeouts, ...input.startupTimeouts } }
          : {}),
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return ServiceMap.getUnsafe(context, AcpSessionRuntime);
  });

export function classifyAcpAgentFailure(
  spec: AcpAgentSpec,
  error: AcpErrors.AcpError,
): AcpAgentFailure | undefined {
  return spec.classifyFailure(error, spec);
}

/**
 * Startup and prompt failures are the only signal the user gets, so keep the
 * agent's own wording (JSON-RPC data included) behind the classified summary.
 */
export function acpAgentFailureDetail(spec: AcpAgentSpec, error: AcpErrors.AcpError): string {
  const classified = classifyAcpAgentFailure(spec, error);
  const text = acpAgentErrorText(error).trim();
  if (classified) {
    // Moss's own typed failures already say it all; only append agent wording.
    const primary = (error._tag === "AcpRequestError" ? error.errorMessage : text).trim();
    return primary && !classified.message.includes(primary)
      ? `${classified.message} (${text})`
      : classified.message;
  }
  if (error._tag === "AcpRequestError") {
    return text
      ? `${text} (JSON-RPC ${String(error.code)})`
      : `${spec.displayName} ACP request failed (JSON-RPC ${String(error.code)}).`;
  }
  return text || `${spec.displayName} ACP transport failed.`;
}

type ConfigurableAcpRuntime = Pick<
  AcpSessionRuntimeShape,
  "start" | "request" | "getConfigOptions" | "setConfigOption" | "getModeState" | "setMode"
>;

export interface AcpAgentModelSelection {
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
}

export type AcpAgentConfigurationMethod =
  | "session/set_config_options"
  | "session/set_config_option"
  | "session/set_mode";

/**
 * Selects the model through the advertised `model` config option (validated
 * against the agent's catalog by the runtime) or the legacy `session/set_model`
 * request when the agent only implements that.
 */
export function applyAcpAgentModelSelection(input: {
  readonly spec: AcpAgentSpec;
  readonly runtime: ConfigurableAcpRuntime;
  readonly selection: AcpAgentModelSelection;
  readonly managed?: AcpAgentManagedConfig | undefined;
}): Effect.Effect<void, AcpErrors.AcpError> {
  return Effect.gen(function* () {
    const { spec, runtime, selection } = input;
    const model =
      input.managed && spec.managed?.modelId
        ? spec.managed.modelId(selection.model, input.managed)
        : selection.model.trim();
    if (!model) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `${spec.displayName} requires a model identifier.`,
      });
    }
    const configOptions = yield* runtime.getConfigOptions;
    const modelOption = findSelectConfig(configOptions, {
      id: spec.modelConfigId,
      category: "model",
    });
    if (modelOption) {
      if (modelOption.currentValue !== model) {
        yield* runtime.setConfigOption(modelOption.id, model);
      }
    } else if (spec.legacySetModel) {
      const started = yield* runtime.start();
      yield* runtime.request("session/set_model", { sessionId: started.sessionId, modelId: model });
    } else {
      return yield* new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: `${spec.displayName} did not advertise a model option for this session.`,
        data: { requestedModel: model, configOptionIds: configOptions.map((option) => option.id) },
      });
    }
    const reasoningEffort = selection.reasoningEffort?.trim();
    if (!reasoningEffort) return;
    // The thought-level option is per model (and may be absent for models
    // without thinking); re-read after the model switch and skip quietly when
    // the agent does not offer it.
    const thoughtOption = findSelectConfig(yield* runtime.getConfigOptions, {
      id: spec.thoughtLevelConfigId,
      category: "thought_level",
    });
    if (thoughtOption && thoughtOption.currentValue !== reasoningEffort) {
      yield* runtime.setConfigOption(thoughtOption.id, reasoningEffort);
    }
  });
}

/**
 * Maps Moss's turn mode onto the agent's native session mode. Plan turns use
 * the native plan mode when advertised; every other turn runs in the agent's
 * ask mode so permission requests keep flowing through Moss approvals. Modes
 * listed under `never` are refused even as the agent's startup default.
 */
export function resolveAcpAgentSessionModeId(input: {
  readonly spec: AcpAgentSpec;
  readonly modeState: AcpSessionModeState | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
}): string | undefined {
  const { spec, modeState } = input;
  if (!modeState) return undefined;
  const requested = resolveRequestedAcpSessionModeId({
    interactionMode: input.interactionMode,
    runtimeMode: input.runtimeMode,
    modeState,
    aliases: spec.modes,
  });
  const forbidden = new Set(spec.modes.never);
  if (requested !== undefined && !forbidden.has(requested)) return requested;
  // No alias matched (or only a bypass mode did): take the first advertised
  // mode that neither plans nor bypasses approvals, keeping the agent's
  // current mode only when it is already acceptable.
  const planModes = new Set(spec.modes.plan);
  return modeState.availableModes.find((mode) => !forbidden.has(mode.id) && !planModes.has(mode.id))
    ?.id;
}

/**
 * Applies the requested model, the process-wide permission option, and the
 * native session mode before a turn. Only changed values are sent.
 */
export function applyAcpAgentSessionConfiguration<E>(input: {
  readonly spec: AcpAgentSpec;
  readonly runtime: ConfigurableAcpRuntime;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection: AcpAgentModelSelection | undefined;
  readonly configuredModel?: AcpAgentModelSelection | undefined;
  readonly managed?: AcpAgentManagedConfig | undefined;
  readonly mapError: (context: {
    readonly cause: AcpErrors.AcpError;
    readonly method: AcpAgentConfigurationMethod;
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const { spec, runtime } = input;
    const mapError =
      (method: AcpAgentConfigurationMethod) =>
      (cause: AcpErrors.AcpError): E =>
        input.mapError({ cause, method });
    const selection = input.modelSelection;
    if (
      selection &&
      (selection.model !== input.configuredModel?.model ||
        (selection.reasoningEffort ?? undefined) !==
          (input.configuredModel?.reasoningEffort ?? undefined))
    ) {
      yield* applyAcpAgentModelSelection({
        spec,
        runtime,
        selection,
        ...(input.managed ? { managed: input.managed } : {}),
      }).pipe(Effect.mapError(mapError("session/set_config_option")));
    }
    if (spec.permissionConfig) {
      const option = findSelectConfig(
        yield* runtime.getConfigOptions.pipe(
          Effect.mapError(mapError("session/set_config_options")),
        ),
        { id: spec.permissionConfig.id, category: "_permission" },
      );
      if (option && option.currentValue !== spec.permissionConfig.value) {
        yield* runtime
          .setConfigOption(option.id, spec.permissionConfig.value)
          .pipe(Effect.mapError(mapError("session/set_config_option")));
      }
    }
    const modeState = yield* runtime.getModeState.pipe(
      Effect.mapError(mapError("session/set_mode")),
    );
    const modeId = resolveAcpAgentSessionModeId({
      spec,
      modeState,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
    });
    if (
      modeState &&
      modeId === undefined &&
      new Set(spec.modes.never).has(modeState.currentModeId)
    ) {
      return yield* Effect.fail(
        input.mapError({
          cause: new AcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `${spec.displayName} only offers modes that bypass approvals (${modeState.availableModes.map((mode) => mode.id).join(", ")}); Moss refuses to run it unrestricted.`,
          }),
          method: "session/set_mode",
        }),
      );
    }
    if (modeState && modeId !== undefined && modeId !== modeState.currentModeId) {
      yield* runtime.setMode(modeId).pipe(Effect.mapError(mapError("session/set_mode")));
    }
  });
}

/**
 * Reads the agent's catalog from its `model` config option: the CLI's own
 * values become Moss model slugs with the CLI's display names. Thought levels
 * are per model, so only the currently selected model carries them. Agents
 * without the option fall back to the legacy `models.availableModels` list.
 */
export function parseAcpAgentModels(
  spec: AcpAgentSpec,
  sessionSetupResult: Acp.NewSessionResponse | Acp.LoadSessionResponse | Acp.ResumeSessionResponse,
): ReadonlyArray<ProviderModelDescriptor> {
  const configOptions = sessionSetupResult.configOptions ?? [];
  const modelOption = findSelectConfig(configOptions, {
    id: spec.modelConfigId,
    category: "model",
  });
  if (!modelOption) {
    return parseAcpAvailableModels(sessionSetupResult).filter(
      (model) => model.slug.trim() !== "" && model.name.trim() !== "",
    );
  }
  const thoughtOption = findSelectConfig(configOptions, {
    id: spec.thoughtLevelConfigId,
    category: "thought_level",
  });
  const seen = new Set<string>();
  return flattenConfigOptions(modelOption.options).flatMap((model) => {
    const slug = model.value.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      buildAcpModelDescriptor(
        { ...model, value: slug, name: model.name.trim() || slug },
        model.value === modelOption.currentValue ? thoughtOption : undefined,
      ),
    ];
  });
}

export function acpAgentModelListResult(
  spec: AcpAgentSpec,
  models: ReadonlyArray<ProviderModelDescriptor>,
): ProviderListModelsResult {
  return { models, source: `${spec.kind}.acp`, cached: false };
}
