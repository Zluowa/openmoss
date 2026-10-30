// FILE: providerOrdering.ts
// Purpose: Keeps provider picker ordering stable across settings, search, and menus.
// Layer: Web settings utility
// Exports: default order, normalization, and order comparison helpers.

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type SupportedProviderKind,
} from "@synara/contracts";
import { MOSS_ACTIVE_PROVIDER_KINDS, isMossActiveProvider } from "./providerProductCatalog";

export const DEFAULT_PROVIDER_ORDER: readonly SupportedProviderKind[] = MOSS_ACTIVE_PROVIDER_KINDS;

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
