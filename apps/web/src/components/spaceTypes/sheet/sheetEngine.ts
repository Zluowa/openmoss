// FILE: sheetEngine.ts
// Purpose: Maps the stored 电子表格 workbook to the spreadsheet engine's sheet data and back.
// Layer: 资料空间 电子表格 (types stream)
// Why: Rows keep Moss's engine-neutral shape (sparse cells: value, formula, light style); only
//      this file knows the engine's cell flags, so replacing the engine touches one file.

import { update as formatWithEngine, type Sheet as EngineSheet } from "@fortune-sheet/core";

import {
  parseSheetWorkbook,
  type Sheet,
  type SheetCell,
  type SheetCellStyle,
  type SheetScalar,
  type SheetWorkbook,
} from "@moss/shared/spaceItems/sheetWorkbook";

type EngineCell = {
  v?: unknown;
  m?: unknown;
  f?: string;
  bl?: number;
  it?: number;
  fc?: string;
  bg?: string;
  ht?: number | string;
  ct?: { fa?: string; t?: string };
};

const HEX = /^#[0-9A-Fa-f]{6}$/u;

function formatNumber(format: string, value: number): string {
  try {
    return String(formatWithEngine(format, value));
  } catch {
    return String(value);
  }
}
const ALIGN_TO_ENGINE = { center: 0, left: 1, right: 2 } as const;

function engineCell(cell: SheetCell): EngineCell {
  const out: EngineCell = {};
  if (cell.v !== null) {
    out.v = cell.v;
    // `m` is what the engine paints; a number format has to be applied here, not on load.
    out.m =
      typeof cell.v === "boolean"
        ? cell.v
          ? "TRUE"
          : "FALSE"
        : typeof cell.v === "number" && cell.s?.format
          ? formatNumber(cell.s.format, cell.v)
          : String(cell.v);
  }
  if (cell.f) out.f = cell.f;
  const style = cell.s;
  if (style?.bold) out.bl = 1;
  if (style?.italic) out.it = 1;
  if (style?.color) out.fc = style.color;
  if (style?.fill) out.bg = style.fill;
  if (style?.align) out.ht = ALIGN_TO_ENGINE[style.align];
  out.ct = { fa: style?.format ?? "General", t: typeof cell.v === "number" ? "n" : "g" };
  return out;
}

export function toEngineSheets(workbook: SheetWorkbook): EngineSheet[] {
  return workbook.sheets.map((sheet, order) => ({
    id: sheet.id,
    name: sheet.name,
    order,
    status: order === 0 ? 1 : 0,
    celldata: sheet.cells.map((cell) => ({ r: cell.r, c: cell.c, v: engineCell(cell) as never })),
    // The engine recomputes a formula's dependents only through its calc chain.
    calcChain: sheet.cells
      .filter((cell) => cell.f)
      .map((cell) => ({ r: cell.r, c: cell.c, id: sheet.id })),
    config: sheet.columnWidths ? { columnlen: { ...sheet.columnWidths } } : {},
    ...(sheet.frozenRows
      ? {
          frozen: {
            type: "rangeRow" as const,
            range: { row_focus: sheet.frozenRows - 1, column_focus: 0 },
          },
        }
      : {}),
  })) as EngineSheet[];
}

function scalar(value: unknown): SheetScalar {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return String(value).slice(0, 32_767);
}

function styleOf(cell: EngineCell): SheetCellStyle | undefined {
  const style: { -readonly [K in keyof SheetCellStyle]: SheetCellStyle[K] } = {};
  if (Number(cell.bl) === 1) style.bold = true;
  if (Number(cell.it) === 1) style.italic = true;
  if (typeof cell.fc === "string" && HEX.test(cell.fc) && cell.fc.toUpperCase() !== "#000000") {
    style.color = cell.fc.toUpperCase();
  }
  if (typeof cell.bg === "string" && HEX.test(cell.bg)) style.fill = cell.bg.toUpperCase();
  const align = Number(cell.ht);
  if (align === 0) style.align = "center";
  else if (align === 2) style.align = "right";
  else if (align === 1) style.align = "left";
  const format = cell.ct?.fa;
  if (format && format !== "General" && format !== "@" && format.length <= 64)
    style.format = format;
  return Object.keys(style).length ? style : undefined;
}

/** Reads the engine's live sheets (dense `data` matrix, or `celldata` before first render). */
export function fromEngineSheets(sheets: readonly EngineSheet[]): SheetWorkbook {
  const used = new Set<string>();
  const out: Sheet[] = sheets
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((sheet, position) => {
      const cells: SheetCell[] = [];
      const push = (r: number, c: number, raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const cell = raw as EngineCell;
        const f = typeof cell.f === "string" && cell.f.startsWith("=") ? cell.f : undefined;
        // Typed numbers arrive as text with a numeric cell type; keep them numbers for formulas and Excel.
        const entered = scalar(cell.v);
        const numeric =
          typeof entered === "string" &&
          cell.ct?.t === "n" &&
          entered.trim() !== "" &&
          Number.isFinite(Number(entered));
        const v = numeric ? Number(entered) : entered;
        const s = styleOf(cell);
        if (v === null && !f && !s) return;
        cells.push({ r, c, v, ...(f ? { f } : {}), ...(s ? { s } : {}) });
      };
      if (sheet.data) {
        sheet.data.forEach((row, r) => row?.forEach((cell, c) => push(r, c, cell)));
      } else {
        for (const entry of sheet.celldata ?? []) push(entry.r, entry.c, entry.v);
      }
      const widths: Record<string, number> = {};
      for (const [column, width] of Object.entries(sheet.config?.columnlen ?? {})) {
        if (typeof width === "number" && width >= 8 && width <= 2_000)
          widths[column] = Math.round(width);
      }
      let name = (sheet.name || `工作表${position + 1}`).slice(0, 31);
      while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)}_${position}`;
      used.add(name.toLowerCase());
      const frozen = (sheet as { frozen?: { type?: string; range?: { row_focus?: number } } })
        .frozen;
      const frozenRows =
        frozen?.type === "rangeRow" && typeof frozen.range?.row_focus === "number"
          ? frozen.range.row_focus + 1
          : frozen?.type === "row"
            ? 1
            : undefined;
      return {
        id: String(sheet.id ?? `sheet${position + 1}`).slice(0, 64),
        name,
        cells,
        ...(Object.keys(widths).length ? { columnWidths: widths } : {}),
        ...(frozenRows && frozenRows < 100 ? { frozenRows } : {}),
      };
    });
  return parseSheetWorkbook({ version: 1, sheets: out });
}
