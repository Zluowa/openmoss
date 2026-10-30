// Deterministic structured fixtures, not recordings of live provider sessions.
import { EventId, TurnId, OrchestrationThreadActivity } from "@synara/contracts";
import { normalizeSubagentToolData } from "@synara/shared/subagentTool";
import { Schema } from "effect";
import { deriveWorkLogEntries } from "../../workLog";

export const PARITY9_TURN_ID = TurnId.makeUnsafe("parity9-turn");
export const PARITY9_STARTED_AT = "2026-09-05T12:00:00.000Z";
export type Parity9Provider = "codex" | "claudeAgent" | "opencode";

export function parity9Activity(
  id: string,
  kind: OrchestrationThreadActivity["kind"],
  payload: unknown,
  seconds = 0,
): OrchestrationThreadActivity {
  return Schema.decodeUnknownSync(OrchestrationThreadActivity)({
    id: EventId.makeUnsafe(id),
    kind,
    payload,
    turnId: PARITY9_TURN_ID,
    createdAt: new Date(Date.parse(PARITY9_STARTED_AT) + seconds * 1000).toISOString(),
    summary: kind,
    tone: kind.startsWith("turn.") ? "info" : "tool",
  });
}

export function parity9SubagentActivity(
  provider: Parity9Provider,
  status: "inProgress" | "completed" | "failed" = "inProgress",
): OrchestrationThreadActivity {
  const callId = "parity9-spawn";
  const childId = "parity9-child";
  const prompt = "Review the transcript and report the result.";
  const state = status === "inProgress" ? "running" : status === "failed" ? "errored" : "completed";
  const data =
    provider === "codex"
      ? {
          item: {
            id: callId,
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status,
            receiverThreads: [{ threadId: childId, agentNickname: "Cedar", agentRole: "reviewer" }],
            prompt,
            agentsStates: { [childId]: { status: state } },
          },
        }
      : provider === "claudeAgent"
        ? normalizeSubagentToolData(provider, {
            toolCallId: callId,
            toolName: "Agent",
            receiverThreadId: childId,
            nickname: "Cedar",
            agentType: "reviewer",
            prompt,
            input: { description: "Cedar", prompt, subagent_type: "reviewer" },
            agentsStates: { [childId]: { status: state } },
          })
        : normalizeSubagentToolData(provider, {
            toolCallId: callId,
            tool: "task",
            toolName: "task",
            input: { description: "Cedar", prompt, subagent_type: "reviewer" },
            state: {
              status:
                status === "inProgress" ? "running" : status === "failed" ? "error" : "completed",
              metadata: { sessionId: childId },
            },
          });
  return parity9Activity(
    `parity9-${provider}-${status}`,
    status === "inProgress" ? "tool.started" : "tool.completed",
    { provider, itemType: "collab_agent_tool_call", status, data },
    status === "inProgress" ? 0 : 10,
  );
}

export function parity9SubagentEntries(
  provider: Parity9Provider,
  status: "inProgress" | "completed" | "failed",
) {
  const started = parity9SubagentActivity(provider);
  return deriveWorkLogEntries(
    status === "inProgress" ? [started] : [started, parity9SubagentActivity(provider, status)],
    PARITY9_TURN_ID,
  );
}

export function parity9BackgroundActivities(
  state: "running" | "finished" | "interrupted",
  processId: string | undefined = "process-9",
) {
  const command = "python3 /home/user/.codex/skills/pdf/scripts/render.py";
  const item = {
    id: "bg-command",
    type: "commandExecution",
    command,
    cwd: "/workspace/project",
    ...(processId ? { processId } : {}),
    status: "inProgress",
    aggregatedOutput: "\u001b[32mgreen tick\u001b[0m\n\u001b[31mred stderr\u001b[0m\n",
  };
  return [
    parity9Activity("bg-start", "tool.started", {
      itemType: "command_execution",
      status: "inProgress",
      data: { item },
    }),
    parity9Activity(
      "owner-settled",
      state === "interrupted" ? "turn.aborted" : "turn.completed",
      {},
      2,
    ),
    ...(state === "finished"
      ? [
          parity9Activity(
            "bg-done",
            "tool.completed",
            {
              itemType: "command_execution",
              status: "completed",
              data: {
                item: {
                  ...item,
                  status: "completed",
                  exitCode: 0,
                  aggregatedOutput: `${item.aggregatedOutput}Complete.\n`,
                },
              },
            },
            9,
          ),
        ]
      : []),
  ];
}
