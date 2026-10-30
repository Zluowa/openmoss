import type {
  ProviderInstanceConfig,
  ServerSettings,
  ServerSettingsPatch,
} from "@synara/contracts";
import type { JsonObject } from "effect/Schema";

export const RESERVED_MOSS_CODEX_ACCOUNT_IDS = ["moss", "byok"] as const;
export const RESERVED_MOSS_PROVIDER_INSTANCE_IDS = [
  "codex_moss",
  "codex_byok",
  "claude_moss",
  "opencode_moss",
  "pi_moss",
  "grok_moss",
  "hermes_moss",
  "kimi_moss",
  "minimax_moss",
  "zcode_moss",
] as const;
/**
 * Internal-only provenance written when managed cleanup changes routing.
 * Keeping this outside the legacy `previousSelectedAccountId` field prevents
 * a normal managed selection from being mistaken for a cleanup fallback.
 */
export const MOSS_MANAGED_SELECTION_FALLBACK_CONFIG_KEY = "managedSelectionFallback";

const RESERVED_CODEX_ACCOUNT_ID_SET = new Set<string>(RESERVED_MOSS_CODEX_ACCOUNT_IDS);
const RESERVED_PROVIDER_INSTANCE_ID_SET = new Set<string>(RESERVED_MOSS_PROVIDER_INSTANCE_IDS);

function isReservedCodexAccountId(accountId: string): boolean {
  return RESERVED_CODEX_ACCOUNT_ID_SET.has(accountId);
}

function isReservedProviderInstanceId(instanceId: string): boolean {
  return RESERVED_PROVIDER_INSTANCE_ID_SET.has(instanceId);
}

function isJsonObject(value: ProviderInstanceConfig["config"]): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProtectedProviderInstance(
  instanceId: string,
  instance?: ProviderInstanceConfig,
): boolean {
  if (isReservedProviderInstanceId(instanceId)) {
    return true;
  }
  const config = instance?.config;
  return (
    isJsonObject(config) &&
    (config.managed === true || config.byok === true || config.mossByok === true)
  );
}

function claimsReservedCodexAccount(instance?: ProviderInstanceConfig): boolean {
  if (instance?.driver !== "codex" || !isJsonObject(instance.config)) {
    return false;
  }
  const accountId = instance.config.accountId;
  return typeof accountId === "string" && isReservedCodexAccountId(accountId.trim());
}

export function userChangedManagedSelection(patch: ServerSettingsPatch): boolean {
  const codexPatch = patch.providers?.codex;
  return (
    codexPatch?.selectedAccountId !== undefined ||
    codexPatch?.accounts !== undefined ||
    Object.prototype.hasOwnProperty.call(patch, "textGenerationModelSelection")
  );
}

/**
 * Protects server-managed Moss records at the untrusted client WS boundary.
 * Internal services deliberately bypass this helper so they can maintain the
 * reserved records themselves.
 */
export function protectReservedSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  const incomingAccounts = patch.providers?.codex?.accounts;
  const incomingProviderInstances = patch.providerInstances;
  // Selection-only edits stay minimal. The server settings transaction clears
  // the managed marker by instance; copying a snapshot map here would make a
  // concurrent client update able to replay stale provider records.
  if (incomingAccounts === undefined && incomingProviderInstances === undefined) {
    return patch;
  }

  const protectedAccounts =
    incomingAccounts === undefined
      ? undefined
      : [
          ...incomingAccounts.filter((account) => !isReservedCodexAccountId(account.id)),
          ...current.providers.codex.accounts.filter((account) =>
            isReservedCodexAccountId(account.id),
          ),
        ];

  const protectedProviderInstances = Object.fromEntries([
    ...Object.entries(incomingProviderInstances ?? {}).filter(
      ([instanceId, instance]) =>
        !isProtectedProviderInstance(instanceId, instance) &&
        !isProtectedProviderInstance(instanceId, current.providerInstances[instanceId]) &&
        !claimsReservedCodexAccount(instance),
    ),
    ...Object.entries(current.providerInstances).filter(([instanceId, instance]) =>
      isProtectedProviderInstance(instanceId, instance),
    ),
  ]);

  return {
    ...patch,
    ...(protectedAccounts === undefined
      ? {}
      : {
          providers: {
            ...patch.providers,
            codex: {
              ...patch.providers?.codex,
              accounts: protectedAccounts,
            },
          },
        }),
    ...(incomingProviderInstances === undefined
      ? {}
      : { providerInstances: protectedProviderInstances }),
  };
}
