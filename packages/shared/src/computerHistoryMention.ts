// FILE: computerHistoryMention.ts
// Purpose: Canonical Moss-owned composer reference for explicit Computer History context.
// Layer: Shared runtime utilities (consumed by web and server)
// Exports: Stable reference identity, token, and type guard.

import type { ProviderMentionReference } from "@synara/contracts";

/** Stable pseudo-reference used only to carry an explicit Computer History selection. */
export const COMPUTER_HISTORY_MENTION_NAME = "Computer History" as const;
export const COMPUTER_HISTORY_MENTION_PATH = "moss://computer-history" as const;
export const COMPUTER_HISTORY_MENTION_TOKEN = `@${COMPUTER_HISTORY_MENTION_PATH}` as const;

export const COMPUTER_HISTORY_MENTION_REFERENCE = {
  name: COMPUTER_HISTORY_MENTION_NAME,
  path: COMPUTER_HISTORY_MENTION_PATH,
} as const satisfies ProviderMentionReference;

export function isComputerHistoryMention(
  reference: Pick<ProviderMentionReference, "name" | "path">,
): boolean {
  return (
    reference.name === COMPUTER_HISTORY_MENTION_NAME &&
    reference.path === COMPUTER_HISTORY_MENTION_PATH
  );
}
