import {
  ServerProviderStatus,
  isSupportedProviderKind,
  ProviderInstanceId,
  CLAUDE_CODE_EFFORT_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  DROID_REASONING_EFFORT_OPTIONS,
  GEMINI_THINKING_BUDGET_OPTIONS,
  GEMINI_THINKING_LEVEL_OPTIONS,
  GROK_REASONING_EFFORT_OPTIONS,
  OMP_THINKING_LEVEL_OPTIONS,
  PI_THINKING_LEVEL_OPTIONS,
  type ModelSelection,
  type ProviderKind,
  type ProviderListModelsResult,
  type ProviderModelDescriptor,
  type ServerProviderAuthStatus,
  type MossProviderInstanceCatalog,
} from "@synara/contracts";
import {
  getClaudeContextWindowSuffix,
  getDefaultModel,
  stripClaudeContextWindowSuffix,
} from "@synara/shared/model";
import { defaultInstanceIdForProvider } from "@synara/shared/providerInstances";
import { Effect, Option } from "effect";

import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";

export type AgentGatewayTargetErrorCode =
  | "provider_unavailable"
  | "model_unavailable"
  | "model_option_unavailable";

export class AgentGatewayTargetError extends Error {
  readonly code: AgentGatewayTargetErrorCode;
  readonly details?: unknown;

  constructor(code: AgentGatewayTargetErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AgentGatewayTargetError";
    this.code = code;
    this.details = details;
  }
}

export interface AgentGatewayProviderCatalog {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderKind;
  readonly defaultModel: string | null;
  readonly models: ReadonlyArray<ProviderModelDescriptor>;
  readonly instances?: ReadonlyArray<MossProviderInstanceCatalog>;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly authStatus?: ServerProviderAuthStatus;
  readonly source?: string;
  readonly error?: string;
}

export interface AgentGatewayProviderInstanceAvailability extends MossProviderInstanceCatalog {
  readonly available?: boolean;
  readonly authStatus?: ServerProviderAuthStatus;
  readonly modelPolicy?: AgentGatewayProviderAvailability["modelPolicy"];
}

export interface AgentGatewayProviderAvailability {
  readonly instances?: ReadonlyArray<AgentGatewayProviderInstanceAvailability>;
  readonly enabled: boolean;
  /** Undefined means health has not produced a trustworthy snapshot yet. */
  readonly available?: boolean;
  readonly authStatus?: ServerProviderAuthStatus;
  readonly message?: string;
  /**
   * Managed provider instances have an account-scoped model contract that is
   * stricter than the generic provider discovery catalog. Keep that contract
   * attached to the instance so capabilities and creation validate the same
   * exact model slugs as ProviderService.
   */
  readonly modelPolicy?: {
    readonly allowedModels: ReadonlyArray<string>;
    readonly defaultModel: string | null;
  };
}

export interface AgentGatewayProviderInstance extends AgentGatewayProviderAvailability {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderKind;
}

export type AgentGatewayProviderInstances = ReadonlyMap<string, AgentGatewayProviderInstance>;

const MOSS_DEFAULT_MANAGED_PROVIDER_INSTANCE_IDS = new Set<string>([
  "codex_moss",
  "claude_moss",
  "opencode_moss",
  "pi_moss",
  "grok_moss",
  "hermes_moss",
  "kimi_moss",
  "minimax_moss",
  "zcode_moss",
]);
const MOSS_MANAGED_STARTUP_STATUS_MAX_AGE_MS = 5 * 60_000;
const MOSS_MANAGED_STARTUP_STATUS_FUTURE_SKEW_MS = 30_000;

export function managedProviderModelPolicy(
  config: Readonly<Record<string, unknown>>,
): AgentGatewayProviderInstance["modelPolicy"] | undefined {
  if (config.managed !== true) return undefined;
  const allowedModels = Array.isArray(config.modelAllowlist)
    ? [
        ...new Set(
          config.modelAllowlist
            .filter((model): model is string => typeof model === "string")
            .map((model) => model.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  const defaultModel =
    typeof config.defaultModel === "string" && config.defaultModel.trim().length > 0
      ? config.defaultModel.trim()
      : null;
  return { allowedModels, defaultModel };
}

function isFreshManagedStartupStatus(
  instanceId: ProviderInstanceId,
  status: ServerProviderStatus,
  nowMs: number,
): boolean {
  if (
    !MOSS_DEFAULT_MANAGED_PROVIDER_INSTANCE_IDS.has(instanceId) ||
    status.enabled === false ||
    status.status !== "warning" ||
    status.available !== false ||
    status.authStatus === "unauthenticated" ||
    status.availability === "unavailable"
  ) {
    return false;
  }
  const checkedAtMs = Date.parse(status.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  const ageMs = nowMs - checkedAtMs;
  return (
    ageMs >= -MOSS_MANAGED_STARTUP_STATUS_FUTURE_SKEW_MS &&
    ageMs <= MOSS_MANAGED_STARTUP_STATUS_MAX_AGE_MS
  );
}

export function projectAgentGatewayProviderInstance(input: {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderKind;
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly status?: ServerProviderStatus | undefined;
  readonly missingStatusMessage: string;
  readonly nowMs?: number;
}): AgentGatewayProviderInstance {
  const modelPolicy = managedProviderModelPolicy(input.config);
  const isDefaultManaged =
    modelPolicy !== undefined && MOSS_DEFAULT_MANAGED_PROVIDER_INSTANCE_IDS.has(input.instanceId);
  const managedStartupAvailable =
    isDefaultManaged &&
    (input.status === undefined ||
      isFreshManagedStartupStatus(input.instanceId, input.status, input.nowMs ?? Date.now()));
  return {
    instanceId: input.instanceId,
    provider: input.provider,
    enabled: input.enabled,
    ...(modelPolicy ? { modelPolicy } : {}),
    ...(input.status
      ? {
          available: managedStartupAvailable || input.status.available,
          authStatus: input.status.authStatus,
          ...(input.status.message ? { message: input.status.message } : {}),
        }
      : {
          available: managedStartupAvailable,
          authStatus: "unknown" as const,
          message: managedStartupAvailable
            ? "Managed provider availability will be verified when its session starts."
            : input.missingStatusMessage,
        }),
  };
}

export const AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION =
  "Provider-specific target options. Use targetConstruction[provider].optionsByModel[model] when present; otherwise use providerOptions. Preserve each option's exact key and valueType. allowedValues are authoritative unless allowsCustomValue is true.";

export type AgentGatewayTargetOptionValue = string | number | boolean;

export interface AgentGatewayTargetOptionRule {
  readonly key: string;
  readonly valueType: "string" | "number" | "boolean";
  readonly allowedValues: ReadonlyArray<AgentGatewayTargetOptionValue>;
  readonly allowedValuesSource: "provider-contract" | "model-discovery";
  readonly allowsCustomValue?: boolean;
}

export interface AgentGatewayTargetOptionGuidance {
  readonly primaryOptionKey: string;
  readonly alternativeOptionKeys: ReadonlyArray<string>;
  readonly optionSelectionRule: string;
  readonly providerOptions: ReadonlyArray<AgentGatewayTargetOptionRule>;
  readonly optionsByModel: Readonly<Record<string, ReadonlyArray<AgentGatewayTargetOptionRule>>>;
  readonly exampleTarget: {
    readonly provider: ModelSelection["provider"];
    readonly instanceId: string;
    readonly model: string;
    readonly options: Readonly<Record<string, AgentGatewayTargetOptionValue>>;
  } | null;
}

type ModelSelectionForProvider<P extends ProviderKind> = Extract<
  ModelSelection,
  { readonly provider: P }
>;

type ProviderTargetOptionKey<P extends ProviderKind> = keyof NonNullable<
  ModelSelectionForProvider<P>["options"]
> &
  string;

type ProviderOptionValidation =
  | { readonly kind: "effort" }
  | {
      readonly kind: "boolean-capability";
      readonly capability: "supportsFastMode" | "supportsThinkingToggle";
    }
  | { readonly kind: "context-window" }
  | { readonly kind: "non-empty-string" };

interface ProviderTargetOptionRuleSpec extends Omit<AgentGatewayTargetOptionRule, "key"> {
  readonly advertised: boolean | "when-discovered";
  readonly validation: ProviderOptionValidation;
}

interface ResolvedProviderTargetOptionRuleSpec extends ProviderTargetOptionRuleSpec {
  readonly key: string;
}

type ProviderTargetOptionRuleRegistry<P extends ProviderKind> = {
  readonly [Key in ProviderTargetOptionKey<P>]: ProviderTargetOptionRuleSpec;
};

interface ProviderTargetOptionConfigInput<P extends ProviderKind> {
  readonly primaryOptionKey: ProviderTargetOptionKey<P>;
  readonly options: ProviderTargetOptionRuleRegistry<P>;
}

interface ProviderTargetOptionConfig {
  readonly primaryOptionKey: string;
  readonly options: Readonly<Record<string, ProviderTargetOptionRuleSpec>>;
}

function defineProviderOptionConfig<P extends ProviderKind>(
  config: ProviderTargetOptionConfigInput<P>,
): ProviderTargetOptionConfig {
  return config;
}

function providerOptionRule(
  valueType: AgentGatewayTargetOptionRule["valueType"],
  allowedValues: ReadonlyArray<AgentGatewayTargetOptionValue>,
  allowedValuesSource: AgentGatewayTargetOptionRule["allowedValuesSource"] = "provider-contract",
  options?: {
    readonly advertised?: boolean | "when-discovered";
    readonly validation?: ProviderOptionValidation;
    readonly allowsCustomValue?: boolean;
  },
): ProviderTargetOptionRuleSpec {
  return {
    valueType,
    allowedValues,
    allowedValuesSource,
    advertised: options?.advertised ?? true,
    validation: options?.validation ?? { kind: "effort" },
    allowsCustomValue: options?.allowsCustomValue ?? false,
  };
}

const PROVIDER_TARGET_OPTION_RULES = {
  codex: defineProviderOptionConfig<"codex">({
    primaryOptionKey: "reasoningEffort",
    options: {
      reasoningEffort: providerOptionRule("string", CODEX_REASONING_EFFORT_OPTIONS),
      fastMode: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsFastMode" },
      }),
    },
  }),
  cursor: defineProviderOptionConfig<"cursor">({
    primaryOptionKey: "reasoningEffort",
    options: {
      reasoningEffort: providerOptionRule("string", CODEX_REASONING_EFFORT_OPTIONS),
      fastMode: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsFastMode" },
      }),
      thinking: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsThinkingToggle" },
      }),
      contextWindow: providerOptionRule("string", [], "model-discovery", {
        advertised: false,
        validation: { kind: "context-window" },
      }),
    },
  }),
  grok: defineProviderOptionConfig<"grok">({
    primaryOptionKey: "reasoningEffort",
    options: {
      reasoningEffort: providerOptionRule("string", GROK_REASONING_EFFORT_OPTIONS),
    },
  }),
  droid: defineProviderOptionConfig<"droid">({
    primaryOptionKey: "reasoningEffort",
    options: {
      reasoningEffort: providerOptionRule("string", DROID_REASONING_EFFORT_OPTIONS),
    },
  }),
  claudeAgent: defineProviderOptionConfig<"claudeAgent">({
    primaryOptionKey: "effort",
    options: {
      effort: providerOptionRule("string", CLAUDE_CODE_EFFORT_OPTIONS),
      fastMode: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsFastMode" },
      }),
      thinking: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsThinkingToggle" },
      }),
      autoCompactWindow: providerOptionRule("string", [], "model-discovery", {
        advertised: "when-discovered",
        validation: { kind: "context-window" },
      }),
      contextWindow: providerOptionRule("string", [], "model-discovery", {
        advertised: false,
        validation: { kind: "context-window" },
      }),
    },
  }),
  pi: defineProviderOptionConfig<"pi">({
    primaryOptionKey: "thinkingLevel",
    options: { thinkingLevel: providerOptionRule("string", PI_THINKING_LEVEL_OPTIONS) },
  }),
  gemini: defineProviderOptionConfig<"gemini">({
    primaryOptionKey: "thinkingLevel",
    options: {
      thinkingLevel: providerOptionRule("string", GEMINI_THINKING_LEVEL_OPTIONS),
      thinkingBudget: providerOptionRule("string", GEMINI_THINKING_BUDGET_OPTIONS.map(String)),
    },
  }),
  // Hermes exposes no model options, so there is no key to type against.
  hermes: { primaryOptionKey: "", options: {} },
  // Kimi Code, MiniMax Code, and ZCode advertise a per-model `thought_level`
  // select over ACP, so the effort values come from model discovery.
  kimi: defineProviderOptionConfig<"kimi">({
    primaryOptionKey: "reasoningEffort",
    options: { reasoningEffort: providerOptionRule("string", [], "model-discovery") },
  }),
  minimax: defineProviderOptionConfig<"minimax">({
    primaryOptionKey: "reasoningEffort",
    options: { reasoningEffort: providerOptionRule("string", [], "model-discovery") },
  }),
  zcode: defineProviderOptionConfig<"zcode">({
    primaryOptionKey: "reasoningEffort",
    options: { reasoningEffort: providerOptionRule("string", [], "model-discovery") },
  }),
  omp: defineProviderOptionConfig<"omp">({
    primaryOptionKey: "thinkingLevel",
    options: { thinkingLevel: providerOptionRule("string", OMP_THINKING_LEVEL_OPTIONS) },
  }),
  antigravity: defineProviderOptionConfig<"antigravity">({
    primaryOptionKey: "reasoningEffort",
    options: { reasoningEffort: providerOptionRule("string", [], "model-discovery") },
  }),
  kilo: defineProviderOptionConfig<"kilo">({
    primaryOptionKey: "variant",
    options: {
      variant: providerOptionRule("string", [], "model-discovery"),
      agent: providerOptionRule("string", [], "model-discovery", {
        validation: { kind: "non-empty-string" },
        allowsCustomValue: true,
      }),
    },
  }),
  opencode: defineProviderOptionConfig<"opencode">({
    primaryOptionKey: "variant",
    options: {
      variant: providerOptionRule("string", [], "model-discovery"),
      agent: providerOptionRule("string", [], "model-discovery", {
        validation: { kind: "non-empty-string" },
        allowsCustomValue: true,
      }),
    },
  }),
  devin: defineProviderOptionConfig<"devin">({
    primaryOptionKey: "modelVariant",
    options: {
      fastMode: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsFastMode" },
      }),
      thinking: providerOptionRule("boolean", [], "model-discovery", {
        advertised: false,
        validation: { kind: "boolean-capability", capability: "supportsThinkingToggle" },
      }),
      contextWindow: providerOptionRule("string", [], "model-discovery", {
        advertised: false,
        validation: { kind: "context-window" },
      }),
      reasoningEffort: providerOptionRule("string", [], "model-discovery"),
      modelVariant: providerOptionRule("string", [], "model-discovery", {
        validation: { kind: "non-empty-string" },
        allowsCustomValue: true,
      }),
    },
  }),
} as const satisfies Record<ProviderKind, ProviderTargetOptionConfig>;

function providerTargetOptionConfig(provider: ProviderKind): ProviderTargetOptionConfig {
  const registry: Readonly<Record<ProviderKind, ProviderTargetOptionConfig>> =
    PROVIDER_TARGET_OPTION_RULES;
  return registry[provider];
}

function providerDefaultModel(provider: ProviderKind): string | null {
  return getDefaultModel(provider);
}

const AGENT_GATEWAY_PROVIDER_CATALOG_TIMEOUT_MS = 15_000;

export function loadAgentGatewayProviderCatalog(input: {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderKind;
  readonly discovery: ProviderDiscoveryServiceShape;
  readonly availability?: AgentGatewayProviderAvailability;
  readonly cwd?: string;
  readonly discoveryTimeoutMs?: number;
}): Effect.Effect<AgentGatewayProviderCatalog> {
  const availability = input.availability ?? { enabled: true };
  const provider = input.provider;
  if (!isSupportedProviderKind(provider)) {
    return Effect.succeed({
      instanceId: input.instanceId,
      provider,
      defaultModel: null,
      models: [],
      enabled: false,
      available: false,
      ...(availability.authStatus ? { authStatus: availability.authStatus } : {}),
      source: "moss-supported-provider-boundary",
      error: `Provider '${provider}' is no longer supported by Moss.`,
    });
  }
  const modelPolicy = availability.modelPolicy;
  const catalogInstances = availability.instances?.map(
    ({ instanceId, displayName, isDefault, enabled }) => ({
      instanceId,
      displayName,
      isDefault,
      enabled,
    }),
  );
  const defaultModel = modelPolicy?.defaultModel ?? providerDefaultModel(provider);
  const modelPolicyError =
    modelPolicy === undefined
      ? null
      : modelPolicy.allowedModels.length === 0
        ? `Managed provider instance "${input.instanceId}" has no enabled models.`
        : modelPolicy.defaultModel === null ||
            !modelPolicy.allowedModels.includes(modelPolicy.defaultModel)
          ? `Managed provider instance "${input.instanceId}" has an invalid default model policy.`
          : null;
  const unavailableReason =
    availability.enabled === false
      ? `Provider "${provider}" is disabled in Moss settings.`
      : availability.available === false
        ? (availability.message ?? `Provider "${provider}" is not available.`)
        : availability.authStatus === "unauthenticated"
          ? (availability.message ?? `Provider "${provider}" is not authenticated.`)
          : modelPolicyError;
  if (unavailableReason !== null) {
    return Effect.succeed({
      instanceId: input.instanceId,
      provider,
      defaultModel,
      models: modelPolicy
        ? modelPolicy.allowedModels.map((slug): ProviderModelDescriptor => ({ slug, name: slug }))
        : [],
      enabled: availability.enabled,
      available: false,
      ...(availability.authStatus ? { authStatus: availability.authStatus } : {}),
      ...(modelPolicy ? { source: "moss-managed-provider-settings" } : {}),
      error: unavailableReason,
    });
  }
  const discovery = input.discovery
    .listModels({
      provider,
      instanceId: input.instanceId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    })
    .pipe(
      Effect.timeoutOption(input.discoveryTimeoutMs ?? AGENT_GATEWAY_PROVIDER_CATALOG_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new Error(
                `Timed out while discovering models for provider instance "${input.instanceId}".`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  return discovery.pipe(
    Effect.map((result: ProviderListModelsResult): AgentGatewayProviderCatalog => {
      const discoveredBySlug = new Map(result.models.map((model) => [model.slug, model]));
      const models = modelPolicy
        ? modelPolicy.allowedModels.map(
            (slug): ProviderModelDescriptor =>
              discoveredBySlug.get(slug) ?? {
                slug,
                name: slug,
              },
          )
        : result.models;
      return {
        instanceId: input.instanceId,
        provider,
        defaultModel,
        models,
        ...(catalogInstances ? { instances: catalogInstances } : {}),
        enabled: true,
        available: models.length > 0 || defaultModel !== null,
        ...(availability.authStatus ? { authStatus: availability.authStatus } : {}),
        ...(modelPolicy
          ? { source: "moss-managed-provider-settings" }
          : result.source
            ? { source: result.source }
            : {}),
      };
    }),
    Effect.catch((error) => {
      const fallback: AgentGatewayProviderCatalog = modelPolicy
        ? {
            instanceId: input.instanceId,
            provider,
            defaultModel,
            models: modelPolicy.allowedModels.map(
              (slug): ProviderModelDescriptor => ({ slug, name: slug }),
            ),
            enabled: true,
            available: true,
            ...(availability.authStatus ? { authStatus: availability.authStatus } : {}),
            source: "moss-managed-provider-settings",
          }
        : {
            instanceId: input.instanceId,
            provider,
            defaultModel,
            models: [],
            enabled: true,
            available: defaultModel !== null,
            ...(availability.authStatus ? { authStatus: availability.authStatus } : {}),
            error: error instanceof Error ? error.message : String(error),
          };
      return Effect.succeed(fallback);
    }),
  );
}

function providerTargetOptionRules(
  provider: ProviderKind,
): ReadonlyArray<AgentGatewayTargetOptionRule> {
  return Object.entries(providerTargetOptionConfig(provider).options)
    .filter(([, option]) => option.advertised === true)
    .map(([key, { valueType, allowedValues, allowedValuesSource, allowsCustomValue }]) => ({
      key,
      valueType,
      allowedValues,
      allowedValuesSource,
      ...(allowsCustomValue ? { allowsCustomValue: true } : {}),
    }));
}

function providerPrimaryOptionKey(provider: ProviderKind): string {
  return providerTargetOptionConfig(provider).primaryOptionKey;
}

function convertDiscoveredOptionValue(
  value: string,
  valueType: AgentGatewayTargetOptionRule["valueType"],
): AgentGatewayTargetOptionValue | null {
  if (valueType === "string") return value;
  if (valueType === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function modelTargetOptionRules(
  provider: ProviderKind,
  model: ProviderModelDescriptor,
): ReadonlyArray<AgentGatewayTargetOptionRule> {
  const rules = providerTargetOptionRules(provider).map(
    ({ key, valueType, allowedValues, allowedValuesSource, allowsCustomValue }) => ({
      key,
      valueType,
      allowedValues,
      allowedValuesSource,
      ...(allowsCustomValue === undefined ? {} : { allowsCustomValue }),
    }),
  );
  const replaceAllowedValues = (
    key: string,
    values: ReadonlyArray<AgentGatewayTargetOptionValue>,
    allowEmpty = false,
  ) => {
    if (values.length === 0 && !allowEmpty) return;
    const index = rules.findIndex((rule) => rule.key === key);
    if (index < 0) return;
    rules[index] = {
      ...rules[index]!,
      allowedValues: values,
      allowedValuesSource: "model-discovery",
      ...(rules[index]!.allowsCustomValue === true ? { allowsCustomValue: false } : {}),
    };
  };

  const discoveredEfforts = model.supportedReasoningEfforts?.map((entry) => entry.value) ?? [];
  const primaryOptionKey = providerPrimaryOptionKey(provider);
  // A custom-value primary option (e.g. Devin modelVariant) accepts arbitrary
  // values, so the discovered reasoning-effort list must not constrain it.
  if (rules.find((rule) => rule.key === primaryOptionKey)?.allowsCustomValue !== true) {
    replaceAllowedValues(primaryOptionKey, discoveredEfforts);
  }

  for (const descriptor of model.optionDescriptors ?? []) {
    const spec = providerOptionRuleSpec(provider, descriptor.id);
    if (spec?.advertised === "when-discovered") {
      rules.push({
        key: spec.key,
        valueType: spec.valueType,
        allowedValues: [],
        allowedValuesSource: "model-discovery",
      });
    }
    const rule = rules.find((candidate) => candidate.key === descriptor.id);
    if (!rule) continue;
    if (descriptor.type === "select") {
      replaceAllowedValues(
        descriptor.id,
        descriptor.options
          .map((option) => convertDiscoveredOptionValue(option.id, rule.valueType))
          .filter((value): value is AgentGatewayTargetOptionValue => value !== null),
        true,
      );
    } else if (descriptor.type === "boolean") {
      replaceAllowedValues(descriptor.id, [true, false]);
    }
  }
  return rules;
}

function preferredExampleOptionValue(
  rule: AgentGatewayTargetOptionRule,
): AgentGatewayTargetOptionValue | null {
  const preferences: ReadonlyArray<AgentGatewayTargetOptionValue> =
    rule.key === "reasoningEffort"
      ? ["medium", "low"]
      : rule.key === "thinkingLevel"
        ? ["LOW", "low"]
        : ["low"];
  return (
    preferences.find((value) => rule.allowedValues.includes(value)) ?? rule.allowedValues[0] ?? null
  );
}

function exampleOptionsForRules(
  primaryOptionKey: string,
  rules: ReadonlyArray<AgentGatewayTargetOptionRule>,
): Readonly<Record<string, AgentGatewayTargetOptionValue>> {
  const primaryRule = rules.find((rule) => rule.key === primaryOptionKey);
  const exampleRule =
    primaryRule && primaryRule.allowedValues.length > 0
      ? primaryRule
      : rules.find((rule) => rule.allowedValues.length > 0);
  if (!exampleRule) return {};
  const value = preferredExampleOptionValue(exampleRule);
  return value === null ? {} : { [exampleRule.key]: value };
}

/** Compact, typed construction guidance returned before the full model catalog. */
export function agentGatewayTargetOptionGuidance(
  catalog: AgentGatewayProviderCatalog,
): AgentGatewayTargetOptionGuidance {
  const primaryOptionKey = providerPrimaryOptionKey(catalog.provider);
  const providerOptions = providerTargetOptionRules(catalog.provider);
  const optionsByModel = Object.fromEntries(
    catalog.models.map((model) => [model.slug, modelTargetOptionRules(catalog.provider, model)]),
  );
  const exampleModel = catalog.models[0]?.slug ?? catalog.defaultModel;
  const exampleRules = exampleModel
    ? (optionsByModel[exampleModel] ?? providerOptions)
    : providerOptions;
  return {
    primaryOptionKey,
    alternativeOptionKeys: providerOptions
      .map((rule) => rule.key)
      .filter((key) => key !== primaryOptionKey),
    optionSelectionRule:
      "Use optionsByModel[model] when present. Its keys and valueType are authoritative. Choose from allowedValues unless allowsCustomValue is true; otherwise use providerOptions.",
    providerOptions,
    optionsByModel,
    exampleTarget:
      catalog.available && exampleModel
        ? {
            // Retired drivers (kilo) never produce a live catalog; every
            // reachable provider is a valid ModelSelection discriminator.
            provider: catalog.provider as ModelSelection["provider"],
            instanceId: defaultInstanceIdForProvider(catalog.provider),
            model: exampleModel,
            options: exampleOptionsForRules(primaryOptionKey, exampleRules),
          }
        : null,
  };
}

function failUnavailableOption(
  target: ModelSelection,
  option: string,
  available?: ReadonlyArray<string>,
): never {
  throw new AgentGatewayTargetError(
    "model_option_unavailable",
    `Option "${option}" is not available for ${target.provider}/${target.model}.${
      available && available.length > 0 ? ` Available values: ${available.join(", ")}.` : ""
    }`,
    { provider: target.provider, model: target.model, option, available: available ?? [] },
  );
}

const DISCOVERED_EFFORT_OPTION_IDS = new Set([
  "reasoningEffort",
  "effort",
  "thinkingLevel",
  "thinkingBudget",
  "variant",
]);

function providerOptionRuleSpec(
  provider: ProviderKind,
  optionId: string,
): ResolvedProviderTargetOptionRuleSpec | undefined {
  const rule = providerTargetOptionConfig(provider).options[optionId];
  return rule ? { key: optionId, ...rule } : undefined;
}

function normalizedEffortValue(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return undefined;
}

function validateOptionsWithoutCatalog(target: ModelSelection): void {
  const rawOptions = target.options as Record<string, unknown> | undefined;
  for (const [optionId, value] of Object.entries(rawOptions ?? {})) {
    if (value === undefined) continue;
    const rule = providerOptionRuleSpec(target.provider, optionId);
    if (!rule) failUnavailableOption(target, optionId);
    switch (rule.validation.kind) {
      case "effort": {
        const effort = normalizedEffortValue(value);
        const available = rule.allowedValues.map(String);
        if (effort === undefined || !available.includes(effort)) {
          failUnavailableOption(target, effort ?? optionId, available);
        }
        break;
      }
      case "boolean-capability":
        if (typeof value !== "boolean" || value === true) {
          failUnavailableOption(target, optionId);
        }
        break;
      case "context-window":
        failUnavailableOption(target, optionId);
      case "non-empty-string":
        if (typeof value !== "string" || value.trim().length === 0) {
          failUnavailableOption(target, optionId);
        }
        break;
    }
  }
}

function validateDiscoveredDescriptorOption(
  target: ModelSelection,
  descriptor: ProviderModelDescriptor,
  optionId: string,
  value: unknown,
): void {
  const advertised = descriptor.optionDescriptors?.find((option) => option.id === optionId);
  if (advertised?.type === "select") {
    const available = advertised.options.map((entry) => entry.id);
    if (available.includes(String(value))) return;
    failUnavailableOption(target, String(value), available);
  }
  if (advertised?.type === "boolean" && typeof value === "boolean") return;
  failUnavailableOption(target, optionId);
}

function validateEffortOption(
  target: ModelSelection,
  descriptor: ProviderModelDescriptor,
  rule: ResolvedProviderTargetOptionRuleSpec,
  value: unknown,
): void {
  const effort = normalizedEffortValue(value);
  if (effort === undefined) failUnavailableOption(target, rule.key);

  const advertisedEfforts = descriptor.supportedReasoningEfforts?.map((entry) => entry.value);
  if (advertisedEfforts && advertisedEfforts.length > 0 && !advertisedEfforts.includes(effort)) {
    failUnavailableOption(target, effort, advertisedEfforts);
  }

  const effortDescriptors = (descriptor.optionDescriptors ?? []).filter(
    (option) => option.type === "select" && DISCOVERED_EFFORT_OPTION_IDS.has(option.id),
  );
  for (const option of effortDescriptors) {
    if (option.type !== "select") continue;
    const available = option.options.map((entry) => entry.id);
    if (!available.includes(effort)) {
      failUnavailableOption(target, effort, available);
    }
  }

  if ((advertisedEfforts?.length ?? 0) === 0 && effortDescriptors.length === 0) {
    const available = rule.allowedValues.map(String);
    if (!available.includes(effort)) failUnavailableOption(target, effort, available);
  }
}

function validateKnownProviderOption(
  target: ModelSelection,
  descriptor: ProviderModelDescriptor,
  rule: ResolvedProviderTargetOptionRuleSpec,
  value: unknown,
): void {
  switch (rule.validation.kind) {
    case "effort":
      validateEffortOption(target, descriptor, rule, value);
      return;
    case "boolean-capability":
      if (typeof value !== "boolean") failUnavailableOption(target, rule.key);
      if (value === true && descriptor[rule.validation.capability] !== true) {
        failUnavailableOption(target, rule.key);
      }
      return;
    case "context-window": {
      const available = descriptor.contextWindowOptions?.map((entry) => entry.value) ?? [];
      if (available.includes(String(value))) return;
      const optionId =
        target.provider === "claudeAgent" &&
        rule.key === "contextWindow" &&
        descriptor.optionDescriptors?.some((option) => option.id === "autoCompactWindow")
          ? "autoCompactWindow"
          : rule.key;
      validateDiscoveredDescriptorOption(target, descriptor, optionId, value);
      return;
    }
    case "non-empty-string": {
      if (typeof value !== "string" || value.trim().length === 0) {
        failUnavailableOption(target, rule.key);
      }
      if (descriptor.optionDescriptors?.some((option) => option.id === rule.key)) {
        validateDiscoveredDescriptorOption(target, descriptor, rule.key, value);
      }
      return;
    }
  }
}

function validateAdvertisedOption(
  target: ModelSelection,
  descriptor: ProviderModelDescriptor,
): void {
  const rawOptions = target.options as Record<string, unknown> | undefined;
  for (const [optionId, value] of Object.entries(rawOptions ?? {})) {
    if (value === undefined) continue;
    const rule = providerOptionRuleSpec(target.provider, optionId);
    if (rule) {
      validateKnownProviderOption(target, descriptor, rule, value);
    } else {
      validateDiscoveredDescriptorOption(target, descriptor, optionId, value);
    }
  }
}

/** Resolve an exact advertised target before any git/orchestration side effect. */
export function resolveAgentGatewayTarget(input: {
  readonly target: ModelSelection;
  readonly discovery: ProviderDiscoveryServiceShape;
  readonly availability?: AgentGatewayProviderAvailability;
  readonly cwd?: string;
}): Effect.Effect<ModelSelection, AgentGatewayTargetError> {
  return Effect.gen(function* () {
    let targetAvailability = input.availability;
    const requestedInstanceId = input.target.instanceId;
    const instances = input.availability?.instances;
    if (requestedInstanceId !== undefined && instances !== undefined) {
      const selected = instances.find((instance) => instance.instanceId === requestedInstanceId);
      if (selected === undefined) {
        return yield* Effect.fail(
          new AgentGatewayTargetError(
            "provider_unavailable",
            `Provider instance "${requestedInstanceId}" is not configured for provider "${input.target.provider}". Choose an instance from moss_capabilities providers[].instances[].`,
            {
              provider: input.target.provider,
              instanceId: requestedInstanceId,
              availableInstanceIds: instances.map((instance) => instance.instanceId),
            },
          ),
        );
      }
      if (!selected.enabled) {
        return yield* Effect.fail(
          new AgentGatewayTargetError(
            "provider_unavailable",
            `Provider instance "${requestedInstanceId}" is disabled in Moss settings.`,
            { provider: input.target.provider, instanceId: requestedInstanceId },
          ),
        );
      }
      targetAvailability = {
        enabled: selected.enabled,
        ...(selected.available !== undefined ? { available: selected.available } : {}),
        ...(selected.authStatus !== undefined ? { authStatus: selected.authStatus } : {}),
        ...(selected.modelPolicy ? { modelPolicy: selected.modelPolicy } : {}),
        instances,
      } satisfies AgentGatewayProviderAvailability;
    }
    const catalog = yield* loadAgentGatewayProviderCatalog({
      instanceId: input.target.instanceId ?? input.target.provider,
      provider: input.target.provider,
      discovery: input.discovery,
      ...(targetAvailability ? { availability: targetAvailability } : {}),
      ...(input.target.instanceId !== undefined ? { instanceId: input.target.instanceId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    if (!catalog.available) {
      return yield* Effect.fail(
        new AgentGatewayTargetError(
          "provider_unavailable",
          catalog.error ?? `Provider "${input.target.provider}" is unavailable.`,
          {
            provider: input.target.provider,
            enabled: catalog.enabled,
            authStatus: catalog.authStatus,
          },
        ),
      );
    }
    const exactDescriptor = catalog.models.find((model) => model.slug === input.target.model);
    // The Claude picker can show a concrete resolved id for a newly discovered
    // alias. Discovery still advertises the alias as its slug, so validate that
    // id against a single non-default descriptor carrying it. Prefer an exact
    // resolved id before ignoring its context qualifier.
    const resolvedClaudeDescriptors =
      !exactDescriptor && input.target.provider === "claudeAgent"
        ? catalog.models.filter((model) => model.slug !== "default" && model.resolvedModel)
        : [];
    const exactResolved = resolvedClaudeDescriptors.filter(
      (model) => model.resolvedModel === input.target.model,
    );
    const unqualifiedResolved =
      getClaudeContextWindowSuffix(input.target.model) === null
        ? resolvedClaudeDescriptors.filter(
            (model) =>
              model.resolvedModel &&
              stripClaudeContextWindowSuffix(model.resolvedModel) === input.target.model,
          )
        : [];
    const resolvedMatches = exactResolved.length > 0 ? exactResolved : unqualifiedResolved;
    const descriptor =
      exactDescriptor ?? (resolvedMatches.length === 1 ? resolvedMatches[0] : undefined);
    // Capability claims come from discovery, never the agent's target input. Keep
    // unknown distinct from false so Auto-mode validation can still fail closed.
    const target: ModelSelection =
      input.target.provider === "claudeAgent"
        ? {
            provider: input.target.provider,
            ...(input.target.instanceId !== undefined
              ? { instanceId: input.target.instanceId }
              : {}),
            model: input.target.model,
            ...(input.target.options !== undefined ? { options: input.target.options } : {}),
            ...(descriptor?.supportsAutoMode !== undefined
              ? { supportsAutoMode: descriptor.supportsAutoMode }
              : {}),
          }
        : input.target;

    if (catalog.models.length > 0 && descriptor === undefined) {
      return yield* Effect.fail(
        new AgentGatewayTargetError(
          "model_unavailable",
          `Model "${input.target.model}" is not available for ${input.target.provider}. Use an exact slug from moss_capabilities.`,
          {
            provider: input.target.provider,
            requestedModel: input.target.model,
            availableModels: catalog.models.map((model) => model.slug),
          },
        ),
      );
    }

    if (catalog.models.length === 0) {
      if (catalog.defaultModel === null) {
        return yield* Effect.fail(
          new AgentGatewayTargetError(
            "provider_unavailable",
            `Provider "${input.target.provider}" has no available model catalog or configured default.`,
            { provider: input.target.provider, discoveryError: catalog.error },
          ),
        );
      }
      if (input.target.model !== catalog.defaultModel) {
        return yield* Effect.fail(
          new AgentGatewayTargetError(
            "model_unavailable",
            `The ${input.target.provider} model catalog is unavailable. Only its configured default "${catalog.defaultModel}" can be used safely; custom model "${input.target.model}" was not verified.`,
            { provider: input.target.provider, requestedModel: input.target.model },
          ),
        );
      }
      try {
        validateOptionsWithoutCatalog(input.target);
      } catch (error) {
        if (error instanceof AgentGatewayTargetError) return yield* Effect.fail(error);
        throw error;
      }
      return target;
    }

    try {
      validateAdvertisedOption(input.target, descriptor!);
    } catch (error) {
      if (error instanceof AgentGatewayTargetError) return yield* Effect.fail(error);
      throw error;
    }
    // Explicit Claude windows must reach the runtime with the same concrete model
    // whose capabilities were discovered; custom SDK aliases have no static caps.
    if (
      input.target.provider === "claudeAgent" &&
      (input.target.options?.autoCompactWindow !== undefined ||
        input.target.options?.contextWindow !== undefined) &&
      descriptor?.resolvedModel &&
      stripClaudeContextWindowSuffix(descriptor.resolvedModel) !== input.target.model
    ) {
      const suffix =
        getClaudeContextWindowSuffix(input.target.model) === "1m" &&
        getClaudeContextWindowSuffix(descriptor.resolvedModel) === null
          ? "[1m]"
          : "";
      return { ...target, model: `${descriptor.resolvedModel}${suffix}` };
    }
    return target;
  });
}
