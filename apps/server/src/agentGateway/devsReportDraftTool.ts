// FILE: devsReportDraftTool.ts
// Purpose: The `moss_draft_devs_report` agent tool: an agent writes up a problem the person
//   met in Moss and the chat shows it as a report card. The person opens the same review
//   dialog as `@devs` from the card and decides whether it is sent.
// Layer: Agent gateway tool
// Exports: DEVS_REPORT_DRAFT_TOOL_DESCRIPTION, DEVS_REPORT_DRAFT_MAX_PER_TURN,
//   DEVS_REPORT_DRAFT_MAX_PER_THREAD, makeAgentGatewayDevsReportDraftTool
// Why: The agent saw the failure and can describe it better than the person can, but only
//   the person may decide that anything leaves their computer.

import { randomBytes } from "node:crypto";

import {
  CommandId,
  DEVS_REPORT_DRAFT_ACTIVITY_KIND,
  DEVS_REPORT_DRAFT_DETAILS_MAX_LENGTH,
  DEVS_REPORT_DRAFT_SUMMARY_MAX_LENGTH,
  DEVS_REPORT_DRAFT_TOOL_NAME,
  type DevsReportDraftActivityPayload,
  type DevsReportDraftId,
  EventId,
  ThreadId,
  TurnId,
} from "@moss/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { errorText } from "./toolInput.ts";
import type { ToolEntry } from "./toolRuntime.ts";

/** A person can send three reports a day; more drafts than that only crowd the chat. */
export const DEVS_REPORT_DRAFT_MAX_PER_TURN = 1;
export const DEVS_REPORT_DRAFT_MAX_PER_THREAD = 3;
const MAX_TRACKED_KEYS = 512;

export const DEVS_REPORT_DRAFT_TOOL_DESCRIPTION =
  "Draft a report to the Moss developers about a problem the person met in Moss, so they can " +
  "send it with one click instead of writing it up themselves. Call it when the person asks you " +
  "to report something to the Moss developers, or when you and the person hit what looks like a " +
  "fault in Moss itself (the app, a Moss tool, a Moss panel, or Moss's connection to you) that " +
  "got in the way of their task. Do not call it for problems in the person's own code, files or " +
  "setup, for a request you can simply carry out, or again for a problem you already drafted in " +
  "this chat. For a rough edge in a Moss tool that only you noticed, use moss_report_friction " +
  "instead. summary: one plain sentence naming what went wrong. details: what the person was " +
  "doing, what happened, what they expected, and anything that shows when it happens. Write " +
  "both in the person's language: they read the report before it is sent. Never include " +
  "secrets, passwords, file contents or private text. The chat shows the report as a card; " +
  "nothing is sent until the person reviews it and chooses to send it. After the call, tell " +
  "the person in one short sentence that a report is ready for them to review in the chat, " +
  "then carry on.";

const text = (value: unknown, max: number, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return trimmed.length > 0 ? trimmed : null;
};

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
  while (map.size > MAX_TRACKED_KEYS) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export function makeAgentGatewayDevsReportDraftTool(input: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly newDraftId?: () => DevsReportDraftId;
}): ToolEntry {
  const newDraftId =
    input.newDraftId ??
    (() => `devs-draft:${randomBytes(16).toString("hex")}` as DevsReportDraftId);
  const draftsByTurn = new Map<string, number>();
  const draftsByThread = new Map<string, number>();
  return {
    requiredCapability: "thread:write",
    definition: {
      name: DEVS_REPORT_DRAFT_TOOL_NAME,
      description: DEVS_REPORT_DRAFT_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: `One sentence: what went wrong (≤${DEVS_REPORT_DRAFT_SUMMARY_MAX_LENGTH} chars).`,
          },
          details: {
            type: "string",
            description: `What the person was doing, what happened and what they expected (≤${DEVS_REPORT_DRAFT_DETAILS_MAX_LENGTH} chars).`,
          },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      annotations: {
        title: "Draft a report to the Moss developers",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fields = yield* Effect.try({
          try: () => ({
            summary: text(args.summary, DEVS_REPORT_DRAFT_SUMMARY_MAX_LENGTH, "summary"),
            details: text(args.details, DEVS_REPORT_DRAFT_DETAILS_MAX_LENGTH, "details"),
          }),
          catch: (error) => new Error(errorText(error)),
        });
        if (fields.summary === null) return mcpToolResultError("summary is required.");
        const turnKey =
          context.callerTurnId === null
            ? null
            : `${context.callerThreadId}\0${context.callerTurnId}`;
        if (turnKey !== null && (draftsByTurn.get(turnKey) ?? 0) >= DEVS_REPORT_DRAFT_MAX_PER_TURN)
          return mcpToolResultError("This turn already drafted a report. Carry on with the task.");
        if ((draftsByThread.get(context.callerThreadId) ?? 0) >= DEVS_REPORT_DRAFT_MAX_PER_THREAD)
          return mcpToolResultError(
            `This chat already has ${DEVS_REPORT_DRAFT_MAX_PER_THREAD} drafted reports. Carry on with the task.`,
          );
        const draftId = newDraftId();
        const createdAt = new Date().toISOString();
        yield* input.orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`agent:${draftId}`),
          threadId: ThreadId.makeUnsafe(context.callerThreadId),
          activity: {
            id: EventId.makeUnsafe(draftId),
            tone: "info",
            kind: DEVS_REPORT_DRAFT_ACTIVITY_KIND,
            summary: `Drafted a report for the Moss developers: ${fields.summary}`,
            payload: {
              draftId,
              summary: fields.summary,
              ...(fields.details === null ? {} : { details: fields.details }),
            } satisfies DevsReportDraftActivityPayload,
            turnId: context.callerTurnId === null ? null : TurnId.makeUnsafe(context.callerTurnId),
            createdAt,
          },
          createdAt,
        });
        if (turnKey !== null) bump(draftsByTurn, turnKey);
        bump(draftsByThread, context.callerThreadId);
        return mcpToolResultJson({
          drafted: true,
          sent: false,
          note: "The chat shows the report as a card. Nothing is sent until the person reviews it and chooses to send it. Tell them in one short sentence, then carry on.",
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };
}
