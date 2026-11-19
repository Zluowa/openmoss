// FILE: effortLabels.ts
// Purpose: A provider's raw reasoning effort ("max", "xhigh" …) in the words the composer's
//          effort picker uses (chat.effort.*: 最大, 极高 …), for every surface that prints one:
//          workflow cards, the sub-agent run card, list, side panel and tab header.
// Layer: Chat presentation helpers (pure)

import type { TranslationKey } from "../../localization";

type Translate = (key: TranslationKey) => string;

export function localizeKnownWorkflowEffortLabel(t: Translate, effortLabel: string): string {
  switch (effortLabel) {
    case "minimal":
      return t("chat.effort.minimal");
    case "low":
      return t("chat.effort.low");
    case "medium":
      return t("chat.effort.medium");
    case "high":
      return t("chat.effort.high");
    case "xhigh":
      return t("chat.effort.extraHigh");
    case "max":
      return t("chat.effort.max");
    default:
      return effortLabel;
  }
}

/**
 * "GPT-6.1 Terra · max" carries the provider's raw effort; show it in the words the composer's
 * effort picker uses (最大, 高 …) through the same chat.effort.* keys.
 */
export function localizedModelLabel(t: Translate, label: string): string {
  const separator = label.lastIndexOf(" · ");
  const effort = separator === -1 ? label : label.slice(separator + 3);
  const localized = localizeKnownWorkflowEffortLabel(t, effort);
  if (localized === effort) return label;
  return separator === -1 ? localized : `${label.slice(0, separator)} · ${localized}`;
}
