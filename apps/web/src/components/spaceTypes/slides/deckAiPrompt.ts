// FILE: deckAiPrompt.ts
// Purpose: The turn a deck sends to the selected Moss agent for 提出修改请求 / the inline
//          "描述修改" prompt / 生成图像: the person's words, plus what they are looking at and
//          the rules (read with moss_slides_read, change only through moss_slides_edit drafts).
// Layer: 资料空间 幻灯片 AI

import type { Page } from "@moss/contracts";
import { bodyText, elementText, type SlidesDeck } from "@moss/shared/spaceItems/slidesDeck";

import type { DeckTarget, DeckViewContext } from "~/lib/deckEditorChannel";

export interface DeckAiTurnPrompt {
  readonly request: string;
  readonly context: string;
}

function describeTarget(deck: SlidesDeck, target: DeckTarget): string {
  const lines: string[] = [];
  for (const slideId of target.slideIds.slice(0, 20)) {
    const index = deck.slides.findIndex((slide) => slide.id === slideId);
    const slide = deck.slides[index];
    if (!slide) continue;
    const title = slide.elements.find((e) => e.type === "text" && e.role === "title");
    lines.push(
      `- 第 ${index + 1} 张（slideId: ${slide.id}）${title && title.type === "text" ? `“${bodyText(title.body).slice(0, 60)}”` : ""}`,
    );
  }
  for (const elementId of target.elementIds.slice(0, 30)) {
    for (const [index, slide] of deck.slides.entries()) {
      const element = slide.elements.find((e) => e.id === elementId);
      if (!element) continue;
      const words = elementText(element).replaceAll("\n", " ").slice(0, 80);
      lines.push(
        `- 第 ${index + 1} 张上的${element.type === "text" ? "文本" : element.type === "image" ? "图片" : element.type === "table" ? "表格" : element.type === "chart" ? "图表" : element.type === "line" ? "线条" : "形状"}（slideId: ${slide.id}，elementId: ${element.id}）${words ? `：“${words}”` : ""}`,
      );
    }
  }
  return lines.length ? lines.join("\n") : "（没有选中具体内容：按整份演示文稿理解请求）";
}

function header(page: Page) {
  return `资料空间幻灯片“${page.title}”（pageId: ${page.id}，scopeSpaceId: ${page.scopeSpaceId === null ? "null" : page.scopeSpaceId}，当前版本 revision: ${page.revision}）`;
}

export function deckChangePrompt(input: {
  page: Page;
  deck: SlidesDeck;
  instruction: string;
  target: DeckTarget;
  view: DeckViewContext | null;
  mode: "change" | "ask";
}): DeckAiTurnPrompt {
  const where = input.view
    ? `用户正在看第 ${input.view.slideIndex + 1} / ${input.view.slideCount} 张${input.view.slideTitle ? `“${input.view.slideTitle}”` : ""}（${input.view.mode === "edit" ? "单页编辑" : input.view.mode === "present" ? "演示" : "总览"}）。`
    : "";
  const target = describeTarget(input.deck, input.target);
  if (input.mode === "ask")
    return {
      request: input.instruction.trim(),
      context: `用户在${header(input.page)}里提了一个问题。${where}\n问题针对：\n${target}\n先用 moss_slides_read 读取这些幻灯片，然后直接回答，不要修改演示文稿。`,
    };
  return {
    request: input.instruction.trim(),
    context: `你正在修改${header(input.page)}。${where}\n这次修改针对：\n${target}\n\n步骤：\n1. 用 moss_slides_read 读取最新内容（必要时先读 moss_slides_guide）。\n2. 只用 moss_slides_edit（或放图片时用 moss_slides_image）提交修改，带上 expectedRevision、一句话 summary，以及 target {slideIds, elementIds}（就是上面列出的 id）。修改会直接出现在打开的幻灯片里（用户可以撤销）；不要用其他方式改写，也不要重建整份演示文稿。如果结果里有 layoutFaults（元素互相遮挡或超出页面），先移动或缩放把它们改好再结束。\n3. 除非用户要求，只改上面列出的内容，保持原有版式、主题颜色（用 @accent 这类主题色）和字号层级。\n完成后用一两句话告诉用户你改了什么。`,
  };
}

export function deckImagePrompt(input: {
  page: Page;
  prompt: string;
  target: { slideId: string; elementId?: string };
  deck: SlidesDeck;
}): DeckAiTurnPrompt {
  const index = input.deck.slides.findIndex((slide) => slide.id === input.target.slideId);
  return {
    request: input.prompt.trim() || "为这张幻灯片生成一张合适的配图",
    context: `为${header(input.page)}第 ${index + 1} 张（slideId: ${input.target.slideId}）生成一张图片${input.target.elementId ? `，替换 elementId: ${input.target.elementId}` : ""}。\n先用 moss_media_list 选一个图像模型，用 moss_media_generate 生成（16:9 或与位置相符的比例），用 moss_media_get 等到完成；然后用 moss_slides_image 把结果的 https 地址或 Moss 媒体路径放到这张幻灯片上${input.target.elementId ? `（elementId: ${input.target.elementId}）` : ""}，它会直接出现在幻灯片里，用户可以撤销。拿不到可用的图片时，说明原因。`,
  };
}

/** 新建幻灯片 → 让 Moss 生成: the agent fills the blank deck the person just made. */
export function deckGeneratePrompt(input: { page: Page; prompt: string }): DeckAiTurnPrompt {
  return {
    request: input.prompt.trim(),
    context: `用户新建了${header(input.page)}，请按上面的要求把它做成一份完整的演示文稿。\n先读 moss_slides_guide，规划好章节和每页要点（一页一个观点，6-12 页），然后调用一次 moss_slides_create，带上 pageId: ${input.page.id} 和 outline（可选 theme），把内容直接写进这份空白幻灯片。之后用 moss_slides_read 检查，必要时用 moss_slides_edit 修正。不要另建新的幻灯片。完成后用两三句话告诉用户你做了什么。`,
  };
}

const pendingGeneration = new Map<string, string>();
/** Remembers a 让 Moss 生成 request until the new deck's editor opens and runs it. */
export function queueDeckGeneration(pageId: string, prompt: string) {
  pendingGeneration.set(pageId, prompt);
}
export function takeDeckGeneration(pageId: string): string | null {
  const prompt = pendingGeneration.get(pageId) ?? null;
  pendingGeneration.delete(pageId);
  return prompt;
}
