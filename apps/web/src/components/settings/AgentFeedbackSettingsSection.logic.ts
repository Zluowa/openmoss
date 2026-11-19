// FILE: AgentFeedbackSettingsSection.logic.ts
// Purpose: Turns one agent feedback note into the report Moss sends, and orders the notes.
// Layer: Settings UI logic (pure)
// Exports: agentFeedbackAgents, agentFeedbackDraft, agentFeedbackReportId,
//   agentFeedbackThreadContext, sortAgentFeedback

import { PROVIDER_DISPLAY_NAMES, type AgentFeedbackEntry } from "@moss/contracts";

import type { FeedbackCategory, FeedbackThreadContext } from "~/feedback";
import type { TranslationKey } from "~/localization";

type Format = (key: TranslationKey, values: Record<string, string | number>) => string;

/** The agents who hit it, as the person's language lists names ("Codex和Claude"). */
export function agentFeedbackAgents(entry: AgentFeedbackEntry, locale: string): string {
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(
    entry.providers.map((provider) => PROVIDER_DISPLAY_NAMES[provider]),
  );
}

/**
 * The report text, read the way the row reads: what happened, then why and what would help,
 * then one quiet line on who hit it. Sending previews it in full first.
 */
export function agentFeedbackDraft(
  entry: AgentFeedbackEntry,
  t: (key: TranslationKey) => string,
  format: Format,
  locale: string,
): { details: string; category: FeedbackCategory } {
  const agents = agentFeedbackAgents(entry, locale);
  const body = [
    entry.details,
    entry.proposedFix ? format("agentFeedback.proposedFix", { fix: entry.proposedFix }) : null,
  ].filter((line): line is string => Boolean(line));
  const source = [
    format("agentFeedback.draftSource", { agents: agents || "Moss" }),
    t(`agentFeedback.severity.${entry.severity}`),
    entry.occurrences > 1
      ? format("agentFeedback.occurrences", { count: entry.occurrences })
      : null,
    entry.tool,
  ].filter((part): part is string => Boolean(part));
  const paragraphs = [entry.summary, body.join("\n"), source.join(" · ")].filter(Boolean);
  return { details: paragraphs.join("\n\n"), category: entry.severity === "idea" ? "idea" : "bug" };
}

const SEVERITY_ORDER: Record<AgentFeedbackEntry["severity"], number> = {
  blocker: 0,
  friction: 1,
  idea: 2,
};

/** What stopped agents first, then what keeps coming back, then the newest. */
export function sortAgentFeedback(
  entries: ReadonlyArray<AgentFeedbackEntry>,
): ReadonlyArray<AgentFeedbackEntry> {
  return entries.toSorted(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.occurrences - a.occurrences ||
      b.lastReportedAt.localeCompare(a.lastReportedAt),
  );
}

/** Only the agent that last reported it; a note carries no chat, path or log. */
export function agentFeedbackThreadContext(entry: AgentFeedbackEntry): FeedbackThreadContext {
  return {
    provider: entry.providers[0] ?? null,
    model: null,
    projectKind: null,
    environmentMode: null,
    runtimeMode: null,
    interactionMode: null,
    sessionStatus: null,
    latestTurnState: null,
    messageCount: 0,
    activityCount: 0,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    hasThreadError: false,
  };
}

/** The note's own 32 hex digits in report-ID form: one note is one report, retries included. */
export function agentFeedbackReportId(entry: AgentFeedbackEntry): string {
  const hex = entry.id.slice(entry.id.indexOf(":") + 1);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
