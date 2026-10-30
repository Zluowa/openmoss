import { describe, expect, it } from "vitest";

import {
  columnName,
  dimensionOffsets,
  getWorkbookCell,
  indexAtOffset,
  parseDelimited,
  parseRange,
  readDelimitedWorkbook,
  selectionText,
} from "./workbookModel";

describe("workbook data coordinates", () => {
  it("preserves BOM quoted fields and blank records without inventing a header", () => {
    const rows = parseDelimited('\ufeff"a,b",c\r\n,\r\n\r\n"line1\nline2",end\r\n', ",");
    expect(rows).toEqual([["a,b", "c"], ["", ""], [""], ["line1\nline2", "end"]]);
    const workbook = readDelimitedWorkbook("name,value\n,\nthird,3\n", ",");
    expect(workbook.sheets[0]?.rowCount).toBe(3);
    expect(getWorkbookCell(workbook.sheets[0]!, { row: 0, col: 0 })).toEqual({ text: "name" });
    expect(getWorkbookCell(workbook.sheets[0]!, { row: 2, col: 0 })?.text).toBe("third");
  });
  it("parses 150000 real CSV records without an argument-limit exception", () => {
    const sheet = readDelimitedWorkbook("a,b\n".repeat(150_000), ",").sheets[0]!;
    expect(sheet.rowCount).toBe(150_000);
    expect(sheet.columnCount).toBe(2);
    expect(getWorkbookCell(sheet, { row: 149_999, col: 1 })?.text).toBe("b");
  });
  it("reports incomplete quoting instead of quietly reinterpreting the file", () => {
    expect(() => parseDelimited('a,"unterminated', ",")).toThrow("unterminated");
  });
  it("uses real Excel addresses including absolute and reversed ranges", () => {
    expect(columnName(26)).toBe("AA");
    expect(columnName(16383)).toBe("XFD");
    expect(parseRange("$D$8:B2")).toEqual({ start: { row: 1, col: 1 }, end: { row: 7, col: 3 } });
    expect(parseRange("XFE1")).toBeNull();
    expect(parseRange("A1048577")).toBeNull();
  });
  it("copies TSV preserving multiline and quote content", () => {
    const sheet = readDelimitedWorkbook('"a\nb",c\n"x""y",d', ",").sheets[0]!;
    expect(selectionText(sheet, parseRange("A1:B2")!)).toBe('"a\nb"\tc\n"x""y"\td');
  });
  it("locates visible rows through hidden rows and custom dimensions", () => {
    const offsets = dimensionOffsets(5, new Map([[2, 40]]), new Set([1]), 24);
    expect([...offsets]).toEqual([0, 24, 24, 64, 88, 112]);
    expect(indexAtOffset(offsets, 24)).toBe(2);
    expect(indexAtOffset(offsets, 110)).toBe(4);
  });
});
