import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAgentFeedback } from "../agentFeedback/Layers/AgentFeedback.ts";
import {
  AGENT_FEEDBACK_MAX_REPORTS_PER_THREAD,
  AGENT_FEEDBACK_MAX_REPORTS_PER_TURN,
  makeAgentGatewayAgentFeedbackTool,
} from "./agentFeedbackTool.ts";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-agent-feedback-tool-"));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

const setup = async () => {
  const store = await Effect.runPromise(
    makeAgentFeedback({ filePath: path.join(directory, "agent-feedback.json") }),
  );
  const tool = makeAgentGatewayAgentFeedbackTool({ agentFeedback: store });
  const call = (
    input: Record<string, unknown>,
    threadId = "thread-1",
    turnId: string | null = "turn-1",
  ) =>
    Effect.runPromise(
      tool.handler(input, {
        callerThreadId: threadId,
        callerProvider: "codex",
        callerTurnId: turnId,
      } as Parameters<typeof tool.handler>[1]),
    );
  return { store, tool, call };
};

const payload = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) => {
  const first = result.content[0];
  return JSON.parse(first?.type === "text" ? (first.text ?? "{}") : "{}") as {
    recorded: boolean;
    occurrences: number;
  };
};

describe("moss_report_friction", () => {
  it("is offered to every thread and asks for a summary and a severity", async () => {
    const { tool } = await setup();
    expect(tool.definition.name).toBe("moss_report_friction");
    expect(tool.requiredCapability).toBe("thread:read");
    expect(tool.definition.inputSchema.required).toEqual(["summary", "severity"]);
  });

  it("records a report with the caller's thread and runtime", async () => {
    const { store, call } = await setup();
    const result = await call({
      summary: "moss_pages_mutate rejected a heading level without saying which levels work",
      severity: "friction",
      tool: "moss_pages_mutate",
      proposedFix: "List the accepted levels in the error.",
    });
    expect(result.isError).not.toBe(true);
    expect(payload(result)).toMatchObject({ recorded: true, occurrences: 1 });
    const [entry] = await Effect.runPromise(store.list);
    expect(entry).toMatchObject({
      tool: "moss_pages_mutate",
      severity: "friction",
      providers: ["codex"],
      threadIds: ["thread-1"],
      proposedFix: "List the accepted levels in the error.",
    });
  });

  it("refuses a report without a summary or with an unknown severity", async () => {
    const { call } = await setup();
    expect((await call({ severity: "blocker" })).isError).toBe(true);
    expect((await call({ summary: "x", severity: "urgent" })).isError).toBe(true);
  });

  it("tells the agent when the same problem was already reported", async () => {
    const { call } = await setup();
    await call({
      summary: "Search returns stale threads",
      severity: "idea",
      tool: "moss_list_threads",
    });
    const again = await call(
      { summary: "search returns stale threads.", severity: "idea", tool: "moss_list_threads" },
      "thread-2",
    );
    expect(payload(again).occurrences).toBe(2);
  });

  it("caps reports per turn and per thread so a looping agent cannot flood the store", async () => {
    const { store, call } = await setup();
    for (let i = 1; i <= AGENT_FEEDBACK_MAX_REPORTS_PER_TURN; i += 1) {
      const result = await call(
        { summary: `Turn 1 problem ${i}`, severity: "friction" },
        "t1",
        "turn-a",
      );
      expect(result.isError).not.toBe(true);
    }
    const overTurn = await call(
      { summary: "Turn 1 overflow", severity: "friction" },
      "t1",
      "turn-a",
    );
    expect(overTurn.isError).toBe(true);

    // Subsequent turns on the same thread work up to the per-thread cap, then stop.
    let remaining = AGENT_FEEDBACK_MAX_REPORTS_PER_THREAD - AGENT_FEEDBACK_MAX_REPORTS_PER_TURN;
    let turnIndex = 2;
    while (remaining > 0) {
      const batch = Math.min(remaining, AGENT_FEEDBACK_MAX_REPORTS_PER_TURN);
      for (let i = 1; i <= batch; i += 1) {
        const result = await call(
          { summary: `Turn ${turnIndex} problem ${i}`, severity: "idea" },
          "t1",
          `turn-${turnIndex}`,
        );
        expect(result.isError).not.toBe(true);
      }
      remaining -= batch;
      turnIndex += 1;
    }
    const overThread = await call(
      { summary: "Thread overflow", severity: "blocker" },
      "t1",
      `turn-${turnIndex}`,
    );
    expect(overThread.isError).toBe(true);

    // Another thread is unaffected.
    const otherThread = await call(
      { summary: "Separate thread problem", severity: "friction" },
      "t2",
      "turn-1",
    );
    expect(otherThread.isError).not.toBe(true);
    expect(await Effect.runPromise(store.list)).toHaveLength(
      AGENT_FEEDBACK_MAX_REPORTS_PER_THREAD + 1,
    );
  });
});
