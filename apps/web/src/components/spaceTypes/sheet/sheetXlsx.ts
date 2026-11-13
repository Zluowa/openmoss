// FILE: sheetXlsx.ts
// Purpose: 电子表格 ↔ Excel (.xlsx) and CSV / TSV. Formulas are written as real Excel formulas with
//          their cached results; fonts, fills, alignment, wrap, number formats, borders, merges,
//          sizes, freeze and dropdowns travel both ways. An import adds its sheets after the
//          ones that are there.
// Layer: 资料空间 电子表格 (types stream), on the exceljs package Moss already ships.
// Exports: workbookToXlsx, xlsxToWorkbook, workbookSheetToCsv, csvToWorkbook, appendImportedSheets.

import ExcelJS from "exceljs";

import { parseTypedCellInput } from "@moss/shared/spaceItems/sheetValues";
import {
  csvToSheet,
  filledRange,
  formatSheetRange,
  parseSheetRange,
  parseSheetWorkbook,
  sheetToCsv,
  type Sheet,
  type SheetBorderLine,
  type SheetCell,
  type SheetCellBorder,
  type SheetCellStyle,
  type SheetDropdown,
  type SheetRange,
  type SheetScalar,
  type SheetWorkbook,
} from "@moss/shared/spaceItems/sheetWorkbook";

/** Engine column widths are pixels; Excel's are characters of the default font (~7px). */
const PX_PER_CHAR = 7;
/** Excel row heights are points; a pixel is 0.75 pt. */
const PT_PER_PX = 0.75;
const argb = (hex: string) => `FF${hex.replace(/^#/u, "").toUpperCase()}`;

const TO_EXCEL_BORDER: Record<SheetBorderLine["style"], ExcelJS.BorderStyle> = {
  thin: "thin",
  medium: "medium",
  thick: "thick",
  dashed: "dashed",
  dotted: "dotted",
  double: "double",
};
function fromExcelBorder(border: Partial<ExcelJS.Border> | undefined): SheetBorderLine | undefined {
  const style = border?.style;
  if (!style) return undefined;
  const map: Partial<Record<ExcelJS.BorderStyle, SheetBorderLine["style"]>> = {
    thin: "thin",
    hair: "thin",
    medium: "medium",
    thick: "thick",
    dashed: "dashed",
    mediumDashed: "dashed",
    dashDot: "dashed",
    mediumDashDot: "dashed",
    dashDotDot: "dashed",
    mediumDashDotDot: "dashed",
    slantDashDot: "dashed",
    dotted: "dotted",
    double: "double",
  };
  const color = border?.color?.argb;
  return {
    style: map[style] ?? "thin",
    ...(color && /^[0-9A-Fa-f]{8}$/u.test(color) && color.slice(2).toUpperCase() !== "000000"
      ? { color: `#${color.slice(2).toUpperCase()}` }
      : {}),
  };
}

export async function workbookToXlsx(workbook: SheetWorkbook): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  book.creator = "Moss";
  book.created = new Date();
  const used = new Set<string>();
  for (const sheet of workbook.sheets) {
    // Excel names hold 31 characters and none of \ / ? * [ ] :.
    let name = sheet.name.replace(/[\\/?*[\]:]/gu, "_").slice(0, 31) || "Sheet";
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name.slice(0, 28)}_${n}`;
    used.add(name.toLowerCase());
    const target = book.addWorksheet(name, {
      views:
        sheet.frozenRows || sheet.frozenColumns
          ? [
              {
                state: "frozen",
                ySplit: sheet.frozenRows ?? 0,
                xSplit: sheet.frozenColumns ?? 0,
                showGridLines: !sheet.gridlinesHidden,
              },
            ]
          : [{ showGridLines: !sheet.gridlinesHidden }],
    });
    for (const [column, width] of Object.entries(sheet.columnWidths ?? {})) {
      target.getColumn(Number(column) + 1).width = Math.round((width / PX_PER_CHAR) * 10) / 10;
    }
    for (const [row, height] of Object.entries(sheet.rowHeights ?? {})) {
      target.getRow(Number(row) + 1).height = Math.round(height * PT_PER_PX * 10) / 10;
    }
    for (const g of sheet.rowGroups ?? [])
      for (let r = g.start; r <= g.end; r++) {
        const row = target.getRow(r + 1);
        row.outlineLevel = 1;
        row.hidden = g.collapsed;
      }
    for (const g of sheet.columnGroups ?? [])
      for (let c = g.start; c <= g.end; c++) {
        const column = target.getColumn(c + 1);
        column.outlineLevel = 1;
        column.hidden = g.collapsed;
      }
    for (const cell of sheet.cells) {
      const out = target.getCell(cell.r + 1, cell.c + 1);
      if (cell.f || cell.v !== null) {
        out.value = cell.f
          ? ({
              formula: cell.f.slice(1),
              ...(cell.v === null ? {} : { result: cell.v as never }),
            } as ExcelJS.CellFormulaValue)
          : cell.v;
      }
      const style = cell.s;
      if (!style) continue;
      if (
        style.bold ||
        style.italic ||
        style.color ||
        style.underline ||
        style.strike ||
        style.size
      ) {
        out.font = {
          ...(style.bold ? { bold: true } : {}),
          ...(style.italic ? { italic: true } : {}),
          ...(style.underline ? { underline: style.underline } : {}),
          ...(style.strike ? { strike: true } : {}),
          ...(style.size ? { size: style.size } : {}),
          ...(style.color ? { color: { argb: argb(style.color) } } : {}),
        };
      }
      if (style.fill)
        out.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(style.fill) } };
      if (style.align || style.valign || style.wrap) {
        out.alignment = {
          ...(style.align ? { horizontal: style.align } : {}),
          vertical:
            style.valign === "middle" ? "middle" : style.valign === "bottom" ? "bottom" : "top",
          ...(style.wrap ? { wrapText: true } : {}),
        };
      }
      if (style.format) out.numFmt = style.format;
      if (style.border) {
        const line = (l: SheetBorderLine) => ({
          style: TO_EXCEL_BORDER[l.style],
          ...(l.color ? { color: { argb: argb(l.color) } } : {}),
        });
        out.border = {
          ...(style.border.t ? { top: line(style.border.t) } : {}),
          ...(style.border.r ? { right: line(style.border.r) } : {}),
          ...(style.border.b ? { bottom: line(style.border.b) } : {}),
          ...(style.border.l ? { left: line(style.border.l) } : {}),
        };
      }
    }
    for (const merge of sheet.merges ?? [])
      target.mergeCells(merge.r0 + 1, merge.c0 + 1, merge.r1 + 1, merge.c1 + 1);
    for (const dropdown of sheet.dropdowns ?? []) {
      const list = dropdown.options.map((option) => option.label.replaceAll('"', '""')).join(",");
      if (list.length > 255) continue; // Excel's inline list limit.
      for (const range of dropdown.ranges) {
        (
          target as unknown as { dataValidations: { add: (ref: string, rule: object) => void } }
        ).dataValidations.add(formatSheetRange(range), {
          type: "list",
          allowBlank: true,
          formulae: [`"${list}"`],
        });
      }
    }
  }
  return new Uint8Array(await book.xlsx.writeBuffer());
}

function scalarOf(value: ExcelJS.CellValue): { v: SheetScalar; f?: string } {
  if (value === null || value === undefined) return { v: null };
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    return { v: value };
  if (value instanceof Date) {
    // Excel dates come back as UTC midnight; keep the serial day number.
    return { v: value.getTime() / 86_400_000 + 25_569 };
  }
  if (typeof value === "object") {
    if ("formula" in value && typeof value.formula === "string") {
      const result = scalarOf((value.result ?? null) as ExcelJS.CellValue).v;
      return { v: result, f: `=${value.formula}` };
    }
    if ("sharedFormula" in value)
      return { v: scalarOf((value.result ?? null) as ExcelJS.CellValue).v };
    if ("richText" in value) return { v: value.richText.map((part) => part.text).join("") };
    if ("text" in value && typeof value.text === "string") return { v: value.text };
    if ("error" in value) return { v: String(value.error) };
  }
  return { v: null };
}

function styleOf(cell: ExcelJS.Cell): SheetCellStyle | undefined {
  const style: { -readonly [K in keyof SheetCellStyle]: SheetCellStyle[K] } = {};
  if (cell.font?.bold) style.bold = true;
  if (cell.font?.italic) style.italic = true;
  if (
    cell.font?.underline === true ||
    cell.font?.underline === "single" ||
    cell.font?.underline === "singleAccounting"
  )
    style.underline = "single";
  else if (cell.font?.underline === "double" || cell.font?.underline === "doubleAccounting")
    style.underline = "double";
  if (cell.font?.strike) style.strike = true;
  const size = cell.font?.size;
  if (typeof size === "number" && size !== 10 && size !== 11 && size >= 6 && size <= 96)
    style.size = Math.round(size);
  const color = cell.font?.color?.argb;
  if (color && /^[0-9A-Fa-f]{8}$/u.test(color) && color.slice(2).toUpperCase() !== "000000")
    style.color = `#${color.slice(2).toUpperCase()}`;
  const fill =
    cell.fill?.type === "pattern" && cell.fill.pattern === "solid"
      ? cell.fill.fgColor?.argb
      : undefined;
  if (fill && /^[0-9A-Fa-f]{8}$/u.test(fill)) style.fill = `#${fill.slice(2).toUpperCase()}`;
  const align = cell.alignment?.horizontal;
  if (align === "left" || align === "center" || align === "right") style.align = align;
  const vertical = cell.alignment?.vertical;
  if (vertical === "middle") style.valign = "middle";
  else if (vertical === "bottom") style.valign = "bottom";
  if (cell.alignment?.wrapText) style.wrap = true;
  if (cell.numFmt && cell.numFmt !== "General" && cell.numFmt.length <= 128)
    style.format = cell.numFmt;
  const border: { -readonly [K in keyof SheetCellBorder]: SheetCellBorder[K] } = {};
  const t = fromExcelBorder(cell.border?.top);
  const r = fromExcelBorder(cell.border?.right);
  const b = fromExcelBorder(cell.border?.bottom);
  const l = fromExcelBorder(cell.border?.left);
  if (t) border.t = t;
  if (r) border.r = r;
  if (b) border.b = b;
  if (l) border.l = l;
  if (Object.keys(border).length) style.border = border;
  return Object.keys(style).length ? style : undefined;
}

export async function xlsxToWorkbook(bytes: ArrayBuffer): Promise<SheetWorkbook> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const sheets: Sheet[] = [];
  book.eachSheet((worksheet, id) => {
    if (sheets.length >= 200) return;
    const cells: SheetCell[] = [];
    const merges: SheetRange[] = [];
    for (const ref of (worksheet as unknown as { model?: { merges?: string[] } }).model?.merges ??
      []) {
      try {
        merges.push(parseSheetRange(ref));
      } catch {
        // A merge that names no range is left out.
      }
    }
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        if (cell.isMerged && cell.master !== cell) return;
        const { v, f } = scalarOf(cell.value);
        const s = styleOf(cell);
        // A date cell with no date format keeps the calendar day.
        const style =
          cell.value instanceof Date && !s?.format ? { ...(s ?? {}), format: "yyyy-mm-dd" } : s;
        if (v === null && !f && !style) return;
        cells.push({
          r: rowNumber - 1,
          c: columnNumber - 1,
          v,
          ...(f ? { f } : {}),
          ...(style ? { s: style } : {}),
        });
      });
    });
    const widths: Record<string, number> = {};
    worksheet.columns?.forEach((column, index) => {
      if (column.width)
        widths[String(index)] = Math.max(
          8,
          Math.min(2_000, Math.round(column.width * PX_PER_CHAR)),
        );
    });
    const heights: Record<string, number> = {};
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (row.height)
        heights[String(rowNumber - 1)] = Math.max(
          8,
          Math.min(2_000, Math.round(row.height / PT_PER_PX)),
        );
    });
    const dropdowns: SheetDropdown[] = [];
    const validations =
      (
        worksheet as unknown as {
          dataValidations?: { model?: Record<string, { type?: string; formulae?: string[] }> };
        }
      ).dataValidations?.model ?? {};
    for (const [ref, rule] of Object.entries(validations)) {
      const formula = rule.formulae?.[0];
      if (rule.type !== "list" || !formula || !/^".*"$/u.test(formula)) continue;
      const labels = [
        ...new Set(
          formula
            .slice(1, -1)
            .split(",")
            .map((label) => label.trim())
            .filter(Boolean),
        ),
      ].slice(0, 100);
      if (!labels.length) continue;
      try {
        const ranges = ref.split(/\s+/u).map(parseSheetRange);
        const ddId = `ddn_x${dropdowns.length}${id}`;
        dropdowns.push({
          id: ddId,
          ranges,
          options: labels.map((label, i) => ({ id: `opt_x${dropdowns.length}${id}_${i}`, label })),
        });
      } catch {
        // A rule over a range Moss cannot read is left out.
      }
    }
    const view = worksheet.views?.[0] as
      | { state?: string; ySplit?: number; xSplit?: number; showGridLines?: boolean }
      | undefined;
    sheets.push({
      id: `sheet${id}`,
      name: worksheet.name.slice(0, 100) || `工作表${id}`,
      cells,
      ...(Object.keys(widths).length ? { columnWidths: widths } : {}),
      ...(Object.keys(heights).length ? { rowHeights: heights } : {}),
      ...(view?.state === "frozen" && view.ySplit && view.ySplit < 1_000
        ? { frozenRows: view.ySplit }
        : {}),
      ...(view?.state === "frozen" && view.xSplit && view.xSplit < 200
        ? { frozenColumns: view.xSplit }
        : {}),
      ...(view?.showGridLines === false ? { gridlinesHidden: true } : {}),
      ...(merges.length ? { merges } : {}),
      ...(dropdowns.length ? { dropdowns } : {}),
    });
  });
  if (sheets.length === 0) throw new Error("这个文件里没有工作表。");
  return parseSheetWorkbook({ version: 1, sheets });
}

export function workbookSheetToCsv(workbook: SheetWorkbook, index = 0): string {
  // A byte-order mark lets Excel open UTF-8 Chinese text correctly.
  return `﻿${sheetToCsv(workbook.sheets[index] ?? workbook.sheets[0]!)}`;
}

/** A .csv / .tsv file as one sheet; each field is read as if it were typed into its cell. */
export function csvToWorkbook(text: string, name = "工作表1"): SheetWorkbook {
  if (!text.replace(/^﻿/u, "").trim()) throw new Error("这个文件是空的。");
  const sheet = csvToSheet(text, name);
  const cells = sheet.cells.map((cell): SheetCell => {
    if (typeof cell.v !== "string") return cell;
    const typed = parseTypedCellInput(cell.v);
    // No formula comes of a CSV file: text that starts with = stays text.
    if (typed.f) return cell;
    return { ...cell, v: typed.v, ...(typed.format ? { s: { format: typed.format } } : {}) };
  });
  return parseSheetWorkbook({ version: 1, sheets: [{ ...sheet, cells }] });
}

/**
 * Puts imported sheets after the ones that are there, renaming any whose name is taken and
 * giving each a fresh id. A workbook that is one blank sheet takes the file's sheets instead.
 */
export function appendImportedSheets(
  current: SheetWorkbook,
  imported: SheetWorkbook,
): SheetWorkbook {
  const onlyBlank =
    current.sheets.length === 1 &&
    filledRange(current.sheets[0]!) === null &&
    !current.sheets[0]!.charts?.length;
  const base = onlyBlank ? [] : [...current.sheets];
  const names = new Set(base.map((sheet) => sheet.name.toLowerCase()));
  const ids = new Set([...base, ...(current.deletedSheets ?? [])].map((sheet) => sheet.id));
  const stamp = Date.now().toString(36);
  const added = imported.sheets.map((sheet, i) => {
    let name = sheet.name;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${sheet.name.slice(0, 96)} (${n})`;
    names.add(name.toLowerCase());
    let id = onlyBlank && i === 0 ? current.sheets[0]!.id : `sheet${stamp}${i}`;
    while (ids.has(id)) id = `${id}x`;
    ids.add(id);
    return {
      ...sheet,
      id,
      name,
      charts: sheet.charts?.map((chart) => ({
        ...chart,
        source: { ...chart.source, sheetId: id },
      })),
    };
  });
  return parseSheetWorkbook({ ...current, sheets: [...base, ...added] });
}
