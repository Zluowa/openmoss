import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerProviderStatus } from "@synara/contracts";
import { Effect } from "effect";
import { vi } from "vitest";

import { projectProviderStatusesForSettings } from "../provider/Layers/ProviderHealth.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import {
  loadAgentGatewayProviderCatalog,
  projectAgentGatewayProviderInstance,
} from "./targetResolver.ts";

const now = Date.parse("2026-09-16T09:00:00.000Z");
describe.each(["pi", "grok", "hermes", "kimi", "minimax", "zcode"] as const)(
  "managed %s gateway startup",
  (provider) => {
    const model =
      provider === "hermes"
        ? "deepseek-v4-pro"
        : provider === "kimi"
          ? "kimi-k3"
          : provider === "minimax"
            ? "minimax-m3"
            : provider === "zcode"
              ? "glm-5.3"
              : "moss/deepseek-v4-pro";
    const instanceId = `${provider}_moss`;
    const config = { managed: true, modelAllowlist: [model], defaultModel: model };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        [provider]: { ...DEFAULT_SERVER_SETTINGS.providers[provider], enabled: true },
      },
      providerInstances: { [instanceId]: { driver: provider, enabled: true, config } },
    };
    function pendingStatus(): ServerProviderStatus {
      const status = projectProviderStatusesForSettings(
        [],
        settings,
        new Date(now).toISOString(),
      ).find((entry) => entry.instanceId === instanceId);
      assert.isDefined(status);
      return status!;
    }
    it.effect("discovers the configured catalog before its first health probe", () =>
      Effect.gen(function* () {
        const status = pendingStatus();
        assert.equal(status.available, false);
        assert.equal(status.authStatus, "unknown");
        const listModels = vi.fn(() => Effect.succeed({ models: [{ slug: model, name: model }] }));
        const availability = projectAgentGatewayProviderInstance({
          instanceId,
          provider,
          enabled: true,
          config,
          status,
          missingStatusMessage: "Awaiting health probe",
          nowMs: now,
        });
        const catalog = yield* loadAgentGatewayProviderCatalog({
          instanceId,
          provider,
          discovery: { listModels } as unknown as ProviderDiscoveryServiceShape,
          availability,
        });
        assert.equal(catalog.available, true);
        assert.deepEqual(
          catalog.models.map((entry) => entry.slug),
          [model],
        );
        assert.equal(listModels.mock.calls.length, 1);
      }),
    );

    it.effect("keeps unhealthy, disabled, stale, and nonmanaged instances blocked", () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<{
          instanceId?: string;
          enabled?: boolean;
          managed?: boolean;
          status?: Partial<ServerProviderStatus>;
        }> = [
          { enabled: false },
          { managed: false },
          { instanceId: `${provider}_moss_other` },
          { status: { status: "error" } },
          { status: { authStatus: "unauthenticated" } },
          { status: { availability: "unavailable" } },
          { status: { checkedAt: new Date(now - 6 * 60_000).toISOString() } },
        ];
        for (const entry of cases) {
          const candidateId = entry.instanceId ?? instanceId;
          const listModels = vi.fn(() =>
            Effect.succeed({ models: [{ slug: model, name: model }] }),
          );
          const availability = projectAgentGatewayProviderInstance({
            instanceId: candidateId,
            provider,
            enabled: entry.enabled ?? true,
            config: { ...config, managed: entry.managed ?? true },
            status: { ...pendingStatus(), ...entry.status, instanceId: candidateId },
            missingStatusMessage: "Awaiting health probe",
            nowMs: now,
          });
          const catalog = yield* loadAgentGatewayProviderCatalog({
            instanceId: candidateId,
            provider,
            discovery: { listModels } as unknown as ProviderDiscoveryServiceShape,
            availability,
          });
          assert.equal(catalog.available, false, JSON.stringify(entry));
          assert.equal(listModels.mock.calls.length, 0, JSON.stringify(entry));
        }
      }),
    );
  },
);
