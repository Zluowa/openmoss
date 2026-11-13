import { describe, expect, it } from "vitest";

import {
  applyDesignOps,
  boardsInReadingOrder,
  createDesignCanvas,
  DESIGN_ROW_GAP,
  nextBoardPosition,
  parseDesignCanvas,
  projectDesignCanvas,
  uniqueDesignId,
} from "./designCanvas";
import { BUILT_IN_DESIGN_SYSTEMS, designSystemCss, parseDesignSystemTokens } from "./designSystems";
import { DESIGN_TEMPLATES } from "./designTemplates";
import { emptyItemData, parseItemData } from "./itemData";

describe("design canvas", () => {
  it("creates an empty canvas with one page and round-trips through itemData", () => {
    const empty = emptyItemData("design");
    const parsed = parseItemData("design", empty, "新设计");
    expect(JSON.parse(parsed.data)).toEqual(createDesignCanvas());
    expect(parsed.content).toBe("# 新设计");
  });

  it("validates artboards, clamps frames and drops unknown tweak values", () => {
    const canvas = parseDesignCanvas({
      version: 1,
      pages: [{ id: "p", name: "页面" }],
      boards: [
        {
          id: "home",
          name: "首页",
          page: "missing",
          x: 0,
          y: 0,
          w: 10,
          h: 99_999,
          html: "<h1>你好</h1>",
          tweaks: [{ name: "accent", label: "强调", editor: "color", default: "#000" }],
          tweakValues: { accent: "#f00", other: 3 },
        },
      ],
      notes: [{ id: "n", text: "备注", color: "pink" }],
      system: null,
    });
    const board = canvas.boards[0]!;
    expect(board.page).toBe("p");
    expect([board.w, board.h]).toEqual([40, 8000]);
    expect(board.tweakValues).toEqual({ accent: "#f00" });
    expect(canvas.notes[0]).toMatchObject({ kind: "sticky", page: "p", color: "pink" });
  });

  it("refuses duplicate ids, bad ids and oversized artboards", () => {
    const base = { version: 1, pages: [], notes: [], system: null };
    expect(() => parseDesignCanvas({ ...base, boards: [{ id: "a" }, { id: "a" }] })).toThrow(
      /duplicate artboard/,
    );
    expect(() => parseDesignCanvas({ ...base, boards: [{ id: "a b" }] })).toThrow(/artboard id/);
    expect(() =>
      parseDesignCanvas({ ...base, boards: [{ id: "a", html: "x".repeat(400_001) }] }),
    ).toThrow(/larger than/);
  });

  it("projects artboard text without markup", () => {
    const canvas = parseDesignCanvas({
      version: 1,
      pages: [],
      boards: [
        { id: "a", name: "海报", w: 100, h: 100, html: "<style>p{}</style><p>春季&amp;夏季</p>" },
      ],
      notes: [],
      system: null,
    });
    expect(projectDesignCanvas(canvas, "活动")).toBe("# 活动\n\n### 海报 (100×100)\n\n春季&夏季");
  });

  it("places new artboards right of the top row and keeps ids unique", () => {
    let canvas = createDesignCanvas();
    canvas = applyDesignOps(canvas, [
      { op: "upsertBoard", board: { id: "a", w: 390, h: 844, html: "<p>a</p>" } },
      { op: "upsertBoard", board: { id: "b", w: 390, h: 844, html: "<p>b</p>" } },
    ]);
    expect(canvas.boards.map((board) => [board.x, board.y])).toEqual([
      [0, 0],
      [390 + DESIGN_ROW_GAP, 0],
    ]);
    expect(nextBoardPosition(canvas, "page-1", { w: 100, h: 100 }).x).toBe(
      2 * 390 + 2 * DESIGN_ROW_GAP,
    );
    expect(uniqueDesignId(canvas, "a")).toBe("a-2");
    expect(uniqueDesignId(canvas, "首页")).toBe("board");
  });

  it("applies moves, order, notes, pages and launch", () => {
    let canvas = applyDesignOps(createDesignCanvas(), [
      { op: "upsertBoard", board: { id: "a", x: 0, y: 0 } },
      { op: "upsertBoard", board: { id: "b", x: 2000, y: 0 } },
      { op: "reorderBoard", id: "b", to: "back" },
      { op: "moveBoard", id: "a", x: 10, w: 500 },
      { op: "upsertPage", page: { id: "p2", name: "第二页" } },
      { op: "upsertNote", note: { id: "n", page: "p2", text: "hi" } },
      { op: "setLaunch", launch: { view: "focused", boardId: "a" } },
      { op: "setThumbnail", id: "a" },
    ]);
    expect(canvas.boards.map((board) => board.id)).toEqual(["b", "a"]);
    expect(canvas.boards[1]).toMatchObject({ x: 10, w: 500 });
    expect(canvas.launch).toEqual({ view: "focused", boardId: "a" });
    canvas = applyDesignOps(canvas, [
      { op: "deletePage", id: "p2" },
      { op: "deleteBoard", id: "a" },
    ]);
    expect(canvas.notes).toEqual([]);
    expect(canvas.thumbnailBoardId).toBeUndefined();
    expect(() => applyDesignOps(canvas, [{ op: "deletePage", id: "page-1" }])).toThrow(
      /at least one page/,
    );
    expect(() => applyDesignOps(canvas, [{ op: "deleteBoard", id: "zz" }])).toThrow(/no artboard/);
  });

  it("orders artboards by rows, then columns", () => {
    const canvas = applyDesignOps(createDesignCanvas(), [
      { op: "upsertBoard", board: { id: "c", x: 0, y: 1000 } },
      { op: "upsertBoard", board: { id: "b", x: 1400, y: 10 } },
      { op: "upsertBoard", board: { id: "a", x: 0, y: 0 } },
    ]);
    expect(boardsInReadingOrder(canvas, "page-1").map((board) => board.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("design systems and templates", () => {
  it("validates built-in tokens and writes CSS variables per theme", () => {
    for (const system of BUILT_IN_DESIGN_SYSTEMS) {
      expect(parseDesignSystemTokens(system.tokens)).toEqual(system.tokens);
    }
    const moss = BUILT_IN_DESIGN_SYSTEMS[0]!.tokens;
    expect(designSystemCss(moss)).toContain("--ds-ink: #141413;");
    expect(designSystemCss(moss, "dark")).toContain("--ds-ink: #f0efec;");
    expect(designSystemCss(moss)).toContain("--ds-text-title-size: 22px;");
    expect(designSystemCss(moss)).toContain("--ds-radius-card: 12px;");
  });

  it("refuses tokens a stylesheet could be escaped through", () => {
    expect(() =>
      parseDesignSystemTokens({ colors: [{ name: "ink", light: "red;}body{x:1" }] }),
    ).toThrow(/colour/);
    expect(() => parseDesignSystemTokens({ fonts: { sans: "a;}" } })).toThrow(/font stack/);
    expect(() => parseDesignSystemTokens({ colors: [{ name: "Ink", light: "#fff" }] })).toThrow(
      /lower-case/,
    );
  });

  it("ships templates that parse and link only to their own artboards", () => {
    for (const template of DESIGN_TEMPLATES) {
      const canvas = parseDesignCanvas(JSON.stringify(template.canvas));
      expect(canvas.boards.length).toBeGreaterThan(0);
      const ids = new Set(canvas.boards.map((board) => board.id));
      for (const board of canvas.boards) {
        for (const match of board.html.matchAll(/href="board:([^"]+)"/gu))
          expect(ids).toContain(match[1]);
      }
    }
    const systemTemplate = DESIGN_TEMPLATES.find(
      (template) => template.id === "builtin:design-system",
    )!;
    expect(systemTemplate.canvas.ownSystem).toBeDefined();
  });
});
