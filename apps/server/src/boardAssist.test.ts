// FILE: boardAssist.test.ts
// Purpose: Tests for server board assist validation, streaming, caching, and error handling.

import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { describe, expect, it } from "vitest";

import {
  parseBoardAssistModel,
  readBoardAssistBody,
  streamBoardAssist,
  streamBoardAssistViaCli,
} from "./boardAssist";
import type { PageAppAiGateway } from "./pages/apps/aiGateway";

const body = {
  board: {
    shapes: [
      { id: "shape:a", type: "note", text: "想法", x: 0, y: 0, w: 200, h: 200, extra: "dropped" },
      { id: "shape:bad", type: "note", x: "0" },
    ],
    truncated: false,
  },
  ask: { text: "@Moss 在这里加一个时间线", via: "comment", pin: { x: 10, y: 20 }, secret: "x" },
  expectedBoard: { pageId: "board-1", scopeSpaceId: null, canvasProjectKey: "proj-1" },
};

async function collect(gateway: PageAppAiGateway) {
  const input = readBoardAssistBody(body)!;
  const events = [];
  for await (const event of streamBoardAssist(gateway, input, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

describe("board assist server", () => {
  it("sanitizes input fields and drops extra properties", () => {
    const input = readBoardAssistBody(body)!;
    expect(input.board.shapes).toEqual([
      { id: "shape:a", type: "note", text: "想法", x: 0, y: 0, w: 200, h: 200 },
    ]);
    expect(input.ask).toEqual({ text: body.ask.text, via: "comment", pin: { x: 10, y: 20 } });
    expect(input.expectedBoard).toEqual(body.expectedBoard);
    expect(readBoardAssistBody({ ask: { text: "", via: "comment" } })).toBeNull();
    expect(readBoardAssistBody({ ask: { text: "hi", via: "chat" } })).toBeNull();
  });

  it("streams model text deltas with the computed tier", async () => {
    let asked: unknown;
    const gateway: PageAppAiGateway = {
      async *ask(request) {
        asked = request;
        yield { type: "text", delta: '{"op":"addNote","text":"一"}\n' };
        yield { type: "done", text: "", model: "moss-stub-model" };
      },
    };
    const events = await collect(gateway);
    expect(events).toEqual([
      { type: "start", tier: "default" },
      { type: "text", delta: '{"op":"addNote","text":"一"}\n' },
      { type: "done", model: "moss-stub-model" },
    ]);
    expect((asked as { tier: string; system: string }).tier).toBe("default");
    expect((asked as { system: string }).system).toContain('{"say":"…"}');
  });

  it("converts capability failures into plain localized SSE error events", async () => {
    const gateway: PageAppAiGateway = {
      // eslint-disable-next-line require-yield -- failure occurs before emitting deltas
      async *ask() {
        throw new PageAppCapabilityError("quota_exceeded", "Your Moss credits are used up.");
      },
    };
    const events = await collect(gateway);
    expect(events.at(-1)).toEqual({
      type: "error",
      code: "quota_exceeded",
      message: "Moss 额度用完了，充值后再试。",
    });
  });

  it("parses configured board assist model selections", () => {
    expect(parseBoardAssistModel("auto")).toBeNull();
    expect(parseBoardAssistModel(undefined)).toBeNull();
    expect(parseBoardAssistModel("claudeAgent:claudeAgent:claude-haiku-4-5")).toEqual({
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      model: "claude-haiku-4-5",
    });
  });

  it("streams CLI-based board edits cleanly", async () => {
    const input = readBoardAssistBody(body)!;
    let capturedPrompt = "";
    const events = [];
    for await (const event of streamBoardAssistViaCli(
      input,
      { provider: "codex", instanceId: "codex", model: "gpt-5.6-mini" } as never,
      async (prompt) => {
        capturedPrompt = prompt;
        return { lines: '{"op":"addNote","text":"一"}\n{"say":"好了"}' };
      },
    )) {
      events.push(event);
    }
    expect(capturedPrompt).toContain("The comment: @Moss 在这里加一个时间线");
    expect(events).toEqual([
      { type: "start", tier: "cli" },
      { type: "text", delta: '{"op":"addNote","text":"一"}\n{"say":"好了"}\n' },
      { type: "done", model: "codex/gpt-5.6-mini" },
    ]);
  });
});
