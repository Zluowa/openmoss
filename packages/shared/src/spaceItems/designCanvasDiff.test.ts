// FILE: designCanvasDiff.test.ts
// Purpose: The canvas diff (live room and per-person undo), shapes / link cards / components in the
//          payload, and the drawing geometry.
// Layer: Shared model tests

import { describe, expect, it } from "vitest";

import {
  applyDesignOps,
  applyDesignOpsLeniently,
  createDesignCanvas,
  designOpKey,
  diffDesignCanvas,
  parseDesignCanvas,
  type DesignCanvas,
} from "./designCanvas";
import { arrowHead, drawingMarkup, penPath, simplifyPoints, smoothPath } from "./designDraw";
import { customFontStack, findDesignFont } from "./designFonts";

const withBoards = (canvas: DesignCanvas, ids: string[]) =>
  applyDesignOps(
    canvas,
    ids.map((id, index) => ({
      op: "upsertBoard" as const,
      board: { id, name: id, page: "page-1", x: index * 500, y: 0, w: 390, h: 844, html: "" },
    })),
  );

describe("diffDesignCanvas", () => {
  it("turns one canvas into another, including removed fields and order", () => {
    const from = applyDesignOps(withBoards(createDesignCanvas(), ["a", "b", "c"]), [
      { op: "upsertBoard", board: { id: "a", hidden: true } },
      { op: "upsertNote", note: { id: "n", kind: "sticky", x: 0, y: 0, text: "hi" } },
    ]);
    const { hidden: _hidden, ...shown } = from.boards[0]!;
    const to = applyDesignOps(from, [
      { op: "upsertBoard", board: shown, replace: true },
      { op: "reorderBoard", id: "c", to: "back" },
      { op: "deleteNote", id: "n" },
      { op: "setTheme", theme: "dark" },
    ]);
    const ops = diffDesignCanvas(from, to);
    expect(applyDesignOps(from, ops)).toEqual(to);
    expect(to.boards.find((board) => board.id === "a")?.hidden).toBeUndefined();
    expect(new Set(ops.map(designOpKey))).toEqual(new Set(["board:a", "order", "note:n", "theme"]));
  });

  it("is empty for equal canvases", () => {
    const canvas = withBoards(createDesignCanvas(), ["a"]);
    expect(diffDesignCanvas(canvas, parseDesignCanvas(JSON.stringify(canvas)))).toEqual([]);
  });

  it("keeps another person's change to something the ops do not name", () => {
    const base = withBoards(createDesignCanvas(), ["a", "b"]);
    const mine = applyDesignOps(base, [{ op: "moveBoard", id: "a", x: 900 }]);
    const theirs = applyDesignOps(base, [{ op: "moveBoard", id: "b", y: 300 }]);
    const merged = applyDesignOps(theirs, diffDesignCanvas(base, mine));
    expect(merged.boards.find((board) => board.id === "a")?.x).toBe(900);
    expect(merged.boards.find((board) => board.id === "b")?.y).toBe(300);
  });

  it("drops ops on things someone else removed instead of failing", () => {
    const base = withBoards(createDesignCanvas(), ["a"]);
    const result = applyDesignOpsLeniently(base, [
      { op: "moveBoard", id: "gone", x: 1 },
      { op: "moveBoard", id: "a", x: 5 },
    ]);
    expect(result.applied).toHaveLength(1);
    expect(result.canvas.boards[0]!.x).toBe(5);
  });
});

describe("canvas shapes, link cards and components", () => {
  it("validates loose shapes, pictures and link cards", () => {
    const canvas = applyDesignOps(createDesignCanvas(), [
      {
        op: "upsertNote",
        note: { id: "arrow", kind: "shape", shape: "arrow", x: 10, y: 10, points: [0, 0, 80, 40] },
      },
      {
        op: "upsertNote",
        note: {
          id: "pen",
          kind: "shape",
          shape: "path",
          x: 0,
          y: 0,
          w: 40,
          h: 40,
          d: "M0 0L40 40",
        },
      },
      {
        op: "upsertNote",
        note: {
          id: "deck",
          kind: "link",
          x: 0,
          y: 900,
          text: "演示稿",
          href: "moss://space-page/p1",
        },
      },
    ]);
    expect(canvas.notes.find((note) => note.id === "arrow")).toMatchObject({ w: 80, h: 40 });
    expect(canvas.notes.find((note) => note.id === "deck")).toMatchObject({ w: 640, h: 112 });
    expect(() =>
      applyDesignOps(canvas, [
        { op: "upsertNote", note: { id: "bad", kind: "link", x: 0, y: 0, href: "javascript:x" } },
      ]),
    ).toThrow(/href/u);
    expect(() =>
      applyDesignOps(canvas, [
        {
          op: "upsertNote",
          note: { id: "bad", kind: "shape", shape: "path", x: 0, y: 0, d: "M0 0<script>" },
        },
      ]),
    ).toThrow(/path data/u);
  });

  it("keeps components and the paper of a flow-printed artboard", () => {
    const canvas = applyDesignOps(withBoards(createDesignCanvas(), ["a"]), [
      {
        op: "upsertComponent",
        component: {
          id: "button",
          name: "按钮",
          html: '<a data-design-component="button">去看看</a>',
        },
      },
      { op: "upsertBoard", board: { id: "a", print: "flow", paper: "a4" } },
    ]);
    const parsed = parseDesignCanvas(JSON.stringify(canvas));
    expect(parsed.components?.map((component) => component.id)).toEqual(["button"]);
    expect(parsed.boards[0]).toMatchObject({ print: "flow", paper: "a4" });
    expect(applyDesignOps(parsed, [{ op: "deleteComponent", id: "button" }]).components).toBe(
      undefined,
    );
  });
});

describe("drawing geometry", () => {
  it("thins a straight pencil stroke to its ends and smooths a curve", () => {
    const line = Array.from({ length: 20 }, (_, i) => ({ x: i, y: i }));
    expect(simplifyPoints(line, 0.5)).toEqual([line[0], line[19]]);
    expect(
      smoothPath([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
      ]),
    ).toBe("M0 0Q10 10 15 5L20 0");
  });

  it("draws corners straight and handles as curves, closing back to the start", () => {
    expect(
      penPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe("M0 0L10 0");
    expect(
      penPath(
        [
          { x: 0, y: 0, out: { x: 5, y: -5 } },
          { x: 10, y: 0 },
        ],
        false,
      ),
    ).toBe("M0 0C5 -5 10 0 10 0");
    expect(
      penPath(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 5, y: 8 },
        ],
        true,
      ),
    ).toMatch(/Z$/u);
  });

  it("puts an arrow head at the end and an artboard drawing in the design's ink", () => {
    expect(arrowHead(0, 0, 10, 0, 10).startsWith("10,0 ")).toBe(true);
    const markup = drawingMarkup({
      kind: "arrow",
      box: { x: 20, y: 30, w: 100, h: 0 },
      points: [0, 0, 100, 0],
    });
    expect(markup).toContain("position: absolute");
    expect(markup).toContain("var(--ds-ink, currentColor)");
    expect(markup).toContain("<polygon");
  });
});

describe("fonts", () => {
  it("finds listed stacks and quotes a typed font name", () => {
    expect(findDesignFont("var(--ds-font-sans)")?.id).toBe("ds-sans");
    expect(customFontStack('My "Font"')).toBe('"My Font", sans-serif');
    expect(customFontStack("")).toBeNull();
  });
});
