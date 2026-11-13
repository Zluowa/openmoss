// FILE: pageTextEdits.ts
// Purpose: The cheap ways an agent reads and edits a page without resending whole blocks: an
//          outline of the page's blocks (id, type, a short text) and word-level replacements
//          (`replace-text`: quote the words as they stand, send what replaces them). A
//          replacement is turned into an ordinary block `replace` draft op here, so drafts,
//          rebase and the editor's review stay as they are; marks around the words are kept.
// Layer: Agent gateway (page tools)
// Exports: pageBlockOutline, resolveTextReplacements, PageOutlineEntry

type Node = Record<string, unknown>;

export interface PageOutlineEntry {
  readonly id: string | null;
  readonly type: string;
  readonly text: string;
  /** Heading level, list style or checked state, when the block has one. */
  readonly level?: number;
  readonly list?: string;
  /** For a `moss_tab` block (a tab of the page; 1 = a sub-tab). */
  readonly tabLevel?: 0 | 1;
}

const OUTLINE_TEXT = 120;

function nodeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as Node;
  if (typeof value.text === "string") return value.text;
  return Array.isArray(value.children) ? value.children.map(nodeText).join("") : "";
}

/** One line per top-level block: what a model needs to anchor edits, at a fraction of the body. */
export function pageBlockOutline(nodes: readonly unknown[]): PageOutlineEntry[] {
  return nodes.map((raw) => {
    const node = (raw && typeof raw === "object" ? raw : {}) as Node;
    const type = typeof node.type === "string" ? node.type : "p";
    // A tab block has no text of its own: its title is what an agent needs.
    const text = (
      type === "moss_tab" && typeof node.title === "string" ? node.title : nodeText(node)
    )
      .replace(/\s+/gu, " ")
      .trim();
    const heading = /^h([1-6])$/u.exec(type);
    return {
      id: typeof node.id === "string" ? node.id : null,
      type,
      text: text.length > OUTLINE_TEXT ? `${text.slice(0, OUTLINE_TEXT)}…` : text,
      ...(heading ? { level: Number(heading[1]) } : {}),
      ...(typeof node.listStyleType === "string" ? { list: node.listStyleType } : {}),
      ...(type === "moss_tab" ? { tabLevel: node.level === 1 ? 1 : 0 } : {}),
    };
  });
}

interface Leaf {
  readonly owner: Node;
  readonly start: number;
  readonly end: number;
}

/** The text leaves of a block in reading order, with their offsets in the joined text. */
function leavesOf(block: Node): Leaf[] {
  const leaves: Leaf[] = [];
  let at = 0;
  const walk = (node: Node) => {
    if (typeof node.text === "string") {
      leaves.push({ owner: node, start: at, end: at + node.text.length });
      at += node.text.length;
      return;
    }
    if (Array.isArray(node.children))
      for (const child of node.children)
        if (child && typeof child === "object") walk(child as Node);
  };
  walk(block);
  return leaves;
}

/** Replaces the nth occurrence of `find` in a (cloned) block; false when it is not there. */
function replaceInBlock(block: Node, find: string, replacement: string, nth: number): boolean {
  const leaves = leavesOf(block);
  const joined = leaves.map((leaf) => leaf.owner.text as string).join("");
  let index = -1;
  for (let count = 0, from = 0; count < nth; count++) {
    index = joined.indexOf(find, from);
    if (index < 0) return false;
    from = index + Math.max(find.length, 1);
  }
  const end = index + find.length;
  let placed = false;
  // Offsets come from the joined text before any change, so edit leaves right to left.
  for (const leaf of [...leaves].reverse()) {
    if (leaf.end <= index || leaf.start >= end) {
      if (!(leaf.start === index && find.length === 0)) continue;
    }
    const text = leaf.owner.text as string;
    const from = Math.max(0, index - leaf.start);
    const to = Math.min(text.length, end - leaf.start);
    const first = leaf.start <= index;
    leaf.owner.text = text.slice(0, from) + (first && !placed ? replacement : "") + text.slice(to);
    if (first) placed = true;
  }
  return placed;
}

export type TextReplacement = {
  kind: "replace-text";
  find: string;
  replacement: string;
  blockId?: string;
  nth?: number;
};

/**
 * Turns `replace-text` ops into block `replace` ops against the page's current blocks (one per
 * block, however many words in it change); other ops pass through. Returns a hint when a quote
 * is not found, so the model quotes the words again as they stand.
 */
export function resolveTextReplacements(
  ops: readonly Record<string, unknown>[],
  nodes: readonly unknown[],
): { ops: Record<string, unknown>[] } | { hint: string } {
  const edited = new Map<string, Node>();
  const out: Record<string, unknown>[] = [];
  const blockSlot = new Map<string, number>();
  for (const [index, op] of ops.entries()) {
    if (op.kind !== "replace-text") {
      out.push(op);
      continue;
    }
    const find = op.find;
    const replacement = op.replacement ?? op.with ?? op.text;
    if (typeof find !== "string" || find === "")
      return {
        hint: `ops[${index}] (replace-text) needs find: the words to change, as they stand in the page.`,
      };
    if (typeof replacement !== "string")
      return {
        hint: `ops[${index}] (replace-text) needs replacement: the words that replace them ("" deletes them).`,
      };
    const nth = typeof op.nth === "number" && Number.isInteger(op.nth) && op.nth > 0 ? op.nth : 1;
    const candidates = nodes.filter(
      (node): node is Node =>
        !!node &&
        typeof node === "object" &&
        typeof (node as Node).id === "string" &&
        (typeof op.blockId !== "string" || (node as Node).id === op.blockId),
    );
    if (typeof op.blockId === "string" && candidates.length === 0)
      return {
        hint: `ops[${index}]: no block has id ${op.blockId}; read the page again (moss_pages_read).`,
      };
    let done = false;
    for (const candidate of candidates) {
      const id = candidate.id as string;
      const working = edited.get(id) ?? (structuredClone(candidate) as Node);
      if (!replaceInBlock(working, find, replacement, typeof op.blockId === "string" ? nth : 1))
        continue;
      edited.set(id, working);
      const op2 = { kind: "replace", blockId: id, richContent: JSON.stringify([working]) };
      const slot = blockSlot.get(id);
      if (slot === undefined) {
        blockSlot.set(id, out.length);
        out.push(op2);
      } else out[slot] = op2;
      done = true;
      break;
    }
    if (!done)
      return {
        hint: `ops[${index}]: "${find.slice(0, 80)}" is not in ${typeof op.blockId === "string" ? `block ${op.blockId}` : "the page"}. Quote the words exactly as they stand in moss_pages_read (no paraphrase), or give blockId.`,
      };
  }
  return { ops: out };
}
