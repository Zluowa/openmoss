// FILE: useRetainedManagedProviderModelOptions.ts
// Purpose: Retains the last committed non-empty model catalog for active Moss-managed sources.
// Layer: Web hooks

import type { ProviderInstanceId, ProviderKind } from "@synara/contracts";
import { useLayoutEffect, useMemo, useRef } from "react";

import type { ProviderModelOption } from "../providerModelOptions";

export type ProviderModelOptionsByInstance = Partial<
  Record<ProviderInstanceId, ReadonlyArray<ProviderModelOption>>
>;

export interface ProviderModelCatalogInstance {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderKind;
}

interface ManagedProviderModelCacheEntry {
  readonly provider: ProviderKind;
  readonly options: ReadonlyArray<ProviderModelOption>;
}

export type ManagedProviderModelCatalogCache = ReadonlyMap<
  ProviderInstanceId,
  ManagedProviderModelCacheEntry
>;

export interface ManagedProviderModelCatalogReconciliation {
  readonly modelOptionsByProviderInstance: ProviderModelOptionsByInstance;
  readonly cache: ManagedProviderModelCatalogCache;
}

function isManagedCatalogInstance(
  instance: ProviderModelCatalogInstance,
): instance is ProviderModelCatalogInstance & {
  readonly instanceId: "codex_moss" | "claude_moss";
  readonly provider: "codex" | "claudeAgent";
} {
  return (
    (instance.instanceId === "codex_moss" && instance.provider === "codex") ||
    (instance.instanceId === "claude_moss" && instance.provider === "claudeAgent")
  );
}

/**
 * Applies committed last-known catalogs only to the two current Moss-managed
 * sources. Availability remains external to this helper: retaining menu rows
 * never makes an unavailable provider selectable for dispatch.
 */
export function reconcileManagedProviderModelOptions(input: {
  readonly cache: ManagedProviderModelCatalogCache;
  readonly providerInstances: ReadonlyArray<ProviderModelCatalogInstance>;
  readonly modelOptionsByProviderInstance: ProviderModelOptionsByInstance;
}): ManagedProviderModelCatalogReconciliation {
  const activeManagedInstances = new Map<ProviderInstanceId, ProviderKind>(
    input.providerInstances
      .filter(isManagedCatalogInstance)
      .map((instance) => [instance.instanceId, instance.provider]),
  );
  let nextCache = input.cache;
  const mutableCache = (): Map<ProviderInstanceId, ManagedProviderModelCacheEntry> => {
    if (nextCache === input.cache) {
      nextCache = new Map(input.cache);
    }
    return nextCache as Map<ProviderInstanceId, ManagedProviderModelCacheEntry>;
  };

  for (const [instanceId, cached] of input.cache) {
    if (activeManagedInstances.get(instanceId) !== cached.provider) {
      mutableCache().delete(instanceId);
    }
  }

  let retainedOptions = input.modelOptionsByProviderInstance;
  for (const instance of input.providerInstances) {
    if (!isManagedCatalogInstance(instance)) {
      continue;
    }

    const currentOptions = input.modelOptionsByProviderInstance[instance.instanceId];
    if (currentOptions && currentOptions.length > 0) {
      const cached = nextCache.get(instance.instanceId);
      if (cached?.provider !== instance.provider || cached.options !== currentOptions) {
        mutableCache().set(instance.instanceId, {
          provider: instance.provider,
          options: currentOptions,
        });
      }
      continue;
    }

    const cached = nextCache.get(instance.instanceId);
    if (cached?.provider !== instance.provider || cached.options.length === 0) {
      continue;
    }
    if (retainedOptions === input.modelOptionsByProviderInstance) {
      retainedOptions = { ...input.modelOptionsByProviderInstance };
    }
    retainedOptions[instance.instanceId] = cached.options;
  }

  return {
    modelOptionsByProviderInstance: retainedOptions,
    cache: nextCache,
  };
}

export function useRetainedManagedProviderModelOptions(input: {
  readonly providerInstances: ReadonlyArray<ProviderModelCatalogInstance>;
  readonly modelOptionsByProviderInstance: ProviderModelOptionsByInstance;
}): ProviderModelOptionsByInstance {
  const committedCacheRef = useRef<ManagedProviderModelCatalogCache>(new Map());
  const reconciliation = useMemo(
    () =>
      reconcileManagedProviderModelOptions({
        cache: committedCacheRef.current,
        providerInstances: input.providerInstances,
        modelOptionsByProviderInstance: input.modelOptionsByProviderInstance,
      }),
    [input.modelOptionsByProviderInstance, input.providerInstances],
  );

  // Only committed catalogs become fallbacks. An abandoned concurrent render
  // must not publish model rows the user never actually observed.
  useLayoutEffect(() => {
    committedCacheRef.current = reconciliation.cache;
  }, [reconciliation.cache]);

  return reconciliation.modelOptionsByProviderInstance;
}
