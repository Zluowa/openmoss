import ExcelJS from "exceljs";

export async function workbookFixture(): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Financials");
  sheet.getCell("A1").value = "Quarterly report";
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF123456" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFCCEEFF" } };
  sheet.mergeCells("A1:C1");
  sheet.getCell("A3").value = new Date("2024-01-01T00:00:00Z");
  sheet.getCell("A3").numFmt = "yyyy-mm-dd";
  sheet.getCell("B3").value = 1234.5;
  sheet.getCell("B3").numFmt = '"$"#,##0.00';
  sheet.getCell("C3").value = { formula: "B3*2", result: 2469 };
  sheet.getCell("C3").numFmt = "#,##0.00";
  sheet.getRow(4).hidden = true;
  sheet.getCell("A4").value = "Hidden row";
  sheet.getRow(5).height = 30;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(4).hidden = true;
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
  sheet.getCell("A6").value = "Last data row";
  const image = workbook.addImage({
    base64:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
    extension: "png",
  });
  sheet.addImage(image, { tl: { col: 5, row: 2 }, ext: { width: 32, height: 32 } });
  workbook.addWorksheet("Second sheet").getCell("B2").value = "second";
  workbook.addWorksheet("Hidden", { state: "hidden" }).getCell("A1").value = "hidden";
  const bytes = await workbook.xlsx.writeBuffer();
  return new Uint8Array(bytes).buffer;
}
