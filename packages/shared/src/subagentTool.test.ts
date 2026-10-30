import { describe, expect, it } from "vitest";
import { decodeSubagentActivity, normalizeSubagentToolData } from "./subagentTool";
import { decodeSubagentReceiverAgents, decodeSubagentReceiverThreadIds } from "./subagents";

describe("structured harness subagent normalization", () => {
  it.each(["started", "interacted", "interrupted", "completed"])(
    "retains native %s activity as a chip with an actual child identity",
    (kind) => {
      const native = {
        type: "subAgentActivity",
        id: `activity-${kind}`,
        kind,
        agentThreadId: "provider-child",
        agentPath: "/root/check_hello",
      };
      const data = normalizeSubagentToolData("codex", native);
      expect(decodeSubagentActivity(data)).toEqual({
        kind,
        threadId: "provider-child",
        nickname: "Check hello",
      });
      expect(decodeSubagentReceiverThreadIds(data)).toEqual(["provider-child"]);
      expect(data.action).toBeUndefined();
      expect(data.agentsStates).toEqual({
        "provider-child": {
          status: kind === "completed" || kind === "interrupted" ? kind : "running",
        },
      });
      expect(normalizeSubagentToolData("codex", data)).toEqual(data);
    },
  );

  it("does not manufacture native activities from unrelated tool output or missing identity", () => {
    for (const data of [
      { type: "subAgentActivity", kind: "started", agentPath: "/root/check" },
      { type: "subAgentActivity", kind: "future-kind", agentThreadId: "child" },
      { type: "subAgentActivity", kind: ["started"], agentThreadId: "child" },
      {
        toolName: "Read",
        output: '{"type":"subAgentActivity","kind":"started","agentThreadId":"child"}',
      },
    ]) {
      expect(decodeSubagentActivity(data)).toBeUndefined();
      expect(normalizeSubagentToolData("codex", data)).toBe(data);
    }
  });
  it.each(["Task", "Agent"])(
    "maps Claude %s with real receiver identity to the common action",
    (toolName) => {
      const input = { prompt: "Review the parser", subagent_type: "reviewer" };
      const data = normalizeSubagentToolData("claudeAgent", {
        toolName,
        toolCallId: "tool-1",
        receiverThreadId: "tool-1",
        nickname: "Cedar",
        input,
      });
      expect(data).toMatchObject({
        action: "spawnAgent",
        toolName,
        receiverThreadId: "tool-1",
        input,
      });
      expect(
        decodeSubagentReceiverAgents(data, decodeSubagentReceiverThreadIds(data))[0],
      ).toMatchObject({
        providerThreadId: "tool-1",
        nickname: "Cedar",
      });
      expect(
        normalizeSubagentToolData("claudeAgent", {
          ...data,
          action: undefined,
          input: { resume: "agent-real" },
        }).action,
      ).toBe("resumeAgent");
    },
  );

  it("preserves native Codex actions, including wait and messaging aliases", () => {
    expect(normalizeSubagentToolData("codex", { tool: "spawnAgent" }).action).toBe("spawnAgent");
    expect(normalizeSubagentToolData("codex", { tool: "send_input" }).action).toBe("sendInput");
    expect(normalizeSubagentToolData("codex", { tool: "wait" }).action).toBe("waitAgent");
  });

  it("normalizes OpenCode metadata without inventing pending child sessions", () => {
    const task = {
      tool: "task",
      input: { description: "Birch", prompt: "Read the tests", subagent_type: "explore" },
    };
    const pending = normalizeSubagentToolData("opencode", {
      ...task,
      state: { status: "pending" },
    });
    expect(pending.action).toBe("spawnAgent");
    expect(decodeSubagentReceiverThreadIds(pending)).toEqual([]);
    for (const status of ["running", "completed", "error"]) {
      const data = normalizeSubagentToolData("opencode", {
        ...task,
        state: { status, metadata: { sessionID: "session-child" } },
      });
      expect(data).toMatchObject({
        receiverThreadId: "session-child",
        agentNickname: "Birch",
        prompt: "Read the tests",
      });
      expect(data.agentsStates).toEqual({
        "session-child": { status: status === "error" ? "errored" : status },
      });
    }
  });

  it("does not turn task lists, arbitrary tool names, output text or another provider into subagents", () => {
    for (const data of [
      { toolName: "Task" },
      { toolName: "TaskList", receiverThreadId: "x" },
      { toolName: "agent_browser", receiverThreadId: "x" },
      { toolName: "Read", output: '{"action":"spawnAgent","receiverThreadId":"x"}' },
    ])
      expect(normalizeSubagentToolData("claudeAgent", data)).toBe(data);
    const data = { toolName: "Agent", receiverThreadId: "x" };
    expect(normalizeSubagentToolData("pi", data)).toBe(data);
  });
});
