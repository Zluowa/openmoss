// FILE: sheetWorkbook.ts
// Purpose: The 电子表格 (kind `sheet`) document: sheets of sparse cells with values, formulas
//          and light styling; A1 addressing; range read/write; and its text projection.
// Layer: Shared model (server validates and serves agent range tools; web maps it to the
//        spreadsheet engine and to xlsx/csv)
// Why: The stored shape is engine-neutral so the engine can be replaced without migrating rows,
//      and so agents can read and write ranges on the server without a browser.

export const SHEET_DATA_LIMITS = {
  bytes: 2_000_000,
  sheets: 50,
  cells: 100_000,
  rows: 100_000,
  columns: 16_384,
} as const;

export type SheetScalar = string | number | boolean | null;
export interface SheetCellStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** #RRGGBB text color. */
  readonly color?: string;
  /** #RRGGBB fill. */
  readonly fill?: string;
  readonly align?: "left" | "center" | "right";
  /** Number format code (`0.00`, `0%`, `yyyy-mm-dd`…). */
  readonly format?: string;
}
export interface SheetCell {
  readonly r: number;
  readonly c: number;
  /** Last computed or entered value. For a formula this is the cached result. */
  readonly v: SheetScalar;
  /** Formula including the leading `=`. */
  readonly f?: string;
  readonly s?: SheetCellStyle;
}
export interface Sheet {
  readonly id: string;
  readonly name: string;
  readonly cells: readonly SheetCell[];
  readonly columnWidths?: Readonly<Record<string, number>>;
  readonly frozenRows?: number;
}
export interface SheetWorkbook {
  readonly version: 1;
  readonly sheets: readonly Sheet[];
}

const HEX = /^#[0-9A-Fa-f]{6}$/u;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

function fail(message: string): never {
  throw new Error(`Invalid workbook: ${message}`);
}
function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${where} must be an object`);
  for (const key of Object.keys(value))
    if (forbiddenKeys.has(key)) fail(`${where} has a forbidden key`);
  return value as Record<string, unknown>;
}
function index(value: unknown, where: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= max) {
    fail(`${where} must be an integer from 0 to ${max - 1}`);
  }
  return value as number;
}
export function sheetScalar(value: unknown, where = "value"): SheetScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length > 32_767) fail(`${where} is longer than 32767 characters`);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fail(`${where} must be a string, finite number, boolean or null`);
}
function style(raw: unknown, where: string): SheetCellStyle | undefined {
  if (raw === undefined) return undefined;
  const value = record(raw, where);
  const out: { -readonly [K in keyof SheetCellStyle]: SheetCellStyle[K] } = {};
  if (value.bold === true) out.bold = true;
  if (value.italic === true) out.italic = true;
  for (const key of ["color", "fill"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || !HEX.test(value[key]))
      fail(`${where}.${key} must be #RRGGBB`);
    out[key] = value[key].toUpperCase();
  }
  if (value.align !== undefined) {
    if (value.align !== "left" && value.align !== "center" && value.align !== "right") {
      fail(`${where}.align must be left, center or right`);
    }
    out.align = value.align;
  }
  if (value.format !== undefined) {
    if (typeof value.format !== "string" || value.format.length > 64)
      fail(`${where}.format is invalid`);
    out.format = value.format;
  }
  return Object.keys(out).length ? out : undefined;
}
function formula(raw: unknown, where: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !raw.startsWith("=") || raw.length > 8_192) {
    fail(`${where} must be a formula starting with =`);
  }
  return raw;
}

export function parseSheetWorkbook(input: string | unknown): SheetWorkbook {
  if (typeof input === "string" && input.length > SHEET_DATA_LIMITS.bytes)
    fail("workbook is too large");
  let raw: unknown;
  try {
    raw = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    return fail("workbook is not JSON");
  }
  const value = record(raw, "workbook");
  if (value.version !== 1) fail("version must be 1");
  if (!Array.isArray(value.sheets) || value.sheets.length === 0)
    fail("sheets must be a non-empty array");
  if (value.sheets.length > SHEET_DATA_LIMITS.sheets)
    fail(`at most ${SHEET_DATA_LIMITS.sheets} sheets`);
  let total = 0;
  const sheets = value.sheets.map((rawSheet, sheetIndex): Sheet => {
    const where = `sheets[${sheetIndex}]`;
    const sheet = record(rawSheet, where);
    if (typeof sheet.id !== "string" || !sheet.id || sheet.id.length > 64)
      fail(`${where}.id is invalid`);
    if (typeof sheet.name !== "string" || !sheet.name.trim() || sheet.name.length > 31) {
      fail(`${where}.name must be 1-31 characters`);
    }
    if (!Array.isArray(sheet.cells)) fail(`${where}.cells must be an array`);
    total += sheet.cells.length;
    if (total > SHEET_DATA_LIMITS.cells) fail(`at most ${SHEET_DATA_LIMITS.cells} cells`);
    const seen = new Set<string>();
    const cells: SheetCell[] = [];
    for (const [cellIndex, rawCell] of sheet.cells.entries()) {
      const at = `${where}.cells[${cellIndex}]`;
      const cell = record(rawCell, at);
      const r = index(cell.r, `${at}.r`, SHEET_DATA_LIMITS.rows);
      const c = index(cell.c, `${at}.c`, SHEET_DATA_LIMITS.columns);
      const key = `${r}:${c}`;
      if (seen.has(key)) fail(`${at} repeats ${cellAddress(r, c)}`);
      seen.add(key);
      const f = formula(cell.f, `${at}.f`);
      const s = style(cell.s, `${at}.s`);
      const v = sheetScalar(cell.v, `${at}.v`);
      if (v === null && !f && !s) continue;
      cells.push({ r, c, v, ...(f ? { f } : {}), ...(s ? { s } : {}) });
    }
    cells.sort((a, b) => a.r - b.r || a.c - b.c);
    const widths: Record<string, number> = {};
    if (sheet.columnWidths !== undefined) {
      for (const [column, width] of Object.entries(
        record(sheet.columnWidths, `${where}.columnWidths`),
      )) {
        index(Number(column), `${where}.columnWidths key`, SHEET_DATA_LIMITS.columns);
        if (typeof width !== "number" || width < 8 || width > 2_000)
          fail(`${where}.columnWidths value`);
        widths[column] = Math.round(width);
      }
    }
    const frozenRows =
      sheet.frozenRows === undefined
        ? undefined
        : index(sheet.frozenRows, `${where}.frozenRows`, 100);
    return {
      id: sheet.id,
      name: sheet.name.trim(),
      cells,
      ...(Object.keys(widths).length ? { columnWidths: widths } : {}),
      ...(frozenRows ? { frozenRows } : {}),
    };
  });
  if (new Set(sheets.map((sheet) => sheet.name.toLowerCase())).size !== sheets.length) {
    fail("sheet names must be unique");
  }
  const workbook: SheetWorkbook = { version: 1, sheets };
  if (JSON.stringify(workbook).length > SHEET_DATA_LIMITS.bytes) fail("workbook is too large");
  return workbook;
}

export function createSheetWorkbook(name = "工作表1"): SheetWorkbook {
  return { version: 1, sheets: [{ id: "sheet1", name, cells: [] }] };
}

export function columnName(c: number): string {
  let name = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}
export function cellAddress(r: number, c: number): string {
  return `${columnName(c)}${r + 1}`;
}

export interface SheetRange {
  readonly r0: number;
  readonly c0: number;
  readonly r1: number;
  readonly c1: number;
}
const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,6})$/u;
function parseCell(text: string): { r: number; c: number } {
  const match = CELL.exec(text.trim());
  if (!match) fail(`${text} is not an A1 cell address`);
  let c = 0;
  for (const char of match[1]!.toUpperCase()) c = c * 26 + (char.charCodeAt(0) - 64);
  const r = Number(match[2]) - 1;
  if (r < 0 || r >= SHEET_DATA_LIMITS.rows || c - 1 >= SHEET_DATA_LIMITS.columns)
    fail(`${text} is out of range`);
  return { r, c: c - 1 };
}
/** `B2`, `A1:C10`. The range is normalized so r0<=r1 and c0<=c1. */
export function parseSheetRange(text: string): SheetRange {
  const parts = text.split(":");
  if (parts.length > 2 || !parts[0]) fail(`${text} is not an A1 range`);
  const a = parseCell(parts[0]);
  const b = parseCell(parts[1] ?? parts[0]);
  return {
    r0: Math.min(a.r, b.r),
    c0: Math.min(a.c, b.c),
    r1: Math.max(a.r, b.r),
    c1: Math.max(a.c, b.c),
  };
}
export function formatSheetRange(range: SheetRange): string {
  const start = cellAddress(range.r0, range.c0);
  const end = cellAddress(range.r1, range.c1);
  return start === end ? start : `${start}:${end}`;
}

export function findSheet(workbook: SheetWorkbook, name?: string): Sheet {
  if (name === undefined) return workbook.sheets[0]!;
  const sheet = workbook.sheets.find(
    (item) => item.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (!sheet) fail(`no sheet named ${name}`);
  return sheet;
}

/** The used area of a sheet, or null when it is empty. */
export function usedRange(sheet: Sheet): SheetRange | null {
  if (sheet.cells.length === 0) return null;
  let r1 = 0;
  let c1 = 0;
  for (const cell of sheet.cells) {
    r1 = Math.max(r1, cell.r);
    c1 = Math.max(c1, cell.c);
  }
  return { r0: 0, c0: 0, r1, c1 };
}

export interface SheetRangeRead {
  readonly sheet: string;
  readonly range: string;
  readonly values: SheetScalar[][];
  /** Same shape as `values`; null where a cell has no formula. */
  readonly formulas: (string | null)[][];
}
const MAX_READ_CELLS = 10_000;
export function readSheetRange(
  workbook: SheetWorkbook,
  sheetName: string | undefined,
  text?: string,
): SheetRangeRead {
  const sheet = findSheet(workbook, sheetName);
  const range = text ? parseSheetRange(text) : (usedRange(sheet) ?? { r0: 0, c0: 0, r1: 0, c1: 0 });
  const rows = range.r1 - range.r0 + 1;
  const columns = range.c1 - range.c0 + 1;
  if (rows * columns > MAX_READ_CELLS) fail(`read at most ${MAX_READ_CELLS} cells at once`);
  const byKey = new Map(sheet.cells.map((cell) => [`${cell.r}:${cell.c}`, cell]));
  const values: SheetScalar[][] = [];
  const formulas: (string | null)[][] = [];
  for (let r = range.r0; r <= range.r1; r++) {
    const valueRow: SheetScalar[] = [];
    const formulaRow: (string | null)[] = [];
    for (let c = range.c0; c <= range.c1; c++) {
      const cell = byKey.get(`${r}:${c}`);
      valueRow.push(cell?.v ?? null);
      formulaRow.push(cell?.f ?? null);
    }
    values.push(valueRow);
    formulas.push(formulaRow);
  }
  return { sheet: sheet.name, range: formatSheetRange(range), values, formulas };
}

/**
 * Writes a 2-D block starting at the range's top-left cell. A string beginning with `=` is a
 * formula; its cached value is cleared and the editor recomputes it on open. `null` clears.
 * Styles of written cells are kept.
 */
export function writeSheetRange(
  workbook: SheetWorkbook,
  sheetName: string | undefined,
  start: string,
  rows: readonly (readonly unknown[])[],
): { workbook: SheetWorkbook; range: string } {
  const sheet = findSheet(workbook, sheetName);
  const origin = parseSheetRange(start);
  if (rows.length === 0) fail("values must contain at least one row");
  const width = Math.max(...rows.map((row) => row.length));
  if (width === 0) fail("values must contain at least one column");
  const range = {
    r0: origin.r0,
    c0: origin.c0,
    r1: origin.r0 + rows.length - 1,
    c1: origin.c0 + width - 1,
  };
  if (range.r1 >= SHEET_DATA_LIMITS.rows || range.c1 >= SHEET_DATA_LIMITS.columns)
    fail("write is out of range");
  const byKey = new Map(sheet.cells.map((cell) => [`${cell.r}:${cell.c}`, cell]));
  rows.forEach((row, dr) =>
    row.forEach((raw, dc) => {
      const r = range.r0 + dr;
      const c = range.c0 + dc;
      const key = `${r}:${c}`;
      const previous = byKey.get(key);
      const text = typeof raw === "string" ? raw : null;
      const isFormula = text !== null && text.startsWith("=") && text.length > 1;
      const v = isFormula ? null : sheetScalar(raw, `values[${dr}][${dc}]`);
      if (!isFormula && v === null && !previous?.s) {
        byKey.delete(key);
        return;
      }
      byKey.set(key, {
        r,
        c,
        v,
        ...(isFormula ? { f: formula(text, `values[${dr}][${dc}]`)! } : {}),
        ...(previous?.s ? { s: previous.s } : {}),
      });
    }),
  );
  const next: Sheet = { ...sheet, cells: [...byKey.values()] };
  return {
    workbook: parseSheetWorkbook({
      ...workbook,
      sheets: workbook.sheets.map((item) => (item.id === sheet.id ? next : item)),
    }),
    range: formatSheetRange(range),
  };
}

function csvField(value: SheetScalar): string {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export function sheetToCsv(sheet: Sheet): string {
  const used = usedRange(sheet);
  if (!used) return "";
  const byKey = new Map(sheet.cells.map((cell) => [`${cell.r}:${cell.c}`, cell]));
  const lines: string[] = [];
  for (let r = 0; r <= used.r1; r++) {
    const fields: string[] = [];
    for (let c = 0; c <= used.c1; c++) fields.push(csvField(byKey.get(`${r}:${c}`)?.v ?? null));
    lines.push(fields.join(","));
  }
  return lines.join("\r\n");
}

/** RFC 4180 parsing; numbers stay text unless the whole field is numeric. */
export function csvToSheet(text: string, name = "工作表1", id = "sheet1"): Sheet {
  const cells: SheetCell[] = [];
  let r = 0;
  let c = 0;
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  const push = () => {
    if (field !== "" || wasQuoted) {
      const numeric = !wasQuoted && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u.test(field.trim());
      cells.push({ r, c, v: numeric ? Number(field) : field });
    }
    field = "";
    wasQuoted = false;
    c++;
  };
  const source = text.replace(/^\uFEFF/u, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") {
      quoted = true;
      wasQuoted = true;
    } else if (char === ",") push();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      push();
      r++;
      c = 0;
    } else field += char;
  }
  if (field !== "" || wasQuoted || c > 0) push();
  return { id, name, cells };
}

/** Readable projection: each sheet as a Markdown table of its first rows. */
export function projectSheetWorkbook(
  workbook: SheetWorkbook,
  maxRows = 50,
  maxColumns = 20,
): string {
  return workbook.sheets
    .map((sheet) => {
      const used = usedRange(sheet);
      if (!used) return `## ${sheet.name}\n\n（空）`;
      const byKey = new Map(sheet.cells.map((cell) => [`${cell.r}:${cell.c}`, cell]));
      const columns = Math.min(used.c1 + 1, maxColumns);
      const rows = Math.min(used.r1 + 1, maxRows);
      const cell = (r: number, c: number) =>
        String(byKey.get(`${r}:${c}`)?.v ?? "")
          .replaceAll("|", "\\|")
          .replaceAll("\n", " ");
      const header = Array.from({ length: columns }, (_, c) => columnName(c));
      const lines = [`| |${header.join("|")}|`, `|-|${header.map(() => "-").join("|")}|`];
      for (let r = 0; r < rows; r++) {
        lines.push(`|${r + 1}|${Array.from({ length: columns }, (_, c) => cell(r, c)).join("|")}|`);
      }
      const more = used.r1 + 1 > rows ? `\n\n（另有 ${used.r1 + 1 - rows} 行）` : "";
      return `## ${sheet.name}\n\n${lines.join("\n")}${more}`;
    })
    .join("\n\n");
}
