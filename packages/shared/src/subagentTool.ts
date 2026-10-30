// Normalize structured provider tool data before ingestion and during history replay.
// Native data stays intact; action/receiver fields are the shared UI contract.
import { normalizeMultiAgentAction } from "./subagentActions";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type SubagentActivityKind = "started" | "interacted" | "interrupted" | "completed";

/** Codex's native activity item is a chip event, distinct from a collab action. */
export function decodeSubagentActivity(
  data: Record<string, unknown> | null | undefined,
): { threadId: string; kind: SubagentActivityKind; nickname?: string } | undefined {
  if (data?.type !== "subAgentActivity") return undefined;
  const threadId = text(data.agentThreadId);
  const kind = data.kind;
  if (
    !threadId ||
    (kind !== "started" && kind !== "interacted" && kind !== "interrupted" && kind !== "completed")
  ) {
    return undefined;
  }
  // Same path label rule as the desktop: the last non-root segment, sentence case.
  const leaf = text(data.agentPath)
    ?.split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "root")
    .at(-1);
  const name = leaf?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return {
    threadId,
    kind,
    ...(name ? { nickname: name[0]!.toUpperCase() + name.slice(1) } : {}),
  };
}

export function normalizeSubagentToolData(
  provider: string | undefined,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const activity =
    provider === "codex" || provider === undefined ? decodeSubagentActivity(data) : undefined;
  if (activity) {
    return {
      ...data,
      receiverThreadId: activity.threadId,
      ...(activity.nickname ? { agentNickname: activity.nickname } : {}),
      agentsStates: {
        [activity.threadId]: {
          status:
            activity.kind === "completed" || activity.kind === "interrupted"
              ? activity.kind
              : "running",
        },
      },
    };
  }
  const tool = text(data.toolName) ?? text(data.tool) ?? text(data.name);
  const explicitAction = normalizeMultiAgentAction(text(data.action) ?? tool);
  const input = record(data.input);
  // Exact SDK tools only. Names containing "agent" or arbitrary tool output
  // must never manufacture child sessions or turn task lists into agent actions.
  const isClaudeTask =
    (provider === "claudeAgent" || provider === undefined) &&
    (tool === "Task" || tool === "Agent") &&
    text(data.receiverThreadId) !== undefined;
  const isOpenCodeTask = provider === "opencode" && tool === "task";
  const action =
    explicitAction ??
    (isClaudeTask
      ? text(input?.resume)
        ? "resumeAgent"
        : "spawnAgent"
      : isOpenCodeTask
        ? text(input?.task_id)
          ? "resumeAgent"
          : "spawnAgent"
        : undefined);
  if (!action) return data;

  if (!isOpenCodeTask) return { ...data, action };
  const state = record(data.state);
  const metadata = record(state?.metadata) ?? record(data.metadata);
  const receiverThreadId = text(metadata?.sessionId) ?? text(metadata?.sessionID);
  // Pending OpenCode tasks may not have created a session yet. Keep their
  // Creating action, but wait for provider identity before projecting a child.
  if (!receiverThreadId) return { ...data, action };
  const nickname = text(input?.description);
  const role = text(input?.subagent_type);
  const prompt = text(input?.prompt);
  const status =
    state?.status === "completed"
      ? "completed"
      : state?.status === "error"
        ? "errored"
        : state?.status === "running"
          ? "running"
          : "pendingInit";
  return {
    ...data,
    action,
    receiverThreadId,
    ...(nickname ? { agentNickname: nickname } : {}),
    ...(role ? { agentRole: role } : {}),
    ...(prompt ? { prompt } : {}),
    agentsStates: { [receiverThreadId]: { status } },
  };
}
