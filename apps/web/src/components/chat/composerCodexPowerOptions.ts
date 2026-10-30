import { type ModelSlug, type ProviderKind, type ProviderModelDescriptor } from "@synara/contracts";

/** The effort values that have a place on the compact Codex power surface. */
export const COMPOSER_CODEX_POWER_EFFORTS = ["low", "medium", "high", "xhigh", "ultra"] as const;
export type ComposerCodexPowerEffort = (typeof COMPOSER_CODEX_POWER_EFFORTS)[number];

/** Provider option key Codex uses for reasoning effort; other providers supply their own. */
export const CODEX_POWER_EFFORT_OPTION_ID = "reasoningEffort";

/** Models whose compact surface is the Codex-bundled Terra→Sol ladder rather than a per-model one. */
const CODEX_BUNDLED_POWER_MODELS = new Set(["gpt-5.6-terra", "gpt-5.6-sol"]);

/**
 * Ascending order for every effort value Moss knows how to rank. Providers with values
 * outside this list keep their own descriptor order instead of being guessed at.
 */
const CANONICAL_EFFORT_RANK: ReadonlyMap<string, number> = new Map(
  ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
    (value, index) => [value, index] as const,
  ),
);

const PRIMARY_POWER_PAIRS = [
  ["gpt-5.6-terra", "low"],
  ["gpt-5.6-sol", "low"],
  ["gpt-5.6-sol", "medium"],
  ["gpt-5.6-sol", "high"],
  ["gpt-5.6-sol", "xhigh"],
  ["gpt-5.6-sol", "ultra"],
] as const satisfies ReadonlyArray<readonly [string, ComposerCodexPowerEffort]>;

const TERRA_FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

const POWER_EFFORT_LABELS: Record<ComposerCodexPowerEffort, string> = {
  low: "Light",
  medium: "Standard",
  high: "Extended",
  xhigh: "Extra High",
  ultra: "Ultra",
};

export type ComposerCodexPowerChoice = {
  readonly model: ModelSlug;
  readonly modelLabel: string;
  /** Raw effort value as the provider advertises it; Codex uses the canonical five. */
  readonly reasoningEffort: string;
  /** Provider option key to patch when this choice is selected. */
  readonly optionId: string;
  readonly effortLabel: string;
  readonly label: string;
  readonly isUltra: boolean;
};

/** Provider option patch produced by a compact surface change (effort and/or speed). */
export type ComposerCodexPowerSelection = Readonly<Record<string, unknown>>;

export type ComposerCodexPowerOptions = {
  readonly choices: ReadonlyArray<ComposerCodexPowerChoice>;
  /** Exact current model + effort, or null when the pair is not represented. */
  readonly selectedIndex: number | null;
  /** The pair used by Reset to default, if a compact surface exists. */
  readonly fallbackChoice: ComposerCodexPowerChoice | null;
  readonly fallbackIndex: number | null;
};

type ResolverInput = {
  readonly runtimeModels: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
  readonly model?: string | null | undefined;
  readonly reasoningEffort?: string | null | undefined;
  /** Optional explicit default model when a catalog exposes one. */
  readonly defaultModel?: string | null | undefined;
  /** Optional explicit default effort when a catalog exposes one. */
  readonly defaultReasoningEffort?: string | null | undefined;
};

function normalized(value: string | null | undefined): string | null {
  const result = value?.trim().toLowerCase();
  return result && result.length > 0 ? result : null;
}

function modelLabelForDescriptor(descriptor: ProviderModelDescriptor): string {
  const name = descriptor.name.trim() || descriptor.slug.trim();
  return name.replace(/^GPT-/iu, "");
}

function advertisedEffortsForDescriptor(descriptor: ProviderModelDescriptor): ReadonlySet<string> {
  const supported = descriptor.supportedReasoningEfforts?.map((effort) => normalized(effort.value));
  if (supported && supported.length > 0) {
    return new Set(supported.filter((effort): effort is string => effort !== null));
  }

  // Older runtime catalogs may only carry the select descriptor. It is still
  // account-scoped discovery data, so accepting it keeps the resolver fail-closed
  // without falling back to Moss's static capability table.
  const descriptorOption = descriptor.optionDescriptors?.find(
    (option) =>
      option.type === "select" &&
      (option.id === "reasoningEffort" || option.id === "effort" || option.id === "variant"),
  );
  if (!descriptorOption || descriptorOption.type !== "select") {
    return new Set();
  }
  return new Set(
    descriptorOption.options
      .map((option) => normalized(option.id))
      .filter((effort): effort is string => effort !== null) ?? [],
  );
}

function descriptorByModel(
  runtimeModels: ReadonlyArray<ProviderModelDescriptor>,
): ReadonlyMap<string, ProviderModelDescriptor> {
  const descriptors = new Map<string, ProviderModelDescriptor>();
  for (const descriptor of runtimeModels) {
    const slug = normalized(descriptor.slug);
    if (!slug) continue;
    if (!descriptors.has(slug)) descriptors.set(slug, descriptor);
  }
  return descriptors;
}

function makeChoice(
  model: string,
  effort: ComposerCodexPowerEffort,
  descriptors: ReadonlyMap<string, ProviderModelDescriptor>,
): ComposerCodexPowerChoice | null {
  const descriptor = descriptors.get(model);
  if (!descriptor || !advertisedEffortsForDescriptor(descriptor).has(effort)) {
    return null;
  }
  const modelLabel = modelLabelForDescriptor(descriptor);
  const effortLabel = POWER_EFFORT_LABELS[effort];
  return {
    // The selectable slug is the only model identifier the compact surface may
    // publish. `resolvedModel` is transport metadata and must never manufacture
    // a canonical slug that the account did not advertise as selectable.
    model: descriptor.slug as ModelSlug,
    modelLabel,
    reasoningEffort: effort,
    optionId: CODEX_POWER_EFFORT_OPTION_ID,
    effortLabel,
    label: `${modelLabel} ${effortLabel}`,
    isUltra: effort === "ultra",
  };
}

function dedupeChoices(
  choices: ReadonlyArray<ComposerCodexPowerChoice>,
): ReadonlyArray<ComposerCodexPowerChoice> {
  const seen = new Set<string>();
  const result: ComposerCodexPowerChoice[] = [];
  for (const choice of choices) {
    const key = `${choice.model}\u0000${choice.reasoningEffort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(choice);
  }
  return result;
}

function resolveDefaultPair(
  input: ResolverInput,
  descriptors: ReadonlyMap<string, ProviderModelDescriptor>,
): { readonly model: string | null; readonly effort: string | null } {
  // Moss does not expose a separate default-model flag. In that case the
  // selected runtime descriptor is the catalog's default-model candidate and
  // its default effort is the only safe default to infer.
  const model = normalized(input.defaultModel) ?? normalized(input.model);
  const descriptor = model ? descriptors.get(model) : undefined;
  const effort =
    normalized(input.defaultReasoningEffort) ?? normalized(descriptor?.defaultReasoningEffort);
  return { model, effort };
}

function findChoiceIndex(
  choices: ReadonlyArray<ComposerCodexPowerChoice>,
  model: string | null,
  effort: string | null,
): number | null {
  if (!model || !effort) return null;
  const index = choices.findIndex(
    (choice) => choice.model.toLowerCase() === model && choice.reasoningEffort === effort,
  );
  return index >= 0 ? index : null;
}

/**
 * Resolves the account-scoped compact Codex power choices.
 *
 * The function deliberately accepts only runtime model descriptors. Static
 * capability defaults can keep the advanced picker alive, but cannot create a
 * compact choice that the selected account did not advertise.
 */
export function resolveComposerCodexPowerOptions(input: ResolverInput): ComposerCodexPowerOptions {
  const runtimeModels = input.runtimeModels ?? [];
  const descriptors = descriptorByModel(runtimeModels);
  const primaryChoices = dedupeChoices(
    PRIMARY_POWER_PAIRS.flatMap(([model, effort]) => {
      const choice = makeChoice(model, effort, descriptors);
      return choice ? [choice] : [];
    }),
  );

  const choices =
    primaryChoices.length >= 3
      ? primaryChoices
      : dedupeChoices(
          TERRA_FALLBACK_EFFORTS.flatMap((effort) => {
            const choice = makeChoice("gpt-5.6-terra", effort, descriptors);
            return choice ? [choice] : [];
          }),
        );

  if (choices.length < 3) {
    return {
      choices: [],
      selectedIndex: null,
      fallbackChoice: null,
      fallbackIndex: null,
    };
  }

  const currentModel = normalized(input.model);
  const currentEffort = normalized(input.reasoningEffort);
  const selectedIndex = findChoiceIndex(choices, currentModel, currentEffort);
  const defaultPair = resolveDefaultPair(input, descriptors);

  const solChoices = choices.filter((choice) => choice.model.toLowerCase() === "gpt-5.6-sol");
  const fallbackChoice =
    (findChoiceIndex(choices, defaultPair.model, defaultPair.effort) !== null
      ? choices[findChoiceIndex(choices, defaultPair.model, defaultPair.effort)!]
      : undefined) ??
    solChoices.find((choice) => choice.reasoningEffort === defaultPair.effort) ??
    solChoices.find((choice) => choice.reasoningEffort === "medium") ??
    solChoices[0] ??
    choices.find((choice) => choice.reasoningEffort === "medium") ??
    choices[0] ??
    null;
  const fallbackIndex = fallbackChoice ? choices.indexOf(fallbackChoice) : null;

  return {
    choices,
    selectedIndex,
    fallbackChoice,
    fallbackIndex,
  };
}

export function composerCodexPowerChoiceLabel(
  choice: ComposerCodexPowerChoice,
  labels?: Partial<Record<string, string>>,
): string {
  return `${choice.modelLabel} ${labels?.[choice.reasoningEffort] ?? choice.effortLabel}`;
}

export type ComposerPowerEffortLevel = {
  readonly value: string;
  readonly label: string;
  readonly isDefault?: boolean;
};

export type ComposerPowerOptionsInput = {
  readonly provider: ProviderKind;
  readonly model: string | null | undefined;
  /** Display label for the current model, already stripped of any vendor prefix. */
  readonly modelLabel: string;
  /** Provider option key that stores the effort for this provider/model. */
  readonly optionId: string;
  /** The current model's advertised effort levels, in descriptor order. */
  readonly effortLevels: ReadonlyArray<ComposerPowerEffortLevel>;
  readonly effort: string | null | undefined;
  readonly defaultEffort?: string | null | undefined;
  /** Levels that are applied through the prompt (e.g. Claude ultrathink) never get a tick. */
  readonly excludedEfforts?: ReadonlyArray<string>;
  /** Runtime catalog, used only for the Codex-bundled Terra→Sol ladder. */
  readonly runtimeModels?: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
  readonly defaultModel?: string | null | undefined;
  readonly defaultReasoningEffort?: string | null | undefined;
};

/** A slider needs at least two stops to say anything. */
export const COMPOSER_POWER_MIN_CHOICES = 2;

const EMPTY_POWER_OPTIONS: ComposerCodexPowerOptions = {
  choices: [],
  selectedIndex: null,
  fallbackChoice: null,
  fallbackIndex: null,
};

function orderEffortLevels(
  levels: ReadonlyArray<ComposerPowerEffortLevel>,
): ReadonlyArray<ComposerPowerEffortLevel> {
  const ranked = levels.map((level) => CANONICAL_EFFORT_RANK.get(normalized(level.value) ?? ""));
  if (ranked.some((rank) => rank === undefined)) return levels;
  return levels
    .map((level, index) => ({ level, rank: ranked[index]! }))
    .toSorted((a, b) => a.rank - b.rank)
    .map((entry) => entry.level);
}

/**
 * Resolves the compact power ladder for whatever model is selected.
 *
 * Codex's Terra and Sol keep the bundled cross-model ladder that Codex Desktop shows.
 * Every other model — Codex or not — gets one tick per effort level it advertises, in
 * canonical low→high order, so the slider always reflects that vendor's real options.
 */
export function resolveComposerPowerOptions(
  input: ComposerPowerOptionsInput,
): ComposerCodexPowerOptions {
  const model = normalized(input.model);
  if (input.provider === "codex" && model && CODEX_BUNDLED_POWER_MODELS.has(model)) {
    const bundled = resolveComposerCodexPowerOptions({
      runtimeModels: input.runtimeModels,
      model: input.model,
      reasoningEffort: input.effort,
      defaultModel: input.defaultModel,
      defaultReasoningEffort: input.defaultReasoningEffort,
    });
    if (bundled.choices.length >= 3) return bundled;
  }
  if (!model) return EMPTY_POWER_OPTIONS;

  // Codex stays fail-closed: only efforts the signed-in account's runtime catalog
  // advertises may become ticks. Other providers' effort lists are already the same
  // capability data their advanced menu renders, so they are trusted as-is.
  let advertised: ReadonlySet<string> | null = null;
  if (input.provider === "codex") {
    const descriptor = descriptorByModel(input.runtimeModels ?? []).get(model);
    if (!descriptor) return EMPTY_POWER_OPTIONS;
    advertised = advertisedEffortsForDescriptor(descriptor);
  }

  const excluded = new Set((input.excludedEfforts ?? []).map((value) => normalized(value)));
  const levels = orderEffortLevels(
    input.effortLevels.filter((level) => {
      const value = normalized(level.value);
      return (
        value !== null && !excluded.has(value) && (advertised === null || advertised.has(value))
      );
    }),
  );
  if (levels.length < COMPOSER_POWER_MIN_CHOICES) return EMPTY_POWER_OPTIONS;

  const choices: ComposerCodexPowerChoice[] = levels.map((level) => ({
    model: input.model as ModelSlug,
    modelLabel: input.modelLabel,
    reasoningEffort: level.value,
    optionId: input.optionId,
    effortLabel: level.label,
    label: `${input.modelLabel} ${level.label}`,
    isUltra: input.provider === "codex" && normalized(level.value) === "ultra",
  }));

  const currentEffort = normalized(input.effort);
  const selectedIndex = choices.findIndex(
    (choice) => normalized(choice.reasoningEffort) === currentEffort,
  );
  const defaultEffort = normalized(input.defaultEffort);
  const fallbackChoice =
    choices.find((choice) => normalized(choice.reasoningEffort) === defaultEffort) ??
    choices.find(
      (choice) => levels.find((level) => level.value === choice.reasoningEffort)?.isDefault,
    ) ??
    choices[Math.floor((choices.length - 1) / 2)] ??
    null;

  return {
    choices,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
    fallbackChoice,
    fallbackIndex: fallbackChoice ? choices.indexOf(fallbackChoice) : null,
  };
}
