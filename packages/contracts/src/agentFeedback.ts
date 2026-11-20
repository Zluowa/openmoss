// FILE: agentFeedback.ts
// Purpose: Schemas for agent feedback: notes an agent leaves through `moss_report_friction`
//   when a Moss tool got in its way, kept on this computer and listed in Settings.
// Layer: Shared contract (schema only)
// Exports: AGENT_FEEDBACK_* limits, AgentFeedbackSeverity, AgentFeedbackEntry,
//   AgentFeedbackListResult, AgentFeedbackDismissInput
// Why: The same friction reported by many turns is one entry with a count, so the list
//   reads as "what keeps getting in the way", not as a log.

import { Schema } from "effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

export const AGENT_FEEDBACK_TOOL_NAME = "moss_report_friction";
export const AGENT_FEEDBACK_SUMMARY_MAX_LENGTH = 200;
export const AGENT_FEEDBACK_DETAILS_MAX_LENGTH = 2_000;
export const AGENT_FEEDBACK_TOOL_MAX_LENGTH = 100;
export const AGENT_FEEDBACK_PROPOSED_FIX_MAX_LENGTH = 1_000;
/** Entries kept on disk; the oldest by last report go first. */
export const AGENT_FEEDBACK_MAX_ENTRIES = 200;
/** Chats remembered per entry, newest first, so the person can open where it happened. */
export const AGENT_FEEDBACK_MAX_THREADS = 5;
/** Agents remembered per entry, newest first: the faces Settings shows beside a note. */
export const AGENT_FEEDBACK_MAX_PROVIDERS = 3;

export const AgentFeedbackSeverity = Schema.Literals(["blocker", "friction", "idea"]);
export type AgentFeedbackSeverity = typeof AgentFeedbackSeverity.Type;

export const AgentFeedbackId = Schema.String.check(
  Schema.isPattern(/^agent-feedback:[0-9a-f]{32}$/),
);
export type AgentFeedbackId = typeof AgentFeedbackId.Type;

export const AgentFeedbackEntry = Schema.Struct({
  id: AgentFeedbackId,
  severity: AgentFeedbackSeverity,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_FEEDBACK_SUMMARY_MAX_LENGTH)),
  details: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(AGENT_FEEDBACK_DETAILS_MAX_LENGTH)),
  ),
  tool: Schema.NullOr(Schema.String.check(Schema.isMaxLength(AGENT_FEEDBACK_TOOL_MAX_LENGTH))),
  proposedFix: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(AGENT_FEEDBACK_PROPOSED_FIX_MAX_LENGTH)),
  ),
  /** The agents that reported it, most recent first, such as `codex`. */
  providers: Schema.Array(ProviderKind).check(Schema.isMaxLength(AGENT_FEEDBACK_MAX_PROVIDERS)),
  occurrences: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  firstReportedAt: IsoDateTime,
  lastReportedAt: IsoDateTime,
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(AGENT_FEEDBACK_MAX_THREADS)),
});
export type AgentFeedbackEntry = typeof AgentFeedbackEntry.Type;

export const AgentFeedbackListResult = Schema.Struct({
  entries: Schema.Array(AgentFeedbackEntry),
});
export type AgentFeedbackListResult = typeof AgentFeedbackListResult.Type;

export const AgentFeedbackDismissInput = Schema.Struct({ id: AgentFeedbackId });
export type AgentFeedbackDismissInput = typeof AgentFeedbackDismissInput.Type;
