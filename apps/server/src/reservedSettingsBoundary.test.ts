import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  MOSS_MANAGED_SELECTION_FALLBACK_CONFIG_KEY,
  protectReservedSettingsPatch,
} from "./reservedSettingsBoundary";

const currentSettings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    codex: {
      ...DEFAULT_SERVER_SETTINGS.providers.codex,
      accounts: [
        {
          id: "personal",
          label: "Personal",
          homePath: "/home/personal",
          shadowHomePath: "",
        },
        {
          id: "moss",
          label: "Moss managed",
          homePath: "/home/moss",
          shadowHomePath: "/shadow/moss",
        },
        {
          id: "byok",
          label: "Moss BYOK",
          homePath: "/home/byok",
          shadowHomePath: "/shadow/byok",
        },
      ],
      selectedAccountId: "moss",
    },
  },
  providerInstances: {
    ordinary: {
      driver: "codex",
      displayName: "Ordinary",
      config: { homePath: "/home/ordinary" },
    },
    codex_moss: {
      driver: "codex",
      displayName: "Moss managed",
      config: { managed: true, serverOwned: "keep" },
    },
    codex_byok: {
      driver: "codex",
      displayName: "Moss BYOK",
      config: { byok: true, serverOwned: "keep" },
    },
    opencode_moss: {
      driver: "opencode",
      displayName: "Moss DeepSeek & Kimi",
      config: { managed: true, serverOwned: "keep" },
    },
    managed_alias: {
      driver: "codex",
      displayName: "Managed alias",
      config: { managed: true, serverOwned: "keep" },
    },
    byok_alias: {
      driver: "codex",
      displayName: "BYOK alias",
      config: { byok: true, serverOwned: "keep" },
    },
    legacy_byok_alias: {
      driver: "codex",
      displayName: "Legacy BYOK alias",
      config: { mossByok: true, serverOwned: "keep" },
    },
  },
};

describe("protectReservedSettingsPatch", () => {
  it.each(["grok", "hermes", "kimi", "minimax", "zcode"] as const)(
    "protects the reserved %s identity while allowing its global opt-in setting",
    (driver) => {
      const instanceId = `${driver}_moss`;
      const instance = { driver, enabled: true, config: { managed: true } };
      const settings = { ...currentSettings, providerInstances: { [instanceId]: instance } };
      const result = protectReservedSettingsPatch(settings, {
        providers: { [driver]: { enabled: true } },
        providerInstances: { [instanceId]: { driver, config: { managed: false } } },
      });
      expect(result.providerInstances).toEqual({ [instanceId]: instance });
      expect(result.providers?.[driver]?.enabled).toBe(true);
      expect(
        protectReservedSettingsPatch(
          { ...settings, providerInstances: {} },
          {
            providerInstances: { [instanceId]: { driver } },
          },
        ).providerInstances,
      ).toEqual({});
    },
  );

  it("restores reserved accounts while preserving ordinary edits and account selection", () => {
    const patch: ServerSettingsPatch = {
      providers: {
        codex: {
          accounts: [
            {
              id: "personal",
              label: "Renamed",
              homePath: "/home/renamed",
              shadowHomePath: "",
            },
            {
              id: "moss",
              label: "Client overwrite",
              homePath: "/tmp/overwrite",
              shadowHomePath: "",
            },
          ],
          selectedAccountId: "byok",
        },
      },
    };

    expect(protectReservedSettingsPatch(currentSettings, patch)).toEqual({
      providers: {
        codex: {
          accounts: [
            {
              id: "personal",
              label: "Renamed",
              homePath: "/home/renamed",
              shadowHomePath: "",
            },
            currentSettings.providers.codex.accounts[1],
            currentSettings.providers.codex.accounts[2],
          ],
          selectedAccountId: "byok",
        },
      },
    });
  });

  it("prevents client creation of reserved accounts that do not exist on the server", () => {
    const settingsWithoutByok: ServerSettings = {
      ...currentSettings,
      providers: {
        ...currentSettings.providers,
        codex: {
          ...currentSettings.providers.codex,
          accounts: currentSettings.providers.codex.accounts.filter(
            (account) => account.id !== "byok",
          ),
        },
      },
    };

    const result = protectReservedSettingsPatch(settingsWithoutByok, {
      providers: {
        codex: {
          accounts: [
            {
              id: "byok",
              label: "Client-created BYOK",
              homePath: "/tmp/byok",
              shadowHomePath: "",
            },
          ],
        },
      },
    });

    expect(result.providers?.codex?.accounts).toEqual([
      settingsWithoutByok.providers.codex.accounts.find((account) => account.id === "moss"),
    ]);
  });

  it("restores reserved instances while preserving ordinary instance edits", () => {
    const result = protectReservedSettingsPatch(currentSettings, {
      providerInstances: {
        ordinary: {
          driver: "codex",
          displayName: "Renamed ordinary",
          config: { homePath: "/home/renamed" },
        },
        codex_moss: {
          driver: "codex",
          displayName: "Client overwrite",
          config: { managed: false },
        },
        managed_alias: {
          driver: "codex",
          displayName: "Unflagged overwrite",
          config: { managed: false },
        },
      },
    });

    expect(result.providerInstances).toEqual({
      ordinary: {
        driver: "codex",
        displayName: "Renamed ordinary",
        config: { homePath: "/home/renamed" },
      },
      codex_moss: currentSettings.providerInstances.codex_moss,
      codex_byok: currentSettings.providerInstances.codex_byok,
      opencode_moss: currentSettings.providerInstances.opencode_moss,
      managed_alias: currentSettings.providerInstances.managed_alias,
      byok_alias: currentSettings.providerInstances.byok_alias,
      legacy_byok_alias: currentSettings.providerInstances.legacy_byok_alias,
    });
  });

  it("prevents client creation of reserved or marker-protected instances", () => {
    const providerInstances = {
      ordinary: currentSettings.providerInstances.ordinary!,
      codex_moss: currentSettings.providerInstances.codex_moss!,
      opencode_moss: currentSettings.providerInstances.opencode_moss!,
    };
    const result = protectReservedSettingsPatch(
      { ...currentSettings, providerInstances },
      {
        providerInstances: {
          codex_byok: {
            driver: "codex",
            displayName: "Client-created BYOK",
            config: { byok: true },
          },
          client_managed: {
            driver: "codex",
            displayName: "Client-created managed alias",
            config: { managed: true },
          },
          client_byok: {
            driver: "codex",
            displayName: "Client-created BYOK alias",
            config: { byok: true },
          },
          client_legacy_byok: {
            driver: "codex",
            displayName: "Client-created legacy BYOK alias",
            config: { mossByok: true },
          },
        },
      },
    );

    expect(result.providerInstances).toEqual({
      codex_moss: currentSettings.providerInstances.codex_moss,
      opencode_moss: currentSettings.providerInstances.opencode_moss,
    });
  });

  it.each(["moss", "byok"] as const)(
    "rejects a non-reserved provider instance that claims the reserved %s account",
    (accountId) => {
      const result = protectReservedSettingsPatch(currentSettings, {
        providerInstances: {
          ordinary: {
            driver: "codex",
            displayName: "Forged ordinary",
            config: {
              accountId,
              homePath: "/tmp/forged",
              runtimeGeneration: "client-forged-generation",
            },
          },
        },
      });

      expect(result.providerInstances?.ordinary).toBeUndefined();
      expect(result.providerInstances?.codex_moss).toBe(
        currentSettings.providerInstances.codex_moss,
      );
      expect(result.providerInstances?.codex_byok).toBe(
        currentSettings.providerInstances.codex_byok,
      );
    },
  );

  it("returns unrelated patches unchanged", () => {
    const patch: ServerSettingsPatch = {
      providers: { codex: { selectedAccountId: "moss" } },
    };

    expect(protectReservedSettingsPatch(currentSettings, patch)).toBe(patch);
  });

  it.each([
    ["another personal account", "another-personal"],
    ["the same fallback personal account", "personal"],
  ])("keeps a selection-only user patch minimal when selecting %s", (_label, selectedAccountId) => {
    const settingsWithCleanupFallback: ServerSettings = {
      ...currentSettings,
      providerInstances: {
        ...currentSettings.providerInstances,
        codex_moss: {
          driver: "codex",
          displayName: "Moss managed",
          config: {
            managed: true,
            serverOwned: "keep",
            [MOSS_MANAGED_SELECTION_FALLBACK_CONFIG_KEY]: {
              version: 1,
              accountFallback: true,
            },
          },
        },
      },
    };

    const result = protectReservedSettingsPatch(settingsWithCleanupFallback, {
      providers: { codex: { selectedAccountId } },
    });

    expect(result).toEqual({ providers: { codex: { selectedAccountId } } });
    expect(result.providerInstances).toBeUndefined();
  });

  it("keeps a text-selection user patch minimal", () => {
    const settingsWithCleanupFallback: ServerSettings = {
      ...currentSettings,
      providerInstances: {
        ...currentSettings.providerInstances,
        codex_moss: {
          driver: "codex",
          displayName: "Moss managed",
          config: {
            managed: true,
            serverOwned: "keep",
            [MOSS_MANAGED_SELECTION_FALLBACK_CONFIG_KEY]: {
              version: 1,
              textGenerationFallback: true,
            },
          },
        },
      },
    };

    const result = protectReservedSettingsPatch(settingsWithCleanupFallback, {
      textGenerationModelSelection: { instanceId: "codex", model: "gpt-5.4-mini" },
    });

    expect(result).toEqual({
      textGenerationModelSelection: { instanceId: "codex", model: "gpt-5.4-mini" },
    });
    expect(result.providerInstances).toBeUndefined();
  });
});
