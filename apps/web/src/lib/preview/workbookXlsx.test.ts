import { workbookFixture } from "./workbookFixtures";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { getWorkbookCell, selectionText, parseRange } from "./workbookModel";
import { readXlsxWorkbook } from "./workbookXlsx";

describe("real XLSX package import", () => {
  it("preserves coordinates, number formats, formula source and cached result, merges, styles, dimensions, freeze, hidden and image data", async () => {
    const workbook = await readXlsxWorkbook(await workbookFixture());
    const sheet = workbook.sheets[0]!;
    expect(workbook.sheets.map((item) => item.name)).toEqual([
      "Financials",
      "Second sheet",
      "Hidden",
    ]);
    expect(sheet.rowCount).toBeGreaterThanOrEqual(6);
    expect(getWorkbookCell(sheet, { row: 1, col: 0 })?.text ?? "").toBe("");
    expect(getWorkbookCell(sheet, { row: 2, col: 0 })?.text).toBe("2024-01-01");
    expect(getWorkbookCell(sheet, { row: 2, col: 1 })?.text).toBe("$1,234.50");
    expect(getWorkbookCell(sheet, { row: 2, col: 2 })).toMatchObject({
      text: "2,469.00",
      formula: "=B3*2",
      numeric: 2469,
    });
    expect(getWorkbookCell(sheet, { row: 0, col: 0 })).toMatchObject({
      font: { bold: true, size: 16 },
      color: "#123456",
      fill: "#CCEEFF",
    });
    expect(sheet.merges).toEqual([parseRange("A1:C1")]);
    expect(sheet.hiddenRows.has(3)).toBe(true);
    expect(sheet.hiddenColumns.has(3)).toBe(true);
    expect(sheet.rowHeights.get(4)).toBe(40);
    expect(sheet.columnWidths.get(1)).toBe(159);
    expect([sheet.frozenRows, sheet.frozenColumns]).toEqual([1, 1]);
    expect(sheet.images).toHaveLength(1);
    expect(sheet.images[0]?.src).toMatch(/^data:image\/png;base64,/);
    expect(workbook.sheets[2]?.hidden).toBe(true);
    expect(selectionText(sheet, parseRange("A3:C3")!)).toBe("2024-01-01\t$1,234.50\t2,469.00");
  });
  it("reads legal absolute package relationships rather than reporting a fake empty workbook", async () => {
    const zip = await JSZip.loadAsync(await workbookFixture());
    const part = zip.file("xl/_rels/workbook.xml.rels")!;
    zip.file(
      part.name,
      (await part.async("text")).replaceAll('Target="worksheets/', 'Target="/xl/worksheets/'),
    );
    const workbook = await readXlsxWorkbook(await zip.generateAsync({ type: "arraybuffer" }));
    expect(workbook.sheets[0]?.name).toBe("Financials");
    expect(getWorkbookCell(workbook.sheets[0]!, { row: 5, col: 0 })?.text).toBe("Last data row");
  });
  it("rejects a zip without workbook structure", async () => {
    const zip = new JSZip();
    zip.file("text.txt", "not an xlsx");
    await expect(
      readXlsxWorkbook(await zip.generateAsync({ type: "arraybuffer" })),
    ).rejects.toThrow("does not contain");
  });
});
