import { describe, expect, it } from "vitest";

import {
  addBrowserSketchMark,
  browserSketchFileName,
  browserSketchTextMark,
  EMPTY_BROWSER_SKETCH_HISTORY,
  finishBrowserSketchDrag,
  browserSketchStepDiameter,
  browserSketchStepMark,
  redoBrowserSketchMark,
  undoBrowserSketchMark,
} from "./browserSketch.logic";

describe("finishBrowserSketchDrag", () => {
  it("treats a press without movement as a click that draws nothing", () => {
    expect(
      finishBrowserSketchDrag("rect", [
        { x: 10, y: 10 },
        { x: 11, y: 11 },
      ]),
    ).toBeNull();
    expect(finishBrowserSketchDrag("pen", [{ x: 10, y: 10 }])).toBeNull();
  });

  it("keeps a shape's two corners and the pen's whole path", () => {
    expect(
      finishBrowserSketchDrag("arrow", [
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
    expect(finishBrowserSketchDrag("pen", path)).toEqual({ kind: "pen", points: path });
  });
});

describe("browserSketchTextMark", () => {
  it("drops empty text and trims the rest", () => {
    expect(browserSketchTextMark({ x: 1, y: 2 }, "   ")).toBeNull();
    expect(browserSketchTextMark({ x: 1, y: 2 }, "  move this \n")).toEqual({
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
    let history = addBrowserSketchMark(EMPTY_BROWSER_SKETCH_HISTORY, first);
    history = addBrowserSketchMark(history, second);
    history = undoBrowserSketchMark(history);
    expect(history.marks).toEqual([first]);
    expect(history.undone).toEqual([second]);
    history = addBrowserSketchMark(history, second);
    expect(history.undone).toEqual([]);
    expect(undoBrowserSketchMark(EMPTY_BROWSER_SKETCH_HISTORY)).toBe(EMPTY_BROWSER_SKETCH_HISTORY);
  });
});

describe("browserSketchFileName", () => {
  it("names the image after the page without characters a file system rejects", () => {
    expect(browserSketchFileName('Dash: "Q4" / plan', new Date("2026-11-03T12:34:56Z"))).toBe(
      "Dash Q4 plan marked 20261103123456.png",
    );
    expect(browserSketchFileName("", new Date("2026-11-03T12:34:56Z"))).toBe(
      "page marked 20261103123456.png",
    );
  });
});

describe("numbered steps and styles", () => {
  it("numbers each step one past the highest on the page", () => {
    const style = { color: "blue", width: 8 } as const;
    const first = browserSketchStepMark([], { x: 10, y: 10 }, style);
    expect(first).toEqual({ kind: "step", at: { x: 10, y: 10 }, value: 1, style });
    const second = browserSketchStepMark(
      [first, { kind: "line", from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }],
      { x: 30, y: 30 },
    );
    expect(second).toMatchObject({ kind: "step", value: 2 });
    expect(browserSketchStepDiameter(2)).toBeLessThan(browserSketchStepDiameter(12));
  });

  it("carries the chosen colour and width on a drawn mark", () => {
    expect(
      finishBrowserSketchDrag(
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
    const undone = undoBrowserSketchMark(addBrowserSketchMark(EMPTY_BROWSER_SKETCH_HISTORY, mark));
    expect(redoBrowserSketchMark(undone)).toEqual({ marks: [mark], undone: [] });
    expect(redoBrowserSketchMark(EMPTY_BROWSER_SKETCH_HISTORY)).toBe(EMPTY_BROWSER_SKETCH_HISTORY);
  });
});
