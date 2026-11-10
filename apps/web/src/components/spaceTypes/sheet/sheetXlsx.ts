// FILE: sheetXlsx.ts
// Purpose: 电子表格 ↔ Excel (.xlsx) and CSV. Formulas are written as real Excel formulas with
//          their cached results, so Excel shows numbers before it recalculates.
// Layer: 资料空间 电子表格 (types stream), on the exceljs package Moss already ships.

import ExcelJS from "exceljs";

import {
  csvToSheet,
  parseSheetWorkbook,
  sheetToCsv,
  type Sheet,
  type SheetCell,
  type SheetCellStyle,
  type SheetScalar,
  type SheetWorkbook,
} from "@moss/shared/spaceItems/sheetWorkbook";

/** Engine column widths are pixels; Excel's are characters of the default font (~7px). */
const PX_PER_CHAR = 7;
const argb = (hex: string) => `FF${hex.replace(/^#/u, "").toUpperCase()}`;

export async function workbookToXlsx(workbook: SheetWorkbook): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  book.creator = "Moss";
  book.created = new Date();
  for (const sheet of workbook.sheets) {
    const target = book.addWorksheet(sheet.name, {
      ...(sheet.frozenRows
        ? { views: [{ state: "frozen" as const, ySplit: sheet.frozenRows }] }
        : {}),
    });
    for (const [column, width] of Object.entries(sheet.columnWidths ?? {})) {
      target.getColumn(Number(column) + 1).width = Math.round((width / PX_PER_CHAR) * 10) / 10;
    }
    for (const cell of sheet.cells) {
      const out = target.getCell(cell.r + 1, cell.c + 1);
      out.value = cell.f
        ? ({
            formula: cell.f.slice(1),
            ...(cell.v === null ? {} : { result: cell.v as never }),
          } as ExcelJS.CellFormulaValue)
        : cell.v;
      const style = cell.s;
      if (!style) continue;
      if (style.bold || style.italic || style.color) {
        out.font = {
          ...(style.bold ? { bold: true } : {}),
          ...(style.italic ? { italic: true } : {}),
          ...(style.color ? { color: { argb: argb(style.color) } } : {}),
        };
      }
      if (style.fill)
        out.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(style.fill) } };
      if (style.align) out.alignment = { horizontal: style.align };
      if (style.format) out.numFmt = style.format;
    }
  }
  return new Uint8Array(await book.xlsx.writeBuffer());
}

function scalarOf(value: ExcelJS.CellValue): { v: SheetScalar; f?: string } {
  if (value === null || value === undefined) return { v: null };
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    return { v: value };
  if (value instanceof Date) return { v: value.toISOString().slice(0, 10) };
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
  const color = cell.font?.color?.argb;
  if (color && /^[0-9A-Fa-f]{8}$/u.test(color) && color.slice(2).toUpperCase() !== "000000") {
    style.color = `#${color.slice(2).toUpperCase()}`;
  }
  const fill = cell.fill?.type === "pattern" ? cell.fill.fgColor?.argb : undefined;
  if (fill && /^[0-9A-Fa-f]{8}$/u.test(fill)) style.fill = `#${fill.slice(2).toUpperCase()}`;
  const align = cell.alignment?.horizontal;
  if (align === "left" || align === "center" || align === "right") style.align = align;
  if (cell.numFmt && cell.numFmt !== "General" && cell.numFmt.length <= 64)
    style.format = cell.numFmt;
  return Object.keys(style).length ? style : undefined;
}

export async function xlsxToWorkbook(bytes: ArrayBuffer): Promise<SheetWorkbook> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const sheets: Sheet[] = [];
  book.eachSheet((worksheet, id) => {
    if (sheets.length >= 50) return;
    const cells: SheetCell[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        if (cell.isMerged && cell.master !== cell) return;
        const { v, f } = scalarOf(cell.value);
        const s = styleOf(cell);
        if (v === null && !f && !s) return;
        cells.push({
          r: rowNumber - 1,
          c: columnNumber - 1,
          v,
          ...(f ? { f } : {}),
          ...(s ? { s } : {}),
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
    const view = worksheet.views?.[0] as { state?: string; ySplit?: number } | undefined;
    sheets.push({
      id: `sheet${id}`,
      name: worksheet.name.slice(0, 31) || `工作表${id}`,
      cells,
      ...(Object.keys(widths).length ? { columnWidths: widths } : {}),
      ...(view?.state === "frozen" && view.ySplit && view.ySplit < 100
        ? { frozenRows: view.ySplit }
        : {}),
    });
  });
  if (sheets.length === 0) throw new Error("这个文件里没有工作表。");
  return parseSheetWorkbook({ version: 1, sheets });
}

export function workbookSheetToCsv(workbook: SheetWorkbook, index = 0): string {
  // A byte-order mark lets Excel open UTF-8 Chinese text correctly.
  return `﻿${sheetToCsv(workbook.sheets[index] ?? workbook.sheets[0]!)}`;
}

export function csvToWorkbook(text: string, name = "工作表1"): SheetWorkbook {
  return parseSheetWorkbook({ version: 1, sheets: [csvToSheet(text, name)] });
}
