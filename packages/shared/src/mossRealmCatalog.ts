// FILE: mossRealmCatalog.ts
// Purpose: Moss managed model catalog. One Moss model id is stable across every
// engine (Codex / Claude Code / OpenCode). Two independent axes decide what a
// signed-in principal can use:
//   - the realm (cn / global) picks the regional gateway and its upstream relay;
//   - the model scope (domestic / all) picks which vendors that principal may use.
// An access lane binds one sign-in method to exactly one realm and one scope.
// Layer: shared data (no runtime dependencies). The deployable Edge Function
// keeps a byte-identical mirror at
// supabase/functions/moss-model-gateway/mossRealmCatalog.ts because Supabase
// deploys the function directory alone; the shared contract test rejects drift.

export const MOSS_REALMS = ["cn", "global"] as const;
export type MossRealm = (typeof MOSS_REALMS)[number];

/** Managed text relays. CN serves domestic vendors through OpenRouter, but
 * OpenRouter refuses OpenAI and Anthropic for mainland-origin requests, so CN
 * reaches those two families (enterprise lane only, by scope) through APIMart
 * over the signed egress. Global routes every family through APIMart. */
export const MOSS_UPSTREAM_PROVIDERS = ["openrouter", "apimart"] as const;
export type MossUpstreamProvider = (typeof MOSS_UPSTREAM_PROVIDERS)[number];

/** Which upstream serves each realm by default. */
export const MOSS_REALM_DEFAULT_UPSTREAM: Readonly<Record<MossRealm, MossUpstreamProvider>> = {
  cn: "openrouter",
  global: "apimart",
};

/** Every upstream a realm gateway may route to, default first. */
export const MOSS_REALM_UPSTREAMS: Readonly<
  Record<MossRealm, ReadonlyArray<MossUpstreamProvider>>
> = {
  cn: ["openrouter", "apimart"],
  global: ["apimart"],
};

/** Model families CN may route to APIMart; every other CN family stays on OpenRouter. */
export const MOSS_CN_APIMART_FAMILIES: ReadonlyArray<MossModelFamily> = ["openai", "claude"];

/** Default per-family routing override on top of a realm's default upstream. */
export const MOSS_REALM_FAMILY_UPSTREAM_OVERRIDES: Readonly<
  Record<MossRealm, Partial<Record<MossModelFamily, MossUpstreamProvider>>>
> = {
  cn: { openai: "apimart", claude: "apimart" },
  global: {
    openai: "apimart",
    claude: "apimart",
    deepseek: "apimart",
    glm: "apimart",
    kimi: "apimart",
    minimax: "apimart",
    qwen: "apimart",
  },
};

/** Where a model's vendor is based. */
export type MossModelOrigin = "domestic" | "international";

/** Vendor origins one principal may use. */
export const MOSS_MODEL_SCOPES = ["domestic", "all"] as const;
export type MossModelScope = (typeof MOSS_MODEL_SCOPES)[number];

/**
 * How a principal reaches Moss models, chosen by its sign-in method:
 * - `cn`: phone-number account. Mainland gateway, domestic vendors only.
 * - `global`: Google account. Global gateway, every vendor; the user is
 *   expected to reach overseas services on their own network.
 * - `enterprise`: Moss-issued enterprise API key. Mainland gateway, every
 *   vendor, no overseas network required.
 */
export const MOSS_ACCESS_LANES = ["cn", "global", "enterprise"] as const;
export type MossAccessLane = (typeof MOSS_ACCESS_LANES)[number];

/** Identity authority behind each lane; also the gateway's identity realm. */
export type MossAccessAuthority = "memfire-phone" | "supabase-google" | "moss-enterprise-key";

export interface MossAccessLaneSpec {
  readonly lane: MossAccessLane;
  readonly authority: MossAccessAuthority;
  /** Regional gateway (and therefore upstream relay) the lane's traffic uses. */
  readonly realm: MossRealm;
  readonly modelScope: MossModelScope;
}

export const MOSS_ACCESS_LANE_SPECS: Readonly<Record<MossAccessLane, MossAccessLaneSpec>> = {
  cn: { lane: "cn", authority: "memfire-phone", realm: "cn", modelScope: "domestic" },
  global: { lane: "global", authority: "supabase-google", realm: "global", modelScope: "all" },
  enterprise: {
    lane: "enterprise",
    authority: "moss-enterprise-key",
    realm: "cn",
    modelScope: "all",
  },
};

/** Where the mainland lanes download agent CLIs from, since they promise to work without a VPN. */
export const MOSS_CN_NPM_MIRROR_REGISTRY = "https://registry.npmmirror.com";

export function isMossAccessLane(value: unknown): value is MossAccessLane {
  return value === "cn" || value === "global" || value === "enterprise";
}

export function mossAccessLaneForAuthority(authority: MossAccessAuthority): MossAccessLane {
  return authority === "memfire-phone"
    ? "cn"
    : authority === "supabase-google"
      ? "global"
      : "enterprise";
}

/** Enterprise keys are `moss_sk_` followed by 32 random bytes in base64url. */
export const MOSS_ENTERPRISE_API_KEY_PREFIX = "moss_sk_";
const MOSS_ENTERPRISE_API_KEY_PATTERN = /^moss_sk_[A-Za-z0-9_-]{43}$/u;

export function isMossEnterpriseApiKey(value: string): boolean {
  return MOSS_ENTERPRISE_API_KEY_PATTERN.test(value);
}

/** Non-secret prefix stored beside the key digest and shown in the UI. */
export function mossEnterpriseApiKeyDisplayPrefix(key: string): string {
  return key.slice(0, MOSS_ENTERPRISE_API_KEY_PREFIX.length + 4);
}

/**
 * Upstream that serves one model for a gateway configured with `providers`
 * (default first) and optional family overrides. Falls back to the first
 * configured provider that binds the model, so a realm never advertises a
 * model it cannot route.
 */
export function resolveMossUpstreamForModel(
  id: string,
  providers: ReadonlyArray<MossUpstreamProvider>,
  familyOverrides: Partial<Record<MossModelFamily, MossUpstreamProvider>> = {},
): MossUpstreamProvider | null {
  const definition = getMossManagedModelDefinition(id);
  if (!definition || providers.length === 0) return null;
  const preferred = familyOverrides[definition.family];
  if (preferred && providers.includes(preferred) && definition.upstream[preferred])
    return preferred;
  return providers.find((provider) => definition.upstream[provider] !== undefined) ?? null;
}

export const MOSS_UPSTREAM_BASE_URLS: Readonly<Record<MossUpstreamProvider, string>> = {
  openrouter: "https://openrouter.ai/api",
  apimart: "https://api.apimart.ai",
};

export const MOSS_REALM_TEXT_ENDPOINTS = [
  "/v1/responses",
  "/v1/chat/completions",
  "/v1/messages",
] as const;
export type MossRealmTextEndpoint = (typeof MOSS_REALM_TEXT_ENDPOINTS)[number];

/**
 * Reasoning effort vocabulary accepted by the Codex model catalog. Vendors
 * expose subsets; the gateway snaps any client value onto the model's ladder.
 */
export const MOSS_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type MossReasoningEffort = (typeof MOSS_REASONING_EFFORTS)[number];

export type MossModelFamily =
  | "openai"
  | "claude"
  | "deepseek"
  | "glm"
  | "kimi"
  | "qwen"
  | "minimax";

export type MossEngineId = "codex" | "claude-code" | "opencode";

export interface MossModelReasoning {
  readonly levels: ReadonlyArray<MossReasoningEffort>;
  readonly default: MossReasoningEffort;
}

export interface MossRealmUpstreamBinding {
  /** Model id sent to the upstream provider. */
  readonly modelId: string;
  /** Protocols this upstream can serve for the model. */
  readonly endpoints: ReadonlyArray<MossRealmTextEndpoint>;
}

export interface MossManagedModelDefinition {
  /** Stable Moss-facing id used by every engine and by quota entitlements. */
  readonly id: string;
  readonly displayName: string;
  readonly family: MossModelFamily;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly inputModalities: ReadonlyArray<"text" | "image">;
  /** `null` when the vendor exposes no reasoning control. */
  readonly reasoning: MossModelReasoning | null;
  readonly supportsParallelToolCalls: boolean;
  /** OpenAI `service_tier: "priority"` (Codex fast mode) is honoured upstream. */
  readonly supportsFastMode: boolean;
  /** Vendor origin; a `domestic` scope only admits domestic vendors. */
  readonly origin: MossModelOrigin;
  /** Per-upstream binding; absence means the upstream cannot serve the model. */
  readonly upstream: Partial<Record<MossUpstreamProvider, MossRealmUpstreamBinding>>;
}

const ALL_TEXT_ENDPOINTS = MOSS_REALM_TEXT_ENDPOINTS;
const RESPONSES_ONLY = ["/v1/responses"] as const;
const MESSAGES_ONLY = ["/v1/messages"] as const;
// Keep APIMart bindings on the same native engine protocol as the existing
// OpenRouter catalog. The relay also accepts Chat Completions (verified in
// deployment probes), but advertising that extra path would silently expand
// Claude Code/OpenCode model pickers beyond their established contract.
const APIMART_OPENAI_ENDPOINTS = ["/v1/responses"] as const;
const APIMART_CLAUDE_ENDPOINTS = ["/v1/messages"] as const;
/** OpenRouter exposes DeepSeek V4 Pro on its Chat Completions protocol only. */
const CHAT_COMPLETIONS_ONLY = ["/v1/chat/completions"] as const;

const GPT_REASONING: MossModelReasoning = {
  levels: ["low", "medium", "high", "xhigh"],
  default: "medium",
};
const DEEPSEEK_REASONING: MossModelReasoning = {
  levels: ["low", "high", "max"],
  default: "high",
};
// GLM-5.3-Flash stalls for minutes at `max` on the CN relay; the ladder stops at
// `high` until the vendor path is proven stable.
const GLM_REASONING: MossModelReasoning = { levels: ["low", "high", "max"], default: "high" };
const GLM_FLASH_REASONING: MossModelReasoning = { levels: ["low", "high"], default: "high" };
const KIMI_REASONING: MossModelReasoning = { levels: ["low", "high", "max"], default: "high" };
const QWEN_REASONING: MossModelReasoning = {
  levels: ["low", "medium", "high"],
  default: "medium",
};
const MINIMAX_REASONING: MossModelReasoning = { levels: ["none", "high"], default: "high" };

function claudeModel(
  id: string,
  displayName: string,
  openrouterId: string,
  contextWindow = 200_000,
  maxOutputTokens = 128_000,
): MossManagedModelDefinition {
  return {
    id,
    displayName,
    family: "claude",
    contextWindow,
    // Keep each Claude entry aligned with the current OpenRouter provider
    // ceiling; Haiku has a smaller 64K completion limit than the other rows.
    maxOutputTokens,
    inputModalities: ["text", "image"],
    reasoning: null,
    supportsParallelToolCalls: true,
    supportsFastMode: false,
    origin: "international",
    upstream: {
      openrouter: { modelId: openrouterId, endpoints: MESSAGES_ONLY },
      apimart: { modelId: id, endpoints: APIMART_CLAUDE_ENDPOINTS },
    },
  };
}

function gptModel(id: string, displayName: string): MossManagedModelDefinition {
  return {
    id,
    displayName,
    family: "openai",
    // OpenRouter reports 1,050,000 for this family; use the binary 1 Mi token
    // boundary in the client catalog so compaction never overshoots a vendor
    // implementation that advertises 1,048,576.
    contextWindow: 1_048_576,
    maxOutputTokens: 128_000,
    inputModalities: ["text", "image"],
    reasoning: GPT_REASONING,
    supportsParallelToolCalls: true,
    supportsFastMode: true,
    origin: "international",
    upstream: {
      openrouter: { modelId: `openai/${id}`, endpoints: RESPONSES_ONLY },
      apimart: { modelId: id, endpoints: APIMART_OPENAI_ENDPOINTS },
    },
  };
}

/**
 * Every model Moss can present in any lane. Order is the display order.
 * A model is available in a lane only when the lane's realm upstream binds it
 * and the lane's model scope admits its vendor origin: phone accounts see the
 * domestic lineup, Google accounts and enterprise keys see every model.
 */
export const MOSS_MANAGED_MODEL_DEFINITIONS: ReadonlyArray<MossManagedModelDefinition> = [
  gptModel("gpt-5.6-sol", "GPT-5.6 Sol"),
  gptModel("gpt-5.6-terra", "GPT-5.6 Terra"),
  gptModel("gpt-5.6-luna", "GPT-5.6 Luna"),
  {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    family: "deepseek",
    origin: "domestic",
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    inputModalities: ["text"],
    reasoning: DEEPSEEK_REASONING,
    supportsParallelToolCalls: true,
    supportsFastMode: false,
    upstream: {
      openrouter: {
        modelId: "deepseek/deepseek-v4-pro-0813",
        endpoints: CHAT_COMPLETIONS_ONLY,
      },
      apimart: { modelId: "deepseek-v4-pro", endpoints: CHAT_COMPLETIONS_ONLY },
    },
  },
  {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    family: "deepseek",
    origin: "domestic",
    contextWindow: 1_048_576,
    maxOutputTokens: 943_718,
    inputModalities: ["text"],
    reasoning: DEEPSEEK_REASONING,
    supportsParallelToolCalls: true,
    supportsFastMode: false,
    upstream: {
      openrouter: { modelId: "deepseek/deepseek-v4-flash-0731", endpoints: CHAT_COMPLETIONS_ONLY },
      apimart: { modelId: "deepseek-v4-flash", endpoints: CHAT_COMPLETIONS_ONLY },
    },
  },
  {
    id: "glm-5.3",
    displayName: "GLM-5.3",
    family: "glm",
    origin: "domestic",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    inputModalities: ["text"],
    reasoning: GLM_REASONING,
    supportsParallelToolCalls: true,
    supportsFastMode: false,
    upstream: {
      openrouter: { modelId: "z-ai/glm-5.3", endpoints: CHAT_COMPLETIONS_ONLY },
      apimart: { modelId: "glm-5.3", endpoints: CHAT_COMPLETIONS_ONLY },
    },
  },
  {
    id: "glm-5.3-flash",
    displayName: "GLM-5.3 Flash",
    family: "glm",
    origin: "domestic",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    inputModalities: ["text", "image"],
    reasoning: GLM_FLASH_REASONING,
    supportsParallelToolCalls: true,
    supportsFastMode: false,
    upstream: {
      openrouter: { modelId: "z-ai/glm-5.3-flash", endpoints: CHAT_COMPLETIONS_ONLY },
      apimart: { modelId: "glm-5.3-flash", endpoints: CHAT_COMPLETIONS_ONLY },
    },
  },
  {
    id: "kimi-k3",
    displayName: "Kimi K3",
    family: "kimi",
    origin: "domestic",
    contextWindow: 1_048_576,
    maxOutputTokens: 943_718,
    inputModalities: ["text", "image"],
    reasoning: KIMI_REASONING,
    supportsParallelToolCalls: true,
    supportsFastMode: false,
    upstream: {
      // Legacy chat relays expose Chat Completions; the gateway converts
      // Messages/Responses when required.
      openrouter: { modelId: "moonshotai/kimi-k3", endpoints: CHAT_COMPLETIONS_ONLY },
      apimart: { modelId: "kimi-k3", endpoints: CHAT_COMPLETIONS_ONLY },
    },
  },
  {
    id: "minimax-m3",
    displayName: "MiniMax M3",
    family: "minimax",
    origin: "domestic",
    contextWindow: 524_288,
    maxOutputTokens: 512_000,
    inputModalities: ["text", "image"],
    reasoning: MINIMAX_REASONING,
    supportsParallelToolCalls: true,
    supportsFastMode: false,
    upstream: {
      openrouter: { modelId: "minimax/minimax-m3", endpoints: CHAT_COMPLETIONS_ONLY },
      apimart: { modelId: "minimax-m3", endpoints: CHAT_COMPLETIONS_ONLY },
    },
  },
  {
    id: "qwen3.8-max",
    displayName: "Qwen3.8 Max",
    family: "qwen",
    origin: "domestic",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    inputModalities: ["text"],
    reasoning: QWEN_REASONING,
    supportsParallelToolCalls: true,
    supportsFastMode: false,
    upstream: {
      openrouter: { modelId: "qwen/qwen3.8-max-0902", endpoints: CHAT_COMPLETIONS_ONLY },
      apimart: { modelId: "qwen3.8-max", endpoints: CHAT_COMPLETIONS_ONLY },
    },
  },
  claudeModel("claude-sonnet-5", "Claude Sonnet 5", "anthropic/claude-sonnet-5", 1_000_000),
  claudeModel("claude-opus-5", "Claude Opus 5", "anthropic/claude-opus-5", 1_000_000),
  claudeModel("claude-fable-5", "Claude Fable 5", "anthropic/claude-fable-5", 1_000_000),
  claudeModel("claude-opus-4-8", "Claude Opus 4.8", "anthropic/claude-opus-4.8", 1_000_000),
  claudeModel("claude-opus-4-7", "Claude Opus 4.7", "anthropic/claude-opus-4.7", 1_000_000),
  claudeModel("claude-opus-4-6", "Claude Opus 4.6", "anthropic/claude-opus-4.6", 1_000_000),
  claudeModel("claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic/claude-sonnet-4.6", 1_000_000),
  claudeModel(
    "claude-haiku-4-5-20251001",
    "Claude Haiku 4.5",
    "anthropic/claude-haiku-4.5",
    200_000,
    64_000,
  ),
];

const DEFINITION_BY_ID: ReadonlyMap<string, MossManagedModelDefinition> = new Map(
  MOSS_MANAGED_MODEL_DEFINITIONS.map((definition) => [definition.id, definition] as const),
);

export function getMossManagedModelDefinition(id: string): MossManagedModelDefinition | null {
  return DEFINITION_BY_ID.get(id) ?? null;
}

/** Binding of one Moss model on one upstream provider, or `null` when absent. */
export function mossUpstreamBinding(
  id: string,
  provider: MossUpstreamProvider,
): MossRealmUpstreamBinding | null {
  return getMossManagedModelDefinition(id)?.upstream[provider] ?? null;
}

export function isMossModelEnabledOnUpstream(
  id: string,
  provider: MossUpstreamProvider,
  endpoint: MossRealmTextEndpoint,
): boolean {
  return mossUpstreamBinding(id, provider)?.endpoints.includes(endpoint) ?? false;
}

export function mossUpstreamModelIds(
  provider: MossUpstreamProvider,
  endpoint?: MossRealmTextEndpoint,
): ReadonlyArray<string> {
  return MOSS_MANAGED_MODEL_DEFINITIONS.filter((definition) => {
    const binding = definition.upstream[provider];
    if (!binding) return false;
    return endpoint === undefined || binding.endpoints.includes(endpoint);
  }).map((definition) => definition.id);
}

/** Whether a principal limited to `scope` may use a model of this origin. */
export function isMossModelOriginInScope(origin: MossModelOrigin, scope: MossModelScope): boolean {
  return scope === "all" || origin === "domestic";
}

/**
 * Scope gate for one model id. Unknown ids are left to the gateway's
 * provider admission gates; this only rejects a known out-of-scope vendor.
 */
export function isMossModelInScope(id: string, scope: MossModelScope): boolean {
  const definition = getMossManagedModelDefinition(id);
  return definition === null || isMossModelOriginInScope(definition.origin, scope);
}

function laneUpstreamBinding(
  definition: MossManagedModelDefinition,
  lane: MossAccessLane,
): MossRealmUpstreamBinding | undefined {
  const spec = MOSS_ACCESS_LANE_SPECS[lane];
  if (!isMossModelOriginInScope(definition.origin, spec.modelScope)) return undefined;
  const provider = resolveMossUpstreamForModel(
    definition.id,
    MOSS_REALM_UPSTREAMS[spec.realm],
    MOSS_REALM_FAMILY_UPSTREAM_OVERRIDES[spec.realm],
  );
  return provider ? definition.upstream[provider] : undefined;
}

/** Moss model ids a lane can present on a protocol, via whichever upstream serves them. */
export function mossLaneModelIds(
  lane: MossAccessLane,
  endpoint?: MossRealmTextEndpoint,
): ReadonlyArray<string> {
  return MOSS_MANAGED_MODEL_DEFINITIONS.filter((definition) => {
    const binding = laneUpstreamBinding(definition, lane);
    return (
      binding !== undefined && (endpoint === undefined || binding.endpoints.includes(endpoint))
    );
  }).map((definition) => definition.id);
}

const ENGINE_ENDPOINT: Readonly<Record<MossEngineId, MossRealmTextEndpoint>> = {
  codex: "/v1/responses",
  "claude-code": "/v1/messages",
  opencode: "/v1/chat/completions",
};

export function mossEngineEndpoint(engine: MossEngineId): MossRealmTextEndpoint {
  return ENGINE_ENDPOINT[engine];
}

/** Model ids one engine may present in one lane. */
export function mossLaneEngineModelIds(
  lane: MossAccessLane,
  engine: MossEngineId,
): ReadonlyArray<string> {
  if (engine === "opencode") return mossLaneModelIds(lane, ENGINE_ENDPOINT[engine]);
  // Endpoint capability is the engine gate after lane availability has been
  // applied. The gateway may convert non-Claude families through a chat relay;
  // Claude remains Messages-only for the Codex engine.
  return MOSS_MANAGED_MODEL_DEFINITIONS.filter((definition) => {
    const binding = laneUpstreamBinding(definition, lane);
    return (
      binding?.endpoints.includes(ENGINE_ENDPOINT[engine]) === true ||
      (definition.family !== "claude" &&
        binding?.endpoints.includes("/v1/chat/completions") === true)
    );
  }).map((definition) => definition.id);
}

const ALL_VENDOR_ENGINE_DEFAULT_PREFERENCE: Readonly<Record<MossEngineId, ReadonlyArray<string>>> =
  {
    codex: ["gpt-5.6-terra", "gpt-5.6-luna", "deepseek-v4-pro"],
    "claude-code": ["claude-sonnet-5", "claude-opus-4-8"],
    opencode: ["kimi-k3", "deepseek-v4-pro"],
  };

const LANE_ENGINE_DEFAULT_PREFERENCE: Readonly<
  Record<MossAccessLane, Readonly<Record<MossEngineId, ReadonlyArray<string>>>>
> = {
  cn: {
    codex: ["deepseek-v4-pro", "glm-5.3", "deepseek-v4-flash"],
    "claude-code": ["deepseek-v4-pro", "glm-5.3", "kimi-k3"],
    opencode: ["kimi-k3", "deepseek-v4-pro"],
  },
  global: ALL_VENDOR_ENGINE_DEFAULT_PREFERENCE,
  enterprise: ALL_VENDOR_ENGINE_DEFAULT_PREFERENCE,
};

/** First preferred default that the lane actually serves for the engine. */
export function mossLaneEngineDefaultModel(
  lane: MossAccessLane,
  engine: MossEngineId,
): string | null {
  const enabled = new Set(mossLaneEngineModelIds(lane, engine));
  return LANE_ENGINE_DEFAULT_PREFERENCE[lane][engine].find((id) => enabled.has(id)) ?? null;
}

/** The engine's lane lineup with the lane default first: what a picker presents. */
export function mossLaneEngineLineup(
  lane: MossAccessLane,
  engine: MossEngineId,
): ReadonlyArray<string> {
  const models = mossLaneEngineModelIds(lane, engine);
  const preferred = mossLaneEngineDefaultModel(lane, engine);
  return preferred ? [preferred, ...models.filter((model) => model !== preferred)] : models;
}

const EFFORT_ORDINAL: Readonly<Record<MossReasoningEffort, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

export function isMossReasoningEffort(value: unknown): value is MossReasoningEffort {
  return typeof value === "string" && Object.hasOwn(EFFORT_ORDINAL, value);
}

/**
 * Snap a requested effort onto the model's ladder: exact match wins, then the
 * nearest rung. A tie prefers the model's own default (the vendor-tuned
 * quality point) and otherwise resolves downward so a request never gets more
 * expensive than asked. Returns `null` when the model has no reasoning control.
 */
export function normalizeMossReasoningEffort(
  id: string,
  requested: unknown,
): MossReasoningEffort | null {
  const reasoning = getMossManagedModelDefinition(id)?.reasoning ?? null;
  if (!reasoning) return null;
  if (!isMossReasoningEffort(requested)) return reasoning.default;
  if (reasoning.levels.includes(requested)) return requested;
  const target = EFFORT_ORDINAL[requested];
  let best: MossReasoningEffort = reasoning.default;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of reasoning.levels) {
    const distance = Math.abs(EFFORT_ORDINAL[level] - target);
    if (
      distance < bestDistance ||
      (distance === bestDistance &&
        level !== best &&
        (level === reasoning.default ||
          (best !== reasoning.default && EFFORT_ORDINAL[level] < EFFORT_ORDINAL[best])))
    ) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

const REASONING_LEVEL_DESCRIPTION: Readonly<Record<MossReasoningEffort, string>> = {
  none: "No extended thinking",
  minimal: "Fastest responses with minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
};

/**
 * Compact well before the window fills: long prompts on 1M-token models are
 * slow and expensive, and every upstream here is stateless.
 */
export function mossAutoCompactTokenLimit(
  contextWindow: number,
  maxOutputTokens = 128_000,
): number {
  // OpenRouter validates prompt + completion against the provider context.
  // Reserve the advertised completion budget plus a small framing margin so
  // compaction happens before a request can cross that boundary.
  const framingMargin = Math.max(8_192, Math.floor(contextWindow * 0.01));
  const outputReservation = Math.min(maxOutputTokens, Math.max(0, contextWindow - framingMargin));
  const safeInputBudget = Math.max(1, contextWindow - framingMargin - outputReservation);
  return Math.min(Math.floor(contextWindow * 0.65), safeInputBudget, 680_000);
}

/**
 * Codex `models.json` entry for a Moss model. Codex reads the ladder, context
 * window and compaction threshold from here, so every engine-visible model
 * gets a healthy default without per-user configuration.
 */
export function buildMossCodexModelCatalogEntry(
  definition: MossManagedModelDefinition,
  priority: number,
): Record<string, unknown> {
  const reasoning = definition.reasoning;
  return {
    slug: definition.id,
    display_name: definition.displayName,
    description: `${definition.displayName} via Moss`,
    default_reasoning_level: reasoning?.default ?? "none",
    supported_reasoning_levels: (reasoning?.levels ?? ["none"]).map((effort) => ({
      effort,
      description: REASONING_LEVEL_DESCRIPTION[effort],
    })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    base_instructions: "",
    supports_reasoning_summaries: reasoning !== null,
    default_reasoning_summary: "none",
    support_verbosity: definition.family === "openai",
    // Codex's file-edit path is freeform apply_patch. OpenRouter accepts the
    // native custom tool type; legacy relay compatibility still rewrites it.
    apply_patch_tool_type: "freeform",
    // Codex 0.151 fails to parse the whole catalog when this is absent, which
    // silently collapses the picker to the config.toml default model.
    experimental_supported_tools: [],
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: definition.supportsParallelToolCalls,
    input_modalities: [...definition.inputModalities],
    context_window: definition.contextWindow,
    max_context_window: definition.contextWindow,
    effective_context_window_percent: 95,
    auto_compact_token_limit: mossAutoCompactTokenLimit(
      definition.contextWindow,
      definition.maxOutputTokens,
    ),
    ...(definition.supportsFastMode ? { additional_speed_tiers: ["fast"] } : {}),
  };
}
