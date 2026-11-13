// FILE: sheetComments.logic.ts
// Purpose: Where a 电子表格 comment points (one cell of one sheet), how that anchor is written into
//          the shared page-comment store, and how anchors follow rows and columns the person
//          inserts or deletes.
// Layer: 资料空间 电子表格 (pure logic)
// Exports: sheetCommentsKey, sheetCommentAnchor, sheetCommentCell, sheetCommentLabel,
//          openSheetComments, shiftSheetCommentCells, moveSheetComments.
// Why: Comments live with the other page comments on this device (the 幻灯片 and 设计 editors
//      store theirs the same way), so the deck helpers post them and follow Moss's answers; the
//      anchor reuses the deck anchor's two fields: the sheet id and the cell as "r:c".

import { columnName } from "@moss/shared/spaceItems/sheetWorkbook";

import type { DeckCommentAnchor } from "~/lib/deckEditorChannel";
import { usePageCommentsStore, type PageComment } from "~/pageCommentsStore";

export const sheetCommentsKey = (pageId: string) => `sheet:${pageId}`;

export interface SheetCommentCell {
  readonly sheetId: string;
  readonly r: number;
  readonly c: number;
}

export function sheetCommentAnchor(cell: SheetCommentCell): DeckCommentAnchor {
  return { slideId: cell.sheetId, elementId: `${cell.r}:${cell.c}` };
}

/** The cell a comment points at, or null for a comment that is not a sheet cell's. */
export function sheetCommentCell(comment: PageComment): SheetCommentCell | null {
  const [sheetId = "", at = ""] = comment.anchor.selector.split("/");
  const match = /^(\d+):(\d+)$/u.exec(at);
  if (!sheetId || !match) return null;
  return { sheetId, r: Number(match[1]), c: Number(match[2]) };
}

/** "表1!B3", as the thread card's heading and the request to Moss name the cell. */
export function sheetCommentLabel(sheetName: string, r: number, c: number): string {
  const quoted = /^[\p{L}\p{N}_]+$/u.test(sheetName)
    ? sheetName
    : `'${sheetName.replaceAll("'", "''")}'`;
  return `${quoted}!${columnName(c)}${r + 1}`;
}

/** Threads still open (not resolved), by "sheetId|r:c", oldest first. */
export function openSheetComments(
  comments: readonly PageComment[],
): ReadonlyMap<string, PageComment> {
  const out = new Map<string, PageComment>();
  for (const comment of comments) {
    if (comment.resolved) continue;
    const cell = sheetCommentCell(comment);
    if (!cell) continue;
    const key = `${cell.sheetId}|${cell.r}:${cell.c}`;
    if (!out.has(key)) out.set(key, comment);
  }
  return out;
}

export type SheetAxisChange =
  | { readonly kind: "insert"; readonly at: number; readonly count: number }
  | { readonly kind: "delete"; readonly from: number; readonly to: number };

/**
 * Where a cell's comment goes when rows or columns change: cells after an insert move along;
 * cells after a deleted span move back; a cell inside the span keeps its comment on the cell
 * that takes its place, so nothing a person wrote is lost.
 */
export function shiftSheetCommentCells(index: number, change: SheetAxisChange): number {
  if (change.kind === "insert") return index >= change.at ? index + change.count : index;
  if (index > change.to) return index - (change.to - change.from + 1);
  return Math.min(index, change.from);
}

/** Moves the comments of one sheet after the person inserted or deleted rows or columns. */
export function moveSheetComments(
  pageKey: string,
  sheetId: string,
  axis: "row" | "column",
  change: SheetAxisChange,
) {
  usePageCommentsStore.setState((state) => {
    const comments = state.commentsByPage[pageKey];
    if (!comments?.length) return state;
    let moved = false;
    const next = comments.map((comment) => {
      const cell = sheetCommentCell(comment);
      if (!cell || cell.sheetId !== sheetId) return comment;
      const r = axis === "row" ? shiftSheetCommentCells(cell.r, change) : cell.r;
      const c = axis === "column" ? shiftSheetCommentCells(cell.c, change) : cell.c;
      if (r === cell.r && c === cell.c) return comment;
      moved = true;
      const sheetName = comment.anchor.label.includes("!")
        ? comment.anchor.label.slice(0, comment.anchor.label.lastIndexOf("!"))
        : "";
      return {
        ...comment,
        anchor: {
          ...comment.anchor,
          selector: `${sheetId}/${r}:${c}`,
          label: sheetName ? `${sheetName}!${columnName(c)}${r + 1}` : comment.anchor.label,
        },
      };
    });
    return moved ? { commentsByPage: { ...state.commentsByPage, [pageKey]: next } } : state;
  });
}
