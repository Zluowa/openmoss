import type { PageRichNode } from "./pageRichContent";

/**
 * Page block types and properties the AI page features add to Plate JSON. The Moss Canvas page
 * editor renders them; the server and agents only need to recognise them.
 */
export const PAGE_ASSISTANT_INSTRUCTIONS_TYPE = "moss_instructions";
export const PAGE_VISUALIZATION_TYPE = "moss_visualization";
/** Per-block authorship written when a person accepts an agent's draft. */
export const PAGE_BLOCK_AUTHOR_KEY = "mossAuthor";

export interface PageBlockAuthor {
  readonly kind: "agent";
  readonly threadId: string;
  readonly draftId?: string;
  /** ISO time the block was accepted into the page. */
  readonly at: string;
}

const text = (node: PageRichNode): string =>
  typeof node.text === "string"
    ? node.text
    : (node.children ?? [])
        .map(text)
        .join(node.type === "p" || node.type === undefined ? "" : "\n");

/** Standing instructions a person left for agents working on this page, in page order. */
export function pageAssistantInstructions(nodes: readonly PageRichNode[]): string[] {
  const found: string[] = [];
  const visit = (node: PageRichNode, depth: number) => {
    if (depth > 64 || typeof node.text === "string") return;
    if (node.type === PAGE_ASSISTANT_INSTRUCTIONS_TYPE) {
      const value = text(node).trim();
      if (value) found.push(value.slice(0, 20_000));
      return;
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  for (const node of nodes) visit(node, 0);
  return found.slice(0, 32);
}

export function pageBlockAuthor(node: PageRichNode): PageBlockAuthor | null {
  const value = node[PAGE_BLOCK_AUTHOR_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const author = value as Record<string, unknown>;
  return author.kind === "agent" &&
    typeof author.threadId === "string" &&
    typeof author.at === "string"
    ? {
        kind: "agent",
        threadId: author.threadId,
        at: author.at,
        ...(typeof author.draftId === "string" ? { draftId: author.draftId } : {}),
      }
    : null;
}
