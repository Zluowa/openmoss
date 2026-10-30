import { describe, expect, it } from "vitest";

import {
  appendThreadSummaryOutputPrompt,
  createThreadSummaryOutputPrompt,
} from "./threadSummaryOutputCreation.logic";

describe("thread summary output creation", () => {
  it.each([
    [
      "document",
      "使用 [@Documents](plugin://documents@openai-primary-runtime) 创建一个新文档。先问我它应该是什么主题。",
    ],
    [
      "presentation",
      "使用 [@Presentations](plugin://presentations@openai-primary-runtime) 创建一个新演示文稿。先问我它应该是什么主题。",
    ],
    [
      "spreadsheet",
      "使用 [@Spreadsheets](plugin://spreadsheets@openai-primary-runtime) 创建一个新电子表格。先问我它应该是什么主题。",
    ],
    [
      "site",
      "使用 [@Sites](plugin://sites@openai-bundled) 创建一个新网站。先问我它应该是什么主题。",
    ],
  ] as const)("matches Codex's zh-CN %s plugin prompt", (kind, expected) => {
    expect(createThreadSummaryOutputPrompt(kind, "zh-CN")).toBe(expected);
  });

  it("appends to the existing draft with exactly one separator when needed", () => {
    const prompt = createThreadSummaryOutputPrompt("document", "zh-CN");
    expect(appendThreadSummaryOutputPrompt("已有草稿", "document", "zh-CN")).toBe(
      `已有草稿 ${prompt}`,
    );
    expect(appendThreadSummaryOutputPrompt("已有草稿\n", "document", "zh-CN")).toBe(
      `已有草稿\n${prompt}`,
    );
    expect(appendThreadSummaryOutputPrompt("", "document", "zh-CN")).toBe(prompt);
  });
});
