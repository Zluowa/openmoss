// FILE: providerInstanceModelDiscovery.ts
// Purpose: Build and select instance-scoped provider model discovery queries.
// Layer: Web provider discovery helpers

import type { ProviderInstanceId, ProviderKind, ProviderStartOptions } from "@synara/contracts";

import { getProviderStartOptions, type ProviderInstanceOption } from "../appSettings";
import { providerModelsQueryOptions } from "./providerDiscoveryReactQuery";

function readProviderOptionString(options: unknown, key: string): string | null {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return null;
  }
  const value = (options as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readProviderOptionBoolean(options: unknown, key: string): boolean | undefined {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return undefined;
  }
  const value = (options as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

export function providerInstanceModelsQueryOptions(input: {
  readonly settings: Parameters<typeof getProviderStartOptions>[0];
  readonly provider: ProviderKind;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly enabled: boolean;
  readonly priority?: "background" | "prefetch" | undefined;
}) {
  const providerKey: keyof ProviderStartOptions =
    input.provider === "kilo" ? "opencode" : input.provider;
  const providerOptions = getProviderStartOptions(input.settings, input.instanceId)?.[providerKey];
  return providerModelsQueryOptions({
    provider: input.provider,
    instanceId: input.instanceId,
    binaryPath: readProviderOptionString(providerOptions, "binaryPath"),
    homePath: readProviderOptionString(providerOptions, "homePath"),
    shadowHomePath: readProviderOptionString(providerOptions, "shadowHomePath"),
    accountId: readProviderOptionString(providerOptions, "accountId"),
    apiEndpoint: readProviderOptionString(providerOptions, "apiEndpoint"),
    serverUrl: readProviderOptionString(providerOptions, "serverUrl"),
    serverPassword: readProviderOptionString(providerOptions, "serverPassword"),
    experimentalWebSockets:
      input.provider === "opencode"
        ? readProviderOptionBoolean(providerOptions, "experimentalWebSockets")
        : undefined,
    agentDir: readProviderOptionString(providerOptions, "agentDir"),
    cwd: input.cwd,
    enabled: input.enabled,
    priority: input.priority,
  });
}

export function selectProviderInstanceModelQuery<T>(input: {
  readonly providerInstances: ReadonlyArray<Pick<ProviderInstanceOption, "instanceId">>;
  readonly queries: ReadonlyArray<T>;
  readonly selectedInstanceId: ProviderInstanceId;
}): T | undefined {
  const index = input.providerInstances.findIndex(
    (instance) => instance.instanceId === input.selectedInstanceId,
  );
  return index >= 0 ? input.queries[index] : undefined;
}
