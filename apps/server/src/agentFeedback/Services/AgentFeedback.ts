// FILE: AgentFeedback.ts
// Purpose: The service that keeps agent feedback: what agents report through
//   `moss_report_friction`, merged by tool and summary, stored only on this computer.
// Layer: Server service tag
// Exports: AgentFeedback, AgentFeedbackError, AgentFeedbackShape, AgentFeedbackReportInput, AgentFeedbackRecordResult

import type {
  AgentFeedbackEntry,
  AgentFeedbackId,
  AgentFeedbackSeverity,
  ProviderKind,
  ThreadId,
} from "@moss/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

/** The feedback file could not be written; nothing about the report reaches the caller. */
export class AgentFeedbackError extends Schema.TaggedErrorClass<AgentFeedbackError>()(
  "AgentFeedbackError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect) },
) {}

export interface AgentFeedbackReportInput {
  readonly severity: AgentFeedbackSeverity;
  readonly summary: string;
  readonly details: string | null;
  readonly tool: string | null;
  readonly proposedFix: string | null;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
}

export interface AgentFeedbackRecordResult {
  readonly id: AgentFeedbackId;
  /** How many times this friction has now been reported, this one included. */
  readonly occurrences: number;
}

export interface AgentFeedbackShape {
  /** Records a report, or counts it against the entry that already has its tool and summary. */
  readonly record: (
    input: AgentFeedbackReportInput,
  ) => Effect.Effect<AgentFeedbackRecordResult, AgentFeedbackError>;
  /** Newest report first. */
  readonly list: Effect.Effect<ReadonlyArray<AgentFeedbackEntry>>;
  /** Removes one entry; a later report of the same friction starts a new one. */
  readonly dismiss: (id: AgentFeedbackId) => Effect.Effect<void, AgentFeedbackError>;
}

export class AgentFeedback extends ServiceMap.Service<AgentFeedback, AgentFeedbackShape>()(
  "moss/agentFeedback/Services/AgentFeedback",
) {}
