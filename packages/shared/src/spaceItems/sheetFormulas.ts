// FILE: sheetFormulas.ts
// Purpose: Computes the cached result of every formula cell in a stored workbook.
// Layer: Shared model (the editor seeds the engine with it; the server answers agent reads)
// Why: The spreadsheet engine trusts a cell's stored value and only evaluates a formula when
//      someone types it. Formulas from templates, imports and agent writes arrive without a
//      result, so they are evaluated here with the engine's own formula parser before the
//      engine is seeded, and on the server after every agent edit, so reads give results.

/// <reference path="./formulaParser.d.ts" />
// The parser ships no types; its declaration travels with this file to every package that compiles it.
import { Parser } from "@fortune-sheet/formula-parser";

import type { Sheet, SheetCell, SheetScalar, SheetSpill, SheetWorkbook } from "./sheetWorkbook";
import { formulaReferences } from "./sheetFormulaRefs";
import {
  installMossSheetFunctions,
  setSheetFormulaTimeZone,
  withWholeArrays,
} from "./sheetFormulaFunctions";

export { setSheetFormulaTimeZone } from "./sheetFormulaFunctions";

// XLOOKUP, TEXTJOIN, MAXIFS… for this evaluator and, in the browser, the editor's engine.
installMossSheetFunctions();

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

class MissingSheet extends Error {}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
/** The parser's answer as a cell value: dates become serial days, a list its first value. */
function resultValue(result: unknown): SheetScalar {
  if (Array.isArray(result))
    return resultValue(Array.isArray(result[0]) ? result[0][0] : result[0]);
  if (result instanceof Date) return dateSerial(result);
  if (typeof result === "number") return Number.isFinite(result) ? result : "#NUM!";
  if (typeof result === "string") {
    // Division by zero comes back as a result, not an error.
    if (result in EXCEL_ERRORS) return EXCEL_ERRORS[result]!;
    if (ISO_DATE.test(result)) return dateSerial(new Date(result));
    return result;
  }
  if (typeof result === "boolean") return result;
  return result === null || result === undefined ? 0 : String(result);
}
/** The parser builds dates at local midnight; a cell keeps the calendar day. */
function dateSerial(date: Date): number {
  return (
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000 +
    25_569 +
    (date.getHours() * 3_600 + date.getMinutes() * 60 + date.getSeconds()) / 86_400
  );
}

/**
 * Works out every formula. A formula whose answer is a block (FILTER, SORT, UNIQUE, SEQUENCE, an
 * operator on a range) spills it into the cells right and below, or shows #SPILL! when a
 * person's value is in the way; formulas that read spilled cells are worked out again after.
 */
export function computeWorkbookFormulas(workbook: SheetWorkbook): SheetWorkbook {
  // TODAY and NOW follow the Sheet's time zone.
  setSheetFormulaTimeZone(workbook.timeZone);
  return withWholeArrays(() => {
    const blocks = new Map<string, SheetScalar[][]>();
    const first = evaluateOnce(workbook, blocks);
    if (!blocks.size && !workbook.sheets.some((sheet) => sheet.spills?.length)) return first;
    const spilled = placeSpills(first, blocks);
    const again = new Map<string, SheetScalar[][]>();
    return placeSpills(evaluateOnce(spilled, again), again);
  });
}

/** A block answer's values as cells hold them. */
function blockValue(value: unknown): SheetScalar {
  return value instanceof Error ? excelError(value.message) : resultValue(value);
}

/** Writes each block into the cells beside and below its formula, where nothing is in the way. */
function placeSpills(
  workbook: SheetWorkbook,
  blocks: ReadonlyMap<string, SheetScalar[][]>,
): SheetWorkbook {
  return {
    ...workbook,
    sheets: workbook.sheets.map((sheet) => {
      const key = (r: number, c: number) => `${r}:${c}`;
      const byKey = new Map(sheet.cells.map((cell) => [key(cell.r, cell.c), cell]));
      // Cells that still hold what a spill wrote are the spill's: they are written again.
      const owned = new Set<string>();
      for (const spill of sheet.spills ?? [])
        for (const [r, c, v] of spill.cells) {
          const cell = byKey.get(key(r, c));
          if (cell && !cell.f && cell.v === v) owned.add(key(r, c));
        }
      const kept = new Map<string, SheetCell>();
      for (const cell of sheet.cells) {
        const k = key(cell.r, cell.c);
        if (!owned.has(k)) kept.set(k, cell);
        else if (cell.s) kept.set(k, { r: cell.r, c: cell.c, v: null, s: cell.s });
      }
      const spills: SheetSpill[] = [];
      const blocked = new Set<string>();
      for (const [at, grid] of blocks) {
        const [sheetId, spot] = at.split("|");
        if (sheetId !== sheet.id || !spot) continue;
        const [r0, c0] = spot.split(":").map(Number) as [number, number];
        const targets: [number, number, SheetScalar][] = [];
        let inTheWay = false;
        grid.forEach((row, i) =>
          row.forEach((v, j) => {
            if (i === 0 && j === 0) return;
            const there = kept.get(key(r0 + i, c0 + j));
            if (there && (there.f || (there.v !== null && there.v !== ""))) inTheWay = true;
            targets.push([r0 + i, c0 + j, v]);
          }),
        );
        if (inTheWay) {
          blocked.add(spot);
          continue;
        }
        for (const [r, c, v] of targets) {
          const there = kept.get(key(r, c));
          kept.set(key(r, c), { ...(there ?? {}), r, c, v });
        }
        spills.push({ r: r0, c: c0, cells: targets });
      }
      const cells = [...kept.values()]
        .map((cell) => (blocked.has(key(cell.r, cell.c)) ? { ...cell, v: "#SPILL!" } : cell))
        .filter((cell) => cell.f || cell.s || (cell.v !== null && cell.v !== ""))
        .sort((a, b) => a.r - b.r || a.c - b.c);
      const next = { ...sheet, cells } as { -readonly [K in keyof Sheet]: Sheet[K] };
      if (spills.length) next.spills = spills;
      else delete next.spills;
      return next;
    }),
  };
}

function evaluateOnce(
  workbook: SheetWorkbook,
  blocks: Map<string, SheetScalar[][]>,
): SheetWorkbook {
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
      // A reference to a sheet that is not there (deleted, or not made yet) is #REF!.
      const missing = formulaReferences(cell.f!).some(
        (ref) => ref.sheet !== null && !sheets.has(ref.sheet.toLowerCase()),
      );
      if (missing) throw new MissingSheet();
      const { result, error } = parser.parse(withAliases(cell.f!.slice(1))) as {
        result: unknown;
        error: string | null;
      };
      value = error ? excelError(error) : resultValue(result);
      if (!error && Array.isArray(result)) {
        const grid = (Array.isArray(result[0]) ? result : [result]) as unknown[][];
        if (grid.length > 1 || (grid[0]?.length ?? 0) > 1)
          blocks.set(
            `${sheet.id}|${cell.r}:${cell.c}`,
            grid.map((row) => row.map(blockValue)),
          );
      }
    } catch (cause) {
      value = cause instanceof MissingSheet ? "#REF!" : "#ERROR!";
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
