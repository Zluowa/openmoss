import { MessageId, TurnId } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { makeActivity } from "~/storeTestFixtures";
import { deriveTimelineEntries, deriveWorkLogEntries, type TimelineEntry } from "~/workLog";

import { codexOwnerTimelineEntries } from "~/test/fixtures/codexOwnerImageTurn.timeline";

import { isWrapUpTimelineEntry, resolveWrapUpPlan } from "./wrapUpPlan";

const turn = TurnId.makeUnsafe("turn-1");
const wrapUp = (id: string, input: Record<string, unknown>): TimelineEntry => ({
  id,
  kind: "work",
  createdAt: "2026-11-04T00:00:00.000Z",
  entry: {
    id,
    createdAt: "2026-11-04T00:00:00.000Z",
    label: "Tool call",
    tone: "tool",
    turnId: turn,
    itemType: "mcp_tool_call",
    toolName: "mcp__moss__moss_wrap_up",
    detail: `moss_wrap_up: ${JSON.stringify(input)}`,
  },
});
const userMessage = (id: string, text: string): TimelineEntry => ({
  id,
  kind: "message",
  createdAt: "2026-11-04T00:01:00.000Z",
  message: {
    id: MessageId.makeUnsafe(id),
    role: "user",
    text,
    createdAt: "2026-11-04T00:01:00.000Z",
    streaming: false,
  } as unknown as Extract<TimelineEntry, { kind: "message" }>["message"],
});
const asking = {
  recap: "Merged; CN not switched.",
  ask: "Topped up?",
  actions: [{ label: "Topped up" }, { label: "Not yet" }],
};

describe("resolveWrapUpPlan", () => {
  it("keeps a box with a question live until the person answers", () => {
    const plan = resolveWrapUpPlan([wrapUp("w1", asking)]);
    expect(plan.live?.box.ask).toBe("Topped up?");
    expect(plan.live?.turnId).toBe(turn);
    expect(plan.settledByUserMessageId.size).toBe(0);
  });

  it("settles above the answer and records a picked button", () => {
    const plan = resolveWrapUpPlan([wrapUp("w1", asking), userMessage("u1", " topped up ")]);
    expect(plan.live).toBeNull();
    expect(plan.settledByUserMessageId.get("u1")).toEqual({
      box: {
        recap: "Merged; CN not switched.",
        ask: "Topped up?",
        actions: ["Topped up", "Not yet"],
      },
      answer: "Topped up",
    });
  });

  it("settles unanswered when the person writes something else", () => {
    const plan = resolveWrapUpPlan([
      wrapUp("w1", asking),
      userMessage("u1", "Do the CN switch first"),
    ]);
    expect(plan.settledByUserMessageId.get("u1")?.answer).toBeNull();
  });

  it.each(["agent", "automation"] as const)(
    "does not treat a %s message as the person's answer",
    (dispatchOrigin) => {
      const message = userMessage("peer-1", "Topped up");
      if (message.kind !== "message") throw new Error("Expected a message fixture");
      message.message.dispatchOrigin = dispatchOrigin;
      const plan = resolveWrapUpPlan([wrapUp("w1", asking), message]);
      expect(plan.live?.box.ask).toBe("Topped up?");
      expect(plan.settledByUserMessageId.size).toBe(0);
      const answered = resolveWrapUpPlan([
        wrapUp("w1", asking),
        message,
        userMessage("human-1", "Not yet"),
      ]);
      expect(answered.live).toBeNull();
      expect(answered.settledByUserMessageId.get("human-1")?.answer).toBe("Not yet");
    },
  );

  it("draws nothing for a box without a question", () => {
    const plan = resolveWrapUpPlan([
      wrapUp("w1", { recap: "All done." }),
      userMessage("u1", "thanks"),
    ]);
    expect(plan.live).toBeNull();
    expect(plan.settledByUserMessageId.size).toBe(0);
  });

  it("keeps a pending question attached to its own reply when a later turn completes", () => {
    const firstReply = userMessage("assistant-1", "Please choose an answer.");
    const laterReply = userMessage("assistant-2", "The peer's work is done.");
    if (firstReply.kind !== "message" || laterReply.kind !== "message") {
      throw new Error("Expected message fixtures");
    }
    firstReply.message.role = "assistant";
    firstReply.message.turnId = turn;
    laterReply.message.role = "assistant";
    laterReply.message.turnId = TurnId.makeUnsafe("peer-turn");
    const plan = resolveWrapUpPlan([wrapUp("w1", asking), firstReply, laterReply]);
    expect(plan.live?.afterMessageId).toBe("assistant-1");
  });

  it("recognizes wrap-up rows so they never show as tool calls", () => {
    expect(isWrapUpTimelineEntry(wrapUp("w1", asking))).toBe(true);
    expect(isWrapUpTimelineEntry(userMessage("u1", "hi"))).toBe(false);
  });

  // Codex reports an MCP call with its arguments in `data.arguments` and no
  // `detail` string. The owner's 2026-11-17 chat asked a question this way and
  // the box never drew.
  it("reads the box from a Codex MCP call's arguments (real payload)", () => {
    const entries = codexOwnerTimelineEntries();
    const wrapUpEntries = entries.filter(isWrapUpTimelineEntry);
    expect(wrapUpEntries.length).toBeGreaterThan(0);
    const plan = resolveWrapUpPlan(entries);
    expect(plan.live?.box.ask).toBe("现在的角色位置和大小合适吗？");
    expect(plan.live?.box.actions).toEqual(["保持这样", "调整位置"]);
    expect(plan.live?.box.recap).toContain("Moss");
    const lastAssistant = entries.findLast(
      (entry) => entry.kind === "message" && entry.message.role === "assistant",
    );
    expect(plan.live?.afterMessageId).toBe(lastAssistant?.id);
  });

  it("reads the box from a Codex MCP call whose arguments arrive as JSON text", () => {
    const entry = wrapUp("w1", asking);
    if (entry.kind !== "work") throw new Error("Expected a work entry");
    const { detail: _detail, ...withoutDetail } = entry.entry;
    const codexEntry: TimelineEntry = {
      ...entry,
      entry: {
        ...withoutDetail,
        mcpToolResult: {
          callId: "call-1",
          server: "moss",
          tool: "moss_wrap_up",
          status: "completed",
          arguments: JSON.stringify(asking),
        } as never,
      },
    };
    expect(resolveWrapUpPlan([codexEntry]).live?.box.ask).toBe("Topped up?");
  });

  // Lead review of #648, item 8: Claude's stored detail is cut to 397 characters
  // plus "..." (ClaudeAdapter summarizeToolRequest); the full arguments are in
  // data.input. A long recap must still draw the box, whole.
  it("draws the box for a Claude call whose arguments are longer than the stored detail", () => {
    const input = {
      recap: `${"已把聊天背景换成透明人物图，并在浅色和深色主题下各检查了一遍。".repeat(9)}完。`,
      ask: `${"请看一下聊天窗口右下角的人物，".repeat(4)}现在的角色位置和大小合适吗？`,
      actions: [{ label: "保持这样" }, { label: "调整位置" }],
    };
    const toolName = "mcp__moss__moss_wrap_up";
    const serialized = JSON.stringify(input);
    expect(serialized.length).toBeGreaterThan(400);
    const detail = `${toolName}: ${serialized.slice(0, 397)}...`;
    const payload = {
      itemType: "mcp_tool_call",
      status: "completed",
      title: toolName,
      detail,
      data: { toolCallId: "toolu_wrap", callId: "toolu_wrap", toolName, input },
    };
    const activities = [
      makeActivity({
        id: "wrap-start",
        createdAt: "2026-11-17T04:40:00.000Z",
        kind: "tool.started",
        summary: toolName,
        turnId: "claude-turn",
        payload: { ...payload, status: "inProgress" },
      }),
      makeActivity({
        id: "wrap-done",
        createdAt: "2026-11-17T04:40:01.000Z",
        kind: "tool.completed",
        summary: toolName,
        turnId: "claude-turn",
        payload,
      }),
    ];
    const entries = deriveTimelineEntries(
      [],
      [],
      deriveWorkLogEntries(activities, TurnId.makeUnsafe("claude-turn")),
    );
    const plan = resolveWrapUpPlan(entries);
    expect(plan.live?.box.ask).toBe(input.ask);
    expect(plan.live?.box.actions).toEqual(["保持这样", "调整位置"]);
    expect(plan.live?.box.recap).toBe(input.recap);
  });
});
