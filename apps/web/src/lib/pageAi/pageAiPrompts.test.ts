import type { PagesReadResult } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { generatedMarkdown, pageAiPrompt, pageInstructions } from "./pageAiPrompts";

const document = {
  page: { id: "page-1", title: "周报", revision: 4, scopeSpaceId: null },
  content: "# 周报\n\n本周完成了登录页。",
  richContent: JSON.stringify([
    { type: "h1", id: "a", children: [{ text: "周报" }] },
    {
      type: "moss_instructions",
      id: "b",
      children: [{ type: "p", children: [{ text: "用简体中文，语气简洁" }] }],
    },
  ]),
} as unknown as PagesReadResult;

describe("page AI prompts", () => {
  it("sends the request alone, so it names the chat, with the page context beside it", () => {
    const { request, context } = pageAiPrompt("compose", "把要点整理成列表", document);
    const prompt = context;
    expect(request).toBe("把要点整理成列表");
    expect(prompt).toContain("pageId: page-1");
    expect(prompt).toContain("revision: 4");
    expect(prompt).toContain("moss_pages_draft");
    expect(prompt).toContain("用简体中文，语气简洁");
  });

  it("asks a 生成 turn for the text alone, with the page as reference", () => {
    const { request, context: prompt } = pageAiPrompt("generate", "写一段下周计划", document);
    expect(request).toBe("写一段下周计划");
    expect(prompt).toContain("不要调用任何工具");
    expect(prompt).toContain("本周完成了登录页");
    expect(prompt).not.toContain("moss_pages_draft");
  });

  it("asks for one moss_app_visualize call naming the page and the card to fill", () => {
    const context = pageAiPrompt("visualize", "柱状图：甲3 乙5 丙2", document, "viz-1").context;
    expect(context).toContain('blockId: "viz-1"');
    expect(context).toContain('pageId: "page-1"');
    expect(context).toContain("只调用一次 moss_app_visualize");
    // Round 10: the model fought the nested JSON of moss_pages_draft and spawned sub-agents.
    expect(context).toContain("不要调用 moss_app_guide、moss_app_publish 或 moss_pages_draft");
    expect(context).toContain("不要启动子智能体");
    expect(context).toContain("用户说“表格”时也做成可交互的");
    expect(context).not.toContain("Markdown 表格");
    expect(context).toContain("用简体中文，语气简洁");
  });

  it("reads 助手说明 blocks and strips a wrapping fence from generated text", () => {
    expect(pageInstructions(document)).toEqual(["用简体中文，语气简洁"]);
    expect(generatedMarkdown("```markdown\n- 一\n- 二\n```")).toBe("- 一\n- 二");
    expect(generatedMarkdown("  正文  ")).toBe("正文");
  });
});
