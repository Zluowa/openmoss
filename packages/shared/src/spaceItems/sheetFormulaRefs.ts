// FILE: sheetFormulaRefs.ts
// Purpose: Rewrites the cell references inside 电子表格 formulas when rows or columns are
//          inserted, deleted or moved, when a sheet is renamed or deleted, and when a formula
//          is copied or sorted to another place.
// Layer: Shared model (agent edits on the server; the editor's own edits go through the engine)
// Exports: mapFormulaReferences, offsetFormula, renameSheetInFormula, breakSheetInFormula,
//          formulaReferences.
// Why: A formula names cells by address; after an edit moves those cells it must name them where
//      they went, or show #REF! where they are gone, the way spreadsheets do.

import { columnIndex, columnName } from "./sheetWorkbook";

interface Endpoint {
  col: number | null;
  row: number | null;
  absCol: boolean;
  absRow: boolean;
}
export interface FormulaReference {
  /** The sheet as written (unquoted), or null for the formula's own sheet. */
  readonly sheet: string | null;
  readonly start: Endpoint;
  readonly end: Endpoint | null;
}

const SHEET_PART = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_À-￿][\w.À-￿]*))!`;
const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;
const COL = String.raw`\$?[A-Za-z]{1,3}`;
const ROW = String.raw`\$?\d{1,7}`;
const REF = new RegExp(
  String.raw`(?<![\w.$!'À-￿])(?:${SHEET_PART})?(${CELL}(?::${CELL})?|${CELL}:${COL}(?![\w$])|${COL}:${COL}|${ROW}:${ROW})(?![\w(!À-￿])`,
  "gu",
);

function parseEndpoint(text: string): Endpoint {
  const match = /^(\$?)([A-Za-z]{1,3})?(\$?)(\d{1,7})?$/u.exec(text)!;
  return {
    col: match[2] ? columnIndex(match[2]) : null,
    row: match[4] ? Number(match[4]) - 1 : null,
    absCol: match[1] === "$" && match[2] !== undefined,
    absRow:
      match[4] !== undefined
        ? match[3] === "$" || (match[2] === undefined && match[1] === "$")
        : false,
  };
}
function printEndpoint(point: Endpoint): string {
  return `${point.col === null ? "" : `${point.absCol ? "$" : ""}${columnName(point.col)}`}${
    point.row === null ? "" : `${point.absRow ? "$" : ""}${point.row + 1}`
  }`;
}
function quoteSheet(name: string): string {
  return /^[A-Za-z_À-￿][\w.À-￿]*$/u.test(name) && !/^[A-Za-z]{1,3}\d+$/u.test(name)
    ? name
    : `'${name.replaceAll("'", "''")}'`;
}

/** Splits a formula into code and string-literal parts so references are only found in code. */
function rewriteCode(formula: string, rewrite: (code: string) => string): string {
  let out = "";
  let i = 0;
  while (i < formula.length) {
    const quote = formula.indexOf('"', i);
    if (quote === -1) {
      out += rewrite(formula.slice(i));
      break;
    }
    out += rewrite(formula.slice(i, quote));
    let j = quote + 1;
    while (j < formula.length) {
      if (formula[j] === '"' && formula[j + 1] === '"') j += 2;
      else if (formula[j] === '"') break;
      else j += 1;
    }
    out += formula.slice(quote, j + 1);
    i = j + 1;
  }
  return out;
}

type Rewrite = (ref: FormulaReference) => FormulaReference | "#REF!";
function eachReference(formula: string, rewrite: Rewrite): string {
  return rewriteCode(formula, (code) =>
    code.replace(
      REF,
      (whole, quoted: string | undefined, bare: string | undefined, body: string) => {
        const [a, b] = body.split(":");
        const sheet = quoted !== undefined ? quoted.replaceAll("''", "'") : (bare ?? null);
        const ref: FormulaReference = {
          sheet,
          start: parseEndpoint(a!),
          end: b === undefined ? null : parseEndpoint(b),
        };
        const next = rewrite(ref);
        if (next === "#REF!") return "#REF!";
        if (next === ref) return whole;
        const prefix = next.sheet === null ? "" : `${quoteSheet(next.sheet)}!`;
        return `${prefix}${printEndpoint(next.start)}${next.end ? `:${printEndpoint(next.end)}` : ""}`;
      },
    ),
  );
}

/** Every reference in a formula (used by charts and tests). */
export function formulaReferences(formula: string): FormulaReference[] {
  const out: FormulaReference[] = [];
  eachReference(formula, (ref) => {
    out.push(ref);
    return ref;
  });
  return out;
}

/**
 * How one axis of one sheet changed: an insert of `count` lines before index `at`, a delete
 * of `[start, end]`, or a move (a permutation from old index to new index for `[start, end]`).
 */
export type AxisChange =
  | { readonly kind: "insert"; readonly at: number; readonly count: number }
  | { readonly kind: "delete"; readonly start: number; readonly end: number }
  | { readonly kind: "move"; readonly map: (index: number) => number };

export function mapAxisSpan(
  a: number,
  b: number,
  change: AxisChange,
): { a: number; b: number } | null {
  switch (change.kind) {
    case "insert":
      return {
        a: a >= change.at ? a + change.count : a,
        b: b >= change.at ? b + change.count : b,
      };
    case "delete": {
      const n = change.end - change.start + 1;
      if (b < change.start) return { a, b };
      if (a > change.end) return { a: a - n, b: b - n };
      const na = a < change.start ? a : change.start;
      const nb = b > change.end ? b - n : change.start - 1;
      return nb < na ? null : { a: na, b: nb };
    }
    case "move": {
      const ma = change.map(a);
      const mb = change.map(b);
      return { a: Math.min(ma, mb), b: Math.max(ma, mb) };
    }
  }
}

/**
 * Rewrites the references that point at `targetSheet` (the formula lives on `ownSheet`) after
 * rows or columns of `targetSheet` changed. References to deleted cells become #REF!.
 */
export function mapFormulaReferences(
  formula: string,
  ownSheet: string,
  targetSheet: string,
  axis: "row" | "column",
  change: AxisChange,
): string {
  const own = ownSheet.toLowerCase();
  const target = targetSheet.toLowerCase();
  return eachReference(formula, (ref) => {
    const sheet = (ref.sheet ?? ownSheet).toLowerCase();
    if (sheet !== target && !(ref.sheet === null && own === target)) return ref;
    const key = axis === "row" ? "row" : "col";
    const a = ref.start[key];
    const b = ref.end ? ref.end[key] : a;
    if (a === null || b === null) return ref; // whole columns (or rows) are untouched by this axis
    const span = mapAxisSpan(a, b, change);
    if (!span) return "#REF!";
    if (span.a === a && span.b === b) return ref;
    return {
      sheet: ref.sheet,
      start: { ...ref.start, [key]: span.a },
      end: ref.end ? { ...ref.end, [key]: span.b } : null,
    };
  });
}

/** A formula copied `dr` rows down and `dc` columns right: relative references follow. */
export function offsetFormula(formula: string, dr: number, dc: number): string {
  if (dr === 0 && dc === 0) return formula;
  let broken = false;
  const out = eachReference(formula, (ref) => {
    const move = (point: Endpoint): Endpoint => {
      const row = point.row === null || point.absRow ? point.row : point.row + dr;
      const col = point.col === null || point.absCol ? point.col : point.col + dc;
      if ((row !== null && row < 0) || (col !== null && col < 0)) broken = true;
      return { ...point, row, col };
    };
    const next = { sheet: ref.sheet, start: move(ref.start), end: ref.end ? move(ref.end) : null };
    return broken ? "#REF!" : next;
  });
  return out;
}

export function renameSheetInFormula(formula: string, oldName: string, newName: string): string {
  const old = oldName.toLowerCase();
  return eachReference(formula, (ref) =>
    ref.sheet !== null && ref.sheet.toLowerCase() === old ? { ...ref, sheet: newName } : ref,
  );
}

export function breakSheetInFormula(formula: string, name: string): string {
  const lower = name.toLowerCase();
  return eachReference(formula, (ref) =>
    ref.sheet !== null && ref.sheet.toLowerCase() === lower ? "#REF!" : ref,
  );
}
