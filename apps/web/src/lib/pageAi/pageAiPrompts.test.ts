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

  it("names the visualization card the agent should fill", () => {
    expect(pageAiPrompt("visualize", "画一张进度图", document, "viz-1").context).toContain(
      "块 id: viz-1",
    );
  });

  it("reads 助手说明 blocks and strips a wrapping fence from generated text", () => {
    expect(pageInstructions(document)).toEqual(["用简体中文，语气简洁"]);
    expect(generatedMarkdown("```markdown\n- 一\n- 二\n```")).toBe("- 一\n- 二");
    expect(generatedMarkdown("  正文  ")).toBe("正文");
  });
});
