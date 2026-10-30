// FILE: reasoningPresentation.ts
// Purpose: Pure reasoning-item lifecycle and heading helpers for the transcript.
// Layer: Chat presentation helpers
// Exports: Codex-compatible reasoning body/lifecycle presentation

import type { WorkLogEntry, WorkLogLiveActivityState } from "../../workLog";

export type ReasoningPresentationState = "active" | "settled";

const IN_PROGRESS_LIVE_STATES: ReadonlySet<WorkLogLiveActivityState> = new Set([
  "starting",
  "thinking",
  "running_tool",
  "waiting",
  "streaming",
]);

/**
 * A reasoning row is a transcript primitive, not a generic tool row. Keep the
 * label check deliberately narrow so provider activity such as "Reasoning
 * effort" cannot accidentally acquire the reasoning disclosure treatment.
 */
export function isReasoningPresentationEntry(
  entry: Pick<WorkLogEntry, "label" | "toolTitle">,
): boolean {
  const heading = normalizeReasoningLabel(entry.toolTitle ?? entry.label);
  return (
    heading === "reasoning" ||
    heading === "reasoning update" ||
    heading === "reasoning trace" ||
    heading === "reasoning summary"
  );
}

/** Resolves whether the provider item is still streaming reasoning content. */
export function isReasoningPresentationActive(
  entry: Pick<WorkLogEntry, "label" | "toolTitle" | "liveActivity" | "toolStatus">,
): boolean {
  if (!isReasoningPresentationEntry(entry)) {
    return false;
  }
  if (entry.liveActivity && IN_PROGRESS_LIVE_STATES.has(entry.liveActivity.state)) {
    return true;
  }
  return entry.toolStatus === "running";
}

/** Returns the provider-authored body without inventing text for empty items. */
export function reasoningEntryContent(
  entry: Pick<WorkLogEntry, "detail" | "preview" | "label" | "toolTitle">,
): string {
  const content = [entry.detail, entry.preview]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
  return content ?? "";
}

/**
 * Mirrors Codex's active reasoning heading treatment (`kk` in the readable
 * bundle): a complete first bold heading is removed; an unfinished opening
 * `**` is intentionally rendered as no body instead of leaking a fragment.
 */
export function stripActiveReasoningHeading(value: string): string {
  const trimmed = value.trimStart();
  const completeHeading = trimmed.match(/^\*\*([^\n]*?)\*\*/u);
  if (completeHeading) {
    return trimmed.slice(completeHeading[0].length).trimStart();
  }
  return trimmed.startsWith("**") ? "" : trimmed;
}

/**
 * Mirrors Codex's settled reasoning heading treatment (`U` in the readable
 * bundle). It removes only one conservative heading, never a regex-like or
 * comment-looking fragment, and leaves malformed markdown untouched.
 */
export function stripSettledReasoningHeading(value: string): string {
  const trimmed = value.trimStart();

  const boldHeading = trimmed.match(/^\*\*([^\n]*?)\*\*\s*/u);
  if (boldHeading) {
    return trimmed.slice(boldHeading[0].length).trim();
  }

  // Codex accepts only h1-h3 and rejects markdown/control punctuation in the
  // heading text. This keeps a literal regex, code fence, or HTML token intact.
  const markdownHeading = trimmed.match(/^#{1,3}[ \t]+([^#\\*_\x5b\x5d`<>&\r\n]+)(?:\r?\n|$)/u);
  if (markdownHeading?.[1]?.trim()) {
    return trimmed.slice(markdownHeading[0].length).trim();
  }

  // A single strong paragraph is the AST fallback used by Codex for `__text__`.
  // Keep it conservative: it must occupy the first paragraph and have a real
  // closing marker, so an unfinished delimiter is preserved verbatim.
  const strongParagraph = trimmed.match(/^__([^\n]+?)__\s*(?:\r?\n|$)/u);
  if (strongParagraph) {
    return trimmed.slice(strongParagraph[0].length).trim();
  }

  return value;
}

export function resolveReasoningBody(content: string, state: ReasoningPresentationState): string {
  return state === "active"
    ? stripActiveReasoningHeading(content)
    : stripSettledReasoningHeading(content);
}

export function normalizeReasoningLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\u2010-\u2015]/gu, "-")
    .replace(/\s+/gu, " ");
}
