// FILE: boardAssist.test.ts
// Purpose: Tests for server board assist validation, streaming, caching, and error handling.

import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { describe, expect, it } from "vitest";

import {
  BOARD_ASSIST_TIER_MODELS,
  parseBoardAssistModel,
  readBoardAssistBody,
  streamBoardAssist,
  streamBoardAssistViaCli,
} from "./boardAssist";
import type { PageAppAiGateway, PageAppAiGatewayRequest } from "./pages/apps/aiGateway";

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

    const rich = readBoardAssistBody({
      board: { shapes: [], truncated: false },
      ask: {
        text: "画个小狗",
        via: "comment",
        pin: { x: 100, y: 200, w: 400, h: 500, kind: "region" },
        capabilities: ["drawing", "relativePlace", "unknown-cap", "drawing"],
        theme: "dark",
      },
    })!;
    expect(rich.ask).toEqual({
      text: "画个小狗",
      via: "comment",
      pin: { x: 100, y: 200, w: 400, h: 500, kind: "region" },
      capabilities: ["drawing", "relativePlace"],
      theme: "dark",
    });
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

  it("validates tierOverride, new capabilities, issues, history, 40KB attachments, images, and correction", () => {
    const rich = readBoardAssistBody({
      board: {
        shapes: [
          { id: "shape:img1", type: "image", x: 0, y: 0, w: 300, h: 200, picture: 1 },
          { id: "shape:img2", type: "image", x: 0, y: 0, w: 300, h: 200, picture: 99 },
        ],
        truncated: false,
      },
      ask: {
        text: "根据附件和图片整理流程",
        via: "composer",
        tierOverride: "complex",
        capabilities: [
          "drawing",
          "relativePlace",
          "table",
          "pen",
          "offer",
          "show",
          "handoff",
          "undo",
          "bogus",
        ],
        issues: [
          { kind: "words_covered", ids: ["shape:a"], detail: "blocked" },
          { kind: "unknown_kind", ids: ["shape:b"] },
        ],
        history: Array.from({ length: 10 }, (_, idx) => ({
          said: `ask ${idx}`,
          did: `did ${idx}`,
          ...(idx === 9 ? { undone: true } : {}),
        })),
        attachments: [
          { name: "a.md", text: "A".repeat(30_000) },
          { name: "b.md", text: "B".repeat(20_000) },
        ],
        images: [
          { shapeId: "shape:img1", mimeType: "image/jpeg", dataBase64: "AQID" },
          { shapeId: "shape:bad", mimeType: "image/gif", dataBase64: "AQID" },
          { shapeId: "shape:bad2", mimeType: "image/png", dataBase64: "not valid!!" },
        ],
        correction: {
          issues: [{ kind: "overlap", ids: ["shape:a", "k1"], detail: "overlap" }],
          placed: [{ id: "k1", x: 10, y: 20, w: 180, h: 90, text: "节点" }],
        },
      },
    })!;

    expect(rich.board.shapes[0]?.picture).toBe(1);
    expect(rich.board.shapes[1]?.picture).toBeUndefined();
    expect(rich.ask.tierOverride).toBe("complex");
    expect(rich.ask.capabilities).toEqual([
      "drawing",
      "relativePlace",
      "table",
      "pen",
      "offer",
      "show",
      "handoff",
      "undo",
    ]);
    expect(rich.ask.issues).toEqual([
      { kind: "words_covered", ids: ["shape:a"], detail: "blocked" },
    ]);
    expect(rich.ask.history).toHaveLength(8);
    expect(rich.ask.history?.[0]?.said).toBe("ask 2");
    expect(rich.ask.history?.[7]?.undone).toBe(true);
    expect(rich.ask.attachments?.[0]?.text).toHaveLength(30_000);
    expect(rich.ask.attachments?.[1]?.text).toHaveLength(40 * 1024 - 30_000);
    expect(rich.ask.images).toEqual([
      { shapeId: "shape:img1", mimeType: "image/jpeg", dataBase64: "AQID" },
    ]);
    expect(rich.ask.correction).toEqual({
      issues: [{ kind: "overlap", ids: ["shape:a", "k1"], detail: "overlap" }],
      placed: [{ id: "k1", x: 10, y: 20, w: 180, h: 90, text: "节点" }],
    });
  });

  it("forwards vision images and tierOverride to the AI gateway and keeps tier model lists separated", async () => {
    expect(BOARD_ASSIST_TIER_MODELS.default).not.toContain("glm-5.3-flash");
    expect(BOARD_ASSIST_TIER_MODELS.complex).not.toContain("glm-5.3-flash");

    let captured: PageAppAiGatewayRequest | undefined;
    const gateway: PageAppAiGateway = {
      async *ask(request) {
        captured = request;
        yield { type: "text", delta: '{"say":"已识别图片"}\n' };
        yield { type: "done", text: "", model: "kimi-k3" };
      },
    };
    const parsed = readBoardAssistBody({
      board: {
        shapes: [{ id: "shape:img1", type: "image", x: 0, y: 0, w: 300, h: 200, picture: 1 }],
        truncated: false,
      },
      ask: {
        text: "总结图片内容",
        via: "comment",
        tierOverride: "complex",
        images: [{ shapeId: "shape:img1", mimeType: "image/webp", dataBase64: "UklGRg==" }],
      },
    })!;
    const events = [];
    for await (const event of streamBoardAssist(gateway, parsed, new AbortController().signal)) {
      events.push(event);
    }
    expect(events[0]).toEqual({ type: "start", tier: "complex" });
    expect(captured?.tier).toBe("complex");
    expect(captured?.images).toEqual([{ mimeType: "image/webp", dataBase64: "UklGRg==" }]);
  });

  it("supports custom tierOverride and html capability prompt instructions", async () => {
    let capturedPrompt = "";
    const parsed = readBoardAssistBody({
      board: {
        shapes: [
          { id: "shape:h1", type: "moss-html", text: "实时看板", x: 0, y: 0, w: 800, h: 500 },
        ],
        truncated: false,
      },
      ask: {
        text: "创建一个可交互 HTML demo",
        via: "composer",
        tierOverride: "custom",
        capabilities: ["html", "drawing", "relativePlace"],
      },
    })!;
    expect(parsed.ask.tierOverride).toBe("custom");
    expect(parsed.ask.capabilities).toEqual(["html", "drawing", "relativePlace"]);

    const events = [];
    for await (const event of streamBoardAssistViaCli(
      parsed,
      { provider: "codex", model: "gpt-5.3-codex" },
      async (prompt) => {
        capturedPrompt = prompt;
        return {
          lines: '{"op":"addHtml","title":"Demo","html":"<h1>Hi</h1>"}\n{"say":"已生成"}\n',
        };
      },
    )) {
      events.push(event);
    }
    expect(capturedPrompt).toContain("addHtml");
    expect(capturedPrompt).toContain("NATIVELY renders live interactive HTML");
    expect(events).toEqual([
      { type: "start", tier: "cli" },
      {
        type: "text",
        delta: '{"op":"addHtml","title":"Demo","html":"<h1>Hi</h1>"}\n{"say":"已生成"}\n',
      },
      { type: "done", model: "codex/gpt-5.3-codex" },
    ]);
  });
});
