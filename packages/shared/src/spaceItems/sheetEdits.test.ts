import { describe, expect, it } from "vitest";

import {
  applySheetEdits,
  readSheetWorkbook,
  SheetEditRefusal,
  sheetRulesFingerprint,
} from "./sheetEdits";
import { mapFormulaReferences, offsetFormula, renameSheetInFormula } from "./sheetFormulaRefs";
import { sheetGuide } from "./sheetGuide";
import { formatSheetNumber, parseTypedCellInput } from "./sheetValues";
import { createSheetWorkbook, parseSheetWorkbook, type SheetWorkbook } from "./sheetWorkbook";

const S = "工作表1";
function build(edits: unknown[], from: SheetWorkbook = createSheetWorkbook()) {
  return applySheetEdits(from, edits).workbook;
}
function cells(workbook: SheetWorkbook, range: string, sheet = S) {
  return readSheetWorkbook(workbook, 1, { kind: "readCells", sheet, range }).rows as Record<
    string,
    unknown[]
  >;
}
function refusal(fn: () => unknown) {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof SheetEditRefusal) return cause;
    throw cause;
  }
  throw new Error("expected a refusal");
}

describe("typed cell input", () => {
  it("reads numbers, money, percents, dates and times as typed", () => {
    expect(parseTypedCellInput("50%")).toEqual({ v: 0.5, format: "0%" });
    expect(parseTypedCellInput("12.5%")).toEqual({ v: 0.125, format: "0.0%" });
    expect(parseTypedCellInput("$1,200.50")).toEqual({ v: 1200.5, format: "$#,##0.00" });
    expect(parseTypedCellInput("1,200")).toEqual({ v: 1200, format: "#,##0" });
    expect(parseTypedCellInput("2026-03-15")).toEqual({ v: 46096, format: "yyyy-mm-dd" });
    expect(parseTypedCellInput("3/15/2026").v).toBe(46096);
    expect(parseTypedCellInput("Mar 15, 2026")).toEqual({ v: 46096, format: "mmm d, yyyy" });
    expect(parseTypedCellInput("2:30 PM").format).toBe("h:mm AM/PM");
    expect(parseTypedCellInput("'02139")).toEqual({ v: "02139" });
    expect(parseTypedCellInput("TRUE")).toEqual({ v: true });
    expect(parseTypedCellInput("=SUM(A1:A2)")).toEqual({ v: null, f: "=SUM(A1:A2)" });
    expect(parseTypedCellInput("Jan 2026")).toEqual({ v: "Jan 2026" });
    expect(parseTypedCellInput("7", "0%")).toEqual({ v: 0.07 });
  });
  it("shows numbers under formats", () => {
    expect(formatSheetNumber("#,##0.00", 1234.5)).toBe("1,234.50");
    expect(formatSheetNumber("0%", 0.256)).toBe("26%");
    expect(formatSheetNumber("$#,##0.00;[Red]-$#,##0.00", -5)).toBe("-$5.00");
    expect(formatSheetNumber("yyyy-mm-dd", 46096)).toBe("2026-03-15");
    expect(formatSheetNumber("h:mm AM/PM", 0.6041666)).toBe("2:30 PM");
    expect(formatSheetNumber("yyyy-mm-dd h:mm", 46096.5)).toBe("2026-03-15 12:00");
    expect(formatSheetNumber("[h]:mm:ss", 1.25)).toBe("30:00:00");
    expect(formatSheetNumber("0.00E+00", 12345)).toBe("1.23E+04");
    expect(formatSheetNumber('0.0" kg"', 3.14)).toBe("3.1 kg");
    expect(formatSheetNumber("General", 0.1 + 0.2)).toBe("0.3");
  });
});

describe("formula references", () => {
  it("follow inserted, deleted and moved rows", () => {
    const insert = { kind: "insert", at: 3, count: 1 } as const;
    expect(mapFormulaReferences("=SUM(B2:B5)+B9", S, S, "row", insert)).toBe("=SUM(B2:B6)+B10");
    expect(mapFormulaReferences("=B3", S, S, "row", { kind: "insert", at: 1, count: 2 })).toBe(
      "=B5",
    );
    expect(mapFormulaReferences("=B3+B6", S, S, "row", { kind: "delete", start: 2, end: 3 })).toBe(
      "=#REF!+B4",
    );
    expect(
      mapFormulaReferences("=SUM(B2:B9)", S, S, "row", { kind: "delete", start: 2, end: 3 }),
    ).toBe("=SUM(B2:B7)");
    expect(mapFormulaReferences('=LOG10(B2)&"B2"', S, S, "row", insert)).toBe('=LOG10(B2)&"B2"');
    expect(mapFormulaReferences("=Other!B5+B5", S, "Other", "row", insert)).toBe("=Other!B6+B5");
    expect(mapFormulaReferences("=C1", S, S, "column", { kind: "insert", at: 1, count: 1 })).toBe(
      "=D1",
    );
  });
  it("copies relative references and renames sheets", () => {
    expect(offsetFormula("=B2*$C$1+B$1", 2, 0)).toBe("=B4*$C$1+B$1");
    expect(renameSheetInFormula("='预算'!A1+预算!B2", "预算", "Budget 2")).toBe(
      "='Budget 2'!A1+'Budget 2'!B2",
    );
  });
});

describe("applySheetEdits", () => {
  it("builds a table and reads it back with worked-out formulas", () => {
    const wb = build([
      { kind: "renameSheet", sheet: S, name: "Budget" },
      {
        kind: "writeCells",
        sheet: "Budget",
        topLeft: "A1",
        rows: [
          ["Item", "Cost"],
          ["Rent", "$1,200"],
          ["Zip", "'02139"],
          ["Total", "=SUM(B2:B2)"],
        ],
      },
      {
        kind: "formatCells",
        sheet: "Budget",
        ranges: ["A1:B1"],
        format: { font: { bold: true }, fillColor: { kind: "standard", hue: "blue", shade: 100 } },
      },
      {
        kind: "setCellTable",
        sheet: "Budget",
        cellTable: { columns: "A:B", headerRows: "1", footerRows: "4" },
      },
      { kind: "setSheetSettings", sheet: "Budget", settings: { lastFrozenRow: 1 } },
      { kind: "fitColumns", sheet: "Budget", columns: "A:B" },
    ]);
    expect(cells(wb, "A1:B4", "Budget")).toEqual({
      "1": ["Item", "Cost"],
      "2": ["Rent", { number: 1200, shown: "$1,200.00" }],
      "3": ["Zip", "'02139"],
      "4": ["Total", { formula: "=SUM(B2:B2)", value: 1200 }],
    });
    const sheets = readSheetWorkbook(wb, 3, { kind: "readSheets" });
    expect(sheets).toMatchObject({
      revision: 3,
      sheets: [
        {
          name: "Budget",
          filledRange: "A1:B4",
          lastFrozenRow: 1,
          cellTable: { columns: "A:B", headerRows: "1", footerRows: "4" },
        },
      ],
    });
    const formats = readSheetWorkbook(wb, 3, {
      kind: "readCellFormats",
      sheet: "Budget",
      range: "A1:B1",
    });
    expect(formats.formats).toEqual([
      {
        ranges: ["A1:B1"],
        format: { fillColor: { kind: "standard", hue: "blue", shade: 100 }, font: { bold: true } },
      },
    ]);
    expect(parseSheetWorkbook(JSON.stringify(wb)).sheets[0]!.columnWidths?.["0"]).toBeGreaterThan(
      30,
    );
  });

  it("inserts rows that look like their neighbour and keeps totals", () => {
    let wb = build([
      {
        kind: "writeCells",
        sheet: S,
        topLeft: "A1",
        rows: [
          ["Item", "Cost"],
          ["Rent", 1200],
          ["Gas", 90],
          ["Total", "=SUM(B2:B3)"],
        ],
      },
      {
        kind: "formatCells",
        sheet: S,
        ranges: ["B2:B3"],
        format: { numberFormat: { pattern: "#,##0.00" } },
      },
    ]);
    wb = build(
      [
        { kind: "insertRows", sheet: S, besideRow: 3, side: "above", count: 1 },
        { kind: "writeCells", sheet: S, topLeft: "A3", rows: [["Bus", 60]] },
      ],
      wb,
    );
    expect(cells(wb, "A3:B5")).toEqual({
      "3": ["Bus", { number: 60, shown: "60.00" }],
      "4": ["Gas", { number: 90, shown: "90.00" }],
      "5": ["Total", { formula: "=SUM(B2:B4)", value: 1350 }],
    });
  });

  it("sorts records and deletes rows, breaking formulas that named deleted cells", () => {
    let wb = build([
      {
        kind: "writeCells",
        sheet: S,
        topLeft: "A1",
        rows: [
          ["n", "x2"],
          [3, "=A2*2"],
          [1, "=A3*2"],
          [2, "=A4*2"],
          ["top", "=A2"],
        ],
      },
    ]);
    wb = build(
      [{ kind: "sortRows", sheet: S, rows: "2:4", byColumn: "A", direction: "ascending" }],
      wb,
    );
    expect(cells(wb, "A2:B5")).toEqual({
      "2": [1, { formula: "=A2*2", value: 2 }],
      "3": [2, { formula: "=A3*2", value: 4 }],
      "4": [3, { formula: "=A4*2", value: 6 }],
      "5": ["top", { formula: "=A2", value: 1 }],
    });
    wb = build([{ kind: "deleteRows", sheet: S, rows: "2" }], wb);
    expect(cells(wb, "B4")).toEqual({ "4": [{ formula: "=#REF!", value: { error: "#REF!" } }] });
  });

  it("keeps dropdown cells to their options and checks boxes", () => {
    const wb = build([
      {
        kind: "writeCells",
        sheet: S,
        topLeft: "A1",
        rows: [
          ["Status", "Done"],
          ["done", null],
        ],
      },
      {
        kind: "makeDropdown",
        sheet: S,
        range: "A2:A5",
        options: [
          { label: "Done", color: { kind: "standard", hue: "green", shade: 200 } },
          { label: "To do", color: { kind: "none" } },
        ],
      },
      {
        kind: "formatCells",
        sheet: S,
        ranges: ["B2:B3"],
        format: { cellControl: { kind: "checkbox" } },
      },
    ]);
    const read = readSheetWorkbook(wb, 2, { kind: "readCells", sheet: S, range: "A1:B5" });
    expect(read.rows).toEqual({
      "1": ["Status", "Done"],
      "2": ["Done", false],
      "3": [null, false],
    });
    expect(read.checkboxes).toEqual(["B2:B3"]);
    expect((read.dropdowns as { options: unknown[] }[])[0]!.options).toHaveLength(2);
    const refused = refusal(() =>
      applySheetEdits(wb, [{ kind: "writeCells", sheet: S, topLeft: "A3", rows: [["Maybe"]] }]),
    );
    expect(refused).toMatchObject({ refusal: "notAnOption", editIndex: 0, address: "A3" });
  });

  it("refuses unknown kinds and keys, and lands nothing when one edit fails", () => {
    expect(
      refusal(() => applySheetEdits(createSheetWorkbook(), [{ kind: "writeCell" }])),
    ).toMatchObject({ refusal: "kindNotKnown", editIndex: 0 });
    expect(
      refusal(() =>
        applySheetEdits(createSheetWorkbook(), [{ kind: "addSheet", name: "A", extra: 1 }]),
      ),
    ).toMatchObject({ refusal: "keyNotKnown" });
    expect(
      refusal(() =>
        applySheetEdits(createSheetWorkbook(), [
          { kind: "writeCells", sheet: S, topLeft: "A1", rows: [[1]] },
          { kind: "writeCells", sheet: "Nope", topLeft: "A1", rows: [[1]] },
        ]),
      ),
    ).toMatchObject({ refusal: "sheetNotFound", editIndex: 1 });
    expect(
      refusal(() => applySheetEdits(createSheetWorkbook(), [{ kind: "deleteSheet", sheet: S }])),
    ).toMatchObject({ refusal: "onlySheet" });
    expect(
      refusal(() =>
        applySheetEdits(createSheetWorkbook(), [
          { kind: "writeCells", sheet: S, topLeft: "A1", rows: [[1, 2], [3]] },
        ]),
      ),
    ).toMatchObject({ refusal: "rowsNotTheSameLength" });
  });

  it("deletes and restores sheets, and formulas read them again", () => {
    let wb = build([
      { kind: "addSheet", name: "Data" },
      { kind: "writeCells", sheet: "Data", topLeft: "A1", rows: [[5]] },
      { kind: "writeCells", sheet: S, topLeft: "A1", rows: [["=Data!A1*2"]] },
      { kind: "deleteSheet", sheet: "Data" },
    ]);
    expect(cells(wb, "A1")).toEqual({
      "1": [{ formula: "=Data!A1*2", value: { error: "#REF!" } }],
    });
    wb = build([{ kind: "restoreSheet", sheet: "Data" }], wb);
    expect(cells(wb, "A1")).toEqual({ "1": [{ formula: "=Data!A1*2", value: 10 }] });
  });

  it("merges, borders, charts and conditional formats", () => {
    let wb = build([
      {
        kind: "writeCells",
        sheet: S,
        topLeft: "A1",
        rows: [
          ["Week", "Web"],
          ["W1", 4],
          ["W2", 9],
        ],
      },
      { kind: "mergeCells", sheet: S, ranges: ["D1:E1"] },
      {
        kind: "setBorders",
        sheet: S,
        range: "A1:B3",
        edges: "outer",
        border: { kind: "line", style: "thin", color: { kind: "none" } },
      },
      {
        kind: "addChart",
        chart: {
          name: "Web",
          caption: "",
          kind: "bar",
          cells: { sheet: S, range: "A1:B20" },
          sheet: S,
          topLeft: "D3",
          widthInPixels: 480,
          heightInPixels: 280,
        },
      },
    ]);
    const charts = readSheetWorkbook(wb, 2, { kind: "readCharts", sheet: S }).charts as {
      chartId: string;
      chart: Record<string, unknown>;
    }[];
    expect(charts[0]!.chart).toMatchObject({
      kind: "bar",
      topLeft: "D3",
      cells: { sheet: S, range: "A1:B20" },
    });
    expect(
      refusal(() =>
        applySheetEdits(wb, [{ kind: "writeCells", sheet: S, topLeft: "E1", rows: [["x"]] }]),
      ),
    ).toMatchObject({ refusal: "insideAMergedRange" });
    const fingerprint = sheetRulesFingerprint(wb.sheets[0]!);
    wb = build(
      [
        {
          kind: "replaceConditionalFormats",
          sheet: S,
          inPlaceOf: fingerprint,
          rules: [
            {
              cells: ["B2:B3"],
              effect: {
                kind: "formatWhere",
                allOf: [
                  {
                    tested: { kind: "theCellItself" },
                    condition: {
                      kind: "numberIs",
                      comparison: "greaterThan",
                      operand: { kind: "number", number: 5 },
                    },
                  },
                ],
                format: { fillColor: { kind: "standard", hue: "red", shade: 100 } },
              },
            },
          ],
        },
        { kind: "insertRows", sheet: S, besideRow: 1, side: "above", count: 1 },
      ],
      wb,
    );
    const rules = readSheetWorkbook(wb, 3, { kind: "readConditionalFormats", sheet: S });
    expect((rules.rules as { cells: string[] }[])[0]!.cells).toEqual(["B3:B4"]);
    expect(
      (
        readSheetWorkbook(wb, 3, { kind: "readCharts", sheet: S }).charts as {
          chart: { topLeft: string; cells: { range: string } };
        }[]
      )[0]!.chart,
    ).toMatchObject({ topLeft: "D4", cells: { range: "A2:B21" } });
    expect(
      refusal(() =>
        applySheetEdits(wb, [
          { kind: "replaceConditionalFormats", sheet: S, inPlaceOf: fingerprint, rules: [] },
        ]),
      ),
    ).toMatchObject({ refusal: "conditionalFormatsNotAsRead" });
  });

  it("reports edits of looks that changed nothing", () => {
    const wb = build([
      { kind: "formatCells", sheet: S, ranges: ["A1"], format: { font: { bold: true } } },
    ]);
    const result = applySheetEdits(wb, [
      { kind: "formatCells", sheet: S, ranges: ["A1"], format: { font: { bold: true } } },
      { kind: "writeCells", sheet: S, topLeft: "A2", rows: [[1]] },
    ]);
    expect(result.changedNothing).toEqual([0]);
    expect(
      refusal(() =>
        applySheetEdits(wb, [
          { kind: "formatCells", sheet: S, ranges: ["A1"], format: { font: { bold: true } } },
        ]),
      ),
    ).toMatchObject({ refusal: "nothingToChange" });
  });
});

describe("sheetGuide", () => {
  it("serves the core and building topics by default and others on request", () => {
    expect(sheetGuide()).toContain("moss_sheet_apply_edits");
    expect(sheetGuide(["charts"])).toContain("addChart");
  });
});

describe("evaluateSheetRules", () => {
  it("gives rows a look by one of their cells, ranks, and colour scales", async () => {
    const { evaluateSheetRules } = await import("./sheetRules");
    const sheet = parseSheetWorkbook({
      version: 1,
      sheets: [
        {
          id: "s",
          name: "s",
          cells: [
            { r: 0, c: 0, v: "a" },
            { r: 0, c: 1, v: 1 },
            { r: 0, c: 2, v: "Done" },
            { r: 1, c: 0, v: "b" },
            { r: 1, c: 1, v: 5 },
            { r: 1, c: 2, v: "To do" },
          ],
          rules: [
            {
              ranges: [{ r0: 0, c0: 0, r1: 1, c1: 0 }],
              effect: {
                kind: "formatWhere",
                allOf: [
                  {
                    tested: { kind: "sameRowInColumn", c: 2 },
                    condition: { kind: "textIs", text: "done" },
                  },
                ],
                format: { strike: true, color: "#6F6C66" },
              },
            },
            {
              ranges: [{ r0: 0, c0: 1, r1: 1, c1: 1 }],
              effect: {
                kind: "colorScale",
                lowest: { anchor: { kind: "smallestNumber" }, color: "#FFFFFF" },
                middle: null,
                highest: { anchor: { kind: "largestNumber" }, color: "#2A8540" },
              },
            },
          ],
        },
      ],
    }).sheets[0]!;
    const looks = evaluateSheetRules(sheet);
    expect(looks.get("0:0")).toEqual({ strike: true, color: "#6F6C66" });
    expect(looks.get("1:0")).toBeUndefined();
    expect(looks.get("1:1")).toEqual({ fill: "#2A8540" });
    expect(looks.get("0:1")).toBeUndefined();
  });
});
