import { describe, expect, it } from "vitest";

import { parseSheetWorkbook } from "@moss/shared/spaceItems/sheetWorkbook";

import { fromEngineSheets, toEngineSheets } from "./sheet/sheetEngine";
import { computeWorkbookFormulas } from "./sheet/sheetFormulas";
import {
  csvToWorkbook,
  workbookSheetToCsv,
  workbookToXlsx,
  xlsxToWorkbook,
} from "./sheet/sheetXlsx";
import { writeJpegPdf } from "./slides/jpegPdf";

const workbook = parseSheetWorkbook({
  version: 1,
  sheets: [
    {
      id: "sheet1",
      name: "预算",
      columnWidths: { "0": 140 },
      frozenRows: 1,
      cells: [
        { r: 0, c: 0, v: "类别", s: { bold: true, fill: "#EEF4F1" } },
        { r: 0, c: 1, v: "金额", s: { bold: true, align: "right" } },
        { r: 1, c: 0, v: "人员" },
        { r: 1, c: 1, v: 120, s: { format: "0.00" } },
        { r: 2, c: 0, v: "市场" },
        { r: 2, c: 1, v: 45 },
        { r: 3, c: 0, v: "合计" },
        { r: 3, c: 1, v: 165, f: "=SUM(B2:B3)" },
      ],
    },
  ],
});

describe("电子表格 engine mapping", () => {
  it("round-trips values, formulas, styles, widths and frozen rows through engine sheets", () => {
    expect(fromEngineSheets(toEngineSheets(workbook))).toEqual(workbook);
  });

  it("paints number formats into the engine's display text", () => {
    const [sheet] = toEngineSheets(
      parseSheetWorkbook({
        version: 1,
        sheets: [
          {
            id: "s",
            name: "s",
            cells: [
              { r: 0, c: 0, v: 0.9375, s: { format: "0.0%" } },
              { r: 0, c: 1, v: 1234567, s: { format: "#,##0" } },
            ],
          },
        ],
      }),
    );
    expect(sheet!.celldata!.map((entry) => (entry.v as { m?: string }).m)).toEqual([
      "93.8%",
      "1,234,567",
    ]);
  });

  it("reads the engine's dense matrix after edits", () => {
    const [sheet] = toEngineSheets(workbook);
    const data = [
      [
        { v: "A", m: "A", bl: 1 },
        { v: "130000", m: "130000", ct: { fa: "General", t: "n" } },
      ],
      [null, { v: 7, m: "7", f: "=3+4" }],
    ];
    const read = fromEngineSheets([{ ...sheet!, data: data as never }]);
    expect(read.sheets[0]!.cells).toEqual([
      { r: 0, c: 0, v: "A", s: { bold: true } },
      { r: 0, c: 1, v: 130000 },
      { r: 1, c: 1, v: 7, f: "=3+4" },
    ]);
  });
});

describe("电子表格 formulas", () => {
  it("computes template formulas, cross-sheet references and reports cycles", () => {
    const book = parseSheetWorkbook({
      version: 1,
      sheets: [
        {
          id: "a",
          name: "预算",
          cells: [
            { r: 0, c: 0, v: 120000 },
            { r: 0, c: 1, v: 112500 },
            { r: 0, c: 2, v: null, f: "=A1-B1" },
            { r: 0, c: 3, v: null, f: "=B1/A1" },
            { r: 1, c: 0, v: null, f: "=SUM(A1:B1)+C1" },
            { r: 2, c: 0, v: null, f: "=A4" },
            { r: 3, c: 0, v: null, f: "=A3" },
            { r: 4, c: 0, v: null, f: "=1/0" },
          ],
        },
        { id: "b", name: "汇总", cells: [{ r: 0, c: 0, v: null, f: "=预算!C1*2" }] },
      ],
    });
    const computed = computeWorkbookFormulas(book);
    const value = (sheet: number, r: number, c: number) =>
      computed.sheets[sheet]!.cells.find((cell) => cell.r === r && cell.c === c)?.v;
    expect(value(0, 0, 2)).toBe(7500);
    expect(value(0, 0, 3)).toBeCloseTo(0.9375);
    expect(value(0, 1, 0)).toBe(240000);
    expect(value(1, 0, 0)).toBe(15000);
    expect(value(0, 2, 0)).toBe("#REF!");
    expect(value(0, 4, 0)).toBe("#DIV/0!");
    // Formulas stay; only cached results are filled in.
    expect(computed.sheets[0]!.cells.find((cell) => cell.r === 0 && cell.c === 2)?.f).toBe(
      "=A1-B1",
    );
  });
});

describe("电子表格 xlsx and csv", () => {
  it("exports real Excel formulas with cached results and imports them back", async () => {
    const bytes = await workbookToXlsx(workbook);
    expect(bytes[0]).toBe(0x50); // ZIP
    const back = await xlsxToWorkbook(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    const total = back.sheets[0]!.cells.find((cell) => cell.r === 3 && cell.c === 1)!;
    expect(total).toMatchObject({ v: 165, f: "=SUM(B2:B3)" });
    expect(back.sheets[0]!.name).toBe("预算");
    expect(back.sheets[0]!.frozenRows).toBe(1);
    expect(back.sheets[0]!.cells.find((cell) => cell.r === 0 && cell.c === 0)?.s).toMatchObject({
      bold: true,
      fill: "#EEF4F1",
    });
    expect(back.sheets[0]!.cells.find((cell) => cell.r === 1 && cell.c === 1)?.s).toEqual({
      format: "0.00",
    });
  });

  it("writes CSV with a BOM and reads it back", () => {
    const csv = workbookSheetToCsv(workbook);
    expect(csv.startsWith("﻿类别,金额")).toBe(true);
    expect(
      csvToWorkbook(csv).sheets[0]!.cells.find((cell) => cell.r === 3 && cell.c === 1)?.v,
    ).toBe(165);
  });
});

describe("幻灯片 PDF", () => {
  it("writes one PDF page per slide image with a valid cross-reference table", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = writeJpegPdf([
      { jpeg, width: 1920, height: 1080 },
      { jpeg, width: 1920, height: 1080 },
    ]);
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Type /Pages /Count 2");
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(2);
    const startxref = Number(/startxref\n(\d+)/u.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    // Every xref offset points at its "N 0 obj" header.
    const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gmu)].map((match) =>
      Number(match[1]),
    );
    offsets.forEach((offset, index) =>
      expect(text.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true),
    );
  });
});
