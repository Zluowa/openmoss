import type {
  CodexAccountConfig,
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
} from "@synara/contracts";
import type { JsonObject } from "effect/Schema";

export const RESERVED_MOSS_CODEX_ACCOUNT_IDS = ["moss", "byok"] as const;
export const RESERVED_MOSS_PROVIDER_INSTANCE_IDS = [
  "codex_moss",
  "codex_byok",
  "claude_moss",
  "opencode_moss",
  "pi_moss",
] as const;

const RESERVED_CODEX_ACCOUNT_ID_SET = new Set<string>(RESERVED_MOSS_CODEX_ACCOUNT_IDS);
const RESERVED_PROVIDER_INSTANCE_ID_SET = new Set<string>(RESERVED_MOSS_PROVIDER_INSTANCE_IDS);

function isJsonObject(value: ProviderInstanceConfig["config"]): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isProtectedGenericSettingsCodexAccountId(accountId: string): boolean {
  return RESERVED_CODEX_ACCOUNT_ID_SET.has(accountId);
}

export function isProtectedGenericSettingsProviderInstance(
  instanceId: string,
  instance?: ProviderInstanceConfig,
): boolean {
  if (RESERVED_PROVIDER_INSTANCE_ID_SET.has(instanceId)) {
    return true;
  }

  const config = instance?.config;
  return (
    isJsonObject(config) &&
    (config.managed === true || config.byok === true || config.mossByok === true)
  );
}

export function getEditableGenericSettingsCodexAccounts(
  accounts: ReadonlyArray<CodexAccountConfig>,
): CodexAccountConfig[] {
  return accounts.filter((account) => !isProtectedGenericSettingsCodexAccountId(account.id));
}

export function getEditableGenericSettingsProviderInstances(
  providerInstances: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap {
  return Object.fromEntries(
    Object.entries(providerInstances).filter(
      ([instanceId, instance]) => !isProtectedGenericSettingsProviderInstance(instanceId, instance),
    ),
  ) as ProviderInstanceConfigMap;
}

export interface GenericSettingsProviderCollections {
  readonly codexAccounts: ReadonlyArray<CodexAccountConfig>;
  readonly providerInstances: ProviderInstanceConfigMap;
}

/** Keeps server/account-owned records exact while a generic Settings action replaces collections. */
export function preserveProtectedGenericSettingsRecords(
  current: GenericSettingsProviderCollections,
  next: GenericSettingsProviderCollections,
): {
  readonly codexAccounts: CodexAccountConfig[];
  readonly providerInstances: ProviderInstanceConfigMap;
} {
  const protectedCurrentAccounts = current.codexAccounts.filter((account) =>
    isProtectedGenericSettingsCodexAccountId(account.id),
  );
  const protectedCurrentProviderInstances = Object.entries(current.providerInstances).filter(
    ([instanceId, instance]) => isProtectedGenericSettingsProviderInstance(instanceId, instance),
  );

  return {
    codexAccounts: [
      ...getEditableGenericSettingsCodexAccounts(next.codexAccounts),
      ...protectedCurrentAccounts,
    ],
    providerInstances: Object.fromEntries([
      ...Object.entries(next.providerInstances).filter(
        ([instanceId, instance]) =>
          !isProtectedGenericSettingsProviderInstance(instanceId, instance) &&
          !isProtectedGenericSettingsProviderInstance(
            instanceId,
            current.providerInstances[instanceId],
          ),
      ),
      ...protectedCurrentProviderInstances,
    ]) as ProviderInstanceConfigMap,
  };
}
