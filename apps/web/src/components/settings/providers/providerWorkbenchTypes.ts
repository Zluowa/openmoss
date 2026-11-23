import type {
  ProviderKind,
  UnifiedModelProviderConfig,
  UnifiedModelProviderProtocol,
} from "@moss/contracts";

export type ProviderWorkbenchSelection =
  | { readonly kind: "moss" }
  | { readonly kind: "unified"; readonly id: string }
  | { readonly kind: "cli"; readonly provider: ProviderKind }
  | { readonly kind: "preferences" };

export type UnifiedProviderCliSource = string;

export const UNIFIED_PROTOCOL_LABEL: Record<
  UnifiedModelProviderProtocol,
  { readonly en: string; readonly zh: string; readonly badge: string }
> = {
  "openai-compatible": {
    en: "OpenAI Compatible",
    zh: "OpenAI 兼容",
    badge: "OpenAI",
  },
  "anthropic-compatible": {
    en: "Anthropic Compatible",
    zh: "Anthropic 兼容",
    badge: "Anthropic",
  },
  "gemini-compatible": {
    en: "Gemini Compatible",
    zh: "Gemini 兼容",
    badge: "Gemini",
  },
};

export function cliBrandIconId(provider: ProviderKind): string {
  switch (provider) {
    case "codex":
      return "openai";
    case "claudeAgent":
      return "claude";
    case "antigravity":
      return "gemini";
    case "grok":
      return "xai";
    default:
      return provider;
  }
}

export function resolveEffectiveCliSourceUi(input: {
  readonly defaultUnifiedProviderId: string | null | undefined;
  readonly unifiedProviderByCli: Readonly<Record<string, string>> | undefined;
  readonly provider: ProviderKind;
}): UnifiedProviderCliSource {
  const override = input.unifiedProviderByCli?.[input.provider]?.trim();
  if (override) {
    return override.startsWith("unified:") ? override.slice("unified:".length) : override;
  }
  const fallback = input.defaultUnifiedProviderId?.trim();
  if (fallback) {
    return fallback.startsWith("unified:") ? fallback.slice("unified:".length) : fallback;
  }
  return "moss";
}

export function findUnifiedProviderById(
  providers: ReadonlyArray<UnifiedModelProviderConfig> | undefined,
  id: string,
): UnifiedModelProviderConfig | undefined {
  return (providers ?? []).find((provider) => provider.id === id);
}

export function createUnifiedProviderId(
  presetId: string,
  existingIds: ReadonlySet<string>,
): string {
  const base =
    presetId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider";
  if (!existingIds.has(base)) return base;
  let index = 2;
  while (existingIds.has(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}
