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

  it("constrains drawn region comments to exact rounded bounds without a conflicting free area", () => {
    const prompt = buildBoardAssistPrompt(
      { shapes: [], truncated: false },
      {
        text: "画个小狗",
        via: "comment",
        pin: { x: 375.6, y: 1346.7, w: 407.4, h: 504.2, kind: "region" },
        view: { x: -120.4, y: 900.2, w: 1400.6, h: 900.8 },
        capabilities: ["drawing", "relativePlace"],
        theme: "dark",
      },
    );
    expect(prompt.tier).toBe("default");
    expect(prompt.maxTokens).toBe(8_000);
    expect(prompt.input).toContain(
      'The comment is pinned to a drawn region box: {"x":376,"y":1347,"w":407,"h":504}',
    );
    expect(prompt.input).toContain("x from 376 to 783, y from 1347 to 1851");
    expect(prompt.input).not.toContain("Free area for new things:");
    expect(prompt.input).toContain("Board appearance: dark mode");
    expect(prompt.system).toContain('"op":"addDrawing"');
    expect(prompt.system).toContain('"rightOf"|"leftOf"|"below"|"above"');
    expect(prompt.system).toContain('"hollow":false');
    expect(prompt.system).toContain("three-quarter elevated view");
    expect(prompt.system).not.toMatch(/claude/iu);
    expect(prompt.input).not.toMatch(/claude/iu);
  });

  it("keeps drawing and relative-placement instructions gated on client capabilities", () => {
    const legacy = buildBoardAssistPrompt(
      { shapes: [], truncated: false },
      {
        text: "画个小狗",
        via: "comment",
        pin: { x: 100, y: 200, w: 240, h: 120, kind: "shape" },
      },
    );
    expect(legacy.system).not.toContain('"op":"addDrawing"');
    expect(legacy.system).not.toContain('"rightOf"');
    expect(legacy.input).toContain("The comment is attached to a shape");
    expect(legacy.input).toContain("Free area for new things:");

    const parser = createBoardAssistParser();
    const lines = parser.push(
      '{"op":"addDrawing","key":"d1","svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 200 200\\"><circle cx=\\"100\\" cy=\\"100\\" r=\\"60\\"/></svg>","alt":"小狗","look":"marker","x":400,"y":1380,"w":320,"h":320}\n',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "op",
      op: { op: "addDrawing", key: "d1", alt: "小狗", look: "marker" },
    });
  });

  it("parses offer, show, handoff, and upgraded board ops while enforcing limits", () => {
    const parser = createBoardAssistParser();
    const longLabel = "A".repeat(80);
    const longStepText = "B".repeat(260);
    const lines = parser.push(
      [
        JSON.stringify({
          offer: {
            observation: "这里有三条并行流程，可以换更清晰的结构。",
            near: "shape:1",
            options: [
              {
                label: longLabel,
                why: "按角色分泳道更易读",
                ops: [
                  { op: "addTable", key: "t1", headers: ["阶段", "负责人"], rows: [["设计", "A"]] },
                  { op: "addShape", geo: "invalid" },
                ],
              },
              {
                label: longLabel,
                ops: [{ op: "addNote", text: "duplicate label skipped" }],
              },
              {
                label: "无有效操作会被忽略",
                ops: [{ op: "addPen", points: [[0, 0]] }],
              },
              {
                label: "用自由笔标重点",
                ops: [
                  {
                    op: "addPen",
                    key: "p1",
                    points: [
                      [0, 0],
                      [40, 20],
                    ],
                    head: "arrow",
                  },
                ],
              },
            ],
          },
        }),
        JSON.stringify({
          show: {
            steps: [
              { ids: ["shape:1", "shape:2"], text: longStepText, zoom: true },
              { ids: [], text: "整体结构闭合，可以继续细化验收指标。" },
            ],
          },
        }),
        JSON.stringify({
          handoff: { reason: "需要读取仓库里的真实性能日志", rest: "把真实延迟填进表格" },
        }),
        JSON.stringify({ op: "undo", steps: 2 }),
        JSON.stringify({ op: "redo", steps: 1 }),
        JSON.stringify({ say: "已准备好建议和说明" }),
      ].join("\n") + "\n",
    );

    expect(lines).toHaveLength(6);
    expect(lines[0]).toEqual({
      kind: "offer",
      offer: {
        observation: "这里有三条并行流程，可以换更清晰的结构。",
        near: "shape:1",
        options: [
          {
            label: "A".repeat(60),
            why: "按角色分泳道更易读",
            ops: [
              { op: "addTable", key: "t1", headers: ["阶段", "负责人"], rows: [["设计", "A"]] },
            ],
          },
          {
            label: "用自由笔标重点",
            ops: [
              {
                op: "addPen",
                key: "p1",
                points: [
                  [0, 0],
                  [40, 20],
                ],
                head: "arrow",
              },
            ],
          },
        ],
      },
    });
    expect(lines[1]).toEqual({
      kind: "show",
      show: {
        steps: [
          { ids: ["shape:1", "shape:2"], text: "B".repeat(200), zoom: true },
          { ids: [], text: "整体结构闭合，可以继续细化验收指标。" },
        ],
      },
    });
    expect(lines[2]).toEqual({
      kind: "handoff",
      handoff: { reason: "需要读取仓库里的真实性能日志", rest: "把真实延迟填进表格" },
    });
    expect(lines[3]).toEqual({ kind: "op", op: { op: "undo", steps: 2 } });
    expect(lines[4]).toEqual({ kind: "op", op: { op: "redo", steps: 1 } });
    expect(lines[5]).toEqual({ kind: "say", text: "已准备好建议和说明" });
  });

  it("includes full Moss-branded prompt craft, new capabilities, issues, history, attachments, vision, and [measured] repair", () => {
    const prompt = buildBoardAssistPrompt(
      {
        shapes: [
          { id: "shape:img1", type: "image", x: 10, y: 20, w: 320, h: 240, picture: 1 },
          { id: "shape:n1", type: "note", text: "现状", x: 380, y: 20, w: 200, h: 200 },
        ],
        truncated: false,
      },
      {
        text: "按附件和截图帮我做一份团队复盘模板，先修好重叠",
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
        ],
        issues: [{ kind: "words_covered", ids: ["shape:n1"], detail: "covered by banner" }],
        history: [
          { said: "加一个蓝色标题", did: "已添加标题" },
          { said: "删掉全部", did: "已清空画布", undone: true },
        ],
        attachments: [{ name: "sprint.md", text: "Q4 Sprint Retro Notes" }],
        images: [{ shapeId: "shape:img1", mimeType: "image/jpeg", dataBase64: "AQID" }],
        correction: {
          issues: [{ kind: "overlap", ids: ["shape:n1", "k1"], detail: "boxes collide" }],
          placed: [{ id: "k1", x: 390, y: 30, w: 200, h: 100, text: "新卡片" }],
        },
      },
    );

    expect(prompt.tier).toBe("complex");
    expect(prompt.maxTokens).toBe(12_000);
    expect(prompt.system).toContain("3-pass progressive drawing workflow");
    expect(prompt.system).toContain("900×900");
    expect(prompt.system).toContain('"op":"addTable"');
    expect(prompt.system).toContain('"op":"addPen"');
    expect(prompt.system).toContain('"op":"undo"');
    expect(prompt.system).toContain('{"offer":');
    expect(prompt.system).toContain('{"show":');
    expect(prompt.system).toContain('{"handoff":');
    expect(prompt.system).toContain("one-version");
    expect(prompt.system).toContain("No filler");
    expect(prompt.system).not.toMatch(/claude|anthropic|appifact/iu);

    expect(prompt.input).toContain('"picture":1');
    expect(prompt.input).toContain('the shape with "picture": 1 is the first image');
    expect(prompt.input).toContain('"words_covered"');
    expect(prompt.input).toContain("1. Person: 加一个蓝色标题 -> Moss: 已添加标题");
    expect(prompt.input).toContain("2. [undone] Person: 删掉全部 -> Moss: 已清空画布");
    expect(prompt.input).toContain("--- File: sprint.md ---");
    expect(prompt.input).toContain("[measured] Your reply has run.");
    expect(prompt.input).not.toMatch(/claude|anthropic|appifact/iu);
  });

  it("routes tierOverride and automatic quick/default/complex heuristics accurately", () => {
    expect(boardAssistTier({ via: "comment", text: "改颜色", tierOverride: "complex" })).toBe(
      "complex",
    );
    expect(boardAssistTier({ via: "composer", text: "画架构图", tierOverride: "quick" })).toBe(
      "quick",
    );
    expect(boardAssistTier({ via: "comment", text: "精细绘制一栋建筑图" })).toBe("complex");
    expect(boardAssistTier({ via: "comment", text: "整理所有便签并归类" }, 48)).toBe("complex");
    expect(
      boardAssistTier({
        via: "comment",
        text: "看看这张图",
        images: [{ shapeId: "shape:img1", mimeType: "image/png", dataBase64: "AQID" }],
      }),
    ).toBe("default");
    expect(
      boardAssistTier({
        via: "composer",
        text: "原请求",
        correction: {
          issues: [{ kind: "overlap", ids: ["a", "b"] }],
          placed: [{ id: "a", x: 0, y: 0, w: 100, h: 100 }],
        },
      }),
    ).toBe("quick");
  });
});
