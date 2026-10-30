import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { projectCodexSnapshotHistory, codexReplayChildThreadIds } from "./codexReplay";
import { CodexRolloutHistory } from "../workspaceImport/codexRollout";

const now = "2026-09-06T08:56:21.000Z";
const threadId = ThreadId.makeUnsafe("replay-parent");
const sourceItems = [
  { type: "userMessage", id: "u1", content: [{ type: "text", text: "Inspect hello.txt" }] },
  { type: "agentMessage", id: "a1", text: "Please send the instructions.", phase: "final_answer" },
  { type: "userMessage", id: "u2", content: [{ type: "text", text: "Check the byte count." }] },
  { type: "agentMessage", id: "a2", text: "I’ll check the file.", phase: "commentary" },
  { type: "reasoning", id: "hidden", summary: [], content: ["private trace"] },
  {
    type: "commandExecution",
    id: "exec",
    command: "wc -c hello.txt",
    cwd: "/tmp",
    status: "completed",
    aggregatedOutput: "17 hello.txt\n",
    exitCode: 0,
    durationMs: 0,
  },
  {
    type: "subAgentActivity",
    id: "agent",
    kind: "completed",
    agentThreadId: "native-child",
    agentPath: "/root/check_hello",
  },
  {
    type: "mcpToolCall",
    id: "mcp",
    server: "cua_repl",
    tool: "js",
    status: "completed",
    arguments: { code: "await cua.getState();" },
    result: { content: [{ type: "text", text: "UI unavailable" }] },
    durationMs: 350,
  },
  { type: "agentMessage", id: "a3", text: "Confirmed 17 bytes.", phase: "final_answer" },
];

describe("canonical Codex replay", () => {
  it("retains source order, real duration, steering, Shell, MCP and child identity", () => {
    const turns = [
      {
        id: "turn",
        items: sourceItems,
        status: "completed",
        startedAt: 1788684904,
        completedAt: 1788684981,
        durationMs: 77544,
      },
    ];
    const entries = projectCodexSnapshotHistory({ threadId, importedAt: now, turns });
    const messages = entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "assistant",
    ]);
    expect(messages.every((message) => message.turnId === "turn")).toBe(true);
    const activities = entries.flatMap((entry) =>
      entry.kind === "activity" ? [entry.activity] : [],
    );
    expect(activities.some((activity) => JSON.stringify(activity).includes("17 hello.txt"))).toBe(
      true,
    );
    expect(activities.some((activity) => JSON.stringify(activity).includes("cua_repl"))).toBe(true);
    expect(JSON.stringify(activities)).not.toContain("private trace");
    const replay = activities.find((activity) => activity.kind === "codex.turn.replayed")!.payload;
    expect(replay).toMatchObject({
      durationMs: 77544,
      terminalMessageId: "codex-import:replay-parent:a3",
    });
    if (replay === null || typeof replay !== "object" || Array.isArray(replay)) {
      throw new Error("missing replay marker payload");
    }
    expect((replay as { entries: unknown[] }).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "codex-import:replay-parent:exec",
          item: expect.objectContaining({
            itemId: "exec",
            itemType: "commandExecution",
            lifecycle: "completed",
            durationMs: 0,
          }),
        }),
        expect.objectContaining({
          id: "codex-import:replay-parent:agent",
          item: expect.objectContaining({
            childThreadIds: ["native-child"],
          }),
        }),
      ]),
    );
    const shell = activities.find((activity) => activity.kind === "tool.completed");
    expect(shell?.payload).toEqual(
      expect.objectContaining({
        replayItem: expect.objectContaining({ itemId: "exec", itemType: "commandExecution" }),
      }),
    );
    expect(codexReplayChildThreadIds(turns)).toEqual(["native-child"]);
    // Re-reading the same snapshot does not invent new item ids.
    expect(projectCodexSnapshotHistory({ threadId, importedAt: now, turns })).toEqual(entries);
  });

  it("keeps interrupted turn and in-progress item states native-shaped", () => {
    const entries = projectCodexSnapshotHistory({
      threadId,
      importedAt: now,
      turns: [
        {
          id: "interrupted-turn",
          status: "aborted",
          items: [
            {
              id: "running-child",
              type: "commandExecution",
              status: "in_progress",
              parent_turn_id: "parent-turn",
              startedAt: "2026-09-06T08:56:20.000Z",
            },
          ],
        },
      ],
    });
    const replay = entries.find(
      (entry) => entry.kind === "activity" && entry.activity.kind === "codex.turn.replayed",
    );
    expect(replay && replay.kind === "activity" ? replay.activity.payload : null).toMatchObject({
      status: "interrupted",
      entries: [
        {
          item: {
            lifecycle: "started",
            status: "inProgress",
            parentTurnId: "parent-turn",
          },
        },
      ],
    });
    const terminal = entries.find(
      (entry) => entry.kind === "activity" && entry.activity.kind === "turn.completed",
    );
    expect(terminal && terminal.kind === "activity" ? terminal.activity.payload : null).toEqual({
      state: "interrupted",
    });
  });

  it("normalizes canonical rollout items and ignores duplicate transport copies", () => {
    const nativeCwd = resolve("/tmp");
    const history = new CodexRolloutHistory();
    const add = (payload: Record<string, unknown>) =>
      history.add({ type: "event_msg", payload }, now);
    add({ type: "task_started", turn_id: "turn", started_at: 1788684904 });
    add({ type: "user_message", message: "transport duplicate" });
    add({
      type: "item_completed",
      turn_id: "turn",
      item: {
        type: "AgentMessage",
        id: "a",
        phase: "commentary",
        content: [{ type: "Text", text: "Checking." }],
      },
      started_at_ms: 1788684904310,
      completed_at_ms: 1788684904687,
    });
    add({
      type: "item_completed",
      turn_id: "turn",
      item: {
        type: "CommandExecution",
        id: "exec",
        command: ["/bin/bash", "-lc", "wc -c hello.txt"],
        cwd: pathToFileURL(nativeCwd).href,
        parsed_cmd: [{ type: "unknown", cmd: "wc -c hello.txt" }],
        duration: { secs: 0, nanos: 60450 },
        aggregated_output: "17 hello.txt\n",
        exit_code: 0,
      },
    });
    add({
      type: "item_completed",
      turn_id: "turn",
      item: { type: "Reasoning", id: "r", summary_text: [], raw_content: ["private"] },
    });
    add({ type: "task_complete", turn_id: "turn", completed_at: 1788684981, duration_ms: 77544 });
    const snapshot = history.snapshot()!;
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.items).toHaveLength(3);
    expect(snapshot[0]!.items[1]).toMatchObject({
      type: "commandExecution",
      command: "wc -c hello.txt",
      cwd: nativeCwd,
      durationMs: 0,
      aggregatedOutput: "17 hello.txt\n",
      exitCode: 0,
    });
    expect(snapshot[0]!.itemTimes?.a).toEqual({
      createdAt: "2026-09-06T08:55:04.310Z",
      updatedAt: "2026-09-06T08:55:04.687Z",
    });
    expect(JSON.stringify(snapshot)).not.toContain("private");
    expect(snapshot[0]).toMatchObject({ status: "completed", durationMs: 77544 });
  });
});
