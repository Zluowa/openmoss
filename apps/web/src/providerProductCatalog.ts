// FILE: providerProductCatalog.ts
// Purpose: Defines the provider choices Moss currently offers in new-product surfaces.
// Layer: Web product configuration
//
// Runtime descriptors remain exhaustive for persisted sessions and backward compatibility.
// The product offers every supported driver; optional CLIs still require opt-in.

import type { ProviderKind, SupportedProviderKind } from "@synara/contracts";

export const MOSS_RETIRED_PROVIDER_KINDS = [
  "droid",
  "kilo",
] as const satisfies readonly ProviderKind[];

export const MOSS_DEFAULT_PROVIDER_KINDS = [
  "codex",
  "claudeAgent",
  "opencode",
  "grok",
] as const satisfies readonly SupportedProviderKind[];

// Users can enable these providers and sign in with their own CLI account.
export const MOSS_OPTIONAL_PROVIDER_KINDS = [
  "cursor",
  "gemini",
  "antigravity",
  "pi",
  "omp",
  "devin",
  "hermes",
  "kimi",
  "minimax",
  "zcode",
] as const satisfies readonly SupportedProviderKind[];

export const MOSS_ACTIVE_PROVIDER_KINDS = [
  ...MOSS_DEFAULT_PROVIDER_KINDS,
  ...MOSS_OPTIONAL_PROVIDER_KINDS,
] as const;

export type MossActiveProviderKind = (typeof MOSS_ACTIVE_PROVIDER_KINDS)[number];

export const MOSS_UPCOMING_PROVIDERS = [
  { id: "deepseek-harness", title: "DeepSeek Harness", status: "in-development" },
] as const;

const ACTIVE_PROVIDER_SET: ReadonlySet<string> = new Set(MOSS_ACTIVE_PROVIDER_KINDS);

export function isMossActiveProvider(provider: string): provider is MossActiveProviderKind {
  return ACTIVE_PROVIDER_SET.has(provider);
}
