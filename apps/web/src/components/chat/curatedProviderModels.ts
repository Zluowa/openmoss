import type { ProviderKind } from "@synara/contracts";
import type { ProviderModelOption } from "../../providerModelOptions";
import { KIMI_CHANNEL_MODEL, KIMI_CHANNEL_MODEL_LABEL } from "../../lib/ccSwitchChannels";

function normalizedSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * Preserves the provider runtime's complete model catalog in its declared
 * order. Moss authentication controls admission to the product; it must not
 * silently reduce the models exposed by a connected personal provider.
 *
 * A selected legacy model that disappeared from discovery remains available
 * as a compatibility row, and duplicate runtime rows are collapsed by slug.
 */
export function curateProviderModelOptions(input: {
  provider: ProviderKind;
  options: ReadonlyArray<ProviderModelOption>;
  activeModel?: string | null | undefined;
  activeModelName?: string | null | undefined;
  favoriteModels?: ReadonlySet<string> | undefined;
}): ProviderModelOption[] {
  const activeModel = input.activeModel?.trim();
  const result: ProviderModelOption[] = [];
  const seen = new Set<string>();
  const append = (option: ProviderModelOption | undefined) => {
    if (!option) return;
    const key = normalizedSlug(option.slug);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(option);
  };

  for (const option of input.options) {
    append(
      input.provider === "claudeAgent" &&
        normalizedSlug(option.slug) === normalizedSlug(KIMI_CHANNEL_MODEL)
        ? { ...option, name: KIMI_CHANNEL_MODEL_LABEL }
        : option,
    );
  }

  if (activeModel) {
    append(
      input.options.find(
        (option) => normalizedSlug(option.slug) === normalizedSlug(activeModel),
      ) ?? { slug: activeModel, name: input.activeModelName?.trim() || activeModel },
    );
  }

  return result;
}
