// FILE: providerWorkRun.fixture.ts
// Purpose: One agent turn (think, run, think, read, think, search, think, edit)
//          in the activity shape each provider family persists, for checking
//          that every provider reaches the transcript as the same work log.
// Source: the shapes the server writes. Reasoning: providerRuntimeActivityProjection.ts
//         ("Reasoning trace", shared by Codex, Claude, OpenCode, Antigravity).
//         Calls: Codex app-server items (codexOwnerImageTurn.fixture.ts), Claude
//         tool_use blocks (workLog.test.ts), OpenCode session events
//         (OpenCodeAdapter.ts), ACP tool calls (AcpRuntimeModel.ts).
// Layer: Test fixture

import type { OrchestrationThreadActivity } from "@moss/contracts";

import { deriveAgentActivityTimelineState } from "../../components/chat/agentActivity.logic";
import { makeActivity } from "../../storeTestFixtures";
import { deriveWorkLogEntries, type WorkLogEntry } from "../../workLog";

export type WorkRunProvider = "codex" | "claudeAgent" | "opencode" | "acp";
export const WORK_RUN_PROVIDERS: ReadonlyArray<WorkRunProvider> = [
  "codex",
  "claudeAgent",
  "opencode",
  "acp",
];

export const WORK_RUN_TURN_ID = "turn-unified";

export type WorkRunStep =
  | { kind: "think"; text: string }
  | { kind: "command"; command: string }
  | { kind: "read"; path: string }
  | { kind: "search"; pattern: string; path: string }
  | { kind: "edit"; path: string };

interface Stamp {
  id: string;
  createdAt: string;
}

function activity(
  stamp: Stamp,
  kind: string,
  summary: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return makeActivity({
    id: stamp.id,
    createdAt: stamp.createdAt,
    kind,
    summary,
    tone: "tool",
    turnId: WORK_RUN_TURN_ID,
    // Plain JSON built above; the activity type spells it as `Json`.
    payload: payload as OrchestrationThreadActivity["payload"],
  });
}

function completedCall(stamp: Stamp, payload: Record<string, unknown>) {
  return activity(stamp, "tool.completed", String(payload.title), {
    status: "completed",
    ...payload,
  });
}

const DIFF = "@@ -1 +1 @@\n-const theme = 'light';\n+const theme = 'system';";

function codexCall(stamp: Stamp, step: Exclude<WorkRunStep, { kind: "think" }>) {
  if (step.kind === "edit") {
    return completedCall(stamp, {
      itemType: "file_change",
      title: "File change",
      data: {
        item: {
          type: "fileChange",
          id: `patch-${stamp.id}`,
          changes: [{ path: step.path, kind: { type: "update" }, diff: DIFF }],
          status: "completed",
        },
      },
    });
  }
  const command =
    step.kind === "command"
      ? step.command
      : step.kind === "read"
        ? `cat ${step.path}`
        : `rg -n "${step.pattern}" ${step.path}`;
  const action =
    step.kind === "read"
      ? { type: "read", command, name: step.path.split("/").at(-1), path: step.path }
      : step.kind === "search"
        ? { type: "search", command, query: step.pattern, path: step.path }
        : { type: "unknown", command };
  return completedCall(stamp, {
    itemType: "command_execution",
    title: "Ran command",
    detail: command,
    data: {
      item: {
        type: "commandExecution",
        id: `exec-${stamp.id}`,
        command,
        commandActions: [action],
        aggregatedOutput: "",
        exitCode: 0,
        durationMs: 1200,
      },
    },
  });
}

function claudeCall(stamp: Stamp, step: Exclude<WorkRunStep, { kind: "think" }>) {
  const toolCallId = `toolu_${stamp.id}`;
  switch (step.kind) {
    case "command":
      return completedCall(stamp, {
        itemType: "command_execution",
        title: "Command run",
        detail: `Bash: ${step.command}`,
        data: { toolCallId, toolName: "Bash", input: { command: step.command } },
      });
    case "read":
      return completedCall(stamp, {
        itemType: "dynamic_tool_call",
        title: "Read",
        detail: `Read: ${JSON.stringify({ file_path: step.path })}`,
        data: { toolCallId, toolName: "Read", input: { file_path: step.path } },
      });
    case "search":
      return completedCall(stamp, {
        itemType: "dynamic_tool_call",
        title: "Grep",
        detail: `Grep: ${JSON.stringify({ pattern: step.pattern, path: step.path })}`,
        data: { toolCallId, toolName: "Grep", input: { pattern: step.pattern, path: step.path } },
      });
    case "edit":
      return completedCall(stamp, {
        itemType: "file_change",
        title: "Edit",
        detail: `Edit: ${JSON.stringify({ file_path: step.path })}`,
        data: {
          toolCallId,
          toolName: "Edit",
          input: { file_path: step.path, old_string: "light", new_string: "system" },
        },
      });
  }
}

function openCodeCall(stamp: Stamp, step: Exclude<WorkRunStep, { kind: "think" }>) {
  const callID = `call_${stamp.id}`;
  const base = (tool: string, input: Record<string, unknown>) => ({
    title: tool,
    data: { tool, toolName: tool, toolCallId: callID, callID, input },
  });
  switch (step.kind) {
    case "command":
      return completedCall(stamp, {
        itemType: "command_execution",
        ...base("bash", { command: step.command }),
      });
    case "read":
      return completedCall(stamp, {
        itemType: "dynamic_tool_call",
        ...base("read", { filePath: step.path }),
      });
    case "search":
      return completedCall(stamp, {
        itemType: "dynamic_tool_call",
        ...base("grep", { pattern: step.pattern, path: step.path }),
      });
    case "edit":
      return completedCall(stamp, {
        itemType: "file_change",
        ...base("edit", { filePath: step.path, oldString: "light", newString: "system" }),
      });
  }
}

function acpCall(stamp: Stamp, step: Exclude<WorkRunStep, { kind: "think" }>) {
  const toolCallId = `acp-${stamp.id}`;
  switch (step.kind) {
    case "command":
      return completedCall(stamp, {
        itemType: "command_execution",
        title: "Ran command",
        detail: step.command,
        data: { toolCallId, kind: "execute", command: step.command },
      });
    case "read":
      return completedCall(stamp, {
        itemType: "dynamic_tool_call",
        title: `Read ${step.path}`,
        data: { toolCallId, kind: "read", locations: [{ path: step.path }] },
      });
    case "search":
      return completedCall(stamp, {
        itemType: "dynamic_tool_call",
        title: "Searched",
        detail: step.pattern,
        data: { toolCallId, kind: "search" },
      });
    case "edit":
      return completedCall(stamp, {
        itemType: "file_change",
        title: "Edited",
        data: { toolCallId, kind: "edit", locations: [{ path: step.path }] },
      });
  }
}

const CALL_BUILDERS = {
  codex: codexCall,
  claudeAgent: claudeCall,
  opencode: openCodeCall,
  acp: acpCall,
} satisfies Record<WorkRunProvider, unknown>;

/**
 * The turn's persisted activities. ACP agents stream their thinking instead of
 * persisting reasoning items, so their turn carries only the calls.
 */
export function workRunActivities(
  provider: WorkRunProvider,
  steps: ReadonlyArray<WorkRunStep>,
  startMs = Date.UTC(2026, 10, 20, 16, 0, 0),
  idPrefix: string = provider,
): OrchestrationThreadActivity[] {
  return steps.flatMap((step, index) => {
    const stamp = {
      id: `${idPrefix}-${index}`,
      createdAt: new Date(startMs + index * 1000).toISOString(),
    };
    if (step.kind === "think") {
      if (provider === "acp") return [];
      return [
        activity(
          { ...stamp, id: `provider-reasoning:thread:${stamp.id}` },
          "task.progress",
          "Reasoning trace",
          { status: "completed", detail: step.text, data: { toolCallId: `rs_${stamp.id}` } },
        ),
      ];
    }
    return [CALL_BUILDERS[provider](stamp, step)];
  });
}

/** Work entries as the transcript receives them, the way ChatView derives them. */
export function workRunEntries(activities: OrchestrationThreadActivity[]): WorkLogEntry[] {
  const entries = deriveWorkLogEntries(activities, undefined, { latestTurnState: "completed" });
  return deriveAgentActivityTimelineState(entries).timelineWorkEntries;
}

export const INTERLEAVED_TURN: ReadonlyArray<WorkRunStep> = [
  { kind: "think", text: "**Running the tests**" },
  { kind: "command", command: "bun run test" },
  { kind: "think", text: "**Reading the app**\n\nThe entry point decides the theme." },
  { kind: "read", path: "src/app.ts" },
  { kind: "think", text: "**Searching for settings**" },
  { kind: "search", pattern: "settings", path: "src" },
  { kind: "think", text: "**Editing the app**" },
  { kind: "edit", path: "src/app.ts" },
];
