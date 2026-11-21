import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { DevsReportDraftId, OrchestrationCommand } from "@moss/contracts";

import {
  DEVS_REPORT_DRAFT_MAX_PER_THREAD,
  makeAgentGatewayDevsReportDraftTool,
} from "./devsReportDraftTool.ts";

const setup = () => {
  const dispatched: OrchestrationCommand[] = [];
  let next = 0;
  const tool = makeAgentGatewayDevsReportDraftTool({
    orchestrationEngine: {
      dispatch: (command) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
    },
    newDraftId: () => `devs-draft:${String(++next).padStart(32, "0")}` as DevsReportDraftId,
  });
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
  return { tool, call, dispatched };
};

const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) => {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
};

describe("moss_draft_devs_report", () => {
  it("is a thread write tool that asks for a summary", () => {
    const { tool } = setup();
    expect(tool.definition.name).toBe("moss_draft_devs_report");
    expect(tool.requiredCapability).toBe("thread:write");
    expect(tool.definition.inputSchema.required).toEqual(["summary"]);
    // The agent is told the person decides, so it never claims a report was sent.
    expect(tool.definition.description).toContain("nothing is sent until the person reviews it");
  });

  it("puts the draft in the caller's chat as a card and sends nothing", async () => {
    const { call, dispatched } = setup();
    const result = await call({
      summary: "  白板一直停在「正在加载画布…」  ",
      details: "打开白板后等了两分钟，提示 Please sign in to Moss。",
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ drafted: true, sent: false });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.activity.append",
      threadId: "thread-1",
      activity: {
        kind: "devs.report.drafted",
        tone: "info",
        turnId: "turn-1",
        payload: {
          draftId: `devs-draft:${"1".padStart(32, "0")}`,
          summary: "白板一直停在「正在加载画布…」",
          details: "打开白板后等了两分钟，提示 Please sign in to Moss。",
        },
      },
    });
  });

  it("refuses a draft without a summary or with over-long text, and shows nothing", async () => {
    const { call, dispatched } = setup();
    expect((await call({ summary: "   " })).isError).toBe(true);
    expect((await call({ summary: "x".repeat(201) })).isError).toBe(true);
    expect((await call({ summary: "ok", details: "x".repeat(3001) })).isError).toBe(true);
    expect((await call({ summary: 7 })).isError).toBe(true);
    expect(dispatched).toHaveLength(0);
  });

  it("drafts at most one report a turn and three a chat", async () => {
    const { call, dispatched } = setup();
    expect((await call({ summary: "first" }, "thread-1", "turn-1")).isError).not.toBe(true);
    const again = await call({ summary: "second" }, "thread-1", "turn-1");
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain("Carry on");
    for (let turn = 2; turn <= DEVS_REPORT_DRAFT_MAX_PER_THREAD; turn += 1)
      expect(
        (await call({ summary: `turn ${turn}` }, "thread-1", `turn-${turn}`)).isError,
      ).not.toBe(true);
    expect((await call({ summary: "one more" }, "thread-1", "turn-9")).isError).toBe(true);
    expect((await call({ summary: "other chat" }, "thread-2", "turn-1")).isError).not.toBe(true);
    expect(dispatched).toHaveLength(DEVS_REPORT_DRAFT_MAX_PER_THREAD + 1);
  });
});
