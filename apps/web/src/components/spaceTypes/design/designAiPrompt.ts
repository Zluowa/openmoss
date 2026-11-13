// FILE: designAiPrompt.ts
// Purpose: The turn a 设计 sends to the selected Moss agent (让 Moss 修改, a comment sent to Moss,
//          the empty canvas's 让 Moss 来做): the person's words plus what they are looking at —
//          page, visible and selected artboards, selected elements with their words — and the rules.
// Layer: 资料空间 设计 AI
// Why: "this", "these" and "the one on the left" only mean something with the viewer's screen;
//      design tools send this view context with every request for the same reason.

import type { Page } from "@moss/contracts";
import type { DesignCanvas } from "@moss/shared/spaceItems/designCanvas";

export interface DesignAiTurnPrompt {
  readonly request: string;
  readonly context: string;
}

export interface DesignViewContext {
  readonly pageId: string;
  readonly visibleBoardIds: readonly string[];
  readonly selectedBoardIds: readonly string[];
  /** Selected elements: artboard id, element path (`2.0.1`) and the element's label. */
  readonly selectedElements: readonly { boardId: string; path: string; label: string }[];
  /** True while the person has edits not yet saved (the agent reads the saved design). */
  readonly dirty: boolean;
}

function header(page: Page) {
  return `资料空间设计“${page.title}”（pageId: ${page.id}，scopeSpaceId: ${page.scopeSpaceId === null ? "null" : page.scopeSpaceId}，当前版本 revision: ${page.revision}）`;
}

function describeView(canvas: DesignCanvas, view: DesignViewContext | null): string {
  if (!view) return "";
  const name = (id: string) => canvas.boards.find((board) => board.id === id)?.name ?? id;
  const page = canvas.pages.find((entry) => entry.id === view.pageId);
  const lines = [
    `用户正在看${canvas.pages.length > 1 && page ? `页面“${page.name}”（pageId: ${page.id}）上` : ""}的画板：${
      view.visibleBoardIds.length
        ? view.visibleBoardIds
            .slice(0, 20)
            .map((id) => `“${name(id)}”(${id})`)
            .join("、")
        : "（视野里没有画板）"
    }。`,
  ];
  if (view.selectedElements.length) {
    lines.push("选中的元素（路径从画板顶层元素起按子元素序号数，用 . 分隔）：");
    for (const element of view.selectedElements.slice(0, 20))
      lines.push(
        `- 画板“${name(element.boardId)}”(${element.boardId}) 路径 ${element.path}：${element.label}`,
      );
  } else if (view.selectedBoardIds.length) {
    lines.push(
      `选中的画板：${view.selectedBoardIds.map((id) => `“${name(id)}”(${id})`).join("、")}。`,
    );
  } else {
    lines.push("没有选中具体内容：按用户看到的画板理解“这个”。");
  }
  return lines.join("\n");
}

const RULES =
  "规则：只用 moss_design_* 工具改这份设计（先读 moss_design_guide），每次写入带上 expectedRevision；先用 moss_design_read 读出要改的画板（boardIds）再改，只改用户要求的部分，保留用户手动改过的内容和已安装设计系统的 var(--ds-*) 变量。遇到冲突（用户刚改过）就重新读取再改。完成后用一两句中文告诉用户画布上变了什么，不要描述 JSON。";

export function designChangePrompt(input: {
  page: Page;
  canvas: DesignCanvas;
  instruction: string;
  view: DesignViewContext | null;
  mode: "change" | "ask";
}): DesignAiTurnPrompt {
  const where = describeView(input.canvas, input.view);
  if (input.mode === "ask")
    return {
      request: input.instruction.trim(),
      context: `用户在${header(input.page)}里提了一个问题。\n${where}\n先用 moss_design_read 读取相关画板，然后直接回答，不要修改设计。`,
    };
  return {
    request: input.instruction.trim(),
    context: `你正在修改${header(input.page)}。\n${where}\n${RULES}`,
  };
}

/** 让 Moss 来做: the agent fills an empty design the person just opened. */
export function designGeneratePrompt(input: { page: Page; prompt: string }): DesignAiTurnPrompt {
  return {
    request: input.prompt.trim(),
    context: `用户在${header(input.page)}里描述了想要的设计，请把这份空白设计做出来。\n先读 moss_design_guide，定下尺寸（网页 1280–1440 宽、手机 390×844、海报 1080×1350 等）、画板数量和一套明确的风格；没有指定设计系统就用已安装的（默认 Moss 设计标准）。用 moss_design_write_boards 一次写一两个画板，让用户看着画布一点点填满；不要另建新的设计。${RULES}`,
  };
}

const pendingGeneration = new Map<string, string>();
/** Remembers a 让 Moss 来做 request until the design's editor opens and runs it. */
export function queueDesignGeneration(pageId: string, prompt: string) {
  pendingGeneration.set(pageId, prompt);
}
export function takeDesignGeneration(pageId: string): string | null {
  const prompt = pendingGeneration.get(pageId) ?? null;
  pendingGeneration.delete(pageId);
  return prompt;
}
