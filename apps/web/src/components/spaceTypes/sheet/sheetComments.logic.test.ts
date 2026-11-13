import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePageCommentsStore } from "~/pageCommentsStore";
import { postDeckComment } from "../slides/deckComments";
import {
  moveSheetComments,
  openSheetComments,
  sheetCommentAnchor,
  sheetCommentCell,
  sheetCommentLabel,
  sheetCommentsKey,
  shiftSheetCommentCells,
} from "./sheetComments.logic";

const key = sheetCommentsKey("page-1");
const me = { name: "主人", initials: "主" };
const comments = () => usePageCommentsStore.getState().commentsByPage[key] ?? [];

function comment(sheetId: string, r: number, c: number, body: string, sendToAgent = false) {
  const ask = vi.fn(() => Promise.resolve("thread-1"));
  postDeckComment({
    pageKey: key,
    author: me,
    threadId: null,
    anchor: sheetCommentAnchor({ sheetId, r, c }),
    label: sheetCommentLabel("表1", r, c),
    body,
    sendToAgent,
    ask,
  });
  return ask;
}

describe("sheet comments", () => {
  beforeEach(() => usePageCommentsStore.setState({ commentsByPage: {} }));

  it("names a cell the way a formula would", () => {
    expect(sheetCommentLabel("表1", 2, 1)).toBe("表1!B3");
    expect(sheetCommentLabel("Q1 sales", 0, 27)).toBe("'Q1 sales'!AB1");
    expect(sheetCommentLabel("Bob's", 9, 0)).toBe("'Bob''s'!A10");
  });

  it("anchors a comment to one cell of one sheet", () => {
    comment("s1", 4, 2, "这个数对吗？");
    const [first] = comments();
    expect(first!.anchor).toMatchObject({ selector: "s1/4:2", label: "表1!C5" });
    expect(sheetCommentCell(first!)).toEqual({ sheetId: "s1", r: 4, c: 2 });
    expect(openSheetComments(comments()).get("s1|4:2")?.body).toBe("这个数对吗？");
  });

  it("leaves resolved threads and other pages' anchors out of the open list", () => {
    comment("s1", 0, 0, "一");
    comment("s1", 1, 0, "二");
    usePageCommentsStore.getState().setResolved(key, comments()[0]!.id, true);
    usePageCommentsStore.getState().addComment({
      ...comments()[1]!,
      id: "deck",
      anchor: { selector: "slide-1/element-1", label: "", text: "" },
    });
    expect([...openSheetComments(comments()).keys()]).toEqual(["s1|1:0"]);
  });

  it("sends a comment to Moss with its cell and waits for the answer in the thread", () => {
    const ask = comment("s1", 2, 3, "@Moss 这一列为什么是空的？", true);
    expect(ask).toHaveBeenCalledWith("@Moss 这一列为什么是空的？", {
      slideId: "s1",
      elementId: "2:3",
    });
    const [first] = comments();
    expect(first!.sentToAgentAt).not.toBeNull();
    expect(first!.replies.at(-1)).toMatchObject({ kind: "agent", status: "thinking" });
  });

  it("moves anchors with inserted and deleted rows and columns", () => {
    expect(shiftSheetCommentCells(3, { kind: "insert", at: 2, count: 2 })).toBe(5);
    expect(shiftSheetCommentCells(1, { kind: "insert", at: 2, count: 2 })).toBe(1);
    expect(shiftSheetCommentCells(9, { kind: "delete", from: 2, to: 4 })).toBe(6);
    // A deleted cell's comment stays on the cell that takes its place.
    expect(shiftSheetCommentCells(3, { kind: "delete", from: 2, to: 4 })).toBe(2);
    expect(shiftSheetCommentCells(1, { kind: "delete", from: 2, to: 4 })).toBe(1);

    comment("s1", 5, 1, "下移");
    comment("s2", 5, 1, "别的表不动");
    moveSheetComments(key, "s1", "row", { kind: "insert", at: 0, count: 1 });
    moveSheetComments(key, "s1", "column", { kind: "insert", at: 1, count: 2 });
    const [moved, other] = comments();
    expect(moved!.anchor).toMatchObject({ selector: "s1/6:3", label: "表1!D7" });
    expect(other!.anchor.selector).toBe("s2/5:1");
  });
});
