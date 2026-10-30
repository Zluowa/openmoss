// FILE: computerHistoryMentionProjection.ts
// Purpose: Projects the explicit built-in Computer History composer reference into private
//          provider host context while keeping the pseudo-reference out of native mention APIs.
// Layer: Provider prompt compatibility
// Exports: projectComputerHistoryMention, appendComputerHistorySelectionContext.

import type { ProviderMentionReference } from "@synara/contracts";
import {
  COMPUTER_HISTORY_MENTION_TOKEN,
  isComputerHistoryMention,
} from "@synara/shared/computerHistoryMention";

/** Deliberately narrow: remove only the canonical composer token at a token boundary. */
const COMPUTER_HISTORY_MENTION_TOKEN_PATTERN = new RegExp(
  `(^|\\s)${COMPUTER_HISTORY_MENTION_TOKEN.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}(?=\\s|$)`,
  "g",
);

export const COMPUTER_HISTORY_SELECTION_CONTEXT = [
  "<computer_history_selection>",
  "The user explicitly selected Computer History for this request. This is private host context, not user-provided text.",
  "If the read-only history tools are available, call history_status first, then make a narrow history_query (prefer 20 or fewer) only when status reports supported, enabled, and relevant.",
  "History is not implicitly injected; if the tools are unavailable or denied, continue without it. Never request or expose raw event payloads.",
  "</computer_history_selection>",
].join("\n");

export interface ComputerHistoryMentionProjection {
  readonly text: string | undefined;
  readonly mentions: ReadonlyArray<ProviderMentionReference> | undefined;
  readonly selected: boolean;
}

export function projectComputerHistoryMention(input: {
  readonly text: string | undefined;
  readonly mentions: ReadonlyArray<ProviderMentionReference> | undefined;
}): ComputerHistoryMentionProjection {
  const selected = input.mentions?.some(isComputerHistoryMention) ?? false;
  if (!selected) {
    return {
      text: input.text,
      mentions: input.mentions,
      selected: false,
    };
  }

  const mentions = input.mentions?.filter((mention) => !isComputerHistoryMention(mention));
  const text = input.text?.replace(COMPUTER_HISTORY_MENTION_TOKEN_PATTERN, "$1");
  return {
    text,
    mentions: mentions && mentions.length > 0 ? mentions : undefined,
    selected: true,
  };
}

/** Appends the host-only selection guidance exactly once. */
export function appendComputerHistorySelectionContext(input: {
  readonly text: string | undefined;
  readonly selected: boolean;
}): string | undefined {
  if (!input.selected) return input.text;
  if (input.text?.includes(COMPUTER_HISTORY_SELECTION_CONTEXT)) return input.text;
  return input.text
    ? `${input.text}\n\n${COMPUTER_HISTORY_SELECTION_CONTEXT}`
    : COMPUTER_HISTORY_SELECTION_CONTEXT;
}
