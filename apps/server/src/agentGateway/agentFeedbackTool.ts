// FILE: agentFeedbackTool.ts
// Purpose: The `moss_report_friction` agent tool: an agent records where a Moss tool got in
//   its way (a confusing error, a missing parameter or capability, a wrong result, a
//   workaround it needed) and, when it has one, the fix it would make.
// Layer: Agent gateway tool
// Exports: AGENT_FEEDBACK_TOOL_DESCRIPTION, AGENT_FEEDBACK_MAX_REPORTS_PER_TURN,
//   AGENT_FEEDBACK_MAX_REPORTS_PER_THREAD, makeAgentGatewayAgentFeedbackTool
// Why: Agents meet Moss's rough edges first and forget them at the end of the turn.
//   Recording them where the person can see and send them turns real use into fixes.

import {
  AGENT_FEEDBACK_DETAILS_MAX_LENGTH,
  AGENT_FEEDBACK_PROPOSED_FIX_MAX_LENGTH,
  AGENT_FEEDBACK_SUMMARY_MAX_LENGTH,
  AGENT_FEEDBACK_TOOL_MAX_LENGTH,
  AGENT_FEEDBACK_TOOL_NAME,
  type AgentFeedbackSeverity,
  ThreadId,
} from "@moss/contracts";
import { Effect } from "effect";

import type { AgentFeedbackShape } from "../agentFeedback/Services/AgentFeedback.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import type { ToolEntry } from "./toolRuntime.ts";

const SEVERITIES: ReadonlyArray<AgentFeedbackSeverity> = ["blocker", "friction", "idea"];
export const AGENT_FEEDBACK_MAX_REPORTS_PER_TURN = 5;
export const AGENT_FEEDBACK_MAX_REPORTS_PER_THREAD = 15;
const MAX_TRACKED_RATE_KEYS = 512;

function bumpCappedCounter(map: Map<string, number>, key: string): number {
  const next = (map.get(key) ?? 0) + 1;
  map.delete(key);
  map.set(key, next);
  while (map.size > MAX_TRACKED_RATE_KEYS) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
  return next;
}

export const AGENT_FEEDBACK_TOOL_DESCRIPTION =
  "Tell the Moss team where a Moss tool got in your way, so it gets fixed. Call it right after it " +
  "happens, then carry on with the task: when a Moss tool returned an error you could not act on, " +
  "lacked a parameter or capability you needed, returned something wrong or confusing, or made you " +
  "use a workaround. Do not call it for problems in the person's own code or setup, for model or " +
  "network outages, or for anything the person asked you to do differently. One call per distinct " +
  "problem: reporting the same problem again only adds to its count. summary: one plain sentence " +
  "naming what went wrong. tool: the Moss tool's name, when one is involved. details: what you " +
  "called, what you expected and what happened. proposedFix: the change to the tool you would " +
  "make, when you have one. severity: blocker (you could not finish), friction (you finished the " +
  "hard way) or idea (it worked, but could be better). Write summary, details and proposedFix in " +
  "the person's language: they read these notes. Never include secrets, " +
  "file contents or the person's private text. The report stays on this computer until the person " +
  "chooses to send it, and nothing is shown in the chat, so do not mention it to them.";

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export function makeAgentGatewayAgentFeedbackTool(input: {
  readonly agentFeedback: AgentFeedbackShape;
}): ToolEntry {
  const reportsByTurn = new Map<string, number>();
  const reportsByThread = new Map<string, number>();
  return {
    requiredCapability: "thread:read",
    definition: {
      name: AGENT_FEEDBACK_TOOL_NAME,
      description: AGENT_FEEDBACK_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: `One sentence: what went wrong (≤${AGENT_FEEDBACK_SUMMARY_MAX_LENGTH} chars).`,
          },
          severity: {
            type: "string",
            enum: [...SEVERITIES],
            description:
              "blocker: could not finish; friction: finished the hard way; idea: could be better.",
          },
          tool: {
            type: "string",
            description: `The Moss tool involved, such as moss_pages_mutate (≤${AGENT_FEEDBACK_TOOL_MAX_LENGTH} chars).`,
          },
          details: {
            type: "string",
            description: `What you called, what you expected, what happened (≤${AGENT_FEEDBACK_DETAILS_MAX_LENGTH} chars).`,
          },
          proposedFix: {
            type: "string",
            description: `The change to the tool you would make (≤${AGENT_FEEDBACK_PROPOSED_FIX_MAX_LENGTH} chars).`,
          },
        },
        required: ["summary", "severity"],
        additionalProperties: false,
      },
      annotations: {
        title: "Report friction with a Moss tool",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args, context) => {
      const summary = text(args.summary);
      if (summary === null) return Effect.succeed(mcpToolResultError("summary is required."));
      const severity = SEVERITIES.find((candidate) => candidate === args.severity);
      if (severity === undefined)
        return Effect.succeed(
          mcpToolResultError("severity must be one of blocker, friction or idea."),
        );
      const turnKey =
        context.callerTurnId !== null && context.callerTurnId !== undefined
          ? `${context.callerThreadId}\0${context.callerTurnId}`
          : null;
      if (
        turnKey !== null &&
        (reportsByTurn.get(turnKey) ?? 0) >= AGENT_FEEDBACK_MAX_REPORTS_PER_TURN
      ) {
        return Effect.succeed(
          mcpToolResultError(
            `Turn feedback limit reached (${AGENT_FEEDBACK_MAX_REPORTS_PER_TURN} per turn). Carry on with the task.`,
          ),
        );
      }
      if (
        (reportsByThread.get(context.callerThreadId) ?? 0) >= AGENT_FEEDBACK_MAX_REPORTS_PER_THREAD
      ) {
        return Effect.succeed(
          mcpToolResultError(
            `Thread feedback limit reached (${AGENT_FEEDBACK_MAX_REPORTS_PER_THREAD} per thread). Carry on with the task.`,
          ),
        );
      }
      if (turnKey !== null) bumpCappedCounter(reportsByTurn, turnKey);
      bumpCappedCounter(reportsByThread, context.callerThreadId);
      return input.agentFeedback
        .record({
          severity,
          summary,
          details: text(args.details),
          tool: text(args.tool),
          proposedFix: text(args.proposedFix),
          provider: context.callerProvider,
          threadId: ThreadId.makeUnsafe(context.callerThreadId),
        })
        .pipe(
          Effect.map((result) =>
            mcpToolResultJson({
              recorded: true,
              occurrences: result.occurrences,
              note:
                result.occurrences > 1
                  ? `This problem has now been reported ${result.occurrences} times. Carry on with the task.`
                  : "Recorded. Carry on with the task.",
            }),
          ),
          Effect.catch((error) => Effect.succeed(mcpToolResultError(error.message))),
        );
    },
  };
}
