import { describe, expect, it } from "vitest";

import {
  addMarkupMark,
  markupFileName,
  markupTextMark,
  EMPTY_MARKUP_HISTORY,
  finishMarkupDrag,
  markupStepDiameter,
  markupStepMark,
  redoMarkupMark,
  undoMarkupMark,
} from "./markup.logic";

describe("finishMarkupDrag", () => {
  it("treats a press without movement as a click that draws nothing", () => {
    expect(
      finishMarkupDrag("rect", [
        { x: 10, y: 10 },
        { x: 11, y: 11 },
      ]),
    ).toBeNull();
    expect(finishMarkupDrag("pen", [{ x: 10, y: 10 }])).toBeNull();
  });

  it("keeps a shape's two corners and the pen's whole path", () => {
    expect(
      finishMarkupDrag("arrow", [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 40, y: 20 },
      ]),
    ).toEqual({ kind: "arrow", from: { x: 0, y: 0 }, to: { x: 40, y: 20 } });
    const path = [
      { x: 0, y: 0 },
      { x: 4, y: 1 },
      { x: 9, y: 3 },
    ];
    expect(finishMarkupDrag("pen", path)).toEqual({ kind: "pen", points: path });
  });
});

describe("markupTextMark", () => {
  it("drops empty text and trims the rest", () => {
    expect(markupTextMark({ x: 1, y: 2 }, "   ")).toBeNull();
    expect(markupTextMark({ x: 1, y: 2 }, "  move this \n")).toEqual({
      kind: "text",
      at: { x: 1, y: 2 },
      text: "move this",
    });
  });
});

describe("sketch history", () => {
  it("undoes the last mark and clears redo on a new one", () => {
    const first = { kind: "rect", from: { x: 0, y: 0 }, to: { x: 9, y: 9 } } as const;
    const second = { kind: "line", from: { x: 0, y: 0 }, to: { x: 9, y: 0 } } as const;
    let history = addMarkupMark(EMPTY_MARKUP_HISTORY, first);
    history = addMarkupMark(history, second);
    history = undoMarkupMark(history);
    expect(history.marks).toEqual([first]);
    expect(history.undone).toEqual([second]);
    history = addMarkupMark(history, second);
    expect(history.undone).toEqual([]);
    expect(undoMarkupMark(EMPTY_MARKUP_HISTORY)).toBe(EMPTY_MARKUP_HISTORY);
  });
});

describe("markupFileName", () => {
  it("names the image after the page without characters a file system rejects", () => {
    expect(markupFileName('Dash: "Q4" / plan', new Date("2026-11-03T12:34:56Z"))).toBe(
      "Dash Q4 plan marked 20261103123456.png",
    );
    expect(markupFileName("", new Date("2026-11-03T12:34:56Z"))).toBe(
      "page marked 20261103123456.png",
    );
  });
});

describe("numbered steps and styles", () => {
  it("numbers each step one past the highest on the page", () => {
    const style = { color: "blue", width: 8 } as const;
    const first = markupStepMark([], { x: 10, y: 10 }, style);
    expect(first).toEqual({ kind: "step", at: { x: 10, y: 10 }, value: 1, style });
    const second = markupStepMark(
      [first, { kind: "line", from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }],
      { x: 30, y: 30 },
    );
    expect(second).toMatchObject({ kind: "step", value: 2 });
    expect(markupStepDiameter(2)).toBeLessThan(markupStepDiameter(12));
  });

  it("carries the chosen colour and width on a drawn mark", () => {
    expect(
      finishMarkupDrag(
        "line",
        [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
        ],
        { color: "green", width: 2 },
      ),
    ).toEqual({
      kind: "line",
      from: { x: 0, y: 0 },
      to: { x: 20, y: 0 },
      style: { color: "green", width: 2 },
    });
  });

  it("redoes the last undone mark", () => {
    const mark = { kind: "rect", from: { x: 0, y: 0 }, to: { x: 9, y: 9 } } as const;
    const undone = undoMarkupMark(addMarkupMark(EMPTY_MARKUP_HISTORY, mark));
    expect(redoMarkupMark(undone)).toEqual({ marks: [mark], undone: [] });
    expect(redoMarkupMark(EMPTY_MARKUP_HISTORY)).toBe(EMPTY_MARKUP_HISTORY);
  });
});
