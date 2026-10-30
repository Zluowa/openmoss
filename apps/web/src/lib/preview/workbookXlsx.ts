import ExcelJS from "exceljs";
import JSZip from "jszip";
import { format } from "ssf";

import {
  emptySheet,
  parseRange,
  type PreviewWorkbook,
  type WorkbookCell,
  type WorkbookImage,
} from "./workbookModel";
import { readWorkbookCharts } from "./workbookCharts";

const DEFAULT_THEME = [
  "FFFFFF",
  "000000",
  "E7E6E6",
  "44546A",
  "4472C4",
  "ED7D31",
  "A5A5A5",
  "FFC000",
  "5B9BD5",
  "70AD47",
  "0563C1",
  "954F72",
];

function colorCss(color: Partial<ExcelJS.Color> | undefined, theme: string[]): string | undefined {
  const hex =
    color?.argb?.slice(-6) ?? (color?.theme !== undefined ? theme[color.theme] : undefined);
  if (!hex || !/^[a-f\d]{6}$/i.test(hex)) return undefined;
  // Excel stores a luminance tint. Preserve the common tint/shade without dropping theme colors.
  const tint = (color as { tint?: number }).tint ?? 0;
  if (!tint) return `#${hex}`;
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16);
    return Math.round(tint < 0 ? channel * (1 + tint) : channel + (255 - channel) * tint);
  });
  return `rgb(${channels.join(",")})`;
}

function imageDataUrl(image: ExcelJS.Image): string | undefined {
  if (image.base64 && /^data:image\/(png|jpeg|gif);base64,[a-z\d+/=\s]+$/i.test(image.base64))
    return image.base64;
  if (!image.buffer || !["png", "jpeg", "gif"].includes(image.extension)) return undefined;
  const bytes = new Uint8Array(image.buffer as unknown as ArrayBuffer);
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return `data:image/${image.extension};base64,${btoa(binary)}`;
}

function displayedValue(cell: ExcelJS.Cell, date1904: boolean): { text: string; numeric?: number } {
  const value = cell.value;
  const raw =
    value && typeof value === "object" && !(value instanceof Date) && "formula" in value
      ? value.result
      : value && typeof value === "object" && "sharedFormula" in value
        ? value.result
        : value;
  if (raw === null || raw === undefined) return { text: "" };
  if (raw instanceof Date) {
    // SSF consumes Excel serial dates. The 1900 epoch includes Excel's fictitious leap day.
    const serial =
      (raw.getTime() - Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30)) /
      86_400_000;
    return { text: format(cell.numFmt || "m/d/yy", serial, { date1904 }), numeric: serial };
  }
  if (typeof raw === "number") {
    try {
      return { text: format(cell.numFmt || "General", raw, { date1904 }), numeric: raw };
    } catch {
      return { text: String(raw), numeric: raw };
    }
  }
  if (typeof raw === "boolean") return { text: raw ? "TRUE" : "FALSE" };
  if (typeof raw === "object") {
    if ("richText" in raw) return { text: raw.richText.map((run) => run.text).join("") };
    if ("error" in raw) return { text: raw.error };
    if ("text" in raw) return { text: raw.text };
  }
  return { text: String(raw) };
}

export async function readXlsxWorkbook(bytes: ArrayBuffer): Promise<PreviewWorkbook> {
  const zip = await JSZip.loadAsync(bytes);
  if (!zip.file("xl/workbook.xml")) throw new Error("The file does not contain an Excel workbook.");
  const warnings: string[] = [];
  // ExcelJS resolves workbook relationships relative to xl; normalize legal absolute package paths.
  const relationships = zip.file("xl/_rels/workbook.xml.rels");
  if (!relationships) throw new Error("The workbook relationships are missing.");
  const relationXml = await relationships.async("text");
  const normalizedRelations = relationXml.replace(/Target="\/xl\//g, 'Target="');
  const input =
    normalizedRelations === relationXml
      ? bytes
      : await (zip.file("xl/_rels/workbook.xml.rels", normalizedRelations),
        zip.generateAsync({ type: "arraybuffer" }));
  const theme = [...DEFAULT_THEME];
  const themeXml = await zip.file("xl/theme/theme1.xml")?.async("text");
  if (themeXml) {
    const names = [
      "lt1",
      "dk1",
      "lt2",
      "dk2",
      "accent1",
      "accent2",
      "accent3",
      "accent4",
      "accent5",
      "accent6",
      "hlink",
      "folHlink",
    ];
    names.forEach((name, index) => {
      const block = new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`).exec(
        themeXml,
      )?.[1];
      const value = block?.match(/(?:lastClr|val)="([a-f\d]{6})"/i)?.[1];
      if (value) theme[index] = value;
    });
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheets = workbook.worksheets.map((worksheet) => {
    const sheet = emptySheet(worksheet.name);
    sheet.hidden = worksheet.state !== "visible";
    sheet.rowCount = worksheet.rowCount;
    sheet.columnCount = worksheet.columnCount;
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const rowIndex = rowNumber - 1;
      if (row.height) sheet.rowHeights.set(rowIndex, (row.height * 96) / 72);
      if (row.hidden) sheet.hiddenRows.add(rowIndex);
      const cells = new Map<number, WorkbookCell>();
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const value = displayedValue(cell, workbook.properties.date1904 ?? false);
        const fill =
          cell.fill?.type === "pattern" && cell.fill.pattern === "solid"
            ? colorCss(cell.fill.fgColor, theme)
            : undefined;
        const font = cell.font ? { ...cell.font } : undefined;
        cells.set(colNumber - 1, {
          ...value,
          formula: cell.formula ? `=${cell.formula}` : undefined,
          font,
          color: colorCss(cell.font?.color, theme),
          fill,
          alignment: cell.alignment,
          border: cell.border,
          hyperlink: cell.hyperlink,
        });
      });
      if (cells.size) sheet.cells.set(rowIndex, cells);
    });
    // Empty styled/hidden rows have no cell value and are omitted by eachRow(includeEmpty:false).
    const modelRows =
      (
        worksheet.model as unknown as {
          rows?: Array<{ number: number; height?: number; hidden?: boolean }>;
        }
      ).rows ?? [];
    for (const row of modelRows) {
      if (row.height) sheet.rowHeights.set(row.number - 1, (row.height * 96) / 72);
      if (row.hidden) sheet.hiddenRows.add(row.number - 1);
    }
    worksheet.columns?.forEach((column, index) => {
      if (column.width !== undefined) sheet.columnWidths.set(index, column.width * 7 + 5);
      if (column.hidden) sheet.hiddenColumns.add(index);
    });
    for (const address of (worksheet.model as unknown as { merges?: string[] }).merges ?? []) {
      const merge = parseRange(address);
      if (merge) sheet.merges.push(merge);
    }
    const frozen = worksheet.views?.find((view) => view.state === "frozen");
    if (frozen?.state === "frozen") {
      sheet.frozenColumns = frozen.xSplit ?? 0;
      sheet.frozenRows = frozen.ySplit ?? 0;
    }
    for (const image of worksheet.getImages()) {
      const source = workbook.getImage(Number(image.imageId));
      if (!source) continue;
      const src = imageDataUrl(source);
      if (!src) continue;
      const range = image.range;
      const previewImage: WorkbookImage = { src, from: { row: range.tl.row, col: range.tl.col } };
      if (range.br) previewImage.to = { row: range.br.row, col: range.br.col };
      const ext = (range as unknown as { ext?: { width: number; height: number } }).ext;
      if (ext) {
        previewImage.width = ext.width;
        previewImage.height = ext.height;
      }
      sheet.images.push(previewImage);
    }
    const conditionalFormattings = (
      worksheet.model as unknown as { conditionalFormattings?: unknown[] }
    ).conditionalFormattings;
    if (conditionalFormattings?.length)
      warnings.push(
        `Conditional formatting in “${worksheet.name}” is not evaluated; stored cell styles are shown.`,
      );
    return sheet;
  });
  if (!sheets.length) throw new Error("The workbook has no readable worksheets.");
  if (Object.keys(zip.files).some((path) => /^xl\/charts\/chart\d+\.xml$/.test(path)))
    await readWorkbookCharts(zip, sheets, warnings);
  return { sheets, warnings };
}
