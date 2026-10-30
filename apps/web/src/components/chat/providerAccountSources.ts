// FILE: providerAccountSources.ts
// Purpose: Keeps simple account-source labels aligned with their provider-instance identities.
// Layer: Chat composer domain logic
// Depends on: provider instance identifiers only.

import type { ProviderInstanceId, ProviderKind } from "@synara/contracts";

export const MOSS_MANAGED_SOURCE_INSTANCE_IDS = new Set<ProviderInstanceId>([
  "codex_moss",
  "claude_moss",
  "pi_moss",
  "opencode_moss",
  "grok_moss",
  "hermes_moss",
  "kimi_moss",
  "minimax_moss",
  "zcode_moss",
]);

/**
 * Historical server-owned ids kept protected until the server cleanup retires
 * them. `codex_byok` was the single-model Moss Key, removed at server startup.
 */
export const MOSS_LEGACY_SOURCE_INSTANCE_IDS = new Set<ProviderInstanceId>(["codex_byok"]);

export type ComposerAccountSourceKind = "moss" | "personal" | "profile";

export function isMossManagedSourceInstanceId(instanceId: ProviderInstanceId): boolean {
  return MOSS_MANAGED_SOURCE_INSTANCE_IDS.has(instanceId);
}

export function isMossLegacySourceInstanceId(instanceId: ProviderInstanceId): boolean {
  return MOSS_LEGACY_SOURCE_INSTANCE_IDS.has(instanceId);
}

export function isMossProtectedSourceInstanceId(instanceId: ProviderInstanceId): boolean {
  return isMossManagedSourceInstanceId(instanceId) || isMossLegacySourceInstanceId(instanceId);
}

/**
 * Reduces implementation-specific provider-instance ids to the small source
 * vocabulary the composer exposes. Codex and Claude account names remain
 * available in settings, but the compact picker deliberately presents both as
 * the same user-owned source family.
 */
export function resolveComposerAccountSourceKind(input: {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderKind;
}): ComposerAccountSourceKind {
  if (
    isMossManagedSourceInstanceId(input.instanceId) ||
    isMossLegacySourceInstanceId(input.instanceId)
  ) {
    return "moss";
  }
  if (input.provider === "codex" || input.provider === "claudeAgent") return "personal";
  return "profile";
}

/**
 * Keeps the model menu scoped to the source the user picked. Moss is the one
 * intentional multi-provider model group for managed GPT and Claude. Pi keeps
 * its own engine catalog even though it uses the same Moss account.
 */
export function resolveComposerModelSourceProviders(input: {
  readonly selectedProviderInstanceId: ProviderInstanceId;
  readonly selectedProvider: ProviderKind;
  readonly providerInstances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderKind;
  }>;
}): ReadonlyArray<ProviderKind> {
  if (
    input.selectedProviderInstanceId === "codex_moss" ||
    input.selectedProviderInstanceId === "claude_moss"
  ) {
    return ["codex", "claudeAgent"];
  }

  const selectedInstance = input.providerInstances.find(
    (instance) => instance.instanceId === input.selectedProviderInstanceId,
  );
  return [selectedInstance?.provider ?? input.selectedProvider];
}

export function mossManagedSourceInstanceIdForProvider(
  activeInstanceId: ProviderInstanceId,
  targetProvider: ProviderKind,
): ProviderInstanceId | undefined {
  if (!isMossManagedSourceInstanceId(activeInstanceId)) {
    return undefined;
  }
  if (targetProvider === "codex") return "codex_moss";
  if (targetProvider === "claudeAgent") return "claude_moss";
  if (targetProvider === "pi") return "pi_moss";
  if (targetProvider === "opencode") return "opencode_moss";
  if (targetProvider === "grok") return "grok_moss";
  if (targetProvider === "hermes") return "hermes_moss";
  if (targetProvider === "kimi") return "kimi_moss";
  if (targetProvider === "minimax") return "minimax_moss";
  if (targetProvider === "zcode") return "zcode_moss";
  return undefined;
}

/**
 * Preserve the user's visible source family when a model choice crosses from
 * Moss GPT to Moss Claude (or back). Without this mapping the generic picker
 * would choose the first personal account for the target provider.
 */
export function resolveLinkedSourceProviderInstanceId(input: {
  readonly activeInstanceId: ProviderInstanceId;
  readonly targetProvider: ProviderKind;
  readonly providerInstances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderKind;
  }>;
  readonly isSelectable: (instanceId: ProviderInstanceId) => boolean;
}): ProviderInstanceId | undefined {
  if (!isMossManagedSourceInstanceId(input.activeInstanceId)) {
    return undefined;
  }

  const linkedInstanceId = mossManagedSourceInstanceIdForProvider(
    input.activeInstanceId,
    input.targetProvider,
  );
  if (!linkedInstanceId) {
    return undefined;
  }

  const linkedInstance = input.providerInstances.find(
    (instance) =>
      instance.instanceId === linkedInstanceId && instance.provider === input.targetProvider,
  );
  return linkedInstance && input.isSelectable(linkedInstanceId) ? linkedInstanceId : undefined;
}

/**
 * Resolves the exact identity for the model picker's provider switch. Managed
 * Moss targets deliberately remain identity-bearing when missing or unhealthy
 * so the caller fails closed instead of falling through to a personal account.
 */
export function resolveProviderInstanceIdForProviderSwitch(input: {
  readonly activeProvider: ProviderKind;
  readonly activeInstanceId: ProviderInstanceId;
  readonly targetProvider: ProviderKind;
  readonly targetInstances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly isDefault: boolean;
  }>;
  readonly isSelectable: (instanceId: ProviderInstanceId) => boolean;
}): ProviderInstanceId {
  if (input.activeProvider === input.targetProvider) {
    return input.activeInstanceId;
  }

  const managedTarget = mossManagedSourceInstanceIdForProvider(
    input.activeInstanceId,
    input.targetProvider,
  );
  if (managedTarget) {
    return managedTarget;
  }

  return (
    input.targetInstances.find((instance) => input.isSelectable(instance.instanceId))?.instanceId ??
    input.targetInstances.find((instance) => instance.isDefault)?.instanceId ??
    input.targetInstances[0]!.instanceId
  );
}
