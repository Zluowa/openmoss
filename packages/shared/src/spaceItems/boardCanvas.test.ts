// FILE: boardCanvas.test.ts
// Purpose: Unit tests for pure TypeScript board canvas schema, validators, summaries, and projection.

import { describe, expect, it } from "vitest";

import {
  BOARD_OP_KINDS,
  BOARD_PAGE_ID,
  createBoardCanvasDocument,
  isBoardColor,
  isBoardGeo,
  isBoardOp,
  parseBoardCanvasDocument,
  projectBoardCanvas,
  summarizeBoardCanvas,
} from "./boardCanvas";

describe("boardCanvas", () => {
  it("creates and parses valid v2 documents and upgrades v1 cleanly", () => {
    const empty = createBoardCanvasDocument();
    expect(empty.version).toBe(2);
    expect(empty.snapshot.store[BOARD_PAGE_ID]?.typeName).toBe("page");
    expect(parseBoardCanvasDocument(JSON.stringify(empty))).toEqual(empty);
    expect(parseBoardCanvasDocument({ version: 1, canvasProjectKey: "legacy" })).toEqual(empty);
  });

  it("summarizes shapes with parent frame offsets and arrow bindings, and projects readable markdown", () => {
    const doc = parseBoardCanvasDocument({
      version: 2,
      snapshot: {
        store: {
          "document:document": { id: "document:document", typeName: "document" },
          [BOARD_PAGE_ID]: { id: BOARD_PAGE_ID, typeName: "page", index: "a1" },
          "shape:frame1": {
            id: "shape:frame1",
            typeName: "shape",
            type: "frame",
            parentId: BOARD_PAGE_ID,
            x: 100,
            y: 50,
            index: "a1",
            props: { name: "想法区", w: 500, h: 400, color: "blue" },
          },
          "shape:note1": {
            id: "shape:note1",
            typeName: "shape",
            type: "note",
            parentId: "shape:frame1",
            x: 20,
            y: 30,
            index: "a2",
            props: {
              color: "yellow",
              richText: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ text: "核心目标" }] }],
              },
            },
          },
          "shape:loose1": {
            id: "shape:loose1",
            typeName: "shape",
            type: "geo",
            parentId: BOARD_PAGE_ID,
            x: 700,
            y: 60,
            index: "a3",
            props: { geo: "rectangle", text: "落地节奏", w: 200, h: 100, color: "green" },
          },
          "shape:arrow1": {
            id: "shape:arrow1",
            typeName: "shape",
            type: "arrow",
            parentId: BOARD_PAGE_ID,
            x: 0,
            y: 0,
            index: "a4",
            props: { text: "推动" },
          },
          "binding:start": {
            id: "binding:start",
            typeName: "binding",
            type: "arrow",
            fromId: "shape:arrow1",
            toId: "shape:note1",
            props: { terminal: "start" },
          },
          "binding:end": {
            id: "binding:end",
            typeName: "binding",
            type: "arrow",
            fromId: "shape:arrow1",
            toId: "shape:loose1",
            props: { terminal: "end" },
          },
        },
      },
    });

    const summary = summarizeBoardCanvas(doc);
    expect(summary.truncated).toBe(false);
    expect(summary.shapes).toEqual([
      {
        id: "shape:frame1",
        type: "frame",
        text: "想法区",
        color: "blue",
        x: 100,
        y: 50,
        w: 500,
        h: 400,
      },
      {
        id: "shape:note1",
        type: "note",
        text: "核心目标",
        color: "yellow",
        x: 120,
        y: 80,
        w: 200,
        h: 200,
        frame: "shape:frame1",
      },
      {
        id: "shape:loose1",
        type: "geo:rectangle",
        text: "落地节奏",
        color: "green",
        x: 700,
        y: 60,
        w: 200,
        h: 100,
      },
      {
        id: "shape:arrow1",
        type: "arrow",
        text: "推动",
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        from: "shape:note1",
        to: "shape:loose1",
      },
    ]);

    const projected = projectBoardCanvas(doc, "Sprint");
    expect(projected).toContain("## 想法区");
    expect(projected).toContain("- 核心目标");
    expect(projected).toContain("## 其他");
    expect(projected).toContain("- 落地节奏");
  });

  it("validates board colors, geos, and ops without @tldraw runtime", () => {
    expect(isBoardColor("blue")).toBe(true);
    expect(isBoardColor("purple")).toBe(false);
    expect(isBoardGeo("diamond")).toBe(true);
    expect(isBoardGeo("circle")).toBe(false);
    expect(BOARD_OP_KINDS).toContain("timeline");
    expect(isBoardOp({ op: "addNote", text: "Todo", color: "yellow" })).toBe(true);
    expect(isBoardOp({ op: "connect", from: "k1", to: "k2" })).toBe(true);
    expect(isBoardOp({ op: "addShape", geo: "invalid" })).toBe(false);
  });
});
