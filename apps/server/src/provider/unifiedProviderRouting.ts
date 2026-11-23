/**
 * Unified model provider persistence, connection testing, secret handling,
 * and CLI environment routing helpers.
 */
import { Effect } from "effect";
import type {
  ServerDeleteUnifiedProviderResult,
  ServerSaveUnifiedProviderInput,
  ServerSettings,
  ServerTestUnifiedProviderInput,
  ServerTestUnifiedProviderResult,
  UnifiedModelProviderConfig,
} from "@moss/contracts";
import type { ResolvedProviderInstance } from "@moss/shared/providerInstances";
import { isMossManagedRelayInstanceId } from "../account/managedRelayProviders";
import type { SecretStoreError, ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";
import type { ServerSettingsShape } from "../serverSettings";

export const UNIFIED_PROVIDER_SECRET_PREFIX = "unified-provider:";
const TEST_UNIFIED_PROVIDER_TIMEOUT_MS = 8_000;
const MAX_DISCOVERED_MODELS = 100;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function unifiedProviderApiKeySecretName(id: string): string {
  return `${UNIFIED_PROVIDER_SECRET_PREFIX}${id.trim()}:apiKey`;
}

export function isMossManagedProviderInstance(
  instance: Pick<ResolvedProviderInstance, "instanceId" | "config">,
): boolean {
  return (
    instance.config.managed === true ||
    instance.instanceId.endsWith("_moss") ||
    isMossManagedRelayInstanceId(instance.instanceId)
  );
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function validateUnifiedProviderBaseUrl(
  rawUrl: string,
):
  | { readonly ok: true; readonly url: URL; readonly normalizedBaseUrl: string }
  | { readonly ok: false; readonly error: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: "Base URL is required." };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Base URL must be a valid URL." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Base URL must not embed credentials." };
  }
  const isHttps = parsed.protocol === "https:";
  const isLoopbackHttp =
    parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (!isHttps && !isLoopbackHttp) {
    return {
      ok: false,
      error: "Only https:// URLs or loopback http://localhost / http://127.0.0.1 URLs are allowed.",
    };
  }
  const normalizedBaseUrl = trimmed.replace(/\/+$/, "");
  return { ok: true, url: parsed, normalizedBaseUrl };
}

function normalizeProviderSourceSelection(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "moss";
  if (trimmed.startsWith("unified:")) {
    return trimmed.slice("unified:".length).trim() || "moss";
  }
  return trimmed;
}

export function resolveEffectiveCliSource(
  settings: Pick<ServerSettings, "defaultUnifiedProviderId" | "unifiedProviderByCli">,
  driver: string,
): string {
  const direct = settings.unifiedProviderByCli?.[driver]?.trim();
  if (direct) {
    return normalizeProviderSourceSelection(direct);
  }
  return normalizeProviderSourceSelection(settings.defaultUnifiedProviderId);
}

export function resolveUnifiedProviderForCli(
  settings: Pick<
    ServerSettings,
    "unifiedProviders" | "defaultUnifiedProviderId" | "unifiedProviderByCli"
  >,
  driver: string,
): UnifiedModelProviderConfig | null {
  const source = resolveEffectiveCliSource(settings, driver);
  if (source === "moss" || source === "personal") {
    return null;
  }
  return (
    settings.unifiedProviders.find((provider) => provider.id === source && provider.enabled) ?? null
  );
}

const VENDOR_ENV_KEYS_BY_HINT: ReadonlyArray<readonly [RegExp, ReadonlyArray<string>]> = [
  [/deepseek/i, ["DEEPSEEK_API_KEY"]],
  [/moonshot|kimi/i, ["MOONSHOT_API_KEY"]],
  [/openrouter/i, ["OPENROUTER_API_KEY"]],
  [/\bxai\b|grok/i, ["XAI_API_KEY"]],
  [/minimax/i, ["MINIMAX_API_KEY"]],
  [/zhipu|bigmodel|\bzai\b|zcode/i, ["ZAI_API_KEY"]],
  [/qwen|dashscope|aliyun|alibaba/i, ["DASHSCOPE_API_KEY"]],
  [/siliconflow/i, ["SILICONFLOW_API_KEY"]],
  [/\bgroq\b/i, ["GROQ_API_KEY"]],
  [/together/i, ["TOGETHER_API_KEY"]],
  [/fireworks/i, ["FIREWORKS_API_KEY"]],
  [/mistral/i, ["MISTRAL_API_KEY"]],
  [/perplexity/i, ["PERPLEXITY_API_KEY"]],
  [/volcengine|bytedance|ark\.cn-beijing|doubao/i, ["ARK_API_KEY"]],
  [/baidu|qianfan/i, ["QIANFAN_API_KEY"]],
  [/tencent|hunyuan/i, ["HUNYUAN_API_KEY"]],
  [/stepfun/i, ["STEPFUN_API_KEY"]],
  [/xiaomi/i, ["XIAOMI_API_KEY"]],
  [/huggingface|hf\.co/i, ["HF_TOKEN"]],
];

export function buildUnifiedProviderEnvOverlay(input: {
  readonly driver: string;
  readonly provider: UnifiedModelProviderConfig;
  readonly apiKey?: string | null | undefined;
}): Record<string, string> {
  const { provider } = input;
  const baseUrl = provider.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = input.apiKey?.trim() || "";
  const overlay: Record<string, string> = {};

  if (provider.protocol === "openai-compatible") {
    overlay.OPENAI_BASE_URL = baseUrl;
    overlay.OPENAI_API_BASE = baseUrl;
    if (apiKey) {
      overlay.OPENAI_API_KEY = apiKey;
    }
  } else if (provider.protocol === "anthropic-compatible") {
    overlay.ANTHROPIC_BASE_URL = baseUrl;
    if (apiKey) {
      overlay.ANTHROPIC_API_KEY = apiKey;
    }
  } else if (provider.protocol === "gemini-compatible") {
    overlay.GOOGLE_GEMINI_BASE_URL = baseUrl;
    if (apiKey) {
      overlay.GEMINI_API_KEY = apiKey;
    }
  }

  if (apiKey) {
    const hints = `${provider.presetId} ${provider.iconId} ${baseUrl}`;
    for (const [pattern, envKeys] of VENDOR_ENV_KEYS_BY_HINT) {
      if (pattern.test(hints)) {
        for (const envKey of envKeys) {
          overlay[envKey] = apiKey;
        }
      }
    }
  }

  return overlay;
}

export const readUnifiedProviderApiKeyEffect = (
  secretStore: Pick<ServerSecretStoreShape, "get">,
  providerId: string,
): Effect.Effect<string | null> =>
  secretStore.get(unifiedProviderApiKeySecretName(providerId)).pipe(
    Effect.map((bytes) => {
      if (!bytes || bytes.byteLength === 0) return null;
      const decoded = textDecoder.decode(bytes).trim();
      return decoded.length > 0 ? decoded : null;
    }),
    Effect.catch(() => Effect.succeed(null)),
  );

export const writeUnifiedProviderApiKeyEffect = (
  secretStore: Pick<ServerSecretStoreShape, "set">,
  providerId: string,
  apiKey: string,
): Effect.Effect<void, SecretStoreError> =>
  secretStore.set(unifiedProviderApiKeySecretName(providerId), textEncoder.encode(apiKey.trim()));

export const deleteUnifiedProviderApiKeyEffect = (
  secretStore: Pick<ServerSecretStoreShape, "remove">,
  providerId: string,
): Effect.Effect<void> =>
  secretStore.remove(unifiedProviderApiKeySecretName(providerId)).pipe(Effect.ignore);

export const resolveUnifiedProviderEnvOverlayEffect = (
  settings: Pick<
    ServerSettings,
    "unifiedProviders" | "defaultUnifiedProviderId" | "unifiedProviderByCli"
  >,
  secretStore: Pick<ServerSecretStoreShape, "get">,
  driver: string,
): Effect.Effect<Record<string, string> | undefined> =>
  Effect.gen(function* () {
    const provider = resolveUnifiedProviderForCli(settings, driver);
    if (!provider) {
      return undefined;
    }
    const apiKey = yield* readUnifiedProviderApiKeyEffect(secretStore, provider.id);
    const overlay = buildUnifiedProviderEnvOverlay({ driver, provider, apiKey });
    return Object.keys(overlay).length > 0 ? overlay : undefined;
  });

export const saveUnifiedProviderEffect = (input: {
  readonly serverSettings: Pick<ServerSettingsShape, "updateSettings">;
  readonly secretStore: Pick<ServerSecretStoreShape, "get" | "set">;
  readonly payload: ServerSaveUnifiedProviderInput;
}): Effect.Effect<UnifiedModelProviderConfig, Error | SecretStoreError | unknown> =>
  Effect.gen(function* () {
    const urlCheck = validateUnifiedProviderBaseUrl(input.payload.provider.baseUrl);
    if (!urlCheck.ok) {
      return yield* Effect.fail(new Error(urlCheck.error));
    }

    const trimmedKey = input.payload.apiKey?.trim();
    if (trimmedKey && trimmedKey.length > 0) {
      yield* writeUnifiedProviderApiKeyEffect(
        input.secretStore,
        input.payload.provider.id,
        trimmedKey,
      );
    }

    const existingSecret =
      trimmedKey && trimmedKey.length > 0
        ? trimmedKey
        : yield* readUnifiedProviderApiKeyEffect(input.secretStore, input.payload.provider.id);

    const normalizedModels: string[] = [];
    const seenModels = new Set<string>();
    for (const model of input.payload.provider.models) {
      const trimmedModel = model.trim();
      if (trimmedModel.length > 0 && !seenModels.has(trimmedModel)) {
        seenModels.add(trimmedModel);
        normalizedModels.push(trimmedModel);
      }
    }

    const savedProvider: UnifiedModelProviderConfig = {
      id: input.payload.provider.id.trim(),
      presetId: input.payload.provider.presetId.trim(),
      name: input.payload.provider.name.trim(),
      iconId: input.payload.provider.iconId.trim(),
      protocol: input.payload.provider.protocol,
      baseUrl: urlCheck.normalizedBaseUrl,
      models: normalizedModels,
      enabled: input.payload.provider.enabled,
      apiKeyConfigured: existingSecret !== null,
      updatedAt: new Date().toISOString(),
    };

    yield* input.serverSettings.updateSettings({}, (current) => {
      const idx = current.unifiedProviders.findIndex((item) => item.id === savedProvider.id);
      const nextProviders =
        idx >= 0
          ? current.unifiedProviders.map((item, i) => (i === idx ? savedProvider : item))
          : [...current.unifiedProviders, savedProvider];
      return { unifiedProviders: nextProviders };
    });

    return savedProvider;
  });

export const deleteUnifiedProviderEffect = (input: {
  readonly serverSettings: Pick<ServerSettingsShape, "updateSettings">;
  readonly secretStore: Pick<ServerSecretStoreShape, "remove">;
  readonly id: string;
}): Effect.Effect<ServerDeleteUnifiedProviderResult, unknown> =>
  Effect.gen(function* () {
    const id = input.id.trim();
    yield* deleteUnifiedProviderApiKeyEffect(input.secretStore, id);
    let deleted = false;
    yield* input.serverSettings.updateSettings({}, (current) => {
      const nextProviders = current.unifiedProviders.filter((item) => item.id !== id);
      deleted = nextProviders.length !== current.unifiedProviders.length;
      const nextDefaultId = current.defaultUnifiedProviderId === id ? null : undefined;
      const nextByCli: Record<string, string> = {};
      let cliMapChanged = false;
      for (const [driver, value] of Object.entries(current.unifiedProviderByCli)) {
        if (normalizeProviderSourceSelection(value) === id) {
          cliMapChanged = true;
          continue;
        }
        nextByCli[driver] = value;
      }
      return {
        unifiedProviders: nextProviders,
        ...(nextDefaultId !== undefined ? { defaultUnifiedProviderId: nextDefaultId } : {}),
        ...(cliMapChanged ? { unifiedProviderByCli: nextByCli } : {}),
      };
    });
    return { deleted };
  });

function extractDiscoveredModels(payload: unknown): ReadonlyArray<string> {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const obj = payload as { data?: unknown; models?: unknown };
  const results: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const normalized = raw.trim().replace(/^models\//, "");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    results.push(normalized);
  };

  if (Array.isArray(obj.data)) {
    for (const item of obj.data) {
      if (item && typeof item === "object" && "id" in item) {
        add((item as { id?: unknown }).id);
      }
      if (results.length >= MAX_DISCOVERED_MODELS) break;
    }
  }
  if (Array.isArray(obj.models)) {
    for (const item of obj.models) {
      if (typeof item === "string") {
        add(item);
      } else if (item && typeof item === "object") {
        const record = item as { id?: unknown; name?: unknown };
        add(record.id ?? record.name);
      }
      if (results.length >= MAX_DISCOVERED_MODELS) break;
    }
  }
  return results;
}

function buildProbeRequest(input: {
  readonly protocol: ServerTestUnifiedProviderInput["protocol"];
  readonly normalizedBaseUrl: string;
  readonly parsedUrl: URL;
  readonly apiKey: string | null;
}): { readonly targetUrl: string; readonly headers: Record<string, string> } {
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.protocol === "anthropic-compatible") {
    const targetUrl = input.normalizedBaseUrl.endsWith("/v1")
      ? `${input.normalizedBaseUrl}/models`
      : `${input.normalizedBaseUrl}/v1/models`;
    headers["anthropic-version"] = "2023-06-01";
    if (input.apiKey) {
      headers["x-api-key"] = input.apiKey;
      headers.authorization = `Bearer ${input.apiKey}`;
    }
    return { targetUrl, headers };
  }
  if (input.protocol === "gemini-compatible") {
    const cleanPath = input.parsedUrl.pathname.replace(/\/+$/, "");
    const targetUrl =
      cleanPath === ""
        ? `${input.normalizedBaseUrl}/v1beta/models`
        : `${input.normalizedBaseUrl}/models`;
    if (input.apiKey) {
      headers["x-goog-api-key"] = input.apiKey;
    }
    return { targetUrl, headers };
  }
  if (input.apiKey) {
    headers.authorization = `Bearer ${input.apiKey}`;
  }
  return {
    targetUrl: `${input.normalizedBaseUrl}/models`,
    headers,
  };
}

export const testUnifiedProviderEffect = (input: {
  readonly secretStore: Pick<ServerSecretStoreShape, "get">;
  readonly payload: ServerTestUnifiedProviderInput;
  readonly fetchImpl?: typeof fetch;
}): Effect.Effect<ServerTestUnifiedProviderResult, never> =>
  Effect.gen(function* () {
    const urlCheck = validateUnifiedProviderBaseUrl(input.payload.baseUrl);
    if (!urlCheck.ok) {
      return { ok: false, error: urlCheck.error };
    }

    const explicitKey = input.payload.apiKey?.trim();
    const resolvedKey =
      explicitKey && explicitKey.length > 0
        ? explicitKey
        : input.payload.id
          ? yield* readUnifiedProviderApiKeyEffect(input.secretStore, input.payload.id)
          : null;

    const { targetUrl, headers } = buildProbeRequest({
      protocol: input.payload.protocol,
      normalizedBaseUrl: urlCheck.normalizedBaseUrl,
      parsedUrl: urlCheck.url,
      apiKey: resolvedKey,
    });

    const fetchFn = input.fetchImpl ?? globalThis.fetch;
    const startedAt = Date.now();
    return yield* Effect.tryPromise(async () => {
      const response = await fetchFn(targetUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(TEST_UNIFIED_PROVIDER_TIMEOUT_MS),
      });
      const latencyMs = Math.max(0, Math.round(Date.now() - startedAt));
      if (!response.ok) {
        let detail = "";
        try {
          const text = (await response.text()).replace(/\s+/g, " ").trim();
          if (text) {
            detail = text.slice(0, 180);
          }
        } catch {
          // Ignore unreadable error response body.
        }
        return {
          ok: false,
          latencyMs,
          error: detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`,
        } satisfies ServerTestUnifiedProviderResult;
      }
      let discoveredModels: ReadonlyArray<string> = [];
      try {
        const json = await response.json();
        discoveredModels = extractDiscoveredModels(json);
      } catch {
        // Endpoints that return 200 without JSON models list still pass reachability.
      }
      return {
        ok: true,
        latencyMs,
        discoveredModels,
      } satisfies ServerTestUnifiedProviderResult;
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false,
          latencyMs: Math.max(0, Math.round(Date.now() - startedAt)),
          error: cause instanceof Error ? cause.message : String(cause),
        } satisfies ServerTestUnifiedProviderResult),
      ),
    );
  });
