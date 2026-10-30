import { describe, expect, it } from "vitest";

import {
  getEditableGenericSettingsCodexAccounts,
  getEditableGenericSettingsProviderInstances,
  isProtectedGenericSettingsProviderInstance,
  preserveProtectedGenericSettingsRecords,
} from "./genericProviderSettingsProtection";

describe("generic provider Settings protection", () => {
  it("recognizes managed flags and reserved instance ids", () => {
    expect(isProtectedGenericSettingsProviderInstance("pi_moss")).toBe(true);
    expect(isProtectedGenericSettingsProviderInstance("pi_personal")).toBe(false);
    expect(
      isProtectedGenericSettingsProviderInstance("custom_managed", {
        driver: "codex",
        config: { managed: true },
      }),
    ).toBe(true);
    expect(
      isProtectedGenericSettingsProviderInstance("custom_byok", {
        driver: "codex",
        config: { byok: true },
      }),
    ).toBe(true);
    expect(
      isProtectedGenericSettingsProviderInstance("legacy_custom_byok", {
        driver: "codex",
        config: { mossByok: true },
      }),
    ).toBe(true);
    expect(
      isProtectedGenericSettingsProviderInstance("codex_moss", {
        driver: "codex",
        config: { managed: false },
      }),
    ).toBe(true);
    expect(
      isProtectedGenericSettingsProviderInstance("opencode_moss", {
        driver: "opencode",
        config: { managed: false },
      }),
    ).toBe(true);
    expect(
      isProtectedGenericSettingsProviderInstance("ordinary", {
        driver: "codex",
        config: { managed: false, mossByok: false },
      }),
    ).toBe(false);
  });

  it("projects only records the generic editor may display or compare", () => {
    expect(
      getEditableGenericSettingsCodexAccounts([
        { id: "moss", label: "Moss", homePath: "", shadowHomePath: "" },
        { id: "byok", label: "BYOK", homePath: "", shadowHomePath: "" },
        { id: "work", label: "Work", homePath: "/work", shadowHomePath: "" },
      ]),
    ).toEqual([{ id: "work", label: "Work", homePath: "/work", shadowHomePath: "" }]);

    expect(
      getEditableGenericSettingsProviderInstances({
        codex_moss: { driver: "codex", config: {} },
        opencode_moss: { driver: "opencode", config: {} },
        hidden_managed: { driver: "codex", config: { managed: true } },
        hidden_byok: { driver: "codex", config: { byok: true } },
        ordinary: { driver: "codex", config: { homePath: "/work" } },
      }),
    ).toEqual({
      ordinary: { driver: "codex", config: { homePath: "/work" } },
    });
  });

  it("restores exact protected records across overwrite, deletion, and creation attempts", () => {
    const current = {
      codexAccounts: [
        { id: "moss", label: "Moss server", homePath: "/moss", shadowHomePath: "" },
        { id: "work", label: "Old work", homePath: "/old", shadowHomePath: "" },
      ],
      providerInstances: {
        codex_moss: {
          driver: "codex" as const,
          displayName: "Moss server",
          config: { managed: true, serverOwned: "keep" },
        },
        opencode_moss: {
          driver: "opencode" as const,
          displayName: "Moss DeepSeek & Kimi",
          config: { managed: true, serverOwned: "keep" },
        },
        managed_alias: {
          driver: "codex" as const,
          displayName: "Managed alias",
          config: { managed: true, serverOwned: "keep" },
        },
        ordinary: {
          driver: "codex" as const,
          displayName: "Old ordinary",
          config: { homePath: "/old" },
        },
      },
    };

    expect(
      preserveProtectedGenericSettingsRecords(current, {
        codexAccounts: [
          { id: "moss", label: "Overwrite", homePath: "/tmp", shadowHomePath: "" },
          { id: "byok", label: "Create BYOK", homePath: "/tmp", shadowHomePath: "" },
          { id: "work", label: "New work", homePath: "/new", shadowHomePath: "" },
        ],
        providerInstances: {
          codex_moss: {
            driver: "codex",
            displayName: "Overwrite Moss",
            config: { managed: false },
          },
          opencode_moss: {
            driver: "opencode",
            displayName: "Client overwrite",
            config: { managed: false },
          },
          codex_byok: {
            driver: "codex",
            displayName: "Create BYOK",
            config: {},
          },
          managed_alias: {
            driver: "codex",
            displayName: "Unflag overwrite",
            config: { managed: false },
          },
          client_managed: {
            driver: "codex",
            displayName: "Client managed",
            config: { managed: true },
          },
          ordinary: {
            driver: "codex",
            displayName: "New ordinary",
            config: { homePath: "/new" },
          },
        },
      }),
    ).toEqual({
      codexAccounts: [
        { id: "work", label: "New work", homePath: "/new", shadowHomePath: "" },
        current.codexAccounts[0],
      ],
      providerInstances: {
        ordinary: {
          driver: "codex",
          displayName: "New ordinary",
          config: { homePath: "/new" },
        },
        codex_moss: current.providerInstances.codex_moss,
        opencode_moss: current.providerInstances.opencode_moss,
        managed_alias: current.providerInstances.managed_alias,
      },
    });
  });
});
