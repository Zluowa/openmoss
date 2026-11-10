// FILE: sheetFormulas.ts
// Purpose: Computes the cached result of every formula cell in a stored workbook.
// Layer: 资料空间 电子表格 (types stream)
// Why: The spreadsheet engine trusts a cell's stored value and only evaluates a formula when
//      someone types it. Formulas from templates, imports and agent writes arrive without a
//      result, so they are evaluated here with the engine's own formula parser before the
//      engine is seeded, and the results are saved back for agents and exports.

import { Parser } from "@fortune-sheet/formula-parser";

import type {
  Sheet,
  SheetCell,
  SheetScalar,
  SheetWorkbook,
} from "@moss/shared/spaceItems/sheetWorkbook";

type Label = { index: number };
type CellRef = { row: Label; column: Label; sheetName?: string | null };
const CIRCULAR = "#REF!";
/** The parser names errors without Excel's punctuation (`DIV/0`); cells show Excel's form. */
const EXCEL_ERRORS: Record<string, string> = {
  "DIV/0": "#DIV/0!",
  NAME: "#NAME?",
  "N/A": "#N/A",
  REF: "#REF!",
  VALUE: "#VALUE!",
  NUM: "#NUM!",
  NULL: "#NULL!",
  ERROR: "#ERROR!",
};
const excelError = (error: string) =>
  error.startsWith("#") ? error : (EXCEL_ERRORS[error] ?? `#${error}`);

export function computeWorkbookFormulas(workbook: SheetWorkbook): SheetWorkbook {
  const sheets = new Map(workbook.sheets.map((sheet) => [sheet.name.toLowerCase(), sheet]));
  const cells = new Map<Sheet, Map<string, SheetCell>>(
    workbook.sheets.map((sheet) => [
      sheet,
      new Map(sheet.cells.map((cell) => [`${cell.r}:${cell.c}`, cell])),
    ]),
  );
  const results = new Map<SheetCell, SheetScalar>();
  const evaluating = new Set<SheetCell>();
  const parser = new Parser();
  let current: Sheet = workbook.sheets[0]!;

  // The parser reads only ASCII sheet names, so `预算!B2` is parsed as `S0!B2`.
  const aliases = new Map(workbook.sheets.map((sheet, index) => [`s${index}`, sheet]));
  const byLength = [...workbook.sheets.entries()].sort(
    (a, b) => b[1].name.length - a[1].name.length,
  );
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const withAliases = (formula: string) =>
    byLength.reduce(
      (text, [index, sheet]) =>
        text.replace(
          new RegExp(`'${escape(sheet.name)}'!|(?<![A-Za-z0-9_])${escape(sheet.name)}!`, "giu"),
          `S${index}!`,
        ),
      formula,
    );
  const sheetFor = (name: string | null | undefined) => {
    if (!name) return current;
    const key = name.replace(/^'|'$/gu, "").toLowerCase();
    return aliases.get(key) ?? sheets.get(key) ?? current;
  };
  const valueAt = (sheet: Sheet, r: number, c: number): SheetScalar => {
    const cell = cells.get(sheet)?.get(`${r}:${c}`);
    if (!cell) return null;
    return cell.f ? evaluate(sheet, cell) : cell.v;
  };
  // The parser treats empty cells as null; numbers stay numbers.
  const forParser = (value: SheetScalar) => (value === null ? null : value);

  parser.on("callCellValue", (ref: CellRef, _options: unknown, done: (value: unknown) => void) => {
    done(forParser(valueAt(sheetFor(ref.sheetName), ref.row.index, ref.column.index)));
  });
  parser.on(
    "callRangeValue",
    (start: CellRef, end: CellRef, _options: unknown, done: (value: unknown[][]) => void) => {
      const sheet = sheetFor(start.sheetName);
      const rows: unknown[][] = [];
      for (let r = start.row.index; r <= end.row.index; r++) {
        const row: unknown[] = [];
        for (let c = start.column.index; c <= end.column.index; c++)
          row.push(forParser(valueAt(sheet, r, c)));
        rows.push(row);
      }
      done(rows);
    },
  );

  function evaluate(sheet: Sheet, cell: SheetCell): SheetScalar {
    if (results.has(cell)) return results.get(cell)!;
    if (evaluating.has(cell)) return CIRCULAR;
    evaluating.add(cell);
    const outer = current;
    current = sheet;
    let value: SheetScalar;
    try {
      const { result, error } = parser.parse(withAliases(cell.f!.slice(1))) as {
        result: unknown;
        error: string | null;
      };
      value = error
        ? excelError(error)
        : typeof result === "number"
          ? Number.isFinite(result)
            ? result
            : "#NUM!"
          : typeof result === "string" && result in EXCEL_ERRORS
            ? EXCEL_ERRORS[result]! // Division by zero comes back as a result, not an error.
            : typeof result === "boolean" || typeof result === "string"
              ? result
              : result === null || result === undefined
                ? 0
                : String(result);
    } catch {
      value = "#ERROR!";
    } finally {
      current = outer;
      evaluating.delete(cell);
    }
    results.set(cell, value);
    return value;
  }

  return {
    ...workbook,
    sheets: workbook.sheets.map((sheet) => ({
      ...sheet,
      cells: sheet.cells.map((cell) => (cell.f ? { ...cell, v: evaluate(sheet, cell) } : cell)),
    })),
  };
}
