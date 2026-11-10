// FILE: wrapUpTool.ts
// Purpose: The `moss_wrap_up` agent tool: fills the next-step box Moss draws at the end
//   of a turn (a short recap and, when the person must decide or act, one question with
//   1-2 answer buttons). The box itself is drawn by the transcript from the call's input;
//   the tool only validates it and tells the agent to write its closing message next.
// Layer: Agent gateway tool

import { WRAP_UP_LIMITS, WRAP_UP_TOOL_NAME, parseWrapUp } from "@moss/shared/wrapUp";
import { Effect } from "effect";

import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";

export const WRAP_UP_TOOL_DESCRIPTION =
  'Fill the "next step" box Moss shows at the end of your turn: a two-or-three-sentence recap and, ' +
  "when this turn leaves the person a decision to make or a step to take, one question and 1-2 buttons " +
  "that answer it. Call it once, when the turn's work is done and before your closing message, in every " +
  "turn where you changed files, ran commands or did multi-step work; skip it for short answers and " +
  "pure conversation. recap: what is now true, then what is not done or not verified, in the person's " +
  `language, at most ${WRAP_UP_LIMITS.recapChars} characters. ask: only when the next move is theirs, ` +
  `one decision in one short sentence (at most ${WRAP_UP_LIMITS.askChars} characters), with no reason, ` +
  "recommendation or list of the options. actions: 1-2 buttons, your recommendation first, each label " +
  `1-3 words (at most ${WRAP_UP_LIMITS.actionLabelChars} characters) written as the person's own answer; ` +
  "a click sends that label back to you as their message. Omit ask and actions when nothing waits on them. " +
  "Never point at other parts of the conversation from the recap; link another Moss thread as " +
  "[its title](moss://thread/<threadId>) so it shows as a live chip. After this call, write your closing " +
  "message: your full answer, which the recap never replaces.";

export function makeAgentGatewayWrapUpTool(): ToolEntry {
  return {
    requiredCapability: "thread:read",
    definition: {
      name: WRAP_UP_TOOL_NAME,
      description: WRAP_UP_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          recap: {
            type: "string",
            description: `What is now true and what is not done or verified (≤${WRAP_UP_LIMITS.recapChars} chars).`,
          },
          ask: {
            type: "string",
            description: `One decision for the person, when the next move is theirs (≤${WRAP_UP_LIMITS.askChars} chars).`,
          },
          actions: {
            type: "array",
            maxItems: WRAP_UP_LIMITS.maxActions,
            description: "1-2 answers to ask, the recommended one first.",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: `The person's answer, 1-3 words (≤${WRAP_UP_LIMITS.actionLabelChars} chars).`,
                },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
        },
        required: ["recap"],
        additionalProperties: false,
      },
      annotations: { title: "Wrap up the turn", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (input) =>
      Effect.sync(() => {
        const box = parseWrapUp(input);
        if (box === null) return mcpToolResultError("recap is required.");
        return mcpToolResultJson({
          shown: true,
          hasQuestion: box.ask !== null,
          note:
            box.ask === null
              ? "The box shows your recap. Write your closing message now."
              : "The box shows your recap, question and buttons. Write your closing message now; do not ask the question again.",
        });
      }),
  };
}
