// FILE: pluginMutationSettlement.test.ts
// Purpose: Locks mutation -> authoritative read ordering and failure semantics.
// Layer: Web domain unit test

import { describe, expect, it, vi } from "vitest";

import type { ProviderListPluginsResult, ProviderPluginDescriptor } from "@synara/contracts";

import {
  isMarketplaceAddSettled,
  isPluginEnabledSettled,
  isPluginInstallSettled,
  isPluginUninstallSettled,
  pluginCatalogSnapshot,
  readPrimaryPluginCatalog,
  runPluginMutationWithAuthoritativeRead,
} from "./pluginMutationSettlement";

const availablePlugin: ProviderPluginDescriptor = {
  id: "github@openai-curated",
  remotePluginId: null,
  version: null,
  localVersion: null,
  name: "github",
  shareContext: null,
  source: { type: "local", path: "/marketplaces/openai/plugins/github/plugin.json" },
  installed: false,
  enabled: false,
  installPolicy: "AVAILABLE",
  installPolicySource: null,
  authPolicy: "ON_USE",
  availability: "AVAILABLE",
  interface: null,
  keywords: [],
};

function catalog(plugin: ProviderPluginDescriptor): ProviderListPluginsResult {
  return {
    marketplaces: [
      {
        name: "openai-curated",
        path: "/marketplaces/openai",
        interface: null,
        plugins: [plugin],
      },
    ],
    marketplaceLoadErrors: [],
    remoteSyncError: null,
    featuredPluginIds: [],
  };
}

describe("runPluginMutationWithAuthoritativeRead", () => {
  it("does not settle success until the authoritative read and target comparison complete", async () => {
    const order: string[] = [];
    const result = await runPluginMutationWithAuthoritativeRead({
      mutate: vi.fn(async () => {
        order.push("mutate");
        return { status: "ok" };
      }),
      reRead: vi.fn(async () => {
        order.push("re-read");
        return { installed: true };
      }),
      isSettled: vi.fn((state) => {
        order.push("compare");
        return state.installed;
      }),
      failureMessage: "plugin install did not settle",
    });

    expect(result).toEqual({ status: "ok" });
    expect(order).toEqual(["mutate", "re-read", "compare"]);
  });

  it("rejects when the authoritative target state does not match", async () => {
    await expect(
      runPluginMutationWithAuthoritativeRead({
        mutate: async () => ({ status: "ok" }),
        reRead: async () => ({ installed: false }),
        isSettled: (state) => state.installed,
        failureMessage: "catalog did not converge",
      }),
    ).rejects.toThrow("catalog did not converge");
  });

  it("rejects when the authoritative read fails so callers cannot announce success", async () => {
    await expect(
      runPluginMutationWithAuthoritativeRead({
        mutate: async () => ({ status: "ok" }),
        reRead: async (): Promise<{ installed: boolean }> => {
          throw new Error("catalog read failed");
        },
        isSettled: (state) => state.installed,
        failureMessage: "catalog did not converge",
      }),
    ).rejects.toThrow("catalog read failed");
  });

  it.each(["request timed out", "app-server exited before responding"])(
    "reconciles native truth once after mutation failure (%s) without retrying the mutation",
    async (message) => {
      const mutationFailure = new Error(message);
      const mutate = vi.fn(async (): Promise<{ status: "ok" }> => {
        throw mutationFailure;
      });
      const reRead = vi.fn(async () => ({ installed: true }));

      await expect(
        runPluginMutationWithAuthoritativeRead({
          mutate,
          reRead,
          isSettled: (state) => state.installed,
          failureMessage: "catalog did not converge",
        }),
      ).rejects.toBe(mutationFailure);

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(reRead).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves the mutation failure when the recovery reread also fails", async () => {
    const mutationFailure = new Error("request timed out");
    const reRead = vi.fn(async (): Promise<{ installed: boolean }> => {
      throw new Error("catalog unavailable");
    });

    await expect(
      runPluginMutationWithAuthoritativeRead({
        mutate: async (): Promise<{ status: "ok" }> => {
          throw mutationFailure;
        },
        reRead,
        isSettled: (state) => state.installed,
        failureMessage: "catalog did not converge",
      }),
    ).rejects.toBe(mutationFailure);

    expect(reRead).toHaveBeenCalledTimes(1);
  });
});

describe("plugin catalog mutation settlement", () => {
  it("settles local marketplace reads from the primary shard while optional remote shards fail", async () => {
    const primary = catalog(availablePlugin);
    const remoteFailure = vi.fn(async () => {
      throw new Error("chatgpt authentication required for remote plugin catalog");
    });

    await expect(
      readPrimaryPluginCatalog({
        invalidate: vi.fn(async () => undefined),
        readPrimary: vi.fn(async () => primary),
        refreshOptional: [remoteFailure, remoteFailure, remoteFailure],
      }),
    ).resolves.toEqual(pluginCatalogSnapshot([primary]));
    expect(remoteFailure).toHaveBeenCalledTimes(3);
  });

  it("rejects a failed primary marketplace read despite successful unrelated shards", async () => {
    await expect(
      readPrimaryPluginCatalog({
        invalidate: async () => undefined,
        readPrimary: async (): Promise<ProviderListPluginsResult> => {
          throw new Error("primary plugin catalog failed");
        },
        refreshOptional: [async () => catalog(availablePlugin)],
      }),
    ).rejects.toThrow("primary plugin catalog failed");
  });

  it("matches install and enable only from the authoritative plugin state", () => {
    const unavailable = pluginCatalogSnapshot([catalog(availablePlugin)]);
    const installedDisabled = pluginCatalogSnapshot([
      catalog({ ...availablePlugin, installed: true }),
    ]);
    const installedEnabled = pluginCatalogSnapshot([
      catalog({ ...availablePlugin, installed: true, enabled: true }),
    ]);

    expect(isPluginInstallSettled(unavailable, availablePlugin.id)).toBe(false);
    expect(isPluginInstallSettled(installedDisabled, availablePlugin.id)).toBe(true);
    expect(isPluginEnabledSettled(installedDisabled, availablePlugin.id, false)).toBe(true);
    expect(isPluginEnabledSettled(installedDisabled, availablePlugin.id, true)).toBe(false);
    expect(isPluginEnabledSettled(installedEnabled, availablePlugin.id, true)).toBe(true);
  });

  it("matches uninstall only after the installed state disappears", () => {
    const installed = pluginCatalogSnapshot([
      catalog({ ...availablePlugin, installed: true, enabled: true }),
    ]);
    const uninstalled = pluginCatalogSnapshot([catalog(availablePlugin)]);

    expect(isPluginUninstallSettled(installed, availablePlugin.id)).toBe(false);
    expect(isPluginUninstallSettled(uninstalled, availablePlugin.id)).toBe(true);
    expect(isPluginUninstallSettled(pluginCatalogSnapshot([]), availablePlugin.id)).toBe(false);
  });

  it("distinguishes four successful empty shards from no authoritative read", () => {
    const emptyCatalog: ProviderListPluginsResult = {
      marketplaces: [],
      marketplaceLoadErrors: [],
      remoteSyncError: null,
      featuredPluginIds: [],
    };
    const fourSuccessfulEmptyShards = pluginCatalogSnapshot([
      emptyCatalog,
      emptyCatalog,
      emptyCatalog,
      emptyCatalog,
    ]);

    expect(fourSuccessfulEmptyShards.successfulReads).toBe(4);
    expect(isPluginUninstallSettled(fourSuccessfulEmptyShards, availablePlugin.id)).toBe(true);
  });

  it("matches an added marketplace by the native result name and installed root", () => {
    const snapshot = pluginCatalogSnapshot([catalog(availablePlugin)]);
    const manifestSnapshot = pluginCatalogSnapshot([
      {
        ...catalog(availablePlugin),
        marketplaces: [
          {
            ...catalog(availablePlugin).marketplaces[0]!,
            path: "/marketplaces/openai/.agents/plugins/marketplace.json",
          },
        ],
      },
    ]);

    expect(isMarketplaceAddSettled(snapshot, "openai-curated", "/marketplaces/openai")).toBe(true);
    expect(
      isMarketplaceAddSettled(manifestSnapshot, "openai-curated", "/marketplaces/openai/"),
    ).toBe(true);
    expect(
      isMarketplaceAddSettled(manifestSnapshot, "openai-curated", "\\marketplaces\\openai\\"),
    ).toBe(true);
    expect(isMarketplaceAddSettled(snapshot, "openai-curated", "/somewhere/else")).toBe(false);
    expect(
      isMarketplaceAddSettled(manifestSnapshot, "openai-curated", "/marketplaces/openai-sibling"),
    ).toBe(false);
    expect(
      isMarketplaceAddSettled(manifestSnapshot, "openai-curated", "/marketplaces/openai/../openai"),
    ).toBe(false);
  });
});
