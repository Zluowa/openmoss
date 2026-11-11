// FILE: AppRailUsage.logic.ts
// Purpose: Pure selection rules for the provider usage rings at the bottom of the app rail.

import type { ProviderInstanceId, ProviderKind } from "@moss/contracts";
import type { ResolvedProviderInstance } from "@moss/shared/providerInstances";
import { PROVIDER_USAGE_PROVIDERS, providerUsageDisplayName } from "@moss/shared/providerUsage";

import type { RailUsageWindow } from "~/appSettings";
import { isMossManagedSourceInstanceId } from "~/components/chat/providerAccountSources";
import { providerAccountQualifiedLabel } from "~/lib/providerInstancePresentation";
import type { ProviderUsageDisplayRow } from "~/lib/providerUsageDisplay";

export interface RailUsageAccount {
  readonly instance: ResolvedProviderInstance;
  readonly label: string;
  readonly dotted: boolean;
}

/**
 * The rail's Moss ring: the one Moss quota every agent's Moss account draws on. Stored in the
 * rail selection beside account ids; no provider instance uses this id.
 */
export const MOSS_RAIL_USAGE_ID = "moss" as ProviderInstanceId;

/** The rail before anyone chose: the Moss quota. */
export const DEFAULT_RAIL_USAGE_IDS: ReadonlyArray<ProviderInstanceId> = [MOSS_RAIL_USAGE_ID];

/** The rail's first default, Codex and Claude's own accounts, which a Moss user rarely has. */
const LEGACY_DEFAULT_RAIL_USAGE_IDS = new Set(["codex", "claudeAgent"]);

/**
 * One-time move of a selection nobody changed (the old Codex + Claude default) to the Moss
 * ring. A chosen selection, an empty one included, is kept.
 */
export function migrateRailUsageSelection(
  selected: ReadonlyArray<ProviderInstanceId>,
): ReadonlyArray<ProviderInstanceId> {
  const unique = new Set(selected);
  const isLegacyDefault =
    unique.size === LEGACY_DEFAULT_RAIL_USAGE_IDS.size &&
    [...unique].every((id) => LEGACY_DEFAULT_RAIL_USAGE_IDS.has(id));
  return isLegacyDefault ? DEFAULT_RAIL_USAGE_IDS : selected;
}

/**
 * Enabled usage-capable accounts, named consistently in Settings and the rail. Moss accounts
 * are not listed: they have no usage of their own, their quota is the Moss ring.
 */
export function getRailUsageAccounts(
  instances: ReadonlyArray<ResolvedProviderInstance>,
  disabledProviders: ReadonlyArray<ProviderKind> = [],
  localAccountName = "Local account",
): ReadonlyArray<RailUsageAccount> {
  return PROVIDER_USAGE_PROVIDERS.flatMap((provider) => {
    const accounts = instances.filter(
      (instance) =>
        instance.enabled &&
        instance.driver === provider &&
        !disabledProviders.includes(instance.driver) &&
        !isMossManagedSourceInstanceId(instance.instanceId as ProviderInstanceId),
    );
    const providerName = providerUsageDisplayName(provider);
    return accounts.map((instance) => {
      const showAccountName =
        !instance.isDefault || accounts.length > 1 || Boolean(instance.raw.displayName?.trim());
      const accountName =
        instance.isDefault && !instance.raw.displayName?.trim()
          ? localAccountName
          : instance.displayName;
      return {
        instance,
        dotted: accounts.length > 1 && !instance.isDefault,
        label: showAccountName
          ? providerAccountQualifiedLabel(providerName, accountName)
          : providerName,
      };
    });
  });
}

/** Stored selection → unique available accounts, in the order they were chosen. */
export function resolveRailUsageAccounts(
  selected: ReadonlyArray<ProviderInstanceId>,
  available: ReadonlyArray<RailUsageAccount>,
): ReadonlyArray<RailUsageAccount> {
  const byId = new Map(available.map((account) => [account.instance.instanceId, account]));
  return [...new Set(selected)].flatMap((instanceId) => {
    const account = byId.get(instanceId);
    return account ? [account] : [];
  });
}

/** Next selection after a Settings toggle. Any number of accounts can sit in the rail. */
export function toggleRailUsageAccount(
  selected: ReadonlyArray<ProviderInstanceId>,
  instanceId: ProviderInstanceId,
  enabled: boolean,
): ReadonlyArray<ProviderInstanceId> {
  const current = [...new Set(selected)];
  if (!enabled) {
    return current.filter((entry) => entry !== instanceId);
  }
  return current.includes(instanceId) ? current : [...current, instanceId];
}

/**
 * The rows a rail ring draws, outermost first. Named model/pool sublimits can share the
 * account windows' durations, so the account rows are picked by label. A provider that does
 * not report the chosen window shows its other account window, and one with neither keeps
 * its most constrained row, so a chosen provider never loses its ring.
 */
export function selectRailUsageRows(
  rows: ReadonlyArray<ProviderUsageDisplayRow>,
  primaryRow: ProviderUsageDisplayRow | null,
  window: RailUsageWindow,
): ReadonlyArray<ProviderUsageDisplayRow> {
  const weekly = rows.find((row) => row.label === "Weekly");
  const fiveHour = rows.find((row) => row.label === "5h");
  const preferred =
    window === "both"
      ? [weekly, fiveHour]
      : window === "weekly"
        ? [weekly ?? fiveHour]
        : [fiveHour ?? weekly];
  const selected = preferred.filter((row) => row !== undefined);
  if (selected.length > 0) {
    return selected;
  }
  return primaryRow ? [primaryRow] : [];
}

export type RailUsageRingTone = "healthy" | "fair" | "low" | "critical";

/** Remaining quota → ring colour step; the last two match the usage bars' warning/danger. */
export function railUsageRingTone(remainingPercent: number): RailUsageRingTone {
  if (remainingPercent <= 10) return "critical";
  if (remainingPercent <= 25) return "low";
  if (remainingPercent <= 50) return "fair";
  return "healthy";
}
