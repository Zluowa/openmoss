import type { ProviderInstanceConfigMap } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildKimiChannelInstance,
  isKimiChannelConfigured,
  KIMI_CHANNEL_BASE_URL,
  KIMI_CHANNEL_INSTANCE_ID,
  KIMI_CHANNEL_MODEL,
  normalizeKimiApiKey,
  removeKimiChannel,
  saveKimiChannel,
} from "./ccSwitchChannels";

describe("CC Switch Kimi channel", () => {
  it("materializes the audited Kimi Coding Plan preset as an isolated Claude instance", () => {
    const instance = buildKimiChannelInstance("  kimi-secret-token  ");

    expect(instance).toMatchObject({
      driver: "claudeAgent",
      displayName: "Kimi",
      enabled: true,
      config: {
        serviceChannelSource: "cc-switch",
        protocol: "anthropic-messages",
        defaultModel: KIMI_CHANNEL_MODEL,
        customModels: [KIMI_CHANNEL_MODEL],
        modelAllowlist: [KIMI_CHANNEL_MODEL],
      },
    });
    expect(instance.environment).toContainEqual({
      name: "ANTHROPIC_BASE_URL",
      value: KIMI_CHANNEL_BASE_URL,
      sensitive: false,
    });
    expect(instance.environment).toContainEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "kimi-secret-token",
      sensitive: true,
    });
    expect(isKimiChannelConfigured(instance)).toBe(true);
  });

  it("recognizes a server-redacted credential without exposing the secret", () => {
    const baseInstance = buildKimiChannelInstance("kimi-secret-token");
    const instance = {
      ...baseInstance,
      environment: (baseInstance.environment ?? []).map((entry) =>
        entry.name === "ANTHROPIC_AUTH_TOKEN"
          ? { name: entry.name, value: "", sensitive: true, valueRedacted: true }
          : entry,
      ),
    };

    expect(isKimiChannelConfigured(instance)).toBe(true);
  });

  it("fails closed when the reserved record is incomplete or redirected", () => {
    const baseInstance = buildKimiChannelInstance("kimi-secret-token");
    const instance = {
      ...baseInstance,
      environment: (baseInstance.environment ?? []).map((entry) =>
        entry.name === "ANTHROPIC_BASE_URL"
          ? { ...entry, value: "https://attacker.invalid" }
          : entry,
      ),
    };

    expect(isKimiChannelConfigured(instance)).toBe(false);
    expect(isKimiChannelConfigured({ driver: "claudeAgent", displayName: "Kimi" })).toBe(false);
  });

  it("rejects empty, short, and control-character credentials", () => {
    expect(() => normalizeKimiApiKey("short")).toThrow(/valid Kimi/u);
    expect(() => normalizeKimiApiKey("valid-key\nvalue")).toThrow(/valid Kimi/u);
  });

  it("adds and removes only the reserved channel instance", () => {
    const existing = {
      codex_work: { driver: "codex", displayName: "Work" },
    } as ProviderInstanceConfigMap;
    const saved = saveKimiChannel(existing, "kimi-secret-token");
    const removed = removeKimiChannel(saved);

    expect(saved[KIMI_CHANNEL_INSTANCE_ID]?.displayName).toBe("Kimi");
    expect(removed).toEqual(existing);
  });
});
