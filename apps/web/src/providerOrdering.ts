// FILE: providerOrdering.ts
// Purpose: Keeps provider picker ordering stable across settings, search, and menus.
// Layer: Web settings utility
// Exports: default order, normalization, and order comparison helpers.

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type SupportedProviderKind,
  type ServerProviderStatus,
} from "@moss/contracts";
import { MOSS_ACTIVE_PROVIDER_KINDS, isMossActiveProvider } from "./providerProductCatalog";

export const DEFAULT_PROVIDER_ORDER: readonly SupportedProviderKind[] = MOSS_ACTIVE_PROVIDER_KINDS;

/** A desktop app or imported history alone does not prove that its CLI is installed. */
export function isLocalProviderInstalled(status: ServerProviderStatus): boolean {
  const provider = status.driver ?? status.provider;
  // Cloud/account instances are not evidence about the person's default local CLI.
  if (status.instanceId !== provider) return false;
  if (status.version?.trim()) return true;
  const readiness = status.readiness;
  if (
    status.enabled === false ||
    readiness?.state === "checking" ||
    readiness?.reason === "disabled"
  )
    return false;
  return (
    status.available ||
    readiness?.state === "needsLogin" ||
    (readiness?.state === "error" && readiness.reason === "failed-to-run")
  );
}

/** Keep bundled agents first; stable sort preserves the chosen order within each group. */
export function prioritizeInstalledProviders(
  order: ReadonlyArray<ProviderKind>,
  installed: ReadonlySet<ProviderKind>,
): ProviderKind[] {
  const rank = (provider: ProviderKind) =>
    provider === "codex" ? 0 : provider === "claudeAgent" ? 1 : installed.has(provider) ? 2 : 3;
  return order.toSorted((left, right) => rank(left) - rank(right));
}

const PROVIDER_KIND_ORDER = Object.keys(PROVIDER_DISPLAY_NAMES) as ProviderKind[];
const PROVIDER_KIND_SET: ReadonlySet<ProviderKind> = new Set(PROVIDER_KIND_ORDER);

export function isProviderKind(value: string): value is ProviderKind {
  return PROVIDER_KIND_SET.has(value as ProviderKind);
}

export function normalizeHiddenProviders(hiddenProviders: ReadonlyArray<string>): ProviderKind[] {
  const seen = new Set<ProviderKind>();
  const result: ProviderKind[] = [];
  for (const candidate of hiddenProviders) {
    if (isProviderKind(candidate) && isMossActiveProvider(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

export function normalizeProviderOrder(providerOrder: ReadonlyArray<string>): ProviderKind[] {
  const seen = new Set<ProviderKind>();
  const result: ProviderKind[] = [];
  for (const candidate of providerOrder) {
    if (isProviderKind(candidate) && isMossActiveProvider(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  for (const provider of DEFAULT_PROVIDER_ORDER) {
    if (!seen.has(provider)) {
      result.push(provider);
    }
  }
  return result;
}

export function sameProviderOrder(
  left: ReadonlyArray<ProviderKind>,
  right: ReadonlyArray<ProviderKind>,
): boolean {
  return left.length === right.length && left.every((provider, index) => provider === right[index]);
}

export function compareProvidersByOrder(
  providerOrder: ReadonlyArray<ProviderKind>,
  left: ProviderKind,
  right: ProviderKind,
): number {
  const leftIndex = providerOrder.indexOf(left);
  const rightIndex = providerOrder.indexOf(right);
  const normalizedLeftIndex =
    leftIndex >= 0 ? leftIndex : PROVIDER_KIND_ORDER.indexOf(left) + providerOrder.length;
  const normalizedRightIndex =
    rightIndex >= 0 ? rightIndex : PROVIDER_KIND_ORDER.indexOf(right) + providerOrder.length;
  return normalizedLeftIndex - normalizedRightIndex;
}
