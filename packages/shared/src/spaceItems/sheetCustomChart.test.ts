import { describe, expect, it } from "vitest";

import { applySheetEdits, readSheetWorkbook, SheetEditRefusal } from "./sheetEdits";
import { parseSheetWorkbook } from "./sheetWorkbook";

const book = parseSheetWorkbook({
  version: 1,
  sheets: [
    {
      id: "s1",
      name: "账",
      cells: [
        { r: 0, c: 0, v: "项目" },
        { r: 0, c: 1, v: "金额" },
        { r: 1, c: 0, v: "房租" },
        { r: 1, c: 1, v: 3000 },
      ],
    },
  ],
});
const chart = (extra: Record<string, unknown>) => ({
  name: "金额",
  caption: "",
  cells: { sheet: "账", range: "A1:B2" },
  sheet: "账",
  topLeft: "D1",
  widthInPixels: 480,
  heightInPixels: 280,
  ...extra,
});

describe("custom charts", () => {
  it("keep the code an agent wrote and read it back", () => {
    const code = 'document.getElementById("chart").textContent = "hi";';
    const next = applySheetEdits(book, [
      { kind: "addChart", chart: chart({ kind: "custom", code }) },
    ]).workbook;
    expect(next.sheets[0]!.charts?.[0]).toMatchObject({ kind: "custom", code });
    const read = readSheetWorkbook(next, 2, { kind: "readCharts", sheet: "账" }) as {
      charts: { chart: { kind: string; code?: string } }[];
    };
    expect(read.charts[0]!.chart).toMatchObject({ kind: "custom", code });
    expect(parseSheetWorkbook(JSON.stringify(next)).sheets[0]!.charts?.[0]?.code).toBe(code);
  });

  it("need code, and only they take it", () => {
    expect(() =>
      applySheetEdits(book, [{ kind: "addChart", chart: chart({ kind: "custom" }) }]),
    ).toThrow(SheetEditRefusal);
    expect(() =>
      applySheetEdits(book, [{ kind: "addChart", chart: chart({ kind: "bar", code: "x" }) }]),
    ).toThrow(SheetEditRefusal);
  });
});
