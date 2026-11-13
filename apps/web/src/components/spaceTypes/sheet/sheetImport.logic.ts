// FILE: sheetImport.logic.ts
// Purpose: The CSV / TSV import dialog's model: the file read into rows, a first plan (separator,
//          headings, where it goes, each column's type), the rows a plan makes, and the workbook it
//          leaves: a new sheet, rows added under the current sheet's rows (matched by heading), or
//          the current sheet's rows replaced.
// Layer: 资料空间 电子表格 (pure logic)
// Exports: ImportPlan, ImportColumnType, readImportRows, firstImportPlan, importedRows,
//          applyImportPlan, importSummary, IMPORT_COLUMN_TYPES.
// Why: Claude's Sheets shows a file before it lands (settings, columns, a preview); Moss does the
//      same for text files, with the choices a person needs to get a table in right.

import { parseTypedCellInput, SHEET_NUMBER_FORMATS } from "@moss/shared/spaceItems/sheetValues";
import {
  columnName,
  csvToSheet,
  detectCsvSeparator,
  filledRange,
  parseSheetWorkbook,
  SHEET_DATA_LIMITS,
  type Sheet,
  type SheetCell,
  type SheetScalar,
  type SheetWorkbook,
} from "@moss/shared/spaceItems/sheetWorkbook";

export type ImportSeparator = "," | ";" | "\t";
export type ImportMode = "newSheet" | "append" | "update" | "replace";
export type ImportColumnType = "auto" | "text" | "number" | "currency" | "percent" | "date";

export const IMPORT_COLUMN_TYPES: readonly {
  readonly value: ImportColumnType;
  readonly label: string;
}[] = [
  { value: "auto", label: "自动" },
  { value: "text", label: "纯文本" },
  { value: "number", label: "数字" },
  { value: "currency", label: "货币" },
  { value: "percent", label: "百分比" },
  { value: "date", label: "日期" },
];

export interface ImportColumn {
  readonly index: number;
  readonly name: string;
  readonly type: ImportColumnType;
  readonly included: boolean;
}

export interface ImportPlan {
  readonly separator: ImportSeparator;
  readonly headings: boolean;
  readonly mode: ImportMode;
  readonly sheetName: string;
  readonly columns: readonly ImportColumn[];
  /** For "update": the file column whose values find the sheet's rows. */
  readonly matchBy?: number;
}

/** The file as rows of the text in each field. */
export function readImportRows(text: string, separator: ImportSeparator): string[][] {
  const sheet = csvToSheet(text, "import", "import", separator);
  const byRow = new Map<number, string[]>();
  let last = -1;
  for (const cell of sheet.cells) {
    const row = byRow.get(cell.r) ?? [];
    row[cell.c] = cell.v === null ? "" : String(cell.v);
    byRow.set(cell.r, row);
    last = Math.max(last, cell.r);
  }
  // Every line up to the last one with something in it; blank lines inside stay blank rows.
  const rows = Array.from({ length: last + 1 }, (_, r) => {
    const row = byRow.get(r) ?? [];
    return Array.from({ length: row.length }, (_, i) => row[i] ?? "");
  });
  while (rows.length && !rows.at(-1)!.some((field) => field.trim())) rows.pop();
  return rows;
}

const looksNumeric = (field: string) => typeof parseTypedCellInput(field.trim()).v === "number";

/** Headings, when the first row is all text and some later row holds a number. */
function guessHeadings(rows: readonly string[][]): boolean {
  const [first, ...rest] = rows;
  if (!first?.length || !rest.length) return false;
  const allText = first.every((field) => field.trim() !== "" && !looksNumeric(field));
  return allText && rest.slice(0, 20).some((row) => row.some(looksNumeric));
}

export function firstImportPlan(
  text: string,
  fileName: string,
): {
  readonly plan: ImportPlan;
  readonly rows: string[][];
} {
  const separator = detectCsvSeparator(text);
  const rows = readImportRows(text, separator);
  if (!rows.length) throw new Error("这个文件是空的。");
  const headings = guessHeadings(rows);
  const width = Math.max(...rows.map((row) => row.length));
  return {
    rows,
    plan: {
      separator,
      headings,
      mode: "newSheet",
      sheetName:
        fileName
          .replace(/\.(csv|tsv|txt)$/iu, "")
          .slice(0, 100)
          .trim() || "导入的表格",
      columns: Array.from({ length: width }, (_, index) => ({
        index,
        name: (headings ? rows[0]![index]?.trim() : "") || `第 ${columnName(index)} 列`,
        type: "auto",
        included: true,
      })),
    },
  };
}

const TYPE_FORMAT: Partial<Record<ImportColumnType, string>> = {
  currency: SHEET_NUMBER_FORMATS.currency,
  percent: SHEET_NUMBER_FORMATS.percentRounded,
};

/** One field as the column's type reads it; a field that does not fit stays text. */
export function importValue(field: string, type: ImportColumnType): Pick<SheetCell, "v" | "s"> {
  const text = field.trim();
  if (text === "") return { v: null };
  if (type === "text") return { v: field };
  const kept = TYPE_FORMAT[type];
  const typed = parseTypedCellInput(text, kept);
  // A file brings values, never formulas.
  if (typed.f) return { v: field };
  if (type === "auto")
    return { v: typed.v, ...(typed.format ? { s: { format: typed.format } } : {}) };
  if (type === "date") {
    const isDate = typeof typed.v === "number" && typed.format && /[ymd]/iu.test(typed.format);
    return isDate ? { v: typed.v, s: { format: typed.format! } } : { v: field };
  }
  if (typeof typed.v !== "number") return { v: field };
  const format = typed.format ?? kept;
  return { v: typed.v, ...(format ? { s: { format } } : {}) };
}

/** The rows the plan brings in: headings first (when the file has them), then the data. */
export function importedRows(
  plan: ImportPlan,
  rows: readonly string[][],
): {
  readonly headings: readonly string[] | null;
  readonly data: readonly Pick<SheetCell, "v" | "s">[][];
} {
  const columns = plan.columns.filter((column) => column.included);
  const body = plan.headings ? rows.slice(1) : rows;
  return {
    headings: plan.headings ? columns.map((column) => column.name) : null,
    data: body.map((row) =>
      columns.map((column) => importValue(row[column.index] ?? "", column.type)),
    ),
  };
}

function cellsFrom(
  rows: readonly Pick<SheetCell, "v" | "s">[][],
  top: number,
  columnAt: (i: number) => number,
): SheetCell[] {
  const out: SheetCell[] = [];
  rows.forEach((row, r) =>
    row.forEach((value, i) => {
      if (value.v === null || value.v === "") return;
      out.push({
        r: top + r,
        c: columnAt(i),
        v: value.v as SheetScalar,
        ...(value.s ? { s: value.s } : {}),
      });
    }),
  );
  return out;
}

/** The current sheet's headings (its first row's text), lower-cased, by column. */
function headingsOf(sheet: Sheet): Map<string, number> {
  const out = new Map<string, number>();
  for (const cell of sheet.cells)
    if (cell.r === 0 && typeof cell.v === "string" && cell.v.trim())
      out.set(cell.v.trim().toLowerCase(), cell.c);
  return out;
}

export interface ImportOutcome {
  readonly workbook: SheetWorkbook;
  /** The sheet that took the rows. */
  readonly sheetId: string;
  readonly rowCount: number;
  /** File columns left out because the current sheet has no such heading. */
  readonly unmatched: readonly string[];
  /** For "update": rows changed in place and rows added under the sheet's rows. */
  readonly updated?: number;
  readonly added?: number;
}

export function applyImportPlan(
  plan: ImportPlan,
  rows: readonly string[][],
  current: SheetWorkbook,
  activeSheetId: string,
): ImportOutcome {
  const { headings, data } = importedRows(plan, rows);
  const total = current.sheets.reduce((n, sheet) => n + sheet.cells.length, 0);
  const adding = (headings ? 1 : 0) + data.length;
  if (
    total + adding * Math.max(1, plan.columns.filter((c) => c.included).length) >
    SHEET_DATA_LIMITS.cells
  )
    throw new Error("这个表格放不下这么多数据。少导入几列，或导入一个小一点的文件。");
  const heading = (cells: SheetCell[]) =>
    cells.map((cell) =>
      cell.r === 0 && headings ? { ...cell, s: { ...cell.s, bold: true } } : cell,
    );

  if (plan.mode === "newSheet") {
    const ids = new Set([...current.sheets, ...(current.deletedSheets ?? [])].map((s) => s.id));
    let id = `sheet${Date.now().toString(36)}`;
    while (ids.has(id)) id += "x";
    const names = new Set(current.sheets.map((s) => s.name.toLowerCase()));
    let name = plan.sheetName.trim().slice(0, 100) || "导入的表格";
    for (let n = 2; names.has(name.toLowerCase()); n++)
      name = `${plan.sheetName.slice(0, 94)} (${n})`;
    const all = headings
      ? [headings.map((h) => ({ v: h }) as Pick<SheetCell, "v">), ...data]
      : data;
    const sheet: Sheet = {
      id,
      name,
      ...(headings ? { frozenRows: 1 } : {}),
      cells: heading(cellsFrom(all, 0, (i) => i)),
    };
    const onlyBlank =
      current.sheets.length === 1 &&
      filledRange(current.sheets[0]!) === null &&
      !current.sheets[0]!.charts?.length;
    const sheets = onlyBlank
      ? [{ ...sheet, id: current.sheets[0]!.id }]
      : [...current.sheets, sheet];
    return {
      workbook: parseSheetWorkbook({ ...current, sheets }),
      sheetId: sheets.at(-1)!.id,
      rowCount: data.length,
      unmatched: [],
    };
  }

  const target = current.sheets.find((s) => s.id === activeSheetId) ?? current.sheets[0]!;
  const targetHeadings = headingsOf(target);
  const included = plan.columns.filter((column) => column.included);
  // Columns go under the heading of the same name; with no heading in common, by position.
  const matches = headings
    ? included.map((column) => targetHeadings.get(column.name.trim().toLowerCase()))
    : [];
  const byName = matches.some((m) => m !== undefined);
  const unmatched = byName
    ? included.filter((_, i) => matches[i] === undefined).map((c) => c.name)
    : [];
  const columnAt = (i: number) => (byName ? (matches[i] ?? -1) : i);
  const keepTitles = plan.mode === "replace" && targetHeadings.size > 0;

  if (plan.mode === "update") {
    const keyIndex = included.findIndex((column) => column.index === plan.matchBy);
    const keyColumn = included[keyIndex];
    const keyAt = keyIndex >= 0 ? matches[keyIndex] : undefined;
    if (!headings || !keyColumn || keyAt === undefined)
      throw new Error(
        keyColumn
          ? `“${keyColumn.name}”在“${target.name}”里没有同名的列，没法按它对上行。`
          : "先选一列来对上行。",
      );
    const keyOf = (value: unknown) =>
      value === null || value === undefined ? "" : String(value).trim().toLowerCase();
    const rowsByKey = new Map<string, number>();
    for (const cell of target.cells) {
      if (cell.r === 0 || cell.c !== keyAt) continue;
      const key = keyOf(cell.v);
      if (!key) continue;
      if (rowsByKey.has(key))
        throw new Error(
          `“${keyColumn.name}”里有重复的值（${String(cell.v)}），没法按它对上行。换一列对上，或选别的导入方式。`,
        );
      rowsByKey.set(key, cell.r);
    }
    const filled = filledRange(target);
    let next = filled ? filled.r1 + 1 : 1;
    const written = new Set<string>();
    const incoming: SheetCell[] = [];
    let updated = 0;
    let added = 0;
    for (const row of data) {
      const existing = rowsByKey.get(keyOf(row[keyIndex]?.v));
      const r = existing ?? next++;
      if (existing === undefined) added++;
      else updated++;
      row.forEach((value, i) => {
        const c = columnAt(i);
        if (c < 0) return;
        written.add(`${r}:${c}`);
        if (value.v === null || value.v === "") return;
        incoming.push({ r, c, v: value.v as SheetScalar, ...(value.s ? { s: value.s } : {}) });
      });
    }
    const sheet: Sheet = {
      ...target,
      cells: [...target.cells.filter((cell) => !written.has(`${cell.r}:${cell.c}`)), ...incoming],
    };
    return {
      workbook: parseSheetWorkbook({
        ...current,
        sheets: current.sheets.map((s) => (s.id === target.id ? sheet : s)),
      }),
      sheetId: target.id,
      rowCount: data.length,
      unmatched,
      updated,
      added,
    };
  }

  let kept: SheetCell[];
  let top: number;
  if (plan.mode === "replace") {
    kept = keepTitles ? target.cells.filter((cell) => cell.r === 0) : [];
    top = keepTitles ? 1 : 0;
  } else {
    kept = [...target.cells];
    const filled = filledRange(target);
    top = filled ? filled.r1 + 1 : 0;
  }
  const incoming =
    plan.mode === "replace" && !keepTitles && headings
      ? heading(cellsFrom([headings.map((h) => ({ v: h })), ...data], 0, (i) => i))
      : cellsFrom(data, top, columnAt).filter((cell) => cell.c >= 0);
  const sheet: Sheet = { ...target, cells: [...kept, ...incoming] };
  return {
    workbook: parseSheetWorkbook({
      ...current,
      sheets: current.sheets.map((s) => (s.id === target.id ? sheet : s)),
    }),
    sheetId: target.id,
    rowCount: data.length,
    unmatched,
  };
}

/** "12 行，用逗号分隔". */
export function importSummary(rows: readonly string[][], separator: ImportSeparator): string {
  const by = separator === "," ? "逗号" : separator === ";" ? "分号" : "制表符";
  return `${rows.length} 行，用${by}分隔`;
}
