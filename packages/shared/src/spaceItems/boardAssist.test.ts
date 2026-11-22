// FILE: boardAssist.test.ts
// Purpose: Unit tests for shared whiteboard assistant prompt building, JSONL parsing, and comment helpers.

import { describe, expect, it } from "vitest";

import {
  boardAssistTier,
  boardFreeArea,
  boardWorkingWord,
  buildBoardAssistPrompt,
  commentAskText,
  createBoardAssistParser,
  readBoardComments,
} from "./boardAssist";

describe("board assist", () => {
  it("parses ops line by line as the stream arrives, and drops code fences", () => {
    const parser = createBoardAssistParser();
    expect(parser.push('{"op":"addNote","key":"k1","te')).toEqual([]);
    const first = parser.push('xt":"一"}\n{"op":"addNote","text":"二"}\n```\n{"say":"加了');
    expect(first).toEqual([
      { kind: "op", op: { op: "addNote", key: "k1", text: "一" } },
      { kind: "op", op: { op: "addNote", text: "二" } },
    ]);
    expect(parser.end()).toEqual([{ kind: "skip", raw: '{"say":"加了' }]);
  });

  it("reads board questions trimmed to limits and embeds answers in subsequent prompt", () => {
    const parser = createBoardAssistParser();
    const lines = parser.push(
      '{"ask":{"q":"给谁看？","options":["自己","团队","自己","其他（请输入）","客户","a","b","c","d"],"near":"k1"}}\n' +
        '{"ask":{"q":"只有一个","options":["x"]}}\n' +
        '{"say":"请先选一下"}\n',
    );
    expect(lines[0]).toEqual({
      kind: "ask",
      question: { q: "给谁看？", options: ["自己", "团队", "客户", "a", "b", "c"], near: "k1" },
    });
    expect(lines[1]?.kind).toBe("skip");
    expect(lines[2]).toEqual({ kind: "say", text: "请先选一下" });

    const prompt = buildBoardAssistPrompt(
      { shapes: [], truncated: false },
      { text: "画个思维导图", via: "composer", answers: [{ q: "给谁看？", answer: "团队" }] },
    );
    expect(prompt.input).toContain("Q: 给谁看？\nA: 团队");
    expect(prompt.system).toContain('{"ask":');
    expect(prompt.tier).toBe("default");
  });

  it("computes free area, tiers, comment mentions, and working words cleanly", () => {
    expect(boardAssistTier({ via: "comment", text: "改一下颜色" })).toBe("quick");
    expect(boardAssistTier({ via: "comment", text: "画一个系统架构流程图" })).toBe("default");
    expect(
      boardFreeArea([
        { id: "s1", type: "note", x: 100, y: 40, w: 200, h: 200 },
        { id: "s2", type: "arrow", x: 0, y: 0, w: 999, h: 999 },
      ]),
    ).toEqual({ x: 460, y: 40, w: 1200, h: 800 });

    expect(commentAskText("@Moss 在这里加个太空飞船")).toBe("在这里加个太空飞船");
    expect(boardWorkingWord("ask-1")).toMatch(/中$/u);
    expect(
      readBoardComments({
        mossComments: [
          { id: "t1", x: 10, y: 20, messages: [] },
          { id: "bad", x: "nan", y: 0, messages: [] },
        ],
      }),
    ).toHaveLength(1);
  });
});
