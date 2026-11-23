import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Effect } from "effect";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@moss/contracts";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";
import type { ServerSettingsShape } from "../serverSettings";
import { applyServerSettingsPatch } from "@moss/shared/serverSettings";
import {
  buildUnifiedProviderEnvOverlay,
  deleteUnifiedProviderEffect,
  isMossManagedProviderInstance,
  resolveEffectiveCliSource,
  resolveUnifiedProviderEnvOverlayEffect,
  resolveUnifiedProviderForCli,
  saveUnifiedProviderEffect,
  testUnifiedProviderEffect,
  unifiedProviderApiKeySecretName,
  validateUnifiedProviderBaseUrl,
} from "./unifiedProviderRouting";

function makeInMemorySecretStore(): {
  readonly store: ServerSecretStoreShape;
  readonly map: Map<string, Uint8Array>;
} {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    store: {
      get: (name) => Effect.succeed(map.get(name) ?? null),
      set: (name, value) =>
        Effect.sync(() => {
          map.set(name, value);
        }),
      remove: (name) =>
        Effect.sync(() => {
          map.delete(name);
        }),
      getOrCreateRandom: () => Effect.die("unused"),
    },
  };
}

function makeInMemorySettingsService(initial: ServerSettings = DEFAULT_SERVER_SETTINGS): {
  readonly service: Pick<ServerSettingsShape, "updateSettings">;
  getCurrent: () => ServerSettings;
} {
  let current = initial;
  return {
    getCurrent: () => current,
    service: {
      updateSettings: (patch, derivePatch) =>
        Effect.sync(() => {
          const derived = derivePatch ? derivePatch(current) : patch;
          current = applyServerSettingsPatch(current, derived);
          return current;
        }),
    },
  };
}

describe("unifiedProviderRouting", () => {
  it("validates base URLs allowing https and loopback http only", () => {
    assert.strictEqual(validateUnifiedProviderBaseUrl("https://api.deepseek.com/v1/").ok, true);
    const stripped = validateUnifiedProviderBaseUrl("https://api.deepseek.com/v1/");
    assert.strictEqual(stripped.ok, true);
    if (stripped.ok) {
      assert.strictEqual(stripped.normalizedBaseUrl, "https://api.deepseek.com/v1");
    }

    assert.strictEqual(validateUnifiedProviderBaseUrl("http://localhost:11434/v1").ok, true);
    assert.strictEqual(validateUnifiedProviderBaseUrl("http://127.0.0.1:1234/v1").ok, true);
    assert.strictEqual(validateUnifiedProviderBaseUrl("http://[::1]:8080/v1").ok, true);

    assert.strictEqual(validateUnifiedProviderBaseUrl("http://example.com/v1").ok, false);
    assert.strictEqual(validateUnifiedProviderBaseUrl("file:///etc/passwd").ok, false);
    assert.strictEqual(
      validateUnifiedProviderBaseUrl("https://user:pass@api.example.com").ok,
      false,
    );
    assert.strictEqual(validateUnifiedProviderBaseUrl("not-a-url").ok, false);
  });

  it("resolves effective CLI source with per-CLI overrides and default fallback", () => {
    const providerA = {
      id: "deepseek-main",
      presetId: "deepseek",
      name: "DeepSeek",
      iconId: "deepseek",
      protocol: "openai-compatible" as const,
      baseUrl: "https://api.deepseek.com/v1",
      models: ["deepseek-chat"],
      enabled: true,
      apiKeyConfigured: true,
    };
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      unifiedProviders: [providerA],
      defaultUnifiedProviderId: "deepseek-main",
      unifiedProviderByCli: {
        claudeAgent: "personal",
        opencode: "moss",
      },
    };

    assert.strictEqual(resolveEffectiveCliSource(settings, "codex"), "deepseek-main");
    assert.strictEqual(resolveEffectiveCliSource(settings, "claudeAgent"), "personal");
    assert.strictEqual(resolveEffectiveCliSource(settings, "opencode"), "moss");
    assert.strictEqual(resolveUnifiedProviderForCli(settings, "codex")?.id, "deepseek-main");
    assert.strictEqual(resolveUnifiedProviderForCli(settings, "claudeAgent"), null);
    assert.strictEqual(resolveUnifiedProviderForCli(settings, "opencode"), null);
  });

  it("builds standard protocol and vendor env overlays without mutating *_moss instances", () => {
    const deepseekOverlay = buildUnifiedProviderEnvOverlay({
      driver: "codex",
      provider: {
        id: "ds",
        presetId: "deepseek",
        name: "DeepSeek",
        iconId: "deepseek",
        protocol: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1/",
        models: [],
        enabled: true,
        apiKeyConfigured: true,
      },
      apiKey: "sk-ds-secret",
    });
    assert.deepStrictEqual(deepseekOverlay, {
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
      OPENAI_API_BASE: "https://api.deepseek.com/v1",
      OPENAI_API_KEY: "sk-ds-secret",
      DEEPSEEK_API_KEY: "sk-ds-secret",
    });

    const anthropicOverlay = buildUnifiedProviderEnvOverlay({
      driver: "claudeAgent",
      provider: {
        id: "zhipu-cn",
        presetId: "zhipu",
        name: "Zhipu",
        iconId: "zhipu",
        protocol: "anthropic-compatible",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        models: [],
        enabled: true,
        apiKeyConfigured: true,
      },
      apiKey: "zhipu-key",
    });
    assert.deepStrictEqual(anthropicOverlay, {
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_API_KEY: "zhipu-key",
      ZAI_API_KEY: "zhipu-key",
    });

    const geminiOverlay = buildUnifiedProviderEnvOverlay({
      driver: "opencode",
      provider: {
        id: "gemini-direct",
        presetId: "gemini",
        name: "Gemini",
        iconId: "gemini",
        protocol: "gemini-compatible",
        baseUrl: "https://generativelanguage.googleapis.com",
        models: [],
        enabled: true,
        apiKeyConfigured: true,
      },
      apiKey: "AIza-secret",
    });
    assert.deepStrictEqual(geminiOverlay, {
      GOOGLE_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com",
      GEMINI_API_KEY: "AIza-secret",
    });

    assert.strictEqual(
      isMossManagedProviderInstance({ instanceId: "codex_moss", config: {} }),
      true,
    );
    assert.strictEqual(
      isMossManagedProviderInstance({ instanceId: "codex", config: { managed: true } }),
      true,
    );
    assert.strictEqual(isMossManagedProviderInstance({ instanceId: "codex", config: {} }), false);
  });

  it("persists secrets in ServerSecretStore without returning keys and cleans up on delete", async () => {
    const { store, map } = makeInMemorySecretStore();
    const { service, getCurrent } = makeInMemorySettingsService({
      ...DEFAULT_SERVER_SETTINGS,
      defaultUnifiedProviderId: "ds-1",
      unifiedProviderByCli: { codex: "ds-1", claudeAgent: "personal" },
    });

    const saved = await Effect.runPromise(
      saveUnifiedProviderEffect({
        serverSettings: service,
        secretStore: store,
        payload: {
          provider: {
            id: "ds-1",
            presetId: "deepseek",
            name: "DeepSeek",
            iconId: "deepseek",
            protocol: "openai-compatible",
            baseUrl: "https://api.deepseek.com/v1/",
            models: ["deepseek-chat", "deepseek-chat", "deepseek-reasoner"],
            enabled: true,
          },
          apiKey: "sk-real-key",
        },
      }),
    );

    assert.strictEqual(saved.apiKeyConfigured, true);
    assert.strictEqual("apiKey" in saved, false);
    assert.deepStrictEqual(saved.models, ["deepseek-chat", "deepseek-reasoner"]);
    assert.strictEqual(
      new TextDecoder().decode(map.get(unifiedProviderApiKeySecretName("ds-1"))),
      "sk-real-key",
    );

    // Omitting apiKey during metadata update keeps the existing stored key intact.
    const updated = await Effect.runPromise(
      saveUnifiedProviderEffect({
        serverSettings: service,
        secretStore: store,
        payload: {
          provider: {
            id: "ds-1",
            presetId: "deepseek",
            name: "DeepSeek Main",
            iconId: "deepseek",
            protocol: "openai-compatible",
            baseUrl: "https://api.deepseek.com/v1",
            models: ["deepseek-chat"],
            enabled: true,
          },
        },
      }),
    );
    assert.strictEqual(updated.apiKeyConfigured, true);
    assert.strictEqual(updated.name, "DeepSeek Main");

    const envOverlay = await Effect.runPromise(
      resolveUnifiedProviderEnvOverlayEffect(getCurrent(), store, "codex"),
    );
    assert.deepStrictEqual(envOverlay?.OPENAI_API_KEY, "sk-real-key");

    const deleted = await Effect.runPromise(
      deleteUnifiedProviderEffect({
        serverSettings: service,
        secretStore: store,
        id: "ds-1",
      }),
    );
    assert.strictEqual(deleted.deleted, true);
    assert.strictEqual(map.has(unifiedProviderApiKeySecretName("ds-1")), false);
    assert.strictEqual(getCurrent().unifiedProviders.length, 0);
    assert.strictEqual(getCurrent().defaultUnifiedProviderId, null);
    assert.deepStrictEqual(getCurrent().unifiedProviderByCli, { claudeAgent: "personal" });
  });

  it("tests unified provider connections using stored secrets and returns discovered models", async () => {
    const { store, map } = makeInMemorySecretStore();
    map.set(unifiedProviderApiKeySecretName("or-1"), new TextEncoder().encode("sk-or-stored"));
    const seenHeaders: Array<Record<string, string>> = [];
    const seenUrls: string[] = [];

    const okResult = await Effect.runPromise(
      testUnifiedProviderEffect({
        secretStore: store,
        payload: {
          id: "or-1",
          protocol: "openai-compatible",
          baseUrl: "https://openrouter.ai/api/v1/",
        },
        fetchImpl: (async (url, init) => {
          seenUrls.push(String(url));
          if (init?.headers) seenHeaders.push(init.headers as Record<string, string>);
          return Response.json({
            data: [{ id: "anthropic/claude-sonnet-4" }, { id: "openai/gpt-5" }],
          });
        }) as typeof fetch,
      }),
    );

    assert.strictEqual(okResult.ok, true);
    assert.deepStrictEqual(seenUrls, ["https://openrouter.ai/api/v1/models"]);
    assert.deepStrictEqual(
      (seenHeaders[0] as Record<string, string>).authorization,
      "Bearer sk-or-stored",
    );
    assert.deepStrictEqual(okResult.discoveredModels, [
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
    ]);

    const rejected = await Effect.runPromise(
      testUnifiedProviderEffect({
        secretStore: store,
        payload: {
          protocol: "openai-compatible",
          baseUrl: "http://remote-insecure.example.com/v1",
        },
      }),
    );
    assert.strictEqual(rejected.ok, false);
    assert.ok(rejected.error?.includes("https://"));
  });
});
