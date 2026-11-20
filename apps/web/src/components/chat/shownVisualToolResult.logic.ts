// FILE: shownVisualToolResult.logic.ts
// Purpose: Recognises the result of `moss_show_visual` on a tool row, so the row can show the
//          chart it published instead of the tool's JSON reply to the agent.
// Layer: Chat transcript logic
// Exports: shownVisualFromWorkEntry, ShownVisualToolResult

import { INLINE_VISUAL_TOOL_NAME } from "@moss/contracts";

import type { WorkLogEntry } from "../../workLog";

export interface ShownVisualToolResult {
  readonly visualId: string;
  readonly title?: string;
}

const VISUAL_ID_PATTERN = /"visualId"\s*:\s*"(vis_[A-Za-z0-9_-]{1,128})"/u;
const TITLE_PATTERN = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/u;

function isShowVisualTool(entry: Pick<WorkLogEntry, "toolName" | "mcpToolResult">): boolean {
  if (entry.mcpToolResult) return entry.mcpToolResult.tool === INLINE_VISUAL_TOOL_NAME;
  const name = entry.toolName?.trim().toLowerCase();
  return (
    name === INLINE_VISUAL_TOOL_NAME || name?.endsWith(`__${INLINE_VISUAL_TOOL_NAME}`) === true
  );
}

function resultTexts(entry: Pick<WorkLogEntry, "mcpToolResult" | "toolDetails">): string[] {
  const texts: string[] = [];
  const result = entry.mcpToolResult?.result;
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    texts.push(JSON.stringify(structured));
  }
  for (const block of result?.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  const output = entry.toolDetails?.output;
  for (const text of [output?.output, output?.stdout]) if (text) texts.push(text);
  return texts;
}

function parseTitle(text: string): string | undefined {
  const literal = TITLE_PATTERN.exec(text)?.[1];
  if (!literal) return undefined;
  try {
    const title = JSON.parse(literal) as unknown;
    return typeof title === "string" && title.trim().length > 0 ? title.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The visual a finished `moss_show_visual` call published, read from its result. The result
 * is the tool's reply to the agent (`visualId`, `embed`, `message`); even when Moss shortened
 * a large call, the id is near the start of the text, so a partial text still names it.
 */
export function shownVisualFromWorkEntry(
  entry: Pick<WorkLogEntry, "toolName" | "mcpToolResult" | "toolDetails">,
): ShownVisualToolResult | null {
  if (!isShowVisualTool(entry)) return null;
  if (entry.mcpToolResult && entry.mcpToolResult.status !== "completed") return null;
  if (entry.mcpToolResult?.error) return null;
  for (const text of resultTexts(entry)) {
    const visualId = VISUAL_ID_PATTERN.exec(text)?.[1];
    if (!visualId) continue;
    const title = parseTitle(text);
    return title ? { visualId, title } : { visualId };
  }
  return null;
}
