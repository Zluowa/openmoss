/// <reference path="./formulaParser.d.ts" />
import { Parser } from "@fortune-sheet/formula-parser";
import { describe, expect, it } from "vitest";

import { applySheetEdits } from "./sheetEdits";
import { computeWorkbookFormulas } from "./sheetFormulas";
import { parseSheetWorkbook, type SheetCell, type SheetWorkbook } from "./sheetWorkbook";

const data: SheetCell[] = [
  ["项目", "金额"],
  ["房租", 3000],
  ["伙食", 1720],
  ["交通", 260],
  ["伙食", 480],
].flatMap((row, r) => row.map((v, c) => ({ r, c, v })));

function book(extra: SheetCell[], more: Partial<SheetWorkbook["sheets"][number]> = {}) {
  return parseSheetWorkbook({
    version: 1,
    sheets: [{ id: "s1", name: "账", cells: [...data, ...extra], ...more }],
  });
}
const at = (workbook: SheetWorkbook, r: number, c: number) =>
  workbook.sheets[0]!.cells.find((cell) => cell.r === r && cell.c === c)?.v ?? null;
const column = (workbook: SheetWorkbook, c: number, r0: number, r1: number) =>
  Array.from({ length: r1 - r0 + 1 }, (_, i) => at(workbook, r0 + i, c));

describe("formulas that answer with a block", () => {
  it("spills FILTER, SORT, UNIQUE and SEQUENCE into the cells below", () => {
    const out = computeWorkbookFormulas(
      book([
        { r: 0, c: 3, v: null, f: "=FILTER(A2:A5,B2:B5>1000)" },
        { r: 0, c: 4, v: null, f: "=SORT(B2:B5,1,-1)" },
        { r: 0, c: 5, v: null, f: "=UNIQUE(A2:A5)" },
        { r: 0, c: 6, v: null, f: "=SEQUENCE(3)" },
      ]),
    );
    expect(column(out, 3, 0, 2)).toEqual(["房租", "伙食", null]);
    expect(column(out, 4, 0, 4)).toEqual([3000, 1720, 480, 260, null]);
    expect(column(out, 5, 0, 3)).toEqual(["房租", "伙食", "交通", null]);
    expect(column(out, 6, 0, 3)).toEqual([1, 2, 3, null]);
    expect(out.sheets[0]!.spills?.find((s) => s.c === 6)).toEqual({
      r: 0,
      c: 6,
      cells: [
        [1, 6, 2],
        [2, 6, 3],
      ],
    });
  });

  it("works operators cell by cell, so conditions in SUMPRODUCT add up", () => {
    const out = computeWorkbookFormulas(
      book([
        { r: 6, c: 0, v: null, f: '=SUMPRODUCT((A2:A5="伙食")*B2:B5)' },
        { r: 7, c: 0, v: null, f: "=SUMPRODUCT((B2:B5>500)*1)" },
      ]),
    );
    expect(at(out, 6, 0)).toBe(2200);
    expect(at(out, 7, 0)).toBe(2);
  });

  it("lets other formulas read the spilled cells", () => {
    const out = computeWorkbookFormulas(
      book([
        { r: 0, c: 6, v: null, f: "=SEQUENCE(3)" },
        { r: 5, c: 6, v: null, f: "=SUM(G1:G3)" },
      ]),
    );
    expect(at(out, 5, 6)).toBe(6);
  });

  it("shows #SPILL! when a person's value is in the way, and spills again once it is gone", () => {
    const blocked = computeWorkbookFormulas(
      book([
        { r: 0, c: 6, v: null, f: "=SEQUENCE(3)" },
        { r: 2, c: 6, v: "mine" },
      ]),
    );
    expect(column(blocked, 6, 0, 2)).toEqual(["#SPILL!", null, "mine"]);
    const freed = computeWorkbookFormulas({
      ...blocked,
      sheets: [
        { ...blocked.sheets[0]!, cells: blocked.sheets[0]!.cells.filter((c) => c.v !== "mine") },
      ],
    });
    expect(column(freed, 6, 0, 2)).toEqual([1, 2, 3]);
  });

  it("writes a spill again when its source changes, leaving no old values behind", () => {
    const first = computeWorkbookFormulas(book([{ r: 0, c: 3, v: null, f: "=UNIQUE(A2:A5)" }]));
    expect(column(first, 3, 0, 2)).toEqual(["房租", "伙食", "交通"]);
    const edited = applySheetEdits(first, [
      { kind: "writeCells", sheet: "账", topLeft: "A4", rows: [["房租"]] },
    ]).workbook;
    expect(column(edited, 3, 0, 2)).toEqual(["房租", "伙食", null]);
  });

  it("follows inserted rows", () => {
    const first = computeWorkbookFormulas(book([{ r: 0, c: 6, v: null, f: "=SEQUENCE(3)" }]));
    const moved = applySheetEdits(first, [
      { kind: "insertRows", sheet: "账", besideRow: 1, side: "above", count: 1 },
    ]).workbook;
    expect(column(moved, 6, 0, 3)).toEqual([null, 1, 2, 3]);
    expect(moved.sheets[0]!.spills?.[0]?.r).toBe(1);
  });

  it("answers with the first value where blocks are not spilled (the editor's engine)", () => {
    const parser = new Parser();
    expect(parser.parse("SEQUENCE(3)").result).toBe(1);
  });
});
