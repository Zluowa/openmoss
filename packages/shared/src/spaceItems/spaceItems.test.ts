import { describe, expect, it } from "vitest";

import { emptyItemData, parseAppItem, parseBoardItem, parseItemData } from "./itemData";
import {
  csvToSheet,
  parseSheetRange,
  parseSheetWorkbook,
  projectSheetWorkbook,
  readSheetRange,
  sheetToCsv,
  writeSheetRange,
} from "./sheetWorkbook";
import { BUILT_IN_TEMPLATES } from "./templates";

describe("sheet workbook", () => {
  it("parses A1 ranges", () => {
    expect(parseSheetRange("B2")).toEqual({ r0: 1, c0: 1, r1: 1, c1: 1 });
    expect(parseSheetRange("C10:A1")).toEqual({ r0: 0, c0: 0, r1: 9, c1: 2 });
    expect(parseSheetRange("AA3")).toEqual({ r0: 2, c0: 26, r1: 2, c1: 26 });
    expect(() => parseSheetRange("A0")).toThrow();
    expect(() => parseSheetRange("1A")).toThrow();
  });

  it("writes and reads values and formulas, keeping styles", () => {
    const start = parseSheetWorkbook({
      version: 1,
      sheets: [{ id: "s", name: "数据", cells: [{ r: 0, c: 0, v: "旧", s: { bold: true } }] }],
    });
    const { workbook, range } = writeSheetRange(start, "数据", "A1", [
      ["项目", "金额"],
      ["甲", 10],
      ["合计", "=SUM(B2:B2)"],
    ]);
    expect(range).toBe("A1:B3");
    const read = readSheetRange(workbook, undefined, "A1:B3");
    expect(read.values).toEqual([
      ["项目", "金额"],
      ["甲", 10],
      ["合计", null],
    ]);
    expect(read.formulas[2]).toEqual([null, "=SUM(B2:B2)"]);
    expect(workbook.sheets[0]!.cells.find((cell) => cell.r === 0 && cell.c === 0)?.s).toEqual({
      bold: true,
    });
    const cleared = writeSheetRange(workbook, undefined, "A2", [[null, null]]).workbook;
    expect(readSheetRange(cleared, undefined, "A2:B2").values).toEqual([[null, null]]);
    expect(projectSheetWorkbook(workbook)).toContain("|1|项目|金额|");
  });

  it("round-trips CSV with quotes, commas, newlines and numbers", () => {
    const sheet = csvToSheet('﻿名称,数量,备注\r\n"苹果, 红",3,"说 ""好"""\n梨,4.5,"两\n行"\n');
    expect(sheet.cells.find((cell) => cell.r === 1 && cell.c === 0)?.v).toBe("苹果, 红");
    expect(sheet.cells.find((cell) => cell.r === 2 && cell.c === 1)?.v).toBe(4.5);
    expect(sheet.cells.find((cell) => cell.r === 2 && cell.c === 2)?.v).toBe("两\n行");
    const again = csvToSheet(sheetToCsv(sheet));
    expect(again.cells).toEqual(sheet.cells);
  });

  it("rejects duplicate cells, bad formulas and duplicate sheet names", () => {
    const sheet = (cells: object[], name = "a") => ({ id: name, name, cells });
    expect(() =>
      parseSheetWorkbook({
        version: 1,
        sheets: [
          sheet([
            { r: 0, c: 0, v: 1 },
            { r: 0, c: 0, v: 2 },
          ]),
        ],
      }),
    ).toThrow(/repeats A1/);
    expect(() =>
      parseSheetWorkbook({ version: 1, sheets: [sheet([{ r: 0, c: 0, v: null, f: "SUM(A1)" }])] }),
    ).toThrow(/formula/);
    expect(() =>
      parseSheetWorkbook({ version: 1, sheets: [sheet([], "A"), sheet([], "a")] }),
    ).toThrow(/unique/);
  });
});

describe("typed item data and templates", () => {
  it("validates every built-in template payload for its kind", () => {
    for (const template of BUILT_IN_TEMPLATES) {
      if (template.kind === "page") {
        expect(template.content?.length).toBeGreaterThan(10);
        continue;
      }
      const parsed = parseItemData(template.kind, template.data!, template.title);
      expect(parsed.content.length).toBeGreaterThan(0);
    }
    const kpi = parseAppItem(
      BUILT_IN_TEMPLATES.find((template) => template.id === "builtin:kpi-dashboard")!.data!,
    );
    expect(kpi.capabilities).toEqual(["db"]);
    expect(kpi.html).toContain('id="moss-app-manifest"');
    expect(kpi.html).toContain('"capabilities":{"db":{}}');
  });

  it("creates valid empty payloads and rejects unknown app capabilities", () => {
    for (const kind of ["slides", "sheet", "board", "app"] as const) {
      expect(() => parseItemData(kind, emptyItemData(kind, { pageKey: "p1" }))).not.toThrow();
    }
    expect(parseBoardItem(emptyItemData("board", { pageKey: "abc" })).canvasProjectKey).toBe(
      "space-board-abc",
    );
    expect(() => parseAppItem({ version: 1, html: "<p>x</p>", capabilities: ["camera"] })).toThrow(
      /unknown capability/,
    );
  });
});
