// FILE: pageDraftRebase.ts
// Purpose: Keeps an AI page draft from undoing what the person did after the agent read the
//          page. A draft is written against one revision; when the page has moved on, every
//          change that would touch a block the person added, edited or removed since is dropped,
//          and a whole-page rewrite keeps those blocks as they are now.
// Layer: Server pages (pure; the drafts service supplies the two revisions)

import type { PageDraftOp } from "@moss/contracts";
import type { PageRichNode } from "@moss/shared/pageRichContent";

const blockId = (node: PageRichNode): string | null =>
  typeof node.id === "string" && node.id ? node.id : null;

/** Key order differs between serializers; the content is what counts. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface PageChangesSince {
  /** Blocks the person added or edited after the base revision: a draft must not touch them. */
  readonly changed: ReadonlySet<string>;
  /** Blocks the person removed after the base revision: a draft must not bring them back. */
  readonly removed: ReadonlySet<string>;
}

/** Top-level blocks that differ between the revision a draft read and the page now. */
export function pageChangesSince(
  base: readonly PageRichNode[],
  current: readonly PageRichNode[],
): PageChangesSince {
  const before = new Map<string, string>();
  for (const node of base) {
    const id = blockId(node);
    if (id) before.set(id, canonical(node));
  }
  const changed = new Set<string>();
  const present = new Set<string>();
  for (const node of current) {
    const id = blockId(node);
    if (!id) continue;
    present.add(id);
    if (before.get(id) !== canonical(node)) changed.add(id);
  }
  const removed = new Set([...before.keys()].filter((id) => !present.has(id)));
  return { changed, removed };
}

/**
 * A whole-page proposal merged with what the person did since: their new and edited blocks stay
 * exactly as they are now (where they sit in the page), and blocks they removed stay removed.
 */
function mergeWholePage(
  proposed: readonly PageRichNode[],
  current: readonly PageRichNode[],
  changes: PageChangesSince,
): PageRichNode[] {
  const currentById = new Map<string, PageRichNode>();
  for (const node of current) {
    const id = blockId(node);
    if (id) currentById.set(id, node);
  }
  const merged: PageRichNode[] = [];
  for (const node of proposed) {
    const id = blockId(node);
    if (id && changes.removed.has(id)) continue;
    merged.push(id && changes.changed.has(id) ? currentById.get(id)! : node);
  }
  const placed = new Set(merged.map(blockId).filter((id): id is string => !!id));
  current.forEach((node, index) => {
    const id = blockId(node);
    if (!id || !changes.changed.has(id) || placed.has(id)) return;
    // Right after the nearest block above it that the proposal kept, else at the top.
    let at = 0;
    for (let before = index - 1; before >= 0; before--) {
      const anchor = blockId(current[before]!);
      const found = anchor ? merged.findIndex((entry) => blockId(entry) === anchor) : -1;
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    merged.splice(at, 0, node);
    placed.add(id);
  });
  return merged;
}

export interface RebasedPageDraft {
  readonly ops: PageDraftOp[];
  /** How many proposed changes were dropped because the person changed what they touched. */
  readonly dropped: number;
}

/**
 * The draft's changes that are still safe against the page as it is now. `base` is the
 * revision the draft was written against (null when it is unknown: nothing to compare).
 */
export function rebasePageDraftOps(
  ops: readonly PageDraftOp[],
  base: readonly PageRichNode[] | null,
  current: readonly PageRichNode[],
): RebasedPageDraft {
  if (base === null) return { ops: [...ops], dropped: 0 };
  const changes = pageChangesSince(base, current);
  if (changes.changed.size === 0 && changes.removed.size === 0)
    return { ops: [...ops], dropped: 0 };
  const touched = (id: string) => changes.changed.has(id) || changes.removed.has(id);
  const kept: PageDraftOp[] = [];
  let dropped = 0;
  for (const op of ops) {
    if ((op.kind === "replace" || op.kind === "delete") && touched(op.blockId)) {
      dropped += 1;
      continue;
    }
    if (op.kind === "replace-all") {
      if (op.richContent === undefined) {
        // A Markdown rewrite has no block ids to merge with; it would drop the person's work.
        dropped += 1;
        continue;
      }
      let proposed: unknown;
      try {
        proposed = JSON.parse(op.richContent);
      } catch {
        proposed = null;
      }
      if (!Array.isArray(proposed)) {
        dropped += 1;
        continue;
      }
      kept.push({
        kind: "replace-all",
        richContent: JSON.stringify(mergeWholePage(proposed as PageRichNode[], current, changes)),
      });
      continue;
    }
    kept.push(op);
  }
  return { ops: kept, dropped };
}
