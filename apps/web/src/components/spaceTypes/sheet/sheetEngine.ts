// FILE: sheetEngine.ts
// Purpose: Maps the stored 电子表格 workbook to the spreadsheet engine's sheet data and back:
//          values, formulas, every cell look (fonts, colours, alignment, wrap, number format,
//          borders), merges, sizes, freeze and gridlines. Layers the engine knows nothing of
//          (dropdowns, checkboxes, the declared table, rules, charts, groups) travel beside it.
// Layer: 资料空间 电子表格 (types stream)
// Exports: toEngineSheets, fromEngineSheets, sheetLayersOf, ENGINE_BORDER_STYLE, SheetLayers.
// Why: Rows keep Moss's engine-neutral shape; only this file knows the engine's cell flags,
//      so replacing the engine touches one file.

import { update as formatWithEngine, type Sheet as EngineSheet } from "@fortune-sheet/core";

import {
  parseSheetWorkbook,
  type Sheet,
  type SheetBorderLine,
  type SheetBorderStyle,
  type SheetCell,
  type SheetCellBorder,
  type SheetCellStyle,
  type SheetScalar,
  type SheetWorkbook,
} from "@moss/shared/spaceItems/sheetWorkbook";
import { formatSheetNumber, isDateFormat } from "@moss/shared/spaceItems/sheetValues";

import { ENGINE_DEFAULT_INK, SHEET_INK } from "~/theme/sheetPalette";

type EngineCell = {
  v?: unknown;
  m?: unknown;
  f?: string;
  bl?: number;
  it?: number;
  un?: number;
  cl?: number;
  fs?: number;
  fc?: string;
  bg?: string;
  ht?: number | string;
  vt?: number | string;
  tb?: number | string;
  mc?: { r: number; c: number; rs?: number; cs?: number };
  ct?: { fa?: string; t?: string };
};
type EngineBorderSide = { style: number | string; color: string };
type EngineBorder =
  | {
      rangeType: "cell";
      value: {
        row_index: number;
        col_index: number;
        l?: EngineBorderSide;
        r?: EngineBorderSide;
        t?: EngineBorderSide;
        b?: EngineBorderSide;
      };
    }
  | {
      rangeType: "range";
      borderType: string;
      style: number | string;
      color: string;
      range: { row: [number, number]; column: [number, number] }[];
    };

/** Everything of a sheet that lives beside the engine, keyed by sheet id. */
export type SheetLayers = Pick<
  Sheet,
  | "dropdowns"
  | "checkboxes"
  | "table"
  | "rules"
  | "charts"
  | "rowGroups"
  | "columnGroups"
  | "spills"
>;
const LAYER_KEYS = [
  "dropdowns",
  "checkboxes",
  "table",
  "rules",
  "charts",
  "rowGroups",
  "columnGroups",
  "spills",
] as const;
export function sheetLayersOf(sheet: Sheet): SheetLayers {
  const out: Record<string, unknown> = {};
  for (const key of LAYER_KEYS) if (sheet[key] !== undefined) out[key] = sheet[key];
  return out as SheetLayers;
}

const HEX = /^#[0-9A-Fa-f]{6}$/u;
const INK = SHEET_INK;

/** Moss border styles to the engine's numbered line styles. */
export const ENGINE_BORDER_STYLE: Record<SheetBorderStyle, number> = {
  thin: 1,
  dotted: 3,
  dashed: 4,
  double: 7,
  medium: 8,
  thick: 13,
};
function borderStyleOf(value: number | string): SheetBorderStyle {
  const n = Number(value);
  if (n === 3) return "dotted";
  if (n === 4 || n === 5 || n === 6 || n === 9 || n === 10 || n === 11) return "dashed";
  if (n === 7) return "double";
  if (n === 8 || n === 12) return "medium";
  if (n === 13) return "thick";
  return "thin";
}
function engineSide(line: SheetBorderLine): EngineBorderSide {
  return { style: ENGINE_BORDER_STYLE[line.style], color: line.color ?? INK };
}
function mossSide(side: EngineBorderSide | undefined): SheetBorderLine | undefined {
  if (!side || Number(side.style) === 0) return undefined;
  const color = typeof side.color === "string" ? normalizeHex(side.color) : null;
  return {
    style: borderStyleOf(side.style),
    ...(color && color !== INK && color !== ENGINE_DEFAULT_INK ? { color } : {}),
  };
}
function normalizeHex(color: string): string | null {
  if (HEX.test(color)) return color.toUpperCase();
  if (/^#[0-9A-Fa-f]{3}$/u.test(color))
    return `#${[...color.slice(1)].map((x) => x + x).join("")}`.toUpperCase();
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(color);
  if (rgb)
    return `#${rgb
      .slice(1, 4)
      .map((x) => Number(x).toString(16).padStart(2, "0"))
      .join("")}`.toUpperCase();
  return null;
}

function formatNumber(format: string, value: number): string {
  if (isDateFormat(format)) return formatSheetNumber(format, value);
  try {
    return String(formatWithEngine(format, value));
  } catch {
    return formatSheetNumber(format, value);
  }
}
const ALIGN_TO_ENGINE = { center: 0, left: 1, right: 2 } as const;
const VALIGN_TO_ENGINE = { middle: 0, top: 1, bottom: 2 } as const;

function engineCell(
  cell: SheetCell,
  merge?: { r: number; c: number; rs: number; cs: number },
): EngineCell {
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
  if (style?.underline) out.un = style.underline === "double" ? 2 : 1;
  if (style?.strike) out.cl = 1;
  if (style?.size) out.fs = style.size;
  if (style?.color) out.fc = style.color;
  if (style?.fill) out.bg = style.fill;
  if (style?.align) out.ht = ALIGN_TO_ENGINE[style.align];
  out.vt = VALIGN_TO_ENGINE[style?.valign ?? "top"];
  // Text that does not wrap runs on over blank neighbours (the engine's "overflow").
  out.tb = style?.wrap ? "2" : "1";
  if (merge) out.mc = merge;
  const isDate = typeof cell.v === "number" && isDateFormat(style?.format);
  out.ct = {
    fa: style?.format ?? "General",
    t: typeof cell.v === "number" ? (isDate ? "d" : "n") : typeof cell.v === "boolean" ? "b" : "g",
  };
  return out;
}

export function toEngineSheets(workbook: SheetWorkbook, active?: string): EngineSheet[] {
  return workbook.sheets.map((sheet, order) => {
    const merges = sheet.merges ?? [];
    const cells = new Map(sheet.cells.map((cell) => [`${cell.r}:${cell.c}`, cell]));
    const merge: Record<string, { r: number; c: number; rs: number; cs: number }> = {};
    for (const m of merges) {
      merge[`${m.r0}_${m.c0}`] = { r: m.r0, c: m.c0, rs: m.r1 - m.r0 + 1, cs: m.c1 - m.c0 + 1 };
      // Every cell of a merged range carries the merge; the engine reads it from each.
      for (let r = m.r0; r <= m.r1; r++)
        for (let c = m.c0; c <= m.c1; c++)
          if (!cells.has(`${r}:${c}`)) cells.set(`${r}:${c}`, { r, c, v: null });
    }
    const celldata = [...cells.values()].map((cell) => {
      const own = merges.find(
        (m) => cell.r >= m.r0 && cell.r <= m.r1 && cell.c >= m.c0 && cell.c <= m.c1,
      );
      const mc = own
        ? own.r0 === cell.r && own.c0 === cell.c
          ? { r: own.r0, c: own.c0, rs: own.r1 - own.r0 + 1, cs: own.c1 - own.c0 + 1 }
          : { r: own.r0, c: own.c0 }
        : undefined;
      return { r: cell.r, c: cell.c, v: engineCell(cell, mc as never) as never };
    });
    const borderInfo: EngineBorder[] = sheet.cells.flatMap((cell) => {
      const border = cell.s?.border;
      if (!border) return [];
      return [
        {
          rangeType: "cell" as const,
          value: {
            row_index: cell.r,
            col_index: cell.c,
            ...(border.l ? { l: engineSide(border.l) } : {}),
            ...(border.r ? { r: engineSide(border.r) } : {}),
            ...(border.t ? { t: engineSide(border.t) } : {}),
            ...(border.b ? { b: engineSide(border.b) } : {}),
          },
        },
      ];
    });
    const config: Record<string, unknown> = {};
    if (sheet.columnWidths) config.columnlen = { ...sheet.columnWidths };
    if (sheet.rowHeights) config.rowlen = { ...sheet.rowHeights };
    if (Object.keys(merge).length) config.merge = merge;
    if (borderInfo.length) config.borderInfo = borderInfo;
    const rowhidden: Record<string, number> = {};
    for (const g of sheet.rowGroups ?? [])
      if (g.collapsed) for (let r = g.start; r <= g.end; r++) rowhidden[r] = 0;
    if (Object.keys(rowhidden).length) config.rowhidden = rowhidden;
    const colhidden: Record<string, number> = {};
    for (const g of sheet.columnGroups ?? [])
      if (g.collapsed) for (let c = g.start; c <= g.end; c++) colhidden[c] = 0;
    if (Object.keys(colhidden).length) config.colhidden = colhidden;
    const frozenRows = sheet.frozenRows ?? 0;
    const frozenColumns = sheet.frozenColumns ?? 0;
    const frozen =
      frozenRows && frozenColumns
        ? {
            type: "rangeBoth" as const,
            range: { row_focus: frozenRows - 1, column_focus: frozenColumns - 1 },
          }
        : frozenRows
          ? { type: "rangeRow" as const, range: { row_focus: frozenRows - 1, column_focus: 0 } }
          : frozenColumns
            ? {
                type: "rangeColumn" as const,
                range: { row_focus: 0, column_focus: frozenColumns - 1 },
              }
            : undefined;
    return {
      id: sheet.id,
      name: sheet.name,
      order,
      status: (active ? sheet.id === active : order === 0) ? 1 : 0,
      row: Math.max(sheet.rowCount ?? 1000, 100),
      column: Math.max(sheet.columnCount ?? 26, 26),
      celldata,
      // The engine recomputes a formula's dependents only through its calc chain.
      calcChain: sheet.cells
        .filter((cell) => cell.f)
        .map((cell) => ({ r: cell.r, c: cell.c, id: sheet.id })),
      config,
      showGridLines: sheet.gridlinesHidden ? 0 : 1,
      ...(frozen ? { frozen } : {}),
    } as unknown as EngineSheet;
  });
}

function scalar(value: unknown): SheetScalar {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return String(value).slice(0, 32_767);
}

function styleOf(
  cell: EngineCell,
  border: SheetCellBorder | undefined,
): SheetCellStyle | undefined {
  const style: { -readonly [K in keyof SheetCellStyle]: SheetCellStyle[K] } = {};
  if (Number(cell.bl) === 1) style.bold = true;
  if (Number(cell.it) === 1) style.italic = true;
  if (Number(cell.un) === 1 || Number(cell.un) === 3) style.underline = "single";
  else if (Number(cell.un) === 2 || Number(cell.un) === 4) style.underline = "double";
  if (Number(cell.cl) === 1) style.strike = true;
  const size = Number(cell.fs);
  if (Number.isInteger(size) && size >= 6 && size <= 96 && size !== 10) style.size = size;
  const color = typeof cell.fc === "string" ? normalizeHex(cell.fc) : null;
  if (color && color !== ENGINE_DEFAULT_INK) style.color = color;
  const fill = typeof cell.bg === "string" ? normalizeHex(cell.bg) : null;
  if (fill) style.fill = fill;
  const align = Number(cell.ht);
  if (cell.ht !== undefined && cell.ht !== null && cell.ht !== "") {
    if (align === 0) style.align = "center";
    else if (align === 2) style.align = "right";
    else if (align === 1) style.align = "left";
  }
  const valign = Number(cell.vt);
  if (cell.vt !== undefined && cell.vt !== null && cell.vt !== "") {
    if (valign === 0) style.valign = "middle";
    else if (valign === 2) style.valign = "bottom";
  }
  if (String(cell.tb) === "2") style.wrap = true;
  const format = cell.ct?.fa;
  if (format && format !== "General" && format.length <= 128) style.format = format;
  if (border && Object.keys(border).length) style.border = border;
  return Object.keys(style).length ? style : undefined;
}

/** Cell borders from the engine's list: per-cell entries, and ranges the engine's own tools wrote. */
function bordersOf(info: EngineBorder[] | undefined): Map<string, SheetCellBorder> {
  const out = new Map<string, { -readonly [K in keyof SheetCellBorder]: SheetCellBorder[K] }>();
  const at = (r: number, c: number) => {
    const key = `${r}:${c}`;
    let entry = out.get(key);
    if (!entry) out.set(key, (entry = {}));
    return entry;
  };
  for (const item of info ?? []) {
    if (item.rangeType === "cell") {
      const v = item.value;
      const entry = at(v.row_index, v.col_index);
      for (const side of ["l", "r", "t", "b"] as const) {
        if (!(side in v)) continue;
        const line = mossSide(v[side]);
        if (line) entry[side] = line;
        else delete entry[side];
      }
      continue;
    }
    const line = mossSide({ style: item.style, color: item.color });
    for (const range of item.range ?? []) {
      const [r0, r1] = range.row;
      const [c0, c1] = range.column;
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const entry = at(r, c);
          const set = (side: keyof SheetCellBorder, on: boolean) => {
            if (!on) return;
            if (line && item.borderType !== "border-none") entry[side] = line;
            else delete entry[side];
          };
          const type = item.borderType;
          const all = type === "border-all" || type === "border-none";
          set(
            "t",
            all ||
              (type === "border-top" && r === r0) ||
              (type === "border-outside" && r === r0) ||
              ((type === "border-inside" || type === "border-horizontal") && r > r0),
          );
          set(
            "b",
            all ||
              (type === "border-bottom" && r === r1) ||
              (type === "border-outside" && r === r1) ||
              ((type === "border-inside" || type === "border-horizontal") && r < r1),
          );
          set(
            "l",
            all ||
              (type === "border-left" && c === c0) ||
              (type === "border-outside" && c === c0) ||
              ((type === "border-inside" || type === "border-vertical") && c > c0),
          );
          set(
            "r",
            all ||
              (type === "border-right" && c === c1) ||
              (type === "border-outside" && c === c1) ||
              ((type === "border-inside" || type === "border-vertical") && c < c1),
          );
        }
    }
  }
  for (const [key, value] of out) if (Object.keys(value).length === 0) out.delete(key);
  return out;
}

/**
 * Reads the engine's live sheets (dense `data` matrix, or `celldata` before first render) and
 * puts each sheet's layers back beside it.
 */
export function fromEngineSheets(
  sheets: readonly EngineSheet[],
  layers: ReadonlyMap<string, SheetLayers> = new Map(),
  deletedSheets?: readonly Sheet[],
): SheetWorkbook {
  const used = new Set<string>();
  const out: Sheet[] = sheets
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((sheet, position) => {
      const config = (sheet.config ?? {}) as Record<string, unknown>;
      const borders = bordersOf(config.borderInfo as EngineBorder[] | undefined);
      const cells: SheetCell[] = [];
      const seen = new Set<string>();
      const push = (r: number, c: number, raw: unknown) => {
        const key = `${r}:${c}`;
        const cell = (raw && typeof raw === "object" ? raw : {}) as EngineCell;
        const f = typeof cell.f === "string" && cell.f.startsWith("=") ? cell.f : undefined;
        // Typed numbers arrive as text with a numeric cell type; keep them numbers for formulas and Excel.
        const entered = scalar(cell.v);
        const numeric =
          typeof entered === "string" &&
          (cell.ct?.t === "n" || cell.ct?.t === "d") &&
          entered.trim() !== "" &&
          Number.isFinite(Number(entered));
        let v: SheetScalar = numeric ? Number(entered) : entered;
        if (cell.ct?.t === "b" && typeof v === "string") v = v.toUpperCase() === "TRUE";
        const s = styleOf(cell, borders.get(key));
        seen.add(key);
        if (v === null && !f && !s) return;
        cells.push({ r, c, v, ...(f ? { f } : {}), ...(s ? { s } : {}) });
      };
      if (sheet.data) {
        sheet.data.forEach((row, r) => row?.forEach((cell, c) => cell && push(r, c, cell)));
      } else {
        for (const entry of sheet.celldata ?? []) push(entry.r, entry.c, entry.v);
      }
      // Borders on cells that hold nothing else.
      for (const [key, border] of borders) {
        if (seen.has(key)) continue;
        const [r, c] = key.split(":").map(Number) as [number, number];
        cells.push({ r, c, v: null, s: { border } });
      }
      const sizes = (raw: unknown) => {
        const result: Record<string, number> = {};
        for (const [index, size] of Object.entries((raw ?? {}) as Record<string, unknown>))
          if (typeof size === "number" && size >= 8 && size <= 2_000)
            result[index] = Math.round(size);
        return result;
      };
      const widths = sizes(config.columnlen);
      const heights = sizes(config.rowlen);
      const merges = Object.values(
        (config.merge ?? {}) as Record<string, { r: number; c: number; rs?: number; cs?: number }>,
      )
        .filter((m) => (m.rs ?? 1) > 1 || (m.cs ?? 1) > 1)
        .map((m) => ({ r0: m.r, c0: m.c, r1: m.r + (m.rs ?? 1) - 1, c1: m.c + (m.cs ?? 1) - 1 }));
      let name = (sheet.name || `工作表${position + 1}`).slice(0, 100);
      while (used.has(name.toLowerCase())) name = `${name.slice(0, 96)}_${position}`;
      used.add(name.toLowerCase());
      const frozen = (
        sheet as {
          frozen?: { type?: string; range?: { row_focus?: number; column_focus?: number } };
        }
      ).frozen;
      const frozenRows =
        frozen?.type === "rangeRow" || frozen?.type === "rangeBoth"
          ? (frozen.range?.row_focus ?? -1) + 1
          : frozen?.type === "row" || frozen?.type === "both"
            ? 1
            : 0;
      const frozenColumns =
        frozen?.type === "rangeColumn" || frozen?.type === "rangeBoth"
          ? (frozen.range?.column_focus ?? -1) + 1
          : frozen?.type === "column" || frozen?.type === "both"
            ? 1
            : 0;
      const id = String(sheet.id ?? `sheet${position + 1}`).slice(0, 64);
      const showGridLines = (sheet as { showGridLines?: number | boolean }).showGridLines;
      const rows = (sheet as { row?: number }).row;
      const columns = (sheet as { column?: number }).column;
      return {
        id,
        name,
        cells,
        ...(Object.keys(widths).length ? { columnWidths: widths } : {}),
        ...(Object.keys(heights).length ? { rowHeights: heights } : {}),
        ...(frozenRows > 0 && frozenRows < 1_000 ? { frozenRows } : {}),
        ...(frozenColumns > 0 && frozenColumns < 200 ? { frozenColumns } : {}),
        ...(showGridLines === 0 || showGridLines === false ? { gridlinesHidden: true } : {}),
        ...(typeof rows === "number" && rows !== 1000 && rows > 0 ? { rowCount: rows } : {}),
        ...(typeof columns === "number" && columns !== 26 && columns > 0
          ? { columnCount: columns }
          : {}),
        ...(merges.length ? { merges } : {}),
        ...(layers.get(id) ?? {}),
      };
    });
  return parseSheetWorkbook({
    version: 1,
    sheets: out,
    ...(deletedSheets?.length ? { deletedSheets } : {}),
  });
}
