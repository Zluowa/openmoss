// FILE: pluginMutationSettlement.ts
// Purpose: Prevents optimistic plugin success by requiring an authoritative catalog re-read
//          whose state matches the requested mutation.
// Layer: Web domain helper

import type { ProviderListPluginsResult, ProviderPluginDescriptor } from "@synara/contracts";

import { isPluginInstalledForDirectory } from "./pluginLibraryModel";

export interface PluginCatalogSnapshot {
  /** Number of plugin/list shards that completed successfully. */
  readonly successfulReads: number;
  readonly marketplaces: ReadonlyArray<{
    readonly name: string;
    readonly path: string | null;
  }>;
  readonly plugins: readonly ProviderPluginDescriptor[];
}

export function pluginCatalogSnapshot(
  results: readonly (ProviderListPluginsResult | undefined)[],
): PluginCatalogSnapshot {
  const marketplaces = results.flatMap((result) => result?.marketplaces ?? []);
  return {
    successfulReads: results.filter((result) => result !== undefined).length,
    marketplaces: marketplaces.map((marketplace) => ({
      name: marketplace.name,
      path: marketplace.path,
    })),
    plugins: marketplaces.flatMap((marketplace) => marketplace.plugins),
  };
}

export async function readPrimaryPluginCatalog(input: {
  readonly invalidate: () => Promise<unknown>;
  readonly readPrimary: () => Promise<ProviderListPluginsResult>;
  readonly refreshOptional: readonly (() => Promise<unknown>)[];
}): Promise<PluginCatalogSnapshot> {
  await input.invalidate();
  // Remote catalog shards are useful for refreshing the combined directory, but
  // they are not authoritative for a local marketplace mutation. A clean user
  // may legitimately be unauthenticated for all of them.
  void Promise.allSettled(input.refreshOptional.map((refresh) => Promise.resolve().then(refresh)));
  const primary = await input.readPrimary();
  return pluginCatalogSnapshot([primary]);
}

export function isPluginInstallSettled(snapshot: PluginCatalogSnapshot, pluginId: string): boolean {
  return snapshot.plugins.some(
    (plugin) => plugin.id === pluginId && isPluginInstalledForDirectory(plugin),
  );
}

export function isPluginEnabledSettled(
  snapshot: PluginCatalogSnapshot,
  pluginId: string,
  enabled: boolean,
): boolean {
  return snapshot.plugins.some(
    (plugin) =>
      plugin.id === pluginId && isPluginInstalledForDirectory(plugin) && plugin.enabled === enabled,
  );
}

export function isPluginUninstallSettled(
  snapshot: PluginCatalogSnapshot,
  pluginId: string,
): boolean {
  return (
    snapshot.successfulReads > 0 &&
    snapshot.plugins.every(
      (plugin) => plugin.id !== pluginId || !isPluginInstalledForDirectory(plugin),
    )
  );
}

export function isMarketplaceAddSettled(
  snapshot: PluginCatalogSnapshot,
  marketplaceName: string,
  installedRoot: string,
): boolean {
  const normalizedInstalledRoot = installedRoot.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  const canonicalManifestPath = `${normalizedInstalledRoot}/.agents/plugins/marketplace.json`;
  return snapshot.marketplaces.some((marketplace) => {
    if (marketplace.name !== marketplaceName || marketplace.path === null) return false;
    const normalizedMarketplacePath = marketplace.path
      .trim()
      .replaceAll("\\", "/")
      .replace(/\/+$/u, "");
    return (
      normalizedMarketplacePath === normalizedInstalledRoot ||
      normalizedMarketplacePath === canonicalManifestPath
    );
  });
}

export async function runPluginMutationWithAuthoritativeRead<TResult, TState>(input: {
  readonly mutate: () => Promise<TResult>;
  readonly reRead: () => Promise<TState>;
  readonly isSettled: (state: TState, result: TResult) => boolean;
  readonly failureMessage: string;
}): Promise<TResult> {
  let result: TResult;
  try {
    result = await input.mutate();
  } catch (mutationError) {
    // A native timeout or process exit is ambiguous: the operation may have
    // persisted before the transport failed. Reconcile once from native truth,
    // but never retry a non-idempotent mutation. The original mutation error is
    // still the caller-visible failure even when this best-effort read fails.
    try {
      await input.reRead();
    } catch {
      // Best-effort cache reconciliation only.
    }
    throw mutationError;
  }
  const state = await input.reRead();
  if (!input.isSettled(state, result)) {
    throw new Error(input.failureMessage);
  }
  return result;
}
