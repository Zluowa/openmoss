// FILE: subagentActions.ts
// Purpose: Normalize provider multi-agent action/status aliases for work-log and timeline UI.

export type MultiAgentAction =
  | "spawnAgent"
  | "sendInput"
  | "sendMessage"
  | "followupTask"
  | "resumeAgent"
  | "closeAgent"
  | "interruptAgent"
  | "listAgents"
  | "waitAgent";

export type MultiAgentActionStatus = "inProgress" | "completed" | "failed" | "interrupted";

export type MultiAgentAgentState =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "shutdown"
  | "completed"
  | "errored"
  | "notFound";

function compactIdentifier(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "") ?? ""
  );
}

/** Normalizes the snake/camel aliases emitted by supported provider runtimes. */
export function normalizeMultiAgentAction(
  value: string | null | undefined,
): MultiAgentAction | null {
  switch (compactIdentifier(value)) {
    case "spawn":
    case "spawnagent":
      return "spawnAgent";
    case "interaction":
    case "sendinput":
      return "sendInput";
    case "sendmessage":
      return "sendMessage";
    case "followup":
    case "followuptask":
      return "followupTask";
    case "resume":
    case "resumeagent":
      return "resumeAgent";
    case "close":
    case "closeagent":
      return "closeAgent";
    case "interrupt":
    case "interruptagent":
      return "interruptAgent";
    case "list":
    case "listagents":
      return "listAgents";
    case "wait":
    case "waitagent":
      return "waitAgent";
    default:
      return null;
  }
}

export function isTimelineMultiAgentAction(value: string | null | undefined): boolean {
  const action = normalizeMultiAgentAction(value);
  return action !== null && action !== "waitAgent";
}

export function normalizeMultiAgentActionStatus(
  value: string | null | undefined,
): MultiAgentActionStatus | null {
  switch (compactIdentifier(value)) {
    case "inprogress":
    case "pending":
    case "queued":
    case "running":
    case "started":
    case "starting":
      return "inProgress";
    case "complete":
    case "completed":
    case "done":
    case "finished":
    case "success":
    case "succeeded":
      return "completed";
    case "error":
    case "errored":
    case "failed":
    case "failure":
      return "failed";
    case "aborted":
    case "canceled":
    case "cancelled":
    case "interrupted":
    case "stopped":
      return "interrupted";
    default:
      return null;
  }
}

/** Matches Codex aggregate priority: live, then failure, then interruption, then success. */
export function aggregateMultiAgentActionStatus(
  statuses: ReadonlyArray<string | null | undefined>,
): MultiAgentActionStatus {
  let result: MultiAgentActionStatus = "completed";
  for (const status of statuses) {
    const normalized = normalizeMultiAgentActionStatus(status);
    if (normalized === "inProgress") return "inProgress";
    if (normalized === "failed") result = "failed";
    else if (normalized === "interrupted" && result === "completed") result = "interrupted";
  }
  return result;
}

export function normalizeMultiAgentAgentState(
  value: string | null | undefined,
): MultiAgentAgentState | null {
  switch (compactIdentifier(value)) {
    case "pending":
    case "pendinginit":
    case "queued":
    case "starting":
      return "pendingInit";
    case "active":
    case "inprogress":
    case "running":
    case "working":
      return "running";
    case "aborted":
    case "canceled":
    case "cancelled":
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "closed":
    case "shutdown":
      return "shutdown";
    case "complete":
    case "completed":
    case "done":
    case "finished":
    case "success":
    case "succeeded":
      return "completed";
    case "error":
    case "errored":
    case "failed":
    case "failure":
      return "errored";
    case "missing":
    case "notfound":
      return "notFound";
    default:
      return null;
  }
}

export function countMultiAgentActionAgents(
  items: ReadonlyArray<{
    subagents?: ReadonlyArray<{
      threadId: string;
      providerThreadId?: string | undefined;
    }>;
  }>,
): number {
  const uniqueAgentIds = new Set<string>();
  for (const item of items) {
    for (const subagent of item.subagents ?? []) {
      const id = (subagent.providerThreadId ?? subagent.threadId).trim();
      if (id) uniqueAgentIds.add(id);
    }
  }
  return uniqueAgentIds.size > 0 ? uniqueAgentIds.size : items.length;
}
