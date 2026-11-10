// FILE: pageAiPrompts.ts
// Purpose: The turn a page sends to the selected Moss agent: the person's request first (it
//          also names the conversation), then the page context and the rules for editing it.
// Layer: Web lib (page AI)

import type { PagesReadResult } from "@moss/contracts";
import { pageAssistantInstructions } from "@moss/shared/pageAi";
import { parsePageRichContent } from "@moss/shared/pageRichContent";

import type { PageAiRunMode } from "./pageAiSession";

const EXCERPT_LIMIT = 6_000;

export function pageInstructions(document: PagesReadResult): string[] {
  if (!document.richContent) return [];
  try {
    return pageAssistantInstructions(parsePageRichContent(document.richContent).nodes);
  } catch {
    return [];
  }
}

function pageContext(document: PagesReadResult) {
  const { page } = document;
  return `资料空间页面“${page.title}”（pageId: ${page.id}，scopeSpaceId: ${page.scopeSpaceId === null ? "null" : page.scopeSpaceId}，当前版本 revision: ${page.revision}）`;
}

function instructionsSection(document: PagesReadResult) {
  const instructions = pageInstructions(document);
  return instructions.length
    ? `\n\n页面主人写下的“助手说明”，必须遵循：\n${instructions.map((line) => `- ${line.replace(/\n/g, " ")}`).join("\n")}`
    : "";
}

function excerpt(document: PagesReadResult) {
  const text = document.content.trim();
  if (!text) return "（页面目前是空的）";
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}\n…（后文省略）` : text;
}

/** The person's words (which also name the chat) and the page context sent beside them. */
export interface PageAiTurnPrompt {
  readonly request: string;
  readonly context: string;
}

/**
 * 生成 streams the reply straight into the page as a draft, so the agent must answer with the
 * text alone. Every other mode lets the agent use the Moss page tools, which only propose drafts.
 */
export function pageAiPrompt(
  mode: PageAiRunMode,
  request: string,
  document: PagesReadResult,
  anchorBlockId: string | null = null,
): PageAiTurnPrompt {
  const ask = request.trim();
  if (mode === "generate")
    return {
      request: ask,
      context: `请为${pageContext(document)}写一段要插入的内容，满足用户的要求。\n只输出要插入页面的正文（Markdown），不要开场白、不要解释、不要调用任何工具；用户会审阅后再决定是否接受。${instructionsSection(document)}\n\n页面现有内容（供参考，不要重复）：\n${excerpt(document)}`,
    };
  const task =
    mode === "visualize"
      ? `为这个页面做一个可视化（图表、示意图或小工具）。页面里已经放了一个可视化占位块${anchorBlockId ? `（块 id: ${anchorBlockId}）` : ""}。如果有创建应用页的工具，创建后用 moss_pages_draft 的 replace 把这个块换成带 appPageId 的 moss_visualization 块；否则用 replace 把它换成 Markdown 表格或 Mermaid 图。`
      : mode === "image"
        ? "为这个页面生成一张图像。图片必须有可长期访问的 https 地址才能放进页面；拿不到这样的地址时，说明原因，不要提交无效的图片。"
        : mode === "prompt"
          ? "这是页面里读者点击“运行”的提示，请按提示完成工作。"
          : "按用户的要求处理这个页面。";
  return {
    request: ask,
    context: `你正在处理${pageContext(document)}。${task}\n先用 moss_pages_read 读取最新内容。修改正文时只用 moss_pages_draft 提交修改建议（锚定到块 id），用户会在页面里审阅后接受或放弃；不要用其他方式改写页面。${instructionsSection(document)}\n完成后用一两句话告诉用户你提交了什么。`,
  };
}

/** The reply of a 生成 turn, without a wrapping code fence some agents add. */
export function generatedMarkdown(reply: string): string {
  const trimmed = reply.trim();
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/u.exec(trimmed);
  return (fenced ? fenced[1]! : trimmed).trim();
}
