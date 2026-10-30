// FILE: composerEffortLabel.ts
// Purpose: Resolves the compact composer effort label without collapsing runtime-only values.
// Layer: Chat composer presentation helper

import type { ProviderKind } from "@synara/contracts";

type ComposerEffortLevel = {
  readonly value: string;
  readonly label: string;
};

export type LocalizedComposerEffortLabels = {
  readonly none: string;
  readonly minimal: string;
  readonly low: string;
  readonly medium: string;
  readonly high: string;
  readonly extraHigh: string;
  readonly thinking: string;
  readonly ultra: string;
};

export type LocalizedSpecialComposerEffortLabels = Pick<
  LocalizedComposerEffortLabels,
  "thinking" | "ultra"
>;

export const EN_SPECIAL_COMPOSER_EFFORT_LABELS: LocalizedSpecialComposerEffortLabels = {
  thinking: "Thinking",
  ultra: "Ultra",
};

function formatRuntimeEffortValue(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

// Antigravity exposes these two normalized values at runtime. Match by value,
// not display text, so arbitrary runtime labels remain untouched.
export function resolveSpecialComposerEffortLabel(input: {
  readonly provider: ProviderKind;
  readonly effort: string;
  readonly fallbackLabel: string;
  readonly localized: LocalizedSpecialComposerEffortLabels;
}): string {
  if (input.provider !== "antigravity") {
    return input.fallbackLabel;
  }

  switch (input.effort) {
    case "thinking":
      return input.localized.thinking;
    case "ultra":
      return input.localized.ultra;
    default:
      return input.fallbackLabel;
  }
}

export function resolveComposerEffortLabel(input: {
  readonly provider: ProviderKind;
  readonly effort: string | null;
  readonly effortLevels: ReadonlyArray<ComposerEffortLevel>;
  readonly localized: LocalizedComposerEffortLabels;
}): string | null {
  const { effort } = input;
  if (!effort) {
    return null;
  }

  switch (effort) {
    case "none":
      return input.localized.none;
    case "minimal":
      return input.localized.minimal;
    case "low":
      return input.localized.low;
    case "medium":
      return input.localized.medium;
    case "high":
      return input.localized.high;
    case "xhigh":
      return input.localized.extraHigh;
    case "thinking":
    case "ultra":
      return resolveSpecialComposerEffortLabel({
        provider: input.provider,
        effort,
        fallbackLabel:
          input.effortLevels.find((level) => level.value === effort)?.label ??
          formatRuntimeEffortValue(effort),
        localized: input.localized,
      });
    default:
      return (
        input.effortLevels.find((level) => level.value === effort)?.label ??
        formatRuntimeEffortValue(effort)
      );
  }
}
