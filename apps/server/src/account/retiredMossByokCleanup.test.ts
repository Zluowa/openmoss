import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildRetiredMossByokCleanupPatch } from "./retiredMossByokCleanup";

function settingsWithRetiredKey(): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        accounts: [
          ...DEFAULT_SERVER_SETTINGS.providers.codex.accounts,
          { id: "byok", label: "Moss Key", homePath: "/state/byok", shadowHomePath: "" },
        ],
        selectedAccountId: "byok",
      },
    },
    providerInstances: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances,
      codex_byok: {
        driver: "codex",
        displayName: "Moss Key",
        enabled: true,
        environment: [{ name: "MOSS_BYOK_API_KEY", value: "sk-retired", sensitive: true }],
        config: { byok: true, mossByok: true },
      },
    },
    textGenerationModelSelection: {
      provider: "codex",
      instanceId: "codex_byok",
      model: "openai/gpt-5.6-luna",
    },
  } as ServerSettings;
}

describe("buildRetiredMossByokCleanupPatch", () => {
  it("removes the retired instance, its account, and every selection that pointed at it", () => {
    const patch = buildRetiredMossByokCleanupPatch(settingsWithRetiredKey());

    expect(patch?.providerInstances).not.toHaveProperty("codex_byok");
    expect(patch?.providers?.codex?.accounts?.some((account) => account.id === "byok")).toBe(false);
    expect(patch?.providers?.codex?.selectedAccountId).toBe("default");
    expect(patch?.textGenerationModelSelection).toMatchObject({ instanceId: "codex" });
    expect(JSON.stringify(patch)).not.toContain("sk-retired");
  });

  it("leaves settings without the retired surface untouched", () => {
    expect(buildRetiredMossByokCleanupPatch(DEFAULT_SERVER_SETTINGS)).toBeNull();
  });
});
