// FILE: sheetFormulaFunctions.ts
// Purpose: Spreadsheet functions people and agents reach for that the engine's formula parser
//          lacks or gets wrong: XLOOKUP, TEXTJOIN, MAXIFS, MINIFS, HYPERLINK, TEXT (with
//          Moss's number formats) and the IFERROR family (which must see every kind of error). Installed once on the parser class, so the editor's engine and
//          the server's evaluator both know them.
// Layer: Shared model (formulas)
// Exports: MOSS_SHEET_FUNCTIONS, installMossSheetFunctions, matchesCriterion.
// Why: The parser looks a function up by name before its built-in list; a name it finds here
//      wins. Results that are errors are Error objects, the way the built-in functions return
//      them, so IFERROR and IFNA see them.

/// <reference path="./formulaParser.d.ts" />
import { Parser } from "@fortune-sheet/formula-parser";

import { dateToSerial, formatSheetNumber, timeToSerial } from "./sheetValues";

type Fn = (params: unknown[]) => unknown;

const NA = () => new Error("#N/A");
const VALUE = () => new Error("#VALUE!");

function flatten(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  return [value];
}
const firstError = (values: readonly unknown[]) => values.find((v) => v instanceof Error);
const ERROR_TEXT = /^#(?:N\/A|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|NULL!|ERROR!)$/u;
/** An error result, or a cell showing one (cells keep errors as their text). */
function isErrorValue(value: unknown): boolean {
  if (value instanceof Error) return true;
  // Division by zero inside a formula comes back as the parser's bare "DIV/0".
  if (typeof value === "string") return ERROR_TEXT.test(value) || value === "DIV/0";
  return typeof value === "number" && !Number.isFinite(value);
}
function isNotAvailable(value: unknown): boolean {
  return (value instanceof Error && value.message === "#N/A") || value === "#N/A";
}
const isBlank = (value: unknown) => value === null || value === undefined || value === "";
const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
    return Number(value);
  return null;
};
const sameValue = (a: unknown, b: unknown) => {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  const x = toNumber(a);
  const y = toNumber(b);
  if (x !== null && y !== null && typeof a !== "string" && typeof b !== "string") return x === y;
  return a === b || (isBlank(a) && isBlank(b));
};
const wildcard = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
      .replace(/~\*/gu, "\u0001")
      .replace(/~\?/gu, "\u0002")
      .replace(/\*/gu, ".*")
      .replace(/\?/gu, ".")
      .replace(/\u0001/gu, "\\*")
      .replace(/\u0002/gu, "\\?")}$`,
    "iu",
  );

/** A COUNTIF-style criterion: 5, ">5", "<>done", "=a", "a*". */
export function matchesCriterion(value: unknown, criterion: unknown): boolean {
  if (typeof criterion === "number" || typeof criterion === "boolean")
    return sameValue(value, criterion);
  const text = String(criterion ?? "");
  const match = /^(<=|>=|<>|=|<|>)(.*)$/su.exec(text);
  const op = match ? match[1]! : "=";
  const operand = match ? match[2]! : text;
  const n = toNumber(operand);
  const v = toNumber(value);
  if (op !== "=" && op !== "<>" && n !== null) {
    if (v === null || typeof value === "string") return false;
    if (op === "<") return v < n;
    if (op === "<=") return v <= n;
    if (op === ">") return v > n;
    return v >= n;
  }
  const equal =
    n !== null && v !== null && typeof value !== "string"
      ? v === n
      : operand === ""
        ? isBlank(value)
        : /[*?]/u.test(operand)
          ? wildcard(operand).test(String(value ?? ""))
          : String(value ?? "").toLowerCase() === operand.toLowerCase();
  if (op === "<>") return !equal;
  if (op === "=" || !match) return equal;
  // Text compared with < or >.
  const a = String(value ?? "").toLowerCase();
  const b = operand.toLowerCase();
  if (op === "<") return a < b;
  if (op === "<=") return a <= b;
  if (op === ">") return a > b;
  return a >= b;
}

function conditional(pick: (values: number[]) => number): Fn {
  return (params) => {
    const [range, ...pairs] = params;
    if (pairs.length === 0 || pairs.length % 2 === 1) return VALUE();
    const values = flatten(range);
    const error = firstError(values);
    if (error) return error;
    const tests: { cells: unknown[]; criterion: unknown }[] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const cells = flatten(pairs[i]);
      if (cells.length !== values.length) return VALUE();
      tests.push({ cells, criterion: pairs[i + 1] });
    }
    const kept = values.flatMap((value, i) =>
      typeof value === "number" && tests.every((t) => matchesCriterion(t.cells[i], t.criterion))
        ? [value]
        : [],
    );
    return kept.length ? pick(kept) : 0;
  };
}

function xlookup(params: unknown[]): unknown {
  const [lookup, lookupArray, returnArray, ifNotFound, matchMode = 0, searchMode = 1] = params;
  if (lookup instanceof Error) return lookup;
  const keys = flatten(lookupArray);
  const rows = Array.isArray(returnArray) ? (returnArray as unknown[][]) : [[returnArray]];
  const vertical = rows.length === keys.length;
  const result = (i: number): unknown => {
    if (vertical) return Array.isArray(rows[i]) ? rows[i]![0] : rows[i];
    const row = Array.isArray(rows[0]) ? rows[0] : rows;
    return row[i];
  };
  if (!vertical && (Array.isArray(rows[0]) ? rows[0] : rows).length !== keys.length) return VALUE();
  const order = Array.from({ length: keys.length }, (_, i) => i);
  if (Number(searchMode) < 0) order.reverse();
  const mode = Number(matchMode);
  for (const i of order) {
    const key = keys[i];
    if (mode === 2 ? matchesCriterion(key, `=${String(lookup)}`) : sameValue(key, lookup))
      return result(i);
  }
  if (mode === -1 || mode === 1) {
    const target = toNumber(lookup);
    if (target !== null) {
      let best = -1;
      for (const i of order) {
        const n = toNumber(keys[i]);
        if (n === null) continue;
        const fits = mode === -1 ? n <= target : n >= target;
        const better =
          best < 0 || (mode === -1 ? n > toNumber(keys[best])! : n < toNumber(keys[best])!);
        if (fits && better) best = i;
      }
      if (best >= 0) return result(best);
    }
  }
  return ifNotFound === undefined ? NA() : ifNotFound;
}

// ── Blocks of values ───────────────────────────────────────────────────────────────────────

/**
 * Whether a formula's answer may be a whole block. The shared evaluator works blocks out and
 * spills them into the cells beside and below; the editor's engine shows one value per cell,
 * so there a block answers with its first value and Moss writes the rest.
 */
let wholeArrays = false;
export function withWholeArrays<T>(run: () => T): T {
  const before = wholeArrays;
  wholeArrays = true;
  try {
    return run();
  } finally {
    wholeArrays = before;
  }
}

type Grid = unknown[][];
function toGrid(value: unknown): Grid {
  if (!Array.isArray(value)) return [[value]];
  if (value.length && !Array.isArray(value[0])) return [value as unknown[]];
  return value as Grid;
}
/** A block as the formula's answer: all of it, or (in the engine) its first value. */
function answer(grid: Grid): unknown {
  if (!grid.length || !grid[0]?.length) return new Error("#ERROR!");
  return wholeArrays ? grid : grid[0]![0];
}
const truthy = (value: unknown) =>
  value === true || (typeof value === "number" && value !== 0) || value === "TRUE";
function compareValues(a: unknown, b: unknown): number {
  const rank = (v: unknown) =>
    v === null || v === undefined || v === ""
      ? 3
      : typeof v === "number"
        ? 0
        : typeof v === "boolean"
          ? 2
          : 1;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (a as number) - (b as number);
  if (ra === 1) return String(a).localeCompare(String(b), "zh-CN");
  if (ra === 2) return Number(a) - Number(b);
  return 0;
}
const rowKey = (row: readonly unknown[]) =>
  JSON.stringify(row.map((v) => (typeof v === "string" ? v.toLowerCase() : (v ?? null))));
const transpose = (grid: Grid): Grid =>
  grid[0] ? grid[0].map((_, j) => grid.map((row) => row[j])) : [];

function filter(params: unknown[]): unknown {
  const [array, include, ifEmpty] = params;
  if (array instanceof Error) return array;
  if (include instanceof Error) return include;
  const grid = toGrid(array);
  const keep = toGrid(include);
  let out: Grid;
  if (keep.length === grid.length && keep.every((row) => row.length === 1))
    out = grid.filter((_, i) => truthy(keep[i]![0]));
  else if (keep.length === 1 && keep[0]!.length === (grid[0]?.length ?? 0))
    out = transpose(transpose(grid).filter((_, j) => truthy(keep[0]![j])));
  else return new Error("#VALUE!");
  if (!out.length || !out[0]?.length) return ifEmpty === undefined ? new Error("#ERROR!") : ifEmpty;
  return answer(out);
}
function sort(params: unknown[]): unknown {
  const [array, by = 1, order = 1, byColumn = false] = params;
  if (array instanceof Error) return array;
  const across = truthy(byColumn);
  const grid = across ? transpose(toGrid(array)) : toGrid(array);
  const index = Number(by) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= (grid[0]?.length ?? 0))
    return new Error("#VALUE!");
  const sign = Number(order) < 0 ? -1 : 1;
  const sorted = [...grid].sort((a, b) => sign * compareValues(a[index], b[index]));
  return answer(across ? transpose(sorted) : sorted);
}
function unique(params: unknown[]): unknown {
  const [array, byColumn = false, exactlyOnce = false] = params;
  if (array instanceof Error) return array;
  const across = truthy(byColumn);
  const grid = across ? transpose(toGrid(array)) : toGrid(array);
  const counts = new Map<string, number>();
  for (const row of grid) counts.set(rowKey(row), (counts.get(rowKey(row)) ?? 0) + 1);
  const seen = new Set<string>();
  const out = grid.filter((row) => {
    const key = rowKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return !truthy(exactlyOnce) || counts.get(key) === 1;
  });
  return answer(across ? transpose(out) : out);
}
function sequence(params: unknown[]): unknown {
  const [rows, columns = 1, start = 1, step = 1] = params.map((p) =>
    p === undefined ? undefined : Number(p),
  );
  if (![rows, columns, start, step].every((n) => n === undefined || Number.isFinite(n)))
    return new Error("#VALUE!");
  const r = Math.trunc(rows ?? 1);
  const c = Math.trunc(columns ?? 1);
  if (r < 1 || c < 1 || r * c > 10_000) return new Error("#VALUE!");
  return answer(
    Array.from({ length: r }, (_, i) =>
      Array.from({ length: c }, (_, j) => (start ?? 1) + (i * c + j) * (step ?? 1)),
    ),
  );
}

// ── Formula text the parser's grammar lacks ──────────────────────────────────────────────────

/** How far down an open range (B:B, B2:B) reaches. */
export const WHOLE_COLUMN_ROWS = 10_000;
const ARRAY_FUNCTION = "MOSSARRAY";

/** Calls `visit` for each stretch of the text outside "string literals". */
function outsideStrings(text: string, visit: (part: string) => string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const quote = text.indexOf('"', i);
    const end = quote < 0 ? text.length : quote;
    out += visit(text.slice(i, end));
    if (quote < 0) break;
    let j = quote + 1;
    while (j < text.length) {
      if (text[j] === '"' && text[j + 1] === '"') j += 2;
      else if (text[j] === '"') break;
      else j++;
    }
    out += text.slice(quote, j + 1);
    i = j + 1;
  }
  return out;
}

/** The top-level pieces of an argument list, split at commas outside brackets and strings. */
function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '"' && text[i + 1] === '"') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "(" || ch === "{") depth++;
    else if (ch === ")" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Where the bracket opened at `open` closes, or -1. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '"' && text[i + 1] === '"') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** {1,2;3,4} as MOSSARRAY(2,2,1,2,3,4): the grammar has no braces. */
function arrayConstants(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '"' && text[i + 1] === '"') out += text[++i];
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch !== "{") {
      out += ch;
      continue;
    }
    const close = text.indexOf("}", i);
    if (close < 0) return text;
    const rows = text
      .slice(i + 1, close)
      .split(";")
      .map((row) => splitArguments(row).map((v) => v.trim()));
    const width = rows[0]?.length ?? 0;
    if (!width || rows.some((row) => row.length !== width)) return text;
    out += `${ARRAY_FUNCTION}(${rows.length},${width},${rows.flat().join(",")})`;
    i = close;
  }
  return out;
}

/** LET(x, 2, y, x*3, x+y): each name stands for its value, the way the grammar can read it. */
function expandLet(text: string): string {
  for (let round = 0; round < 20; round++) {
    let found = -1;
    const pattern = /(^|[^A-Za-z0-9_.$!])LET\s*\(/giu;
    let match: RegExpExecArray | null;
    // The first LET outside a string literal.
    while ((match = pattern.exec(text))) {
      const before = text.slice(0, match.index + match[1]!.length);
      if ((before.match(/"/gu) ?? []).length % 2 === 0) {
        found = match.index + match[1]!.length;
        break;
      }
    }
    if (found < 0) return text;
    const open = text.indexOf("(", found);
    const close = closingBracket(text, open);
    if (close < 0) return text;
    const args = splitArguments(text.slice(open + 1, close)).map((a) => a.trim());
    if (args.length < 3 || args.length % 2 === 0) return text;
    const names: { name: string; value: string }[] = [];
    const substitute = (body: string) =>
      names.reduce(
        (acc, { name, value }) =>
          outsideStrings(acc, (part) =>
            part.replace(
              new RegExp(`(^|[^A-Za-z0-9_.$!])(${name})(?![A-Za-z0-9_.(!])`, "giu"),
              (_, lead: string) => `${lead}(${value})`,
            ),
          ),
        body,
      );
    for (let k = 0; k < args.length - 1; k += 2) {
      const name = args[k]!;
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(name) || /^[A-Za-z]{1,3}\d+$/u.test(name)) return text;
      names.push({ name, value: substitute(args[k + 1]!) });
    }
    text = `${text.slice(0, found)}(${substitute(args.at(-1)!)})${text.slice(close + 1)}`;
  }
  return text;
}

/** B:B and B2:B as B1:B10000 and B2:B10000: the grammar needs both corners. */
function openRanges(text: string): string {
  return outsideStrings(text, (part) =>
    part.replace(
      /(^|[^A-Za-z0-9_.$])(\$?[A-Za-z]{1,3})(\$?\d+)?:(\$?[A-Za-z]{1,3})(?![A-Za-z0-9_($])/gu,
      (_, lead: string, from: string, row: string | undefined, to: string) =>
        `${lead}${from}${row ?? "1"}:${to}${WHOLE_COLUMN_ROWS}`,
    ),
  );
}

/**
 * TRUE and FALSE as TRUE() and FALSE(): the grammar reads a bare TRUE as a cell address (a
 * column with no row) and answers #NAME?. A sheet name (TRUE!A1) or a longer name stays.
 */
function logicalWords(text: string): string {
  return outsideStrings(text, (part) =>
    part.replace(
      /(^|[^A-Za-z0-9_.$!'])(TRUE|FALSE)(?![A-Za-z0-9_.(!$])/giu,
      (_, lead: string, word: string) => `${lead}${word.toUpperCase()}()`,
    ),
  );
}

/** A formula as the parser's grammar can read it. */
export function rewriteFormula(expression: string): string {
  const logical = /\b(?:TRUE|FALSE)\b/iu.test(expression) ? logicalWords(expression) : expression;
  if (!/[{:]|LET\s*\(/iu.test(logical)) return logical;
  return openRanges(expandLet(arrayConstants(logical)));
}

// ── Money over time ─────────────────────────────────────────────────────────────────────────

const numbers = (value: unknown) =>
  flatten(value).filter((v): v is number => typeof v === "number");
function irr(params: unknown[]): unknown {
  const [values, guess = 0.1] = params;
  const flows = numbers(values);
  if (!flows.some((v) => v > 0) || !flows.some((v) => v < 0)) return new Error("#NUM!");
  let rate = Number(guess);
  for (let step = 0; step < 100; step++) {
    let npv = 0;
    let slope = 0;
    flows.forEach((v, t) => {
      npv += v / (1 + rate) ** t;
      slope -= (t * v) / (1 + rate) ** (t + 1);
    });
    const next = rate - npv / slope;
    if (!Number.isFinite(next)) return new Error("#NUM!");
    if (Math.abs(next - rate) < 1e-10) return next;
    rate = next;
  }
  return new Error("#NUM!");
}
function xnpvOf(rate: number, flows: number[], days: number[]): number {
  return flows.reduce((sum, v, i) => sum + v / (1 + rate) ** ((days[i]! - days[0]!) / 365), 0);
}
function xnpv(params: unknown[]): unknown {
  const [rate, values, dates] = params;
  const flows = numbers(values);
  const days = numbers(dates);
  if (!flows.length || flows.length !== days.length) return new Error("#NUM!");
  return xnpvOf(Number(rate), flows, days);
}
function xirr(params: unknown[]): unknown {
  const [values, dates, guess = 0.1] = params;
  const flows = numbers(values);
  const days = numbers(dates);
  if (!flows.length || flows.length !== days.length) return new Error("#NUM!");
  let rate = Number(guess);
  for (let step = 0; step < 100; step++) {
    const f = xnpvOf(rate, flows, days);
    const h = 1e-6;
    const slope = (xnpvOf(rate + h, flows, days) - f) / h;
    const next = rate - f / slope;
    if (!Number.isFinite(next)) return new Error("#NUM!");
    if (Math.abs(next - rate) < 1e-10) return next;
    rate = next;
  }
  return new Error("#NUM!");
}

// ── Operators on blocks ─────────────────────────────────────────────────────────────────────

const ARITHMETIC = new Set(["+", "-", "*", "/", "^"]);
type Operate = (operator: string, params?: unknown[]) => unknown;
/**
 * B2:B9>100, (A2:A9="x")*C2:C9: an operator with a block works cell by cell, a single value
 * standing for every cell. In sums TRUE is 1, FALSE 0 and an empty cell 0.
 */
function elementwise(original: Operate): Operate {
  return (operator, params = []) => {
    if (!params.some(Array.isArray)) return original(operator, params);
    const grids = params.map((p) => (Array.isArray(p) ? toGrid(p) : null));
    const rows = Math.max(...grids.map((g) => g?.length ?? 1));
    const cols = Math.max(...grids.map((g) => g?.[0]?.length ?? 1));
    const arithmetic = ARITHMETIC.has(String(operator));
    const at = (k: number, i: number, j: number) => {
      const g = grids[k];
      const v = g ? g[g.length === 1 ? 0 : i]?.[g[0]!.length === 1 ? 0 : j] : params[k];
      if (!arithmetic) return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      return v === null || v === undefined || v === "" ? 0 : v;
    };
    return Array.from({ length: rows }, (_, i) =>
      Array.from({ length: cols }, (_, j) => {
        try {
          return original(
            operator,
            params.map((_, k) => at(k, i, j)),
          );
        } catch (cause) {
          return cause instanceof Error ? cause : new Error("#VALUE!");
        }
      }),
    );
  };
}

/** The time zone TODAY and NOW use: the open Sheet's, or the device's when it sets none. */
let sheetTimeZone: string | undefined;
export function setSheetFormulaTimeZone(timeZone: string | undefined): void {
  sheetTimeZone = timeZone;
}

/** Now as a spreadsheet serial (days since 1899-12-30) in the Sheet's time zone. */
export function nowSerial(now: Date = new Date(), timeZone = sheetTimeZone): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}),
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return (
    dateToSerial(Number(parts.year), Number(parts.month), Number(parts.day)) +
    timeToSerial(Number(parts.hour), Number(parts.minute), Number(parts.second))
  );
}

export const MOSS_SHEET_FUNCTIONS: Readonly<Record<string, Fn>> = {
  // Day numbers, the way spreadsheets keep dates, in the Sheet's time zone.
  // A {…} constant: always the whole block (it is an argument, not an answer).
  MOSSARRAY: (params) => {
    const [rows, cols, ...values] = params;
    const r = Number(rows);
    const c = Number(cols);
    return Array.from({ length: r }, (_, i) => values.slice(i * c, i * c + c));
  },
  IRR: irr,
  XNPV: xnpv,
  XIRR: xirr,
  FILTER: filter,
  SORT: sort,
  UNIQUE: unique,
  SEQUENCE: sequence,
  TODAY: () => Math.floor(nowSerial()),
  NOW: () => nowSerial(),
  // The built-in IFERROR family knows only its own error objects; these know every error,
  // including one shown in a cell the formula reads.
  IFERROR: ([value, fallback]) => (isErrorValue(value) ? fallback : value),
  IFNA: ([value, fallback]) => (isNotAvailable(value) ? fallback : value),
  ISERROR: ([value]) => isErrorValue(value),
  ISNA: ([value]) => isNotAvailable(value),
  ISERR: ([value]) => isErrorValue(value) && !isNotAvailable(value),
  XLOOKUP: xlookup,
  TEXTJOIN: (params) => {
    const [delimiter, ignoreEmpty, ...texts] = params;
    const values = texts.flatMap(flatten);
    const error = firstError([delimiter, ...values]);
    if (error) return error;
    const kept = ignoreEmpty ? values.filter((v) => !isBlank(v)) : values;
    return kept
      .map((v) => (v === null || v === undefined ? "" : String(v)))
      .join(String(delimiter ?? ""));
  },
  MAXIFS: conditional((values) => Math.max(...values)),
  MINIFS: conditional((values) => Math.min(...values)),
  HYPERLINK: (params) => {
    const [url, label] = params;
    return label === undefined || isBlank(label) ? url : label;
  },
  TEXT: (params) => {
    const [value, format] = params;
    if (value instanceof Error) return value;
    if (format instanceof Error) return format;
    const n = toNumber(value);
    if (n === null) return value === null || value === undefined ? "" : String(value);
    return formatSheetNumber(String(format ?? "General"), n);
  },
};

let installed = false;

/** Makes every formula parser look in MOSS_SHEET_FUNCTIONS first. Safe to call again. */
export function installMossSheetFunctions(): void {
  if (installed) return;
  installed = true;
  const proto = Parser.prototype as unknown as {
    getFunction: (this: unknown, name: string) => unknown;
    __mossSheetFunctions?: boolean;
  };
  if (proto.__mossSheetFunctions) return;
  const original = proto.getFunction;
  proto.getFunction = function getFunction(this: unknown, name: string) {
    return MOSS_SHEET_FUNCTIONS[String(name).toUpperCase()] ?? original.call(this, name);
  };
  // Operators work cell by cell on blocks; outside the shared evaluator a block answer shows
  // its first value.
  const parse = (Parser.prototype as unknown as { parse: ParseFn }).parse;
  (Parser.prototype as unknown as { parse: ParseFn }).parse = function mossParse(
    this: ParserSelf,
    expression: string,
    options?: unknown,
  ) {
    const yy = this.parser?.yy;
    if (yy && !yy.__mossElementwise && typeof yy.evaluateByOperator === "function") {
      yy.evaluateByOperator = elementwise(yy.evaluateByOperator);
      yy.__mossElementwise = true;
    }
    const out = parse.call(this, rewriteFormula(expression), options);
    if (!wholeArrays && out && Array.isArray(out.result)) {
      const first = toGrid(out.result)[0]?.[0];
      return first instanceof Error
        ? { result: null, error: first.message }
        : { ...out, result: first ?? null };
    }
    return out;
  };
  proto.__mossSheetFunctions = true;
}

type ParseResult = { result: unknown; error: string | null };
type ParserSelf = {
  parser?: { yy?: { evaluateByOperator?: Operate; __mossElementwise?: boolean } };
};
type ParseFn = (this: ParserSelf, expression: string, options?: unknown) => ParseResult;
