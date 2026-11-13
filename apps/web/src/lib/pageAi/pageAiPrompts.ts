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
  quote?: string,
): PageAiTurnPrompt {
  const ask = request.trim();
  if (mode === "comment")
    return {
      request: ask,
      context: [
        `这是${pageContext(document)}里发给你的一条评论，挂在${anchorBlockId ? `块 id "${anchorBlockId}" 的` : ""}文字“${(quote ?? "").replace(/\s+/g, " ").slice(0, 400)}”上。`,
        "评论要求修改时：先用 moss_pages_read 读取最新内容，再只用 moss_pages_draft 提交修改建议（锚定到那个块），用户会在页面里审阅后接受。评论只是提问时直接回答，不要改页面。",
        `你的最后一条回复会原样显示在评论串里：用评论的语言写一两句话，说明你的回答，或者你提交了什么修改；不要贴出页面全文。${instructionsSection(document)}`,
      ].join("\n"),
    };
  if (mode === "generate")
    return {
      request: ask,
      context: `请为${pageContext(document)}写一段要插入的内容，满足用户的要求。\n只输出要插入页面的正文（Markdown），不要开场白、不要解释、不要调用任何工具；用户会审阅后再决定是否接受。${instructionsSection(document)}\n\n页面现有内容（供参考，不要重复）：\n${excerpt(document)}`,
    };
  if (mode === "visualize") {
    const { page } = document;
    const target = [
      `pageId: "${page.id}"`,
      ...(anchorBlockId ? [`blockId: "${anchorBlockId}"`] : []),
      ...(page.scopeSpaceId === null ? [] : [`scopeSpaceId: "${page.scopeSpaceId}"`]),
    ].join("，");
    // One tool call with plain strings: a weaker model failed to hand-escape code inside the
    // nested JSON of moss_pages_draft and started sub-agents to retry (acceptance round 10).
    return {
      request: ask,
      context: [
        `你正在处理${pageContext(document)}。为这个页面做一个可交互的可视化（图表、示意图或小工具）。用户说“表格”时也做成可交互的（例如可排序、可筛选的表格）。`,
        `只调用一次 moss_app_visualize 完成全部工作：${target}，title 用用户的语言写一个简短标题，html 放完整的 HTML（数据直接写进代码，样式和脚本内联；也可以把 CSS、JS 分别放进 css、js 字段）。它会发布应用页，并把页面里的可视化块作为修改建议交给用户审阅。`,
        // Round 11: the model searched for the tool, got nothing back, then read two chart
        // reference files before it called the tool, five minutes later.
        "这个工具在 Moss 的 MCP 服务 moss 里，已经可以直接调用；有的智能体里它显示为 mcp__moss__moss_app_visualize 或 moss_moss_app_visualize。用户的要求和要画的数据都在这条消息里：不需要先搜索工具、读文件、加载技能或查参考资料，直接调用它。",
        "页面必须自包含：应用页没有网络，也不提供任何库。不要引用外部脚本、样式表、字体，不要发网络请求，不要用图表库（Chart.js、D3、ECharts、Plotly、Highcharts 等），只用原生 HTML/CSS/SVG 或 Canvas 和原生 JavaScript 来画。",
        `不需要先读页面，不要调用 moss_app_guide、moss_app_publish 或 moss_pages_draft，不要写本地文件，不要启动子智能体或后台任务。调用失败时按返回的提示改正，再调用一次 moss_app_visualize。${instructionsSection(document)}`,
        "完成后用一句话告诉用户做好了什么。",
      ].join("\n"),
    };
  }
  const task =
    mode === "image"
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
