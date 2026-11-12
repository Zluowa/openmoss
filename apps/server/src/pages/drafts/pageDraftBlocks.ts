// FILE: pageDraftBlocks.ts
// Purpose: Keeps the blocks Markdown cannot hold (可视化, media, 助手说明) intact through an
//          agent's draft. A 可视化 block is only ever replaced by a 可视化 block that names its
//          应用页, the Markdown form agents read (`[title](moss-app-page:id)`) becomes that block
//          again, and a Markdown rewrite of a page holding such blocks is refused with a hint.
// Layer: Server pages (pure)

import type { PageDraftOp } from "@moss/contracts";
import { PAGE_VISUALIZATION_TYPE } from "@moss/shared/pageAi";
import type { PageRichNode } from "@moss/shared/pageRichContent";

/** Block types a Markdown body cannot carry; a Markdown rewrite would turn them into text. */
const RICH_ONLY_TYPES = new Set([
  PAGE_VISUALIZATION_TYPE,
  "moss_instructions",
  "moss_prompt",
  "video",
  "audio",
  "file",
  "media_embed",
]);

const APP_PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const APP_PAGE_LINK = /^\[([^\]\n]*)\]\(\s*moss-app-page:([A-Za-z0-9_-]{1,128})\s*\)$/u;

export interface VisualizationBlockFields {
  readonly appPageId: string;
  readonly title?: string | undefined;
  readonly prompt?: string | undefined;
}

/** The page block that shows a published 应用页 (rendered by the Moss Canvas page editor). */
export function visualizationBlock(fields: VisualizationBlockFields): PageRichNode {
  return {
    type: PAGE_VISUALIZATION_TYPE,
    title: (fields.title ?? "").trim().slice(0, 200) || "可视化",
    ...(fields.prompt ? { prompt: fields.prompt.slice(0, 2_000) } : {}),
    appPageId: fields.appPageId,
    children: [{ text: "" }],
  };
}

/** `[title](moss-app-page:id)` lines, the Markdown projection of 可视化 blocks, back as blocks. */
function markdownAsVisualizations(markdown: string): PageRichNode[] | null {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const blocks: PageRichNode[] = [];
  for (const line of lines) {
    const match = APP_PAGE_LINK.exec(line);
    if (!match) return null;
    blocks.push(visualizationBlock({ title: match[1], appPageId: match[2]! }));
  }
  return blocks;
}

/** A 可视化 node as agents tend to write it (appId, no children), in the editor's shape. */
function normalizeVisualization(node: PageRichNode): PageRichNode {
  if (node.type !== PAGE_VISUALIZATION_TYPE) return node;
  const { appId, appPageId, children, ...rest } = node;
  const id = typeof appPageId === "string" ? appPageId : typeof appId === "string" ? appId : null;
  return {
    ...rest,
    appPageId: id && APP_PAGE_ID.test(id) ? id : null,
    children: Array.isArray(children) && children.length ? children : [{ text: "" }],
  };
}

const isPublishedVisualization = (node: PageRichNode) =>
  node.type === PAGE_VISUALIZATION_TYPE && typeof node.appPageId === "string";

function bodyNodes(op: { markdown?: string; richContent?: string }): PageRichNode[] | null {
  if (op.richContent === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(op.richContent);
    return Array.isArray(parsed) ? (parsed as PageRichNode[]) : null;
  } catch {
    return null;
  }
}

const VISUALIZE_HINT =
  "Call moss_app_visualize with this blockId and the chart's HTML: it publishes the 应用页 and proposes the block in one step.";

/**
 * The draft's changes as they should be stored for this page: 可视化 blocks normalized and kept
 * as blocks. Throws an Error whose message tells the agent exactly what to send instead.
 */
export function prepareDraftOpsForPage(
  ops: readonly PageDraftOp[],
  current: readonly PageRichNode[],
): PageDraftOp[] {
  const byId = new Map<string, PageRichNode>();
  for (const node of current) if (typeof node.id === "string") byId.set(node.id, node);
  return ops.map((op) => {
    if (op.kind === "delete" || op.kind === "deck") return op;
    let body: { markdown?: string; richContent?: string } =
      op.markdown !== undefined ? { markdown: op.markdown } : { richContent: op.richContent! };
    if (body.markdown !== undefined) {
      const blocks = markdownAsVisualizations(body.markdown);
      if (blocks) body = { richContent: JSON.stringify(blocks) };
    }
    let nodes = bodyNodes(body);
    if (nodes?.some((node) => node.type === PAGE_VISUALIZATION_TYPE)) {
      nodes = nodes.map(normalizeVisualization);
      body = { richContent: JSON.stringify(nodes) };
    }
    if (op.kind === "replace") {
      const target = byId.get(op.blockId);
      if (target?.type === PAGE_VISUALIZATION_TYPE) {
        const published = nodes?.find(isPublishedVisualization);
        if (!nodes || !published)
          throw new Error(
            `Block ${op.blockId} is a 可视化 block; replacing it with text would lose it. ${VISUALIZE_HINT}`,
          );
        // The person's request stays on the block that answers it.
        nodes = nodes.map((node) =>
          node === published
            ? {
                ...node,
                title: typeof node.title === "string" && node.title ? node.title : target.title,
                ...(node.prompt === undefined && typeof target.prompt === "string"
                  ? { prompt: target.prompt }
                  : {}),
              }
            : node,
        );
        body = { richContent: JSON.stringify(nodes) };
      }
    }
    if (op.kind === "replace-all" && body.markdown !== undefined) {
      const kept = current.filter(
        (node) => typeof node.type === "string" && RICH_ONLY_TYPES.has(node.type),
      );
      if (kept.length > 0)
        throw new Error(
          `This page has blocks Markdown cannot hold (${[...new Set(kept.map((node) => node.type))].join(", ")}); a Markdown rewrite would turn them into text. Propose targeted ops (insert / replace / delete by block id) with moss_pages_draft instead.`,
        );
    }
    const { markdown: _markdown, richContent: _richContent, ...rest } = op;
    return { ...rest, ...body } as PageDraftOp;
  });
}
