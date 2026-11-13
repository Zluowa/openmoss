// FILE: sheetEdits.ts
// Purpose: The agent protocol of a 电子表格: reads that describe a workbook the way a person sees
//          it (typed values, formula results, formats, dropdowns, rules, charts) and one
//          `applyEdits` that makes a list of edits land together or not at all.
// Layer: Shared model (the server's moss_sheet_* tools; tests)
// Exports: readSheetWorkbook, applySheetEdits, SheetEditRefusal, sheetRulesFingerprint,
//          SHEET_EDIT_KINDS, standardSheetColor.
// Why: Agents build tables in steps (headers, rows, looks, sizes) against a revision; each step
//      must be exact (named kinds and keys), safe (refused whole, with the reason and the edit's
//      index) and predictable (formulas follow moved cells, typed text sets formats).

import {
  mapAxisSpan,
  mapFormulaReferences,
  offsetFormula,
  renameSheetInFormula,
  type AxisChange,
} from "./sheetFormulaRefs";
import { computeWorkbookFormulas } from "./sheetFormulas";
import { formatSheetNumber, isDateFormat, parseTypedCellInput, serialToIso } from "./sheetValues";
import {
  DEFAULT_COLUMN_WIDTH,
  SHEET_BORDER_STYLES,
  SHEET_CHART_CODE_LIMIT,
  SHEET_CHART_KINDS,
  SHEET_DATA_LIMITS,
  SHEET_HUES,
  SHEET_PALETTE,
  SHEET_SHADES,
  cellAddress,
  columnName,
  filledRange,
  formatSheetRange,
  parseSheetColumns,
  parseSheetRange,
  parseSheetRows,
  parseSheetWorkbook,
  isSheetLocale,
  isSheetTimeZone,
  SHEET_LOCALES,
  type SheetLocale,
  rangeContains,
  rangesOverlap,
  sheetSize,
  type Sheet,
  type SheetBorderLine,
  type SheetCell,
  type SheetCellBorder,
  type SheetCellStyle,
  type SheetChart,
  type SheetChartKind,
  type SheetDropdown,
  type SheetGroup,
  type SheetRange,
  type SheetRule,
  type SheetRuleCondition,
  type SheetRuleOperand,
  type SheetScalar,
  type SheetTable,
  type SheetWorkbook,
  type SheetHue,
  type SheetShade,
} from "./sheetWorkbook";

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────

export class SheetEditRefusal extends Error {
  constructor(
    readonly refusal: string,
    readonly detail: string,
    readonly editIndex: number | null = null,
    readonly address: string | null = null,
  ) {
    super(detail);
    this.name = "SheetEditRefusal";
  }
}
function refuse(refusal: string, detail: string, address?: string): never {
  throw new SheetEditRefusal(refusal, detail, null, address ?? null);
}

type Json = Record<string, unknown>;
function obj(value: unknown, where: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    refuse("notRead", `${where} must be an object.`);
  return value as Json;
}
function keys(
  value: Json,
  where: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  for (const key of required) if (!(key in value)) refuse("missingKey", `${where} needs "${key}".`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      refuse("keyNotKnown", `${where} has no key "${key}". It takes ${[...allowed].join(", ")}.`);
}
function str(value: unknown, where: string): string {
  if (typeof value !== "string") refuse("notRead", `${where} must be a string.`);
  return value;
}
function num(value: unknown, where: string, min: number, max: number, whole = true): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (whole && !Number.isInteger(value))
  )
    refuse(
      "notRead",
      `${where} must be ${whole ? "a whole number" : "a number"} from ${min} to ${max}.`,
    );
  return value;
}
function asRange(text: unknown, where: string): SheetRange {
  try {
    return parseSheetRange(str(text, where));
  } catch {
    return refuse(
      "notAnAddress",
      `${where} must be a range such as A1:C4 or one cell such as B2, without $ or a sheet name.`,
    );
  }
}
function asRows(text: unknown, where: string) {
  try {
    return parseSheetRows(String(text));
  } catch {
    return refuse("notAnAddress", `${where} must be rows such as 3 or 3:5.`);
  }
}
function asColumns(text: unknown, where: string) {
  try {
    return parseSheetColumns(str(text, where));
  } catch {
    return refuse("notAnAddress", `${where} must be columns such as B or B:D.`);
  }
}

// ── Colours ──────────────────────────────────────────────────────────────────────────────────

/** Reads a colour of the protocol: standard hue + shade, a picked rgb, or none (null). */
export function standardSheetColor(value: unknown, where = "color"): string | null {
  const color = obj(value, where);
  if (color.kind === "none") return null;
  if (color.kind === "rgb") {
    const hex = str(color.hex, `${where}.hex`);
    if (!/^#[0-9a-fA-F]{6}$/u.test(hex))
      refuse("notRead", `${where}.hex must be # and six hex digits.`);
    return hex.toUpperCase();
  }
  if (color.kind === "standard") {
    if (!SHEET_HUES.includes(color.hue as SheetHue))
      refuse("notRead", `${where}.hue must be one of ${SHEET_HUES.join(", ")}.`);
    if (!SHEET_SHADES.includes(color.shade as SheetShade))
      refuse("notRead", `${where}.shade must be one of ${SHEET_SHADES.join(", ")}.`);
    return SHEET_PALETTE[color.hue as SheetHue][color.shade as SheetShade];
  }
  return refuse("notRead", `${where}.kind must be standard, rgb or none.`);
}
function colorOut(hex: string | null | undefined): Json {
  if (!hex) return { kind: "none" };
  for (const hue of SHEET_HUES)
    for (const shade of SHEET_SHADES)
      if (SHEET_PALETTE[hue][shade] === hex) return { kind: "standard", hue, shade };
  return { kind: "rgb", hex: hex.toLowerCase() };
}

// ── The working copy ─────────────────────────────────────────────────────────────────────────

interface WorkCell {
  r: number;
  c: number;
  v: SheetScalar;
  f?: string;
  s?: SheetCellStyle;
}
interface WorkSheet {
  id: string;
  name: string;
  cells: Map<string, WorkCell>;
  meta: {
    -readonly [K in keyof Omit<Sheet, "id" | "name" | "cells">]: Omit<
      Sheet,
      "id" | "name" | "cells"
    >[K];
  } & Record<string, unknown>;
  rowCount: number;
  columnCount: number;
}
interface Work {
  sheets: WorkSheet[];
  deleted: Sheet[];
  written: number;
  locale: SheetLocale | undefined;
  timeZone: string | undefined;
}
const key = (r: number, c: number) => `${r}:${c}`;

function toWork(workbook: SheetWorkbook): Work {
  return {
    sheets: workbook.sheets.map(toWorkSheet),
    deleted: [...(workbook.deletedSheets ?? [])],
    written: 0,
    locale: workbook.locale,
    timeZone: workbook.timeZone,
  };
}
function toWorkSheet(sheet: Sheet): WorkSheet {
  const { id, name, cells, ...meta } = sheet;
  const size = sheetSize(sheet);
  return {
    id,
    name,
    cells: new Map(cells.map((cell) => [key(cell.r, cell.c), { ...cell }])),
    meta: structuredClone(meta) as WorkSheet["meta"],
    rowCount: size.rows,
    columnCount: size.columns,
  };
}
function fromWorkSheet(sheet: WorkSheet): Sheet {
  const cells: SheetCell[] = [];
  for (const cell of sheet.cells.values()) {
    if (cell.v === null && !cell.f && !cell.s) continue;
    cells.push({
      r: cell.r,
      c: cell.c,
      v: cell.v,
      ...(cell.f ? { f: cell.f } : {}),
      ...(cell.s ? { s: cell.s } : {}),
    });
  }
  const meta = { ...sheet.meta };
  delete meta.rowCount;
  delete meta.columnCount;
  return {
    id: sheet.id,
    name: sheet.name,
    cells,
    ...meta,
    ...(sheet.rowCount !== 1000 ? { rowCount: sheet.rowCount } : {}),
    ...(sheet.columnCount !== 26 ? { columnCount: sheet.columnCount } : {}),
  } as Sheet;
}
function fromWork(work: Work): SheetWorkbook {
  return {
    version: 1,
    sheets: work.sheets.map(fromWorkSheet),
    ...(work.deleted.length
      ? { deletedSheets: work.deleted.slice(-SHEET_DATA_LIMITS.deletedSheets) }
      : {}),
    ...(work.locale ? { locale: work.locale } : {}),
    ...(work.timeZone ? { timeZone: work.timeZone } : {}),
  };
}

function sheetOf(work: Work, name: unknown, where = "sheet"): WorkSheet {
  const wanted = str(name, where).trim().toLowerCase();
  const sheet = work.sheets.find((item) => item.name.toLowerCase() === wanted);
  if (!sheet)
    refuse(
      "sheetNotFound",
      `There is no sheet named "${String(name)}". The sheets are ${work.sheets.map((s) => `"${s.name}"`).join(", ")}.`,
    );
  return sheet;
}
function insideSheet(sheet: WorkSheet, range: SheetRange, where: string) {
  if (range.r1 >= sheet.rowCount || range.c1 >= sheet.columnCount)
    refuse(
      "outsideTheSheet",
      `${where} ${formatSheetRange(range)} goes past ${sheet.name}'s last row (${sheet.rowCount}) or column (${columnName(sheet.columnCount - 1)}). Insert rows or columns first, or write a null at the far corner.`,
    );
}
function eachCell(range: SheetRange, fn: (r: number, c: number) => void) {
  for (let r = range.r0; r <= range.r1; r++) for (let c = range.c0; c <= range.c1; c++) fn(r, c);
}
function cellCount(range: SheetRange) {
  return (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
}
function setStyle(
  sheet: WorkSheet,
  r: number,
  c: number,
  change: (style: SheetCellStyle) => SheetCellStyle,
) {
  const at = key(r, c);
  const cell = sheet.cells.get(at) ?? { r, c, v: null };
  const next = clean(change({ ...(cell.s ?? {}) }));
  if (next) cell.s = next;
  else delete cell.s;
  sheet.cells.set(at, cell);
}
function clean(style: SheetCellStyle): SheetCellStyle | undefined {
  const out = Object.fromEntries(
    Object.entries(style).filter(([, value]) => value !== undefined && value !== false),
  ) as SheetCellStyle;
  if (out.border && Object.keys(out.border).length === 0)
    delete (out as { border?: unknown }).border;
  return Object.keys(out).length ? out : undefined;
}

/** Subtracts `cut` from `range`, leaving up to four rectangles. */
function subtract(range: SheetRange, cut: SheetRange): SheetRange[] {
  if (!rangesOverlap(range, cut)) return [range];
  const out: SheetRange[] = [];
  if (range.r0 < cut.r0) out.push({ ...range, r1: cut.r0 - 1 });
  if (range.r1 > cut.r1) out.push({ ...range, r0: cut.r1 + 1 });
  const r0 = Math.max(range.r0, cut.r0);
  const r1 = Math.min(range.r1, cut.r1);
  if (range.c0 < cut.c0) out.push({ r0, r1, c0: range.c0, c1: cut.c0 - 1 });
  if (range.c1 > cut.c1) out.push({ r0, r1, c0: cut.c1 + 1, c1: range.c1 });
  return out;
}

// ── Cell values ──────────────────────────────────────────────────────────────────────────────

const ERRORS = new Set([
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#ERROR!",
  "#SPILL!",
  "#CALC!",
]);
function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/<u>([^<]+)<\/u>/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .replace(/\\([*[\]#\\~_])/gu, "$1");
}

/** One written value: what the cell then holds and the format the text implies. */
function readWrittenValue(
  raw: unknown,
  kept: string | undefined,
  where: string,
): { v: SheetScalar; f?: string; format?: string } {
  if (raw === null) return { v: null };
  if (raw === "") refuse("notRead", `${where} is "". Write null to clear a cell.`);
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) refuse("notRead", `${where} must be a finite number.`);
    return { v: raw };
  }
  if (typeof raw === "boolean") return { v: raw };
  if (typeof raw === "string") {
    if (raw.length > 32_767) refuse("textTooLong", `${where} is longer than 32,767 characters.`);
    if (raw.startsWith("=") && raw.length > 8_192)
      refuse("formulaTooLong", `${where} is longer than 8,192 bytes.`);
    const typed = parseTypedCellInput(raw, kept);
    return {
      v: typed.v,
      ...(typed.f ? { f: typed.f } : {}),
      ...(typed.format ? { format: typed.format } : {}),
    };
  }
  const value = obj(raw, where);
  if (typeof value.formula === "string") return readWrittenValue(value.formula, kept, where);
  if (typeof value.markdown === "string") return { v: stripMarkdown(value.markdown) };
  if (
    typeof value.date === "string" ||
    typeof value.time === "string" ||
    typeof value.dateTime === "string"
  ) {
    const text = String(value.date ?? value.time ?? value.dateTime);
    const typed = parseTypedCellInput(text, undefined);
    if (typeof typed.v !== "number")
      refuse("notRead", `${where} is not a date or time I can read: "${text}".`);
    return { v: typed.v, ...(typed.format ? { format: typed.format } : {}) };
  }
  if (typeof value.number === "number") {
    if (typeof value.shown === "string") {
      const typed = parseTypedCellInput(value.shown, undefined);
      if (typed.format && typeof typed.v === "number")
        return { v: value.number, format: typed.format };
    }
    return { v: value.number };
  }
  if ("spilledFrom" in value) return { v: null };
  return refuse(
    "notRead",
    `${where} is not a value: write a number, a boolean, a string, null, or {"date": …}.`,
  );
}

/** A cell as an agent reads it. */
function readValue(cell: WorkCell | SheetCell | undefined): unknown {
  if (!cell) return null;
  const shown = shownValue(cell.v, cell.s?.format);
  if (cell.f) return { formula: cell.f, value: shown };
  return shown;
}
function shownValue(v: SheetScalar, format: string | undefined): unknown {
  if (v === null) return null;
  if (typeof v === "string" && ERRORS.has(v)) return { error: v };
  // Text that would be read as something else if typed comes back with its apostrophe.
  if (typeof v === "string") {
    const typed = parseTypedCellInput(v, "General");
    return typed.v === v && !typed.f ? v : `'${v}`;
  }
  if (typeof v !== "number") return v;
  const kind = isDateFormat(format);
  if (kind) return { [kind]: serialToIso(v, kind) };
  if (format && format !== "General" && format !== "@")
    return { number: v, shown: formatSheetNumber(format, v) };
  return v;
}
function displayText(cell: WorkCell | undefined): string {
  if (!cell || cell.v === null) return "";
  if (typeof cell.v === "number") return formatSheetNumber(cell.s?.format, cell.v);
  if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
  return cell.v;
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────

function fnv(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x811c9dc5) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}
function ruleOut(rule: SheetRule): Json {
  const operandOut = (o: SheetRuleOperand): Json =>
    o.kind === "sameRowInColumn" ? { kind: o.kind, c: columnName(o.c) } : { ...o };
  const conditionOut = (c: SheetRuleCondition): Json => {
    if (c.kind === "numberIs") return { ...c, operand: operandOut(c.operand) };
    if (c.kind === "numberIsBetween" || c.kind === "numberIsNotBetween")
      return { ...c, oneEnd: operandOut(c.oneEnd), otherEnd: operandOut(c.otherEnd) };
    return { ...c };
  };
  const formatOut = (f: Extract<SheetRule["effect"], { kind: "formatWhere" }>["format"]): Json => {
    const font: Json = {};
    if (f.bold !== undefined) font.bold = f.bold;
    if (f.italic !== undefined) font.italic = f.italic;
    if (f.strike !== undefined) font.strikethrough = f.strike;
    if (f.underline !== undefined) font.underline = f.underline;
    if (f.color !== undefined) font.color = colorOut(f.color);
    return {
      ...(f.fill ? { fillColor: colorOut(f.fill) } : {}),
      ...(Object.keys(font).length ? { font } : {}),
    };
  };
  const effect = rule.effect;
  return {
    cells: rule.ranges.map(formatSheetRange),
    effect:
      effect.kind === "formatWhere"
        ? {
            kind: "formatWhere",
            allOf: effect.allOf.map((test) => ({
              tested:
                test.tested.kind === "sameRowInColumn"
                  ? { kind: "sameRowInColumn", c: columnName(test.tested.c) }
                  : { kind: "theCellItself" },
              condition: conditionOut(test.condition),
            })),
            format: formatOut(effect.format),
          }
        : {
            kind: "colorScale",
            lowest: { anchor: effect.lowest.anchor, color: colorOut(effect.lowest.color) },
            middle: effect.middle
              ? { anchor: effect.middle.anchor, color: colorOut(effect.middle.color) }
              : null,
            highest: { anchor: effect.highest.anchor, color: colorOut(effect.highest.color) },
          },
  };
}
/** The fingerprint a replaceConditionalFormats must name, so it starts from the rules as read. */
export function sheetRulesFingerprint(sheet: Sheet): string {
  return fnv(JSON.stringify((sheet.rules ?? []).map(ruleOut)));
}
function chartOut(workbook: SheetWorkbook, sheet: Sheet, chart: SheetChart): Json {
  const source = workbook.sheets.find((item) => item.id === chart.source.sheetId);
  return {
    chartId: chart.id,
    chart: {
      name: chart.name,
      caption: chart.caption,
      kind: chart.kind,
      ...(chart.code !== undefined ? { code: chart.code } : {}),
      cells: source ? { sheet: source.name, range: formatSheetRange(chart.source.range) } : null,
      sheet: sheet.name,
      topLeft: cellAddress(chart.anchor.r, chart.anchor.c),
      ...(chart.anchor.dx || chart.anchor.dy
        ? { offsetFromAnchorCell: { xInPixels: chart.anchor.dx, yInPixels: chart.anchor.dy } }
        : {}),
      widthInPixels: chart.width,
      heightInPixels: chart.height,
    },
  };
}
function formatOut(style: SheetCellStyle | undefined): Json {
  const out: Json = {};
  if (!style) return out;
  if (style.format) out.numberFormat = { pattern: style.format };
  const alignment: Json = {};
  if (style.align) alignment.horizontal = style.align;
  if (style.valign) alignment.vertical = style.valign === "middle" ? "center" : style.valign;
  if (style.wrap) alignment.wrap = true;
  if (Object.keys(alignment).length) out.alignment = alignment;
  if (style.fill) out.fillColor = colorOut(style.fill);
  const font: Json = {};
  if (style.bold) font.bold = true;
  if (style.italic) font.italic = true;
  if (style.underline) font.underline = style.underline;
  if (style.strike) font.strikethrough = true;
  if (style.size) font.size = style.size;
  if (style.color) font.color = colorOut(style.color);
  if (Object.keys(font).length) out.font = font;
  if (style.border) {
    const border: Json = {};
    for (const [side, name] of [
      ["t", "top"],
      ["r", "right"],
      ["b", "bottom"],
      ["l", "left"],
    ] as const) {
      const line = style.border[side];
      if (line) border[name] = { kind: "line", style: line.style, color: colorOut(line.color) };
    }
    out.border = border;
  }
  return out;
}

export type SheetReadPayload =
  | { kind: "readSheets" }
  | { kind: "readCells"; sheet: string; range: string }
  | { kind: "readCellFormats"; sheet: string; range: string }
  | { kind: "readConditionalFormats"; sheet: string }
  | { kind: "readCharts"; sheet: string };

const READ_KEYS: Record<string, readonly string[]> = {
  readSheets: [],
  readCells: ["sheet", "range"],
  readCellFormats: ["sheet", "range"],
  readConditionalFormats: ["sheet"],
  readCharts: ["sheet"],
};

/** Answers one read of the protocol. Formula results are worked out first. */
export function readSheetWorkbook(
  input: SheetWorkbook,
  revision: number,
  rawPayload: unknown,
): Json {
  const payload = obj(rawPayload, "payload");
  const kind = payload.kind;
  if (typeof kind !== "string" || !(kind in READ_KEYS))
    refuse("kindNotKnown", `payload.kind must be one of ${Object.keys(READ_KEYS).join(", ")}.`);
  keys(payload, "payload", ["kind", ...READ_KEYS[kind]!]);
  const workbook = computeWorkbookFormulas(input);
  if (kind === "readSheets") {
    return {
      revision,
      sheets: workbook.sheets.map((sheet) => {
        const size = sheetSize(sheet);
        const filled = filledRange(sheet);
        return {
          name: sheet.name,
          rowCount: size.rows,
          columnCount: size.columns,
          ...(filled ? { filledRange: formatSheetRange(filled) } : {}),
          ...(sheet.frozenRows ? { lastFrozenRow: sheet.frozenRows } : {}),
          ...(sheet.frozenColumns ? { lastFrozenColumn: columnName(sheet.frozenColumns - 1) } : {}),
          ...(sheet.gridlinesHidden ? { areGridlinesHidden: true } : {}),
          ...(sheet.table ? { cellTable: tableOut(sheet.table) } : {}),
          ...(sheet.charts?.length ? { chartCount: sheet.charts.length } : {}),
          ...(sheet.rules?.length ? { ruleCount: sheet.rules.length } : {}),
          ...(sheet.rowGroups?.length
            ? {
                rowGroups: sheet.rowGroups.map((g) => ({
                  rows: `${g.start + 1}:${g.end + 1}`,
                  isCollapsed: g.collapsed,
                })),
              }
            : {}),
          ...(sheet.columnGroups?.length
            ? {
                columnGroups: sheet.columnGroups.map((g) => ({
                  columns: `${columnName(g.start)}:${columnName(g.end)}`,
                  isCollapsed: g.collapsed,
                })),
              }
            : {}),
        };
      }),
      ...(workbook.deletedSheets?.length
        ? { deletedSheets: workbook.deletedSheets.map((sheet) => sheet.name) }
        : {}),
      locale: workbook.locale ?? "zh-CN",
      timeZone: workbook.timeZone ?? null,
    };
  }
  const work = toWork(workbook);
  const sheet = sheetOf(work, payload.sheet);
  const stored = workbook.sheets.find((item) => item.id === sheet.id)!;
  if (kind === "readConditionalFormats")
    return {
      revision,
      sheet: sheet.name,
      rules: (stored.rules ?? []).map(ruleOut),
      fingerprint: sheetRulesFingerprint(stored),
    };
  if (kind === "readCharts")
    return {
      revision,
      sheet: sheet.name,
      charts: (stored.charts ?? []).map((chart) => chartOut(workbook, stored, chart)),
    };
  const range = asRange(payload.range, "payload.range");
  if (cellCount(range) > 10_000)
    refuse(
      "readTooLarge",
      "One read answers at most 10,000 cells. Read some hundreds of rows at a time.",
    );
  if (kind === "readCellFormats") {
    const groups = new Map<string, SheetRange[]>();
    eachCell(range, (r, c) => {
      const style = sheet.cells.get(key(r, c))?.s;
      if (!style) return;
      const json = JSON.stringify(formatOut(style));
      if (json === "{}") return;
      const list = groups.get(json) ?? [];
      const last = list.at(-1);
      if (last && last.r0 === r && last.r1 === r && last.c1 === c - 1)
        list[list.length - 1] = { ...last, c1: c };
      else list.push({ r0: r, r1: r, c0: c, c1: c });
      groups.set(json, list);
    });
    return {
      revision,
      sheet: sheet.name,
      formats: [...groups.entries()].map(([json, ranges]) => ({
        ranges: ranges.map(formatSheetRange),
        format: JSON.parse(json),
      })),
    };
  }
  // readCells
  const rows: Record<string, unknown[]> = {};
  let lastRow = -1;
  let lastColumn = -1;
  for (let r = range.r0; r <= range.r1; r++)
    for (let c = range.c0; c <= range.c1; c++) {
      const cell = sheet.cells.get(key(r, c));
      if (cell && (cell.v !== null || cell.f)) {
        lastRow = Math.max(lastRow, r);
        lastColumn = Math.max(lastColumn, c);
      }
    }
  const answer: Json = { revision, sheet: sheet.name };
  if (lastRow < 0) answer.range = null;
  else {
    const covered = { r0: range.r0, c0: range.c0, r1: lastRow, c1: lastColumn };
    answer.range = formatSheetRange(covered);
    for (let r = covered.r0; r <= covered.r1; r++) {
      const row: unknown[] = [];
      for (let c = covered.c0; c <= covered.c1; c++)
        row.push(readValue(sheet.cells.get(key(r, c))));
      rows[String(r + 1)] = row;
    }
  }
  answer.rows = rows;
  const merges = (stored.merges ?? []).filter((m) => rangesOverlap(m, range));
  if (merges.length) answer.mergedRanges = merges.map(formatSheetRange);
  const dropdowns = (stored.dropdowns ?? []).filter((d) =>
    d.ranges.some((r) => rangesOverlap(r, range)),
  );
  if (dropdowns.length)
    answer.dropdowns = dropdowns.map((d) => ({
      dropdownId: d.id,
      ranges: d.ranges
        .filter((r) => rangesOverlap(r, range))
        .map((r) => formatSheetRange(clip(r, range))),
      options: d.options.map((o) => ({ optionId: o.id, label: o.label, color: colorOut(o.color) })),
    }));
  const boxes = (stored.checkboxes ?? []).filter((b) => rangesOverlap(b, range));
  if (boxes.length) answer.checkboxes = boxes.map((b) => formatSheetRange(clip(b, range)));
  const narrow = columnsTooNarrow(sheet, range);
  if (narrow.length) answer.columnsTooNarrowForTheirNumbers = narrow;
  return answer;
}
function clip(a: SheetRange, b: SheetRange): SheetRange {
  return {
    r0: Math.max(a.r0, b.r0),
    r1: Math.min(a.r1, b.r1),
    c0: Math.max(a.c0, b.c0),
    c1: Math.min(a.c1, b.c1),
  };
}
function tableOut(table: SheetTable): Json {
  return {
    columns: `${columnName(table.c0)}:${columnName(table.c1)}`,
    headerRows:
      table.headerR0 === table.headerR1
        ? `${table.headerR0 + 1}`
        : `${table.headerR0 + 1}:${table.headerR1 + 1}`,
    footerRows:
      table.footerR0 === undefined
        ? null
        : table.footerR0 === table.footerR1
          ? `${table.footerR0 + 1}`
          : `${table.footerR0 + 1}:${(table.footerR1 ?? table.footerR0) + 1}`,
  };
}

/** Pixels a cell's shown text needs (an estimate of the editor's 10 pt font). */
function textWidth(text: string, size = 10): number {
  let width = 0;
  for (const char of text)
    width += /[⺀-鿿가-힯＀-￯]/u.test(char)
      ? 13.4
      : /[0-9]/u.test(char)
        ? 7.1
        : /[A-Z]/u.test(char)
          ? 8.6
          : 7;
  return width * (size / 10);
}
function columnWidth(sheet: WorkSheet, c: number): number {
  return (
    (sheet.meta.columnWidths as Record<string, number> | undefined)?.[String(c)] ??
    DEFAULT_COLUMN_WIDTH
  );
}
function columnsTooNarrow(sheet: WorkSheet, range: SheetRange): string[] {
  const out: string[] = [];
  for (let c = range.c0; c <= range.c1; c++) {
    const width = columnWidth(sheet, c);
    for (let r = range.r0; r <= range.r1; r++) {
      const cell = sheet.cells.get(key(r, c));
      if (!cell || typeof cell.v !== "number") continue;
      if (textWidth(displayText(cell), cell.s?.size) + 10 > width) {
        out.push(columnName(c));
        break;
      }
    }
  }
  return out;
}

// ── Axis changes (insert, delete, move rows / columns) ───────────────────────────────────────

function mapIndex(change: AxisChange, i: number): number | null {
  if (change.kind === "insert") return i >= change.at ? i + change.count : i;
  if (change.kind === "delete")
    return i < change.start ? i : i > change.end ? i - (change.end - change.start + 1) : null;
  return change.map(i);
}
function mapRange(
  range: SheetRange,
  axis: "row" | "column",
  change: AxisChange,
): SheetRange | null {
  const [a, b] = axis === "row" ? [range.r0, range.r1] : [range.c0, range.c1];
  const span = mapAxisSpan(a, b, change);
  if (!span) return null;
  return axis === "row"
    ? { ...range, r0: span.a, r1: span.b }
    : { ...range, c0: span.a, c1: span.b };
}
function mapSizes(
  sizes: Record<string, number> | undefined,
  change: AxisChange,
): Record<string, number> | undefined {
  if (!sizes) return undefined;
  const out: Record<string, number> = {};
  for (const [index, size] of Object.entries(sizes)) {
    const next = mapIndex(change, Number(index));
    if (next !== null) out[String(next)] = size;
  }
  return Object.keys(out).length ? out : undefined;
}
function mapGroups(
  groups: readonly SheetGroup[] | undefined,
  change: AxisChange,
): SheetGroup[] | undefined {
  if (!groups) return undefined;
  const out = groups.flatMap((g) => {
    const span = mapAxisSpan(g.start, g.end, change);
    return span ? [{ start: span.a, end: span.b, collapsed: g.collapsed }] : [];
  });
  return out.length ? out : undefined;
}

function changeAxis(work: Work, sheet: WorkSheet, axis: "row" | "column", change: AxisChange) {
  // Cells move.
  const moved = new Map<string, WorkCell>();
  for (const cell of sheet.cells.values()) {
    const index = mapIndex(change, axis === "row" ? cell.r : cell.c);
    if (index === null) continue;
    const next = axis === "row" ? { ...cell, r: index } : { ...cell, c: index };
    moved.set(key(next.r, next.c), next);
  }
  sheet.cells = moved;
  // Formulas everywhere follow the cells of this sheet.
  for (const other of work.sheets)
    for (const cell of other.cells.values())
      if (cell.f) cell.f = mapFormulaReferences(cell.f, other.name, sheet.name, axis, change);
  const meta = sheet.meta;
  const ranges = (list: readonly SheetRange[] | undefined) => {
    if (!list) return undefined;
    const out = list.flatMap((range) => {
      const next = mapRange(range, axis, change);
      return next ? [next] : [];
    });
    return out.length ? out : undefined;
  };
  const set = (name: string, value: unknown) => {
    if (value === undefined) delete meta[name];
    else meta[name] = value;
  };
  set("merges", ranges(meta.merges));
  set("checkboxes", ranges(meta.checkboxes));
  set(
    "dropdowns",
    meta.dropdowns?.flatMap((d) => {
      const r = ranges(d.ranges);
      return r ? [{ ...d, ranges: r }] : [];
    }),
  );
  if (meta.dropdowns && meta.dropdowns.length === 0) delete meta.dropdowns;
  set(
    "rules",
    meta.rules?.flatMap((rule) => {
      const r = ranges(rule.ranges);
      if (!r) return [];
      if (axis === "column" && rule.effect.kind === "formatWhere") {
        let lost = false;
        const mapColumn = (c: number) => {
          const next = mapIndex(change, c);
          if (next === null) lost = true;
          return next ?? 0;
        };
        const allOf = rule.effect.allOf.map((test) => ({
          tested:
            test.tested.kind === "sameRowInColumn"
              ? { kind: "sameRowInColumn" as const, c: mapColumn(test.tested.c) }
              : test.tested,
          condition: mapRuleColumns(test.condition, mapColumn),
        }));
        // A rule that tests a deleted column matches nothing, so it goes.
        return lost ? [] : [{ ranges: r, effect: { ...rule.effect, allOf } }];
      }
      return [{ ...rule, ranges: r }];
    }),
  );
  if (meta.rules && meta.rules.length === 0) delete meta.rules;
  if (meta.table) {
    const t = meta.table;
    if (axis === "column") {
      const span = mapAxisSpan(t.c0, t.c1, change);
      set("table", span ? { ...t, c0: span.a, c1: span.b } : undefined);
    } else {
      const header = mapAxisSpan(t.headerR0, t.headerR1, change);
      const footer =
        t.footerR0 === undefined ? null : mapAxisSpan(t.footerR0, t.footerR1 ?? t.footerR0, change);
      set(
        "table",
        header
          ? {
              c0: t.c0,
              c1: t.c1,
              headerR0: header.a,
              headerR1: header.b,
              ...(footer ? { footerR0: footer.a, footerR1: footer.b } : {}),
            }
          : undefined,
      );
    }
  }
  set(
    "spills",
    meta.spills?.flatMap((spill) => {
      const anchor = mapIndex(change, axis === "row" ? spill.r : spill.c);
      if (anchor === null) return [];
      const cells = spill.cells.flatMap(([r, c, v]) => {
        const at = mapIndex(change, axis === "row" ? r : c);
        if (at === null) return [];
        return [(axis === "row" ? [at, c, v] : [r, at, v]) as [number, number, SheetScalar]];
      });
      return [axis === "row" ? { r: anchor, c: spill.c, cells } : { r: spill.r, c: anchor, cells }];
    }),
  );
  if (meta.spills && meta.spills.length === 0) delete meta.spills;
  if (axis === "row") {
    set("rowHeights", mapSizes(meta.rowHeights as Record<string, number>, change));
    set("rowGroups", mapGroups(meta.rowGroups, change));
    if (meta.frozenRows) {
      const span = mapAxisSpan(0, meta.frozenRows - 1, change);
      set("frozenRows", span ? span.b + 1 : undefined);
    }
  } else {
    set("columnWidths", mapSizes(meta.columnWidths as Record<string, number>, change));
    set("columnGroups", mapGroups(meta.columnGroups, change));
    if (meta.frozenColumns) {
      const span = mapAxisSpan(0, meta.frozenColumns - 1, change);
      set("frozenColumns", span ? span.b + 1 : undefined);
    }
  }
  // Charts: their anchors on this sheet, and their sources anywhere.
  for (const other of work.sheets) {
    const charts = (other.meta.charts as SheetChart[] | undefined)?.map((chart) => {
      let next = chart;
      if (other.id === sheet.id) {
        const index = axis === "row" ? chart.anchor.r : chart.anchor.c;
        let mapped = mapIndex(change, index);
        if (mapped === null)
          mapped = change.kind === "delete" ? Math.max(0, change.start - 1) : index;
        next = {
          ...next,
          anchor: axis === "row" ? { ...next.anchor, r: mapped } : { ...next.anchor, c: mapped },
        };
      }
      if (chart.source.sheetId === sheet.id) {
        const range = mapRange(chart.source.range, axis, change);
        if (range) next = { ...next, source: { ...next.source, range } };
      }
      return next;
    });
    if (charts) other.meta.charts = charts;
  }
}
function mapRuleColumns(
  condition: SheetRuleCondition,
  map: (c: number) => number,
): SheetRuleCondition {
  const operand = (o: SheetRuleOperand): SheetRuleOperand =>
    o.kind === "sameRowInColumn" ? { kind: o.kind, c: map(o.c) } : o;
  if (condition.kind === "numberIs") return { ...condition, operand: operand(condition.operand) };
  if (condition.kind === "numberIsBetween" || condition.kind === "numberIsNotBetween")
    return {
      ...condition,
      oneEnd: operand(condition.oneEnd),
      otherEnd: operand(condition.otherEnd),
    };
  return condition;
}

// ── Sorting ──────────────────────────────────────────────────────────────────────────────────

function sortRank(v: SheetScalar, dropdown: SheetDropdown | undefined): [number, number | string] {
  if (v === null || v === "") return [5, 0];
  if (typeof v === "string" && ERRORS.has(v)) return [4, 0];
  if (dropdown && typeof v === "string") {
    const at = dropdown.options.findIndex((o) => o.label.toLowerCase() === v.toLowerCase());
    if (at >= 0) return [0, at];
  }
  if (typeof v === "number") return [0, v];
  if (typeof v === "string") return [1, v.toLowerCase()];
  return [v ? 3 : 2, 0];
}
function compareRank(a: [number, number | string], b: [number, number | string]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (typeof a[1] === "number" && typeof b[1] === "number") return a[1] - b[1];
  return String(a[1]).localeCompare(String(b[1]), "zh-CN");
}
/** Takes out the values spills wrote (still as written), so they are written again later. */
function clearSpills(sheet: WorkSheet) {
  for (const spill of sheet.meta.spills ?? [])
    for (const [r, c, v] of spill.cells) {
      const cell = sheet.cells.get(key(r, c));
      if (!cell || cell.f || cell.v !== v) continue;
      if (cell.s) cell.v = null;
      else sheet.cells.delete(key(r, c));
    }
  delete sheet.meta.spills;
}
function sortBlock(
  work: Work,
  sheet: WorkSheet,
  block: SheetRange,
  byColumn: number,
  direction: "ascending" | "descending",
  wholeRows: boolean,
) {
  for (const merge of (sheet.meta.merges as SheetRange[] | undefined) ?? [])
    if (
      rangesOverlap(merge, block) &&
      (merge.r0 < block.r0 || merge.r1 > block.r1 || merge.r0 !== merge.r1 || !wholeRows)
    )
      refuse(
        "wouldSplitMerge",
        `Sorting ${formatSheetRange(block)} would split the merged range ${formatSheetRange(merge)}. Unmerge it first.`,
      );
  clearSpills(sheet);
  const computed = computeWorkbookFormulas(fromWork(work));
  const values = new Map(
    computed.sheets
      .find((s) => s.id === sheet.id)!
      .cells.map((cell) => [key(cell.r, cell.c), cell.v]),
  );
  const dropdown = ((sheet.meta.dropdowns as SheetDropdown[] | undefined) ?? []).find((d) =>
    d.ranges.some((r) => byColumn >= r.c0 && byColumn <= r.c1 && rangesOverlap(r, block)),
  );
  const order = Array.from({ length: block.r1 - block.r0 + 1 }, (_, i) => block.r0 + i);
  const sign = direction === "descending" ? -1 : 1;
  order.sort((a, b) => {
    const ra = sortRank(values.get(key(a, byColumn)) ?? null, dropdown);
    const rb = sortRank(values.get(key(b, byColumn)) ?? null, dropdown);
    // Errors and blanks stay last either way; ties keep their order.
    if (ra[0] >= 4 || rb[0] >= 4) return ra[0] - rb[0] || a - b;
    return sign * compareRank(ra, rb) || a - b;
  });
  const c0 = wholeRows ? 0 : block.c0;
  const c1 = wholeRows ? sheet.columnCount - 1 : block.c1;
  const next = new Map(sheet.cells);
  for (let r = block.r0; r <= block.r1; r++) for (let c = c0; c <= c1; c++) next.delete(key(r, c));
  order.forEach((from, i) => {
    const to = block.r0 + i;
    for (let c = c0; c <= c1; c++) {
      const cell = sheet.cells.get(key(from, c));
      if (!cell) continue;
      next.set(key(to, c), {
        ...cell,
        r: to,
        ...(cell.f ? { f: offsetFormula(cell.f, to - from, 0) } : {}),
      });
    }
  });
  sheet.cells = next;
  if (wholeRows) {
    // One-row merges travel with their rows.
    const landing = new Map(order.map((from, i) => [from, block.r0 + i]));
    const merges = sheet.meta.merges as SheetRange[] | undefined;
    if (merges)
      sheet.meta.merges = merges.map((m) => {
        const to = landing.get(m.r0);
        return to === undefined ? m : { ...m, r0: to, r1: to };
      });
    const heights = sheet.meta.rowHeights as Record<string, number> | undefined;
    if (heights) {
      const copy = { ...heights };
      for (let r = block.r0; r <= block.r1; r++) delete copy[String(r)];
      order.forEach((from, i) => {
        if (heights[String(from)] !== undefined)
          copy[String(block.r0 + i)] = heights[String(from)]!;
      });
      sheet.meta.rowHeights = copy;
    }
  }
}

// ── Edits ────────────────────────────────────────────────────────────────────────────────────

export const SHEET_EDIT_KINDS = {
  writeCells: ["sheet", "topLeft", "rows"],
  addSheet: ["name"],
  renameSheet: ["sheet", "name"],
  restoreSheet: ["sheet", "name?"],
  moveSheets: ["sheets", "afterSheet"],
  deleteSheet: ["sheet"],
  formatCells: ["sheet", "ranges", "format"],
  setBorders: ["sheet", "range", "edges", "border"],
  mergeCells: ["sheet", "ranges"],
  unmergeCells: ["sheet", "ranges"],
  setColumnWidths: ["sheet", "columns", "widthInPixels"],
  fitColumns: ["sheet", "columns"],
  setRowHeights: ["sheet", "rows", "heightInPixels"],
  insertRows: ["sheet", "besideRow", "side", "count"],
  insertColumns: ["sheet", "besideColumn", "side", "count"],
  deleteRows: ["sheet", "rows"],
  deleteColumns: ["sheet", "columns"],
  moveRows: ["sheet", "rows", "afterRow"],
  moveColumns: ["sheet", "columns", "afterColumn"],
  sortRows: ["sheet", "rows", "byColumn", "direction"],
  sortCells: ["sheet", "range", "byColumn", "direction"],
  groupRows: ["sheet", "groups"],
  groupColumns: ["sheet", "groups"],
  ungroupRows: ["sheet", "groups"],
  ungroupColumns: ["sheet", "groups"],
  setSheetSettings: ["sheet", "settings"],
  makeDropdown: ["sheet", "range", "options"],
  setDropdownOptions: ["sheet", "dropdownId", "options"],
  setCellTable: ["sheet", "cellTable"],
  replaceConditionalFormats: ["sheet", "inPlaceOf", "rules"],
  addChart: ["chart"],
  setChart: ["chartId", "chart"],
  deleteChart: ["chartId"],
  setLocale: ["locale"],
  setTimeZone: ["timeZone"],
} as const satisfies Record<string, readonly string[]>;
type EditKind = keyof typeof SHEET_EDIT_KINDS;

const MAX_EDITS = 64;
const MAX_CELLS_WRITTEN = 2_000;

let idCounter = 0;
function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${idCounter.toString(36)}`;
}

function dropdownsOf(sheet: WorkSheet): SheetDropdown[] {
  return (sheet.meta.dropdowns as SheetDropdown[] | undefined) ?? [];
}
function dropdownAt(sheet: WorkSheet, r: number, c: number): SheetDropdown | undefined {
  return dropdownsOf(sheet).find((d) => d.ranges.some((range) => rangeContains(range, r, c)));
}
function removeControls(sheet: WorkSheet, cut: SheetRange) {
  const dropdowns = dropdownsOf(sheet).flatMap((d) => {
    const ranges = d.ranges.flatMap((range) => subtract(range, cut));
    return ranges.length ? [{ ...d, ranges }] : [];
  });
  if (dropdowns.length) sheet.meta.dropdowns = dropdowns;
  else delete sheet.meta.dropdowns;
  const boxes = ((sheet.meta.checkboxes as SheetRange[] | undefined) ?? []).flatMap((range) =>
    subtract(range, cut),
  );
  if (boxes.length) sheet.meta.checkboxes = boxes;
  else delete sheet.meta.checkboxes;
}

function writeCells(work: Work, edit: Json) {
  const sheet = sheetOf(work, edit.sheet);
  const origin = asRange(edit.topLeft, "topLeft");
  if (!Array.isArray(edit.rows) || edit.rows.length === 0)
    refuse("notRead", "rows must be a list of rows, each a list of values.");
  const width = Array.isArray(edit.rows[0]) ? edit.rows[0].length : 0;
  if (width === 0) refuse("notRead", "rows must hold at least one value.");
  for (const [i, row] of edit.rows.entries())
    if (!Array.isArray(row) || row.length !== width)
      refuse(
        "rowsNotTheSameLength",
        `Every row of rows must have ${width} values; row ${i} has ${Array.isArray(row) ? row.length : 0}.`,
      );
  const target = {
    r0: origin.r0,
    c0: origin.c0,
    r1: origin.r0 + edit.rows.length - 1,
    c1: origin.c0 + width - 1,
  };
  if (target.r1 >= SHEET_DATA_LIMITS.rows || target.c1 >= SHEET_DATA_LIMITS.columns)
    refuse("outsideTheSheet", "The write goes past the largest sheet.");
  work.written += cellCount(target);
  sheet.rowCount = Math.max(sheet.rowCount, target.r1 + 1);
  sheet.columnCount = Math.max(sheet.columnCount, target.c1 + 1);
  const merges = (sheet.meta.merges as SheetRange[] | undefined) ?? [];
  (edit.rows as unknown[][]).forEach((row, dr) =>
    row.forEach((raw, dc) => {
      const r = target.r0 + dr;
      const c = target.c0 + dc;
      const at = key(r, c);
      const where = `rows[${dr}][${dc}] (${cellAddress(r, c)})`;
      const previous = sheet.cells.get(at);
      const written = readWrittenValue(raw, previous?.s?.format, where);
      if (written.v !== null || written.f)
        for (const merge of merges)
          if (rangeContains(merge, r, c) && (merge.r0 !== r || merge.c0 !== c))
            refuse(
              "insideAMergedRange",
              `${cellAddress(r, c)} is inside the merged range ${formatSheetRange(merge)}; only its first cell ${cellAddress(merge.r0, merge.c0)} holds anything.`,
              cellAddress(r, c),
            );
      const dropdown = dropdownAt(sheet, r, c);
      if (dropdown && (written.v !== null || written.f)) {
        const option =
          typeof written.v === "string"
            ? dropdown.options.find(
                (o) => o.label.toLowerCase() === String(written.v).toLowerCase(),
              )
            : undefined;
        if (!option || written.f)
          refuse(
            "notAnOption",
            `${cellAddress(r, c)} has a dropdown. Write one of its options (${dropdown.options.map((o) => `"${o.label}"`).join(", ")}), add the option first, or write null.`,
            cellAddress(r, c),
          );
        written.v = option.label;
      }
      let style = previous?.s;
      if (written.format && written.format !== style?.format)
        style = { ...(style ?? {}), format: written.format };
      if (written.v === null && !written.f && !style) {
        sheet.cells.delete(at);
        return;
      }
      sheet.cells.set(at, {
        r,
        c,
        v: written.v,
        ...(written.f ? { f: written.f } : {}),
        ...(style ? { s: style } : {}),
      });
    }),
  );
}

function validSheetName(work: Work, raw: unknown, except?: WorkSheet): string {
  const name = str(raw, "name").trim();
  if (!name) refuse("notRead", "A sheet needs a name.");
  if (name.length > 100) refuse("nameTooLong", "A sheet name has at most 100 characters.");
  if (/[\\/?*[\]:]/u.test(name)) refuse("notRead", "A sheet name can't hold \\ / ? * [ ] or :.");
  if (work.sheets.some((s) => s !== except && s.name.toLowerCase() === name.toLowerCase()))
    refuse("sheetNameTaken", `Another sheet is called "${name}" already.`);
  return name;
}

function readBorderLine(raw: unknown, where: string): SheetBorderLine | null {
  const line = obj(raw, where);
  if (line.kind === "none") return null;
  if (line.kind !== "line") refuse("notRead", `${where}.kind must be line or none.`);
  keys(line, where, ["kind", "style"], ["color"]);
  if (!SHEET_BORDER_STYLES.includes(line.style as SheetBorderLine["style"]))
    refuse("notRead", `${where}.style must be one of ${SHEET_BORDER_STYLES.join(", ")}.`);
  const color = line.color === undefined ? null : standardSheetColor(line.color, `${where}.color`);
  return { style: line.style as SheetBorderLine["style"], ...(color ? { color } : {}) };
}

function formatCells(work: Work, edit: Json) {
  const sheet = sheetOf(work, edit.sheet);
  if (!Array.isArray(edit.ranges) || edit.ranges.length === 0 || edit.ranges.length > 1_000)
    refuse("notRead", "ranges must list 1 to 1,000 ranges.");
  const ranges = edit.ranges.map((r, i) => asRange(r, `ranges[${i}]`));
  for (let i = 0; i < ranges.length; i++)
    for (let j = i + 1; j < ranges.length; j++)
      if (rangesOverlap(ranges[i]!, ranges[j]!))
        refuse(
          "rangesShareACell",
          `ranges ${formatSheetRange(ranges[i]!)} and ${formatSheetRange(ranges[j]!)} share a cell.`,
        );
  for (const range of ranges) insideSheet(sheet, range, "range");
  const format = obj(edit.format, "format");
  keys(
    format,
    "format",
    [],
    ["numberFormat", "alignment", "fillColor", "cellControl", "border", "font"],
  );
  const changes: ((style: SheetCellStyle) => SheetCellStyle)[] = [];
  if (format.numberFormat !== undefined) {
    const nf = obj(format.numberFormat, "format.numberFormat");
    keys(nf, "format.numberFormat", ["pattern"]);
    const pattern = str(nf.pattern, "format.numberFormat.pattern");
    if (pattern.length > 128) refuse("notRead", "A number format has at most 128 characters.");
    changes.push(
      (s) => ({ ...s, format: pattern === "General" ? undefined : pattern }) as SheetCellStyle,
    );
  }
  if (format.alignment !== undefined) {
    const al = obj(format.alignment, "format.alignment");
    keys(al, "format.alignment", [], ["horizontal", "vertical", "wrap"]);
    if (
      al.horizontal !== undefined &&
      !["general", "left", "center", "right"].includes(al.horizontal as string)
    )
      refuse("notRead", "format.alignment.horizontal must be general, left, center or right.");
    if (al.vertical !== undefined && !["top", "center", "bottom"].includes(al.vertical as string))
      refuse("notRead", "format.alignment.vertical must be top, center or bottom.");
    if (al.wrap !== undefined && typeof al.wrap !== "boolean")
      refuse("notRead", "format.alignment.wrap must be true or false.");
    changes.push(
      (s) =>
        ({
          ...s,
          ...(al.horizontal !== undefined
            ? { align: al.horizontal === "general" ? undefined : (al.horizontal as "left") }
            : {}),
          ...(al.vertical !== undefined
            ? {
                valign:
                  al.vertical === "top"
                    ? undefined
                    : al.vertical === "center"
                      ? "middle"
                      : "bottom",
              }
            : {}),
          ...(al.wrap !== undefined ? { wrap: al.wrap === true ? true : undefined } : {}),
        }) as SheetCellStyle,
    );
  }
  if (format.fillColor !== undefined) {
    const fill = standardSheetColor(format.fillColor, "format.fillColor");
    changes.push((s) => ({ ...s, fill: fill ?? undefined }) as SheetCellStyle);
  }
  if (format.font !== undefined) {
    const font = obj(format.font, "format.font");
    keys(
      font,
      "format.font",
      [],
      ["bold", "italic", "underline", "strikethrough", "size", "color"],
    );
    for (const k of ["bold", "italic", "strikethrough"])
      if (font[k] !== undefined && typeof font[k] !== "boolean")
        refuse("notRead", `format.font.${k} must be true or false.`);
    if (
      font.underline !== undefined &&
      !["none", "single", "double"].includes(font.underline as string)
    )
      refuse("notRead", "format.font.underline must be none, single or double.");
    const size = font.size === undefined ? undefined : num(font.size, "format.font.size", 6, 96);
    const color =
      font.color === undefined ? undefined : standardSheetColor(font.color, "format.font.color");
    changes.push(
      (s) =>
        ({
          ...s,
          ...(font.bold !== undefined ? { bold: font.bold === true || undefined } : {}),
          ...(font.italic !== undefined ? { italic: font.italic === true || undefined } : {}),
          ...(font.strikethrough !== undefined
            ? { strike: font.strikethrough === true || undefined }
            : {}),
          ...(font.underline !== undefined
            ? { underline: font.underline === "none" ? undefined : (font.underline as "single") }
            : {}),
          ...(size !== undefined ? { size: size === 10 ? undefined : size } : {}),
          ...(color !== undefined ? { color: color ?? undefined } : {}),
        }) as SheetCellStyle,
    );
  }
  if (format.border !== undefined) {
    const border = obj(format.border, "format.border");
    keys(border, "format.border", [], ["top", "right", "bottom", "left"]);
    const sides: [keyof SheetCellBorder, SheetBorderLine | null][] = [];
    for (const [name, side] of [
      ["top", "t"],
      ["right", "r"],
      ["bottom", "b"],
      ["left", "l"],
    ] as const)
      if (border[name] !== undefined)
        sides.push([side, readBorderLine(border[name], `format.border.${name}`)]);
    changes.push((s) => {
      const next: Record<string, SheetBorderLine | undefined> = { ...(s.border ?? {}) };
      for (const [side, line] of sides) next[side] = line ?? undefined;
      const kept = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
      return { ...s, border: Object.keys(kept).length ? kept : undefined } as SheetCellStyle;
    });
  }
  for (const range of ranges) {
    if (changes.length)
      eachCell(range, (r, c) =>
        setStyle(sheet, r, c, (s) => changes.reduce((acc, fn) => fn(acc), s)),
      );
  }
  if (format.cellControl !== undefined) {
    const control = obj(format.cellControl, "format.cellControl");
    for (const range of ranges) {
      if (control.kind === "none") removeControls(sheet, range);
      else if (control.kind === "checkbox") {
        removeControls(sheet, range);
        sheet.meta.checkboxes = [
          ...((sheet.meta.checkboxes as SheetRange[] | undefined) ?? []),
          range,
        ];
        eachCell(range, (r, c) => {
          const cell = sheet.cells.get(key(r, c));
          if (!cell || (cell.v === null && !cell.f)) {
            sheet.cells.set(key(r, c), { ...(cell ?? { r, c }), r, c, v: false });
            work.written += 1;
          }
        });
      } else if (control.kind === "dropdown") {
        const id = str(control.dropdownId, "format.cellControl.dropdownId");
        const dropdown = dropdownsOf(sheet).find((d) => d.id === id);
        if (!dropdown)
          refuse(
            "dropdownNotFound",
            `This sheet has no dropdown ${id}. readCells lists dropdowns.`,
          );
        checkDropdownCells(
          sheet,
          range,
          dropdown.options.map((o) => o.label),
        );
        removeControls(sheet, range);
        sheet.meta.dropdowns = dropdownsOf(sheet).map((d) =>
          d.id === id ? { ...d, ranges: [...d.ranges, range] } : d,
        );
        if (!dropdownsOf(sheet).some((d) => d.id === id))
          sheet.meta.dropdowns = [...dropdownsOf(sheet), { ...dropdown, ranges: [range] }];
      } else refuse("notRead", "format.cellControl.kind must be checkbox, dropdown or none.");
    }
  }
}
function checkDropdownCells(sheet: WorkSheet, range: SheetRange, labels: readonly string[]) {
  const lower = new Map(labels.map((label) => [label.toLowerCase(), label]));
  eachCell(range, (r, c) => {
    const cell = sheet.cells.get(key(r, c));
    if (!cell || (cell.v === null && !cell.f)) return;
    const label =
      typeof cell.v === "string" && !cell.f ? lower.get(cell.v.toLowerCase()) : undefined;
    if (!label)
      refuse(
        "notAnOption",
        `${cellAddress(r, c)} holds ${cell.f ? "a formula" : JSON.stringify(cell.v)}, which is none of the dropdown's options. Add an option for it, or write the cell first.`,
        cellAddress(r, c),
      );
    cell.v = label;
  });
}

function setBorders(work: Work, edit: Json) {
  const sheet = sheetOf(work, edit.sheet);
  const range = asRange(edit.range, "range");
  insideSheet(sheet, range, "range");
  const edges = str(edit.edges, "edges");
  const allowed = [
    "all",
    "inner",
    "innerHorizontal",
    "innerVertical",
    "outer",
    "left",
    "top",
    "right",
    "bottom",
  ];
  if (!allowed.includes(edges)) refuse("notRead", `edges must be one of ${allowed.join(", ")}.`);
  const line = readBorderLine(edit.border, "border");
  const put = (r: number, c: number, side: keyof SheetCellBorder) => {
    if (r < 0 || c < 0) return;
    setStyle(sheet, r, c, (s) => {
      const next: Record<string, SheetBorderLine | undefined> = { ...(s.border ?? {}) };
      next[side] = line ?? undefined;
      const kept = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
      return { ...s, border: Object.keys(kept).length ? kept : undefined } as SheetCellStyle;
    });
  };
  const opposite = { t: "b", b: "t", l: "r", r: "l" } as const;
  // Both cells of a shared edge carry it, so it shows whichever side draws.
  const edge = (r: number, c: number, side: keyof SheetCellBorder) => {
    put(r, c, side);
    const [nr, nc] =
      side === "t"
        ? [r - 1, c]
        : side === "b"
          ? [r + 1, c]
          : side === "l"
            ? [r, c - 1]
            : [r, c + 1];
    if (line === null || rangeContains(range, nr, nc)) put(nr, nc, opposite[side]);
  };
  eachCell(range, (r, c) => {
    const top = r === range.r0;
    const bottom = r === range.r1;
    const left = c === range.c0;
    const right = c === range.c1;
    const want = (side: keyof SheetCellBorder): boolean => {
      const outer = side === "t" ? top : side === "b" ? bottom : side === "l" ? left : right;
      switch (edges) {
        case "all":
          return true;
        case "outer":
          return outer;
        case "inner":
          return !outer;
        case "innerHorizontal":
          return !outer && (side === "t" || side === "b");
        case "innerVertical":
          return !outer && (side === "l" || side === "r");
        case "top":
          return side === "t" && top;
        case "bottom":
          return side === "b" && bottom;
        case "left":
          return side === "l" && left;
        case "right":
          return side === "r" && right;
      }
      return false;
    };
    for (const side of ["t", "r", "b", "l"] as const) if (want(side)) edge(r, c, side);
  });
}

function mergeCells(work: Work, edit: Json, merge: boolean) {
  const sheet = sheetOf(work, edit.sheet);
  if (!Array.isArray(edit.ranges) || edit.ranges.length === 0 || edit.ranges.length > 1_000)
    refuse("notRead", "ranges must list 1 to 1,000 ranges.");
  const ranges = edit.ranges.map((r, i) => asRange(r, `ranges[${i}]`));
  let merges = [...((sheet.meta.merges as SheetRange[] | undefined) ?? [])];
  if (!merge) {
    merges = merges.filter((m) => !ranges.some((r) => rangesOverlap(m, r)));
  } else {
    for (const range of ranges) {
      insideSheet(sheet, range, "range");
      if (cellCount(range) < 2)
        refuse("notRead", `${formatSheetRange(range)} is one cell; a merge needs two or more.`);
      const clash = merges.find((m) => rangesOverlap(m, range));
      if (clash)
        refuse(
          "mergesOverlap",
          `${formatSheetRange(range)} shares a cell with the merged range ${formatSheetRange(clash)}. Unmerge it first.`,
          formatSheetRange(clash),
        );
      eachCell(range, (r, c) => {
        if (r === range.r0 && c === range.c0) return;
        const cell = sheet.cells.get(key(r, c));
        if (cell && (cell.v !== null || cell.f))
          refuse(
            "mergeHasContent",
            `${cellAddress(r, c)} holds something; only the first cell of a merged range may. Write null there first (with the person's yes).`,
            cellAddress(r, c),
          );
      });
      merges.push(range);
    }
  }
  if (merges.length) sheet.meta.merges = merges;
  else delete sheet.meta.merges;
}

function insertLines(work: Work, edit: Json, axis: "row" | "column") {
  const sheet = sheetOf(work, edit.sheet);
  const count = num(edit.count, "count", 1, 5_000);
  const side = str(edit.side, "side");
  let beside: number;
  if (axis === "row") {
    beside = num(edit.besideRow, "besideRow", 1, sheet.rowCount) - 1;
    if (side !== "above" && side !== "below") refuse("notRead", "side must be above or below.");
  } else {
    beside = asColumns(edit.besideColumn, "besideColumn").start;
    if (beside >= sheet.columnCount)
      refuse("outsideTheSheet", `${sheet.name} has no column ${String(edit.besideColumn)}.`);
    if (side !== "left" && side !== "right") refuse("notRead", "side must be left or right.");
  }
  const at = side === "above" || side === "left" ? beside : beside + 1;
  const besideAfter = beside >= at ? beside + count : beside;
  changeAxis(work, sheet, axis, { kind: "insert", at, count });
  if (axis === "row") sheet.rowCount += count;
  else sheet.columnCount += count;
  // New lines look as the line beside them does, with its dropdowns and checkboxes (rows only).
  for (const cell of [...sheet.cells.values()]) {
    if ((axis === "row" ? cell.r : cell.c) !== besideAfter || !cell.s) continue;
    for (let i = 0; i < count; i++) {
      const index = at + i;
      const r = axis === "row" ? index : cell.r;
      const c = axis === "row" ? cell.c : index;
      sheet.cells.set(key(r, c), { r, c, v: null, s: cell.s });
    }
  }
  if (axis === "row") {
    const span = { start: at, end: at + count - 1 };
    const grow = (range: SheetRange) =>
      besideAfter >= range.r0 && besideAfter <= range.r1
        ? { ...range, r0: Math.min(range.r0, span.start), r1: Math.max(range.r1, span.end) }
        : range;
    if (sheet.meta.dropdowns)
      sheet.meta.dropdowns = dropdownsOf(sheet).map((d) => ({ ...d, ranges: d.ranges.map(grow) }));
    if (sheet.meta.checkboxes) {
      sheet.meta.checkboxes = (sheet.meta.checkboxes as SheetRange[]).map(grow);
      for (const range of sheet.meta.checkboxes as SheetRange[])
        for (let r = span.start; r <= span.end; r++)
          for (let c = range.c0; c <= range.c1; c++)
            if (rangeContains(range, r, c))
              sheet.cells.set(key(r, c), {
                ...(sheet.cells.get(key(r, c)) ?? { r, c }),
                r,
                c,
                v: false,
              });
    }
  }
}

function deleteLines(work: Work, edit: Json, axis: "row" | "column") {
  const sheet = sheetOf(work, edit.sheet);
  const span = axis === "row" ? asRows(edit.rows, "rows") : asColumns(edit.columns, "columns");
  const total = axis === "row" ? sheet.rowCount : sheet.columnCount;
  if (span.end >= total)
    refuse("outsideTheSheet", `${sheet.name} has ${total} ${axis === "row" ? "rows" : "columns"}.`);
  if (span.end - span.start + 1 >= total)
    refuse("sheetNeedsALine", `A sheet keeps at least one ${axis}.`);
  changeAxis(work, sheet, axis, { kind: "delete", start: span.start, end: span.end });
  if (axis === "row") sheet.rowCount -= span.end - span.start + 1;
  else sheet.columnCount -= span.end - span.start + 1;
}

function moveLines(work: Work, edit: Json, axis: "row" | "column") {
  const sheet = sheetOf(work, edit.sheet);
  const span = axis === "row" ? asRows(edit.rows, "rows") : asColumns(edit.columns, "columns");
  const afterRaw = axis === "row" ? edit.afterRow : edit.afterColumn;
  const after =
    afterRaw === null
      ? -1
      : axis === "row"
        ? num(afterRaw, "afterRow", 1, sheet.rowCount) - 1
        : asColumns(afterRaw, "afterColumn").start;
  if (after >= span.start && after <= span.end)
    refuse("notRead", "A line can't move to after itself.");
  for (const merge of (sheet.meta.merges as SheetRange[] | undefined) ?? []) {
    const [a, b] = axis === "row" ? [merge.r0, merge.r1] : [merge.c0, merge.c1];
    if ((a < span.start && b >= span.start) || (a <= span.end && b > span.end))
      refuse(
        "wouldSplitMerge",
        `The move would split the merged range ${formatSheetRange(merge)}.`,
      );
  }
  const n = span.end - span.start + 1;
  const map = (i: number) => {
    if (after < span.start) {
      // Moving up: the lines land right after `after`.
      if (i >= span.start && i <= span.end) return after + 1 + (i - span.start);
      if (i > after && i < span.start) return i + n;
      return i;
    }
    if (i >= span.start && i <= span.end) return after - n + 1 + (i - span.start);
    if (i > span.end && i <= after) return i - n;
    return i;
  };
  changeAxis(work, sheet, axis, { kind: "move", map });
}

function sortRows(work: Work, edit: Json, wholeRows: boolean) {
  const sheet = sheetOf(work, edit.sheet);
  const direction = str(edit.direction, "direction");
  if (direction !== "ascending" && direction !== "descending")
    refuse("notRead", "direction must be ascending or descending.");
  const byColumn = asColumns(edit.byColumn, "byColumn").start;
  let block: SheetRange;
  if (wholeRows) {
    const rows = asRows(edit.rows, "rows");
    block = { r0: rows.start, r1: rows.end, c0: 0, c1: sheet.columnCount - 1 };
  } else {
    block = asRange(edit.range, "range");
    if (byColumn < block.c0 || byColumn > block.c1)
      refuse("notRead", `byColumn ${String(edit.byColumn)} is not one of the range's columns.`);
  }
  insideSheet(sheet, block, "rows");
  sortBlock(work, sheet, block, byColumn, direction, wholeRows);
}

function groupLines(work: Work, edit: Json, axis: "row" | "column", group: boolean) {
  const sheet = sheetOf(work, edit.sheet);
  if (!Array.isArray(edit.groups) || edit.groups.length === 0)
    refuse("notRead", "groups must list at least one group.");
  const field = axis === "row" ? "rowGroups" : "columnGroups";
  let groups = [...((sheet.meta[field] as SheetGroup[] | undefined) ?? [])];
  for (const [i, raw] of edit.groups.entries()) {
    let span: { start: number; end: number };
    let collapsed = false;
    if (group) {
      const entry = obj(raw, `groups[${i}]`);
      keys(entry, `groups[${i}]`, [axis === "row" ? "rows" : "columns", "isCollapsed"]);
      span =
        axis === "row"
          ? asRows(entry.rows, `groups[${i}].rows`)
          : asColumns(entry.columns, `groups[${i}].columns`);
      collapsed = entry.isCollapsed === true;
      const same = groups.findIndex((g) => g.start === span.start && g.end === span.end);
      if (same >= 0) groups[same] = { ...span, collapsed };
      else {
        const clash = groups.find((g) =>
          g.start < span.start
            ? g.end >= span.start && g.end < span.end
            : span.start < g.start && span.end >= g.start && span.end < g.end,
        );
        if (clash) refuse("groupsOverlap", "Groups nest but never partly overlap.");
        groups.push({ ...span, collapsed });
      }
    } else {
      span = axis === "row" ? asRows(raw, `groups[${i}]`) : asColumns(raw, `groups[${i}]`);
      const before = groups.length;
      groups = groups.filter((g) => !(g.start === span.start && g.end === span.end));
      if (groups.length === before) refuse("groupNotFound", `No group covers just ${String(raw)}.`);
    }
  }
  if (groups.length) sheet.meta[field] = groups;
  else delete sheet.meta[field];
}

function setSheetSettings(work: Work, edit: Json) {
  const sheet = sheetOf(work, edit.sheet);
  const settings = obj(edit.settings, "settings");
  keys(settings, "settings", [], ["lastFrozenRow", "lastFrozenColumn", "areGridlinesHidden"]);
  if (settings.lastFrozenRow !== undefined) {
    if (settings.lastFrozenRow === null) delete sheet.meta.frozenRows;
    else sheet.meta.frozenRows = num(settings.lastFrozenRow, "settings.lastFrozenRow", 1, 999);
  }
  if (settings.lastFrozenColumn !== undefined) {
    if (settings.lastFrozenColumn === null) delete sheet.meta.frozenColumns;
    else
      sheet.meta.frozenColumns =
        asColumns(settings.lastFrozenColumn, "settings.lastFrozenColumn").start + 1;
  }
  if (settings.areGridlinesHidden !== undefined) {
    if (typeof settings.areGridlinesHidden !== "boolean")
      refuse("notRead", "settings.areGridlinesHidden must be true or false.");
    if (settings.areGridlinesHidden) sheet.meta.gridlinesHidden = true;
    else delete sheet.meta.gridlinesHidden;
  }
}

function readOptions(
  raw: unknown,
  withIds: boolean,
): { id: string | null; label: string; color?: string }[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SHEET_DATA_LIMITS.dropdownOptions)
    refuse("notRead", "options must list 1 to 100 options.");
  const labels = new Set<string>();
  return raw.map((item, i) => {
    const option = obj(item, `options[${i}]`);
    keys(option, `options[${i}]`, withIds ? ["optionId", "label", "color"] : ["label", "color"]);
    const label = str(option.label, `options[${i}].label`).trim();
    if (!label || label.length > 100)
      refuse("notRead", `options[${i}].label must be 1 to 100 characters.`);
    if (labels.has(label.toLowerCase()))
      refuse("optionsRepeat", `Two options are called "${label}".`);
    labels.add(label.toLowerCase());
    const color = standardSheetColor(option.color, `options[${i}].color`);
    return {
      id:
        withIds && option.optionId !== null ? str(option.optionId, `options[${i}].optionId`) : null,
      label,
      ...(color ? { color } : {}),
    };
  });
}

function makeDropdown(work: Work, edit: Json) {
  const sheet = sheetOf(work, edit.sheet);
  const range = asRange(edit.range, "range");
  insideSheet(sheet, range, "range");
  const options = readOptions(edit.options, false);
  if (dropdownsOf(sheet).length >= SHEET_DATA_LIMITS.dropdowns)
    refuse("tooManyDropdowns", "A sheet holds at most 500 dropdowns.");
  checkDropdownCells(
    sheet,
    range,
    options.map((o) => o.label),
  );
  removeControls(sheet, range);
  const id = newId("ddn");
  sheet.meta.dropdowns = [
    ...dropdownsOf(sheet),
    {
      id,
      ranges: [range],
      options: options.map((o, i) => ({
        id: `opt_${id.slice(4)}_${i}`,
        label: o.label,
        ...(o.color ? { color: o.color } : {}),
      })),
    },
  ];
}

function setDropdownOptions(work: Work, edit: Json) {
  const sheet = sheetOf(work, edit.sheet);
  const id = str(edit.dropdownId, "dropdownId");
  const dropdown = dropdownsOf(sheet).find((d) => d.id === id);
  if (!dropdown)
    refuse("dropdownNotFound", `This sheet has no dropdown ${id}. readCells lists dropdowns.`);
  const options = readOptions(edit.options, true);
  const renamed = new Map<string, string>();
  const next = options.map((o, i) => {
    if (o.id !== null) {
      const old = dropdown.options.find((x) => x.id === o.id);
      if (!old)
        refuse("optionNotFound", `The dropdown has no option ${o.id}. Send null for a new option.`);
      if (old.label !== o.label) renamed.set(old.label.toLowerCase(), o.label);
      return { id: o.id, label: o.label, ...(o.color ? { color: o.color } : {}) };
    }
    return {
      id: `opt_${id.slice(4)}_${Date.now().toString(36)}${i}`,
      label: o.label,
      ...(o.color ? { color: o.color } : {}),
    };
  });
  const kept = new Set(next.map((o) => o.label.toLowerCase()));
  for (const range of dropdown.ranges)
    eachCell(range, (r, c) => {
      const cell = sheet.cells.get(key(r, c));
      if (!cell || typeof cell.v !== "string") return;
      const to = renamed.get(cell.v.toLowerCase());
      if (to) cell.v = to;
      else if (!kept.has(cell.v.toLowerCase()))
        refuse(
          "optionInUse",
          `${cellAddress(r, c)} holds "${cell.v}", so that option can't go. Write another option there first.`,
          cellAddress(r, c),
        );
    });
  sheet.meta.dropdowns = dropdownsOf(sheet).map((d) => (d.id === id ? { ...d, options: next } : d));
}

function setCellTable(work: Work, edit: Json) {
  const sheet = sheetOf(work, edit.sheet);
  if (edit.cellTable === null) {
    delete sheet.meta.table;
    return;
  }
  const table = obj(edit.cellTable, "cellTable");
  keys(table, "cellTable", ["columns", "headerRows", "footerRows"]);
  const columns = asColumns(table.columns, "cellTable.columns");
  const header = asRows(table.headerRows, "cellTable.headerRows");
  const footer =
    table.footerRows === null ? null : asRows(table.footerRows, "cellTable.footerRows");
  if (footer && footer.start <= header.end)
    refuse("notRead", "cellTable.footerRows must lie under the header.");
  sheet.meta.table = {
    c0: columns.start,
    c1: columns.end,
    headerR0: header.start,
    headerR1: header.end,
    ...(footer ? { footerR0: footer.start, footerR1: footer.end } : {}),
  };
}

function readRuleOperand(raw: unknown, where: string): SheetRuleOperand {
  const o = obj(raw, where);
  if (o.kind === "number")
    return { kind: "number", number: num(o.number, `${where}.number`, -1e300, 1e300, false) };
  if (o.kind === "daysFromToday")
    return { kind: "daysFromToday", days: num(o.days, `${where}.days`, -100_000, 100_000) };
  if (o.kind === "sameRowInColumn")
    return { kind: "sameRowInColumn", c: asColumns(o.c, `${where}.c`).start };
  return refuse(
    "conditionalFormatNotRead",
    `${where}.kind must be number, daysFromToday or sameRowInColumn.`,
  );
}
function readRule(raw: unknown, where: string, sheet: WorkSheet): SheetRule {
  const rule = obj(raw, where);
  keys(rule, where, ["cells", "effect"]);
  if (!Array.isArray(rule.cells) || rule.cells.length < 1 || rule.cells.length > 20)
    refuse("conditionalFormatNotRead", `${where}.cells needs 1 to 20 ranges.`);
  const ranges = rule.cells.map((cells, i) => asRange(cells, `${where}.cells[${i}]`));
  for (const range of ranges) insideSheet(sheet, range, `${where}.cells`);
  const effect = obj(rule.effect, `${where}.effect`);
  const color = (value: unknown, w: string) => standardSheetColor(value, w);
  if (effect.kind === "colorScale") {
    keys(effect, `${where}.effect`, ["kind", "lowest", "middle", "highest"]);
    const stop = (value: unknown, w: string) => {
      const s = obj(value, w);
      keys(s, w, ["anchor", "color"]);
      const a = obj(s.anchor, `${w}.anchor`);
      return { anchor: a as never, color: color(s.color, `${w}.color`) };
    };
    return {
      ranges,
      effect: {
        kind: "colorScale",
        lowest: stop(effect.lowest, `${where}.effect.lowest`),
        middle: effect.middle === null ? null : stop(effect.middle, `${where}.effect.middle`),
        highest: stop(effect.highest, `${where}.effect.highest`),
      },
    };
  }
  if (effect.kind !== "formatWhere")
    refuse("conditionalFormatNotRead", `${where}.effect.kind must be formatWhere or colorScale.`);
  keys(effect, `${where}.effect`, ["kind", "allOf", "format"]);
  if (!Array.isArray(effect.allOf) || effect.allOf.length < 1 || effect.allOf.length > 5)
    refuse("conditionalFormatNotRead", `${where}.effect.allOf needs 1 to 5 tests.`);
  const allOf = effect.allOf.map((rawTest, i) => {
    const w = `${where}.effect.allOf[${i}]`;
    const test = obj(rawTest, w);
    keys(test, w, ["tested", "condition"]);
    const tested = obj(test.tested, `${w}.tested`);
    const condition = obj(test.condition, `${w}.condition`);
    const c = { ...condition } as Json;
    if (condition.kind === "numberIs")
      c.operand = readRuleOperand(condition.operand, `${w}.condition.operand`);
    if (condition.kind === "numberIsBetween" || condition.kind === "numberIsNotBetween") {
      c.oneEnd = readRuleOperand(condition.oneEnd, `${w}.condition.oneEnd`);
      c.otherEnd = readRuleOperand(condition.otherEnd, `${w}.condition.otherEnd`);
    }
    return {
      tested:
        tested.kind === "sameRowInColumn"
          ? { kind: "sameRowInColumn", c: asColumns(tested.c, `${w}.tested.c`).start }
          : { kind: tested.kind },
      condition: c,
    };
  });
  const format = obj(effect.format, `${where}.effect.format`);
  keys(format, `${where}.effect.format`, [], ["fillColor", "font"]);
  const out: Json = {};
  if (format.fillColor !== undefined) {
    const fill = color(format.fillColor, `${where}.effect.format.fillColor`);
    if (fill) out.fill = fill;
  }
  if (format.font !== undefined) {
    const font = obj(format.font, `${where}.effect.format.font`);
    keys(
      font,
      `${where}.effect.format.font`,
      [],
      ["bold", "italic", "underline", "strikethrough", "color"],
    );
    if (typeof font.bold === "boolean") out.bold = font.bold;
    if (typeof font.italic === "boolean") out.italic = font.italic;
    if (typeof font.strikethrough === "boolean") out.strike = font.strikethrough;
    if (font.underline === "single" || font.underline === "double") out.underline = font.underline;
    if (font.color !== undefined) {
      const c = color(font.color, `${where}.effect.format.font.color`);
      if (c) out.color = c;
    }
  }
  return { ranges, effect: { kind: "formatWhere", allOf: allOf as never, format: out } };
}

function replaceRules(work: Work, edit: Json, revisionSheet: Sheet | undefined) {
  const sheet = sheetOf(work, edit.sheet);
  const current = revisionSheet ?? fromWorkSheet(sheet);
  if (str(edit.inPlaceOf, "inPlaceOf") !== sheetRulesFingerprint(current))
    refuse(
      "conditionalFormatsNotAsRead",
      "The rules are not as you read them. Read them again with readConditionalFormats and start from that list.",
    );
  if (!Array.isArray(edit.rules)) refuse("conditionalFormatNotRead", "rules must be a list.");
  const rules = edit.rules.map((rule, i) => readRule(rule, `rules[${i}]`, sheet));
  const total =
    work.sheets.reduce(
      (n, s) =>
        n + (s.id === sheet.id ? 0 : ((s.meta.rules as SheetRule[] | undefined)?.length ?? 0)),
      0,
    ) + rules.length;
  if (total > SHEET_DATA_LIMITS.rules)
    refuse("tooManyConditionalFormats", "A workbook holds at most 500 rules.");
  if (rules.length) sheet.meta.rules = rules;
  else delete sheet.meta.rules;
}

function readChart(
  work: Work,
  raw: unknown,
  previous?: SheetChart,
): { chart: SheetChart; on: WorkSheet } {
  const chart = obj(raw, "chart");
  keys(
    chart,
    "chart",
    ["name", "caption", "kind", "cells", "sheet", "topLeft", "widthInPixels", "heightInPixels"],
    ["offsetFromAnchorCell", "code"],
  );
  if (chart.kind === "custom") {
    if (typeof chart.code !== "string" || !chart.code.trim())
      refuse("notRead", "A custom chart needs code: JavaScript that draws into #chart.");
    if (chart.code.length > SHEET_CHART_CODE_LIMIT)
      refuse("notRead", `chart.code is longer than ${SHEET_CHART_CODE_LIMIT} characters.`);
  } else if (chart.code !== undefined) refuse("notRead", "Only a custom chart takes code.");
  const on = sheetOf(work, chart.sheet, "chart.sheet");
  if (!SHEET_CHART_KINDS.includes(chart.kind as SheetChartKind))
    refuse("notRead", `chart.kind must be one of ${SHEET_CHART_KINDS.join(", ")}.`);
  const cells = obj(chart.cells, "chart.cells");
  keys(cells, "chart.cells", ["sheet", "range"]);
  const source = sheetOf(work, cells.sheet, "chart.cells.sheet");
  const range = asRange(cells.range, "chart.cells.range");
  const corner = asRange(chart.topLeft, "chart.topLeft");
  const offset =
    chart.offsetFromAnchorCell === undefined
      ? previous && previous.anchor.r === corner.r0 && previous.anchor.c === corner.c0
        ? { xInPixels: previous.anchor.dx, yInPixels: previous.anchor.dy }
        : { xInPixels: 0, yInPixels: 0 }
      : obj(chart.offsetFromAnchorCell, "chart.offsetFromAnchorCell");
  return {
    on,
    chart: {
      id: previous?.id ?? newId("cht"),
      name: str(chart.name, "chart.name").slice(0, 200),
      caption: str(chart.caption, "chart.caption").slice(0, 500),
      kind: chart.kind as SheetChartKind,
      ...(chart.kind === "custom" ? { code: chart.code as string } : {}),
      source: { sheetId: source.id, range },
      anchor: {
        r: corner.r0,
        c: corner.c0,
        dx: num(offset.xInPixels ?? 0, "offsetFromAnchorCell.xInPixels", 0, 2_000),
        dy: num(offset.yInPixels ?? 0, "offsetFromAnchorCell.yInPixels", 0, 2_000),
      },
      width: num(chart.widthInPixels, "chart.widthInPixels", 40, 4_000),
      height: num(chart.heightInPixels, "chart.heightInPixels", 40, 4_000),
    },
  };
}
function findChart(work: Work, id: unknown): { sheet: WorkSheet; chart: SheetChart } {
  const wanted = str(id, "chartId");
  for (const sheet of work.sheets) {
    const chart = (sheet.meta.charts as SheetChart[] | undefined)?.find((c) => c.id === wanted);
    if (chart) return { sheet, chart };
  }
  return refuse("chartNotFound", `No chart has the id ${wanted}. readCharts lists them.`);
}

function applyEdit(work: Work, edit: Json, original: SheetWorkbook) {
  const kind = edit.kind as EditKind;
  if (typeof kind !== "string" || !(kind in SHEET_EDIT_KINDS))
    refuse(
      "kindNotKnown",
      `"${String(edit.kind)}" is no edit kind. The kinds are ${Object.keys(SHEET_EDIT_KINDS).join(", ")}.`,
    );
  const fields = SHEET_EDIT_KINDS[kind] as readonly string[];
  keys(
    edit,
    `the ${kind} edit`,
    ["kind", ...fields.filter((f) => !f.endsWith("?"))],
    fields.filter((f) => f.endsWith("?")).map((f) => f.slice(0, -1)),
  );
  switch (kind) {
    case "writeCells":
      return writeCells(work, edit);
    case "addSheet": {
      if (work.sheets.length >= SHEET_DATA_LIMITS.sheets)
        refuse("tooManySheets", `A workbook holds at most ${SHEET_DATA_LIMITS.sheets} sheets.`);
      const name = validSheetName(work, edit.name);
      let id = `sheet${work.sheets.length + work.deleted.length + 1}`;
      while (work.sheets.some((s) => s.id === id) || work.deleted.some((s) => s.id === id))
        id = newId("sht");
      work.sheets.push({ id, name, cells: new Map(), meta: {}, rowCount: 1000, columnCount: 26 });
      return;
    }
    case "renameSheet": {
      const sheet = sheetOf(work, edit.sheet);
      const name = validSheetName(work, edit.name, sheet);
      for (const other of work.sheets)
        for (const cell of other.cells.values())
          if (cell.f) cell.f = renameSheetInFormula(cell.f, sheet.name, name);
      sheet.name = name;
      return;
    }
    case "deleteSheet": {
      const sheet = sheetOf(work, edit.sheet);
      if (work.sheets.length === 1)
        refuse("onlySheet", "This is the only sheet, so it can't be deleted. Add a sheet first.");
      work.sheets = work.sheets.filter((s) => s !== sheet);
      work.deleted.push(fromWorkSheet(sheet));
      for (const other of work.sheets) {
        const charts = (other.meta.charts as SheetChart[] | undefined)?.filter(
          (c) => c.source.sheetId !== sheet.id,
        );
        if (charts) other.meta.charts = charts;
      }
      return;
    }
    case "restoreSheet": {
      const wanted = str(edit.sheet, "sheet").trim().toLowerCase();
      const at = work.deleted.findLastIndex((s) => s.name.toLowerCase() === wanted);
      if (at < 0) refuse("sheetNotFound", `No deleted sheet is called "${String(edit.sheet)}".`);
      const back = toWorkSheet(work.deleted[at]!);
      back.name = edit.name === undefined ? back.name : str(edit.name, "name").trim();
      if (work.sheets.some((s) => s.name.toLowerCase() === back.name.toLowerCase()))
        refuse(
          "sheetNameTaken",
          `Another sheet is called "${back.name}" by now. Give the restored sheet another name.`,
        );
      while (work.sheets.some((s) => s.id === back.id)) back.id = newId("sht");
      work.deleted.splice(at, 1);
      work.sheets.push(back);
      return;
    }
    case "moveSheets": {
      if (!Array.isArray(edit.sheets) || edit.sheets.length === 0)
        refuse("notRead", "sheets must list at least one sheet.");
      const moving = edit.sheets.map((name, i) => sheetOf(work, name, `sheets[${i}]`));
      if (new Set(moving).size !== moving.length) refuse("notRead", "sheets names a sheet twice.");
      const after = edit.afterSheet === null ? null : sheetOf(work, edit.afterSheet, "afterSheet");
      if (after && moving.includes(after))
        refuse("notRead", "afterSheet can't be one of the sheets that move.");
      const rest = work.sheets.filter((s) => !moving.includes(s));
      const at = after ? rest.indexOf(after) + 1 : 0;
      work.sheets = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
      return;
    }
    case "formatCells":
      return formatCells(work, edit);
    case "setBorders":
      return setBorders(work, edit);
    case "mergeCells":
      return mergeCells(work, edit, true);
    case "unmergeCells":
      return mergeCells(work, edit, false);
    case "setColumnWidths": {
      const sheet = sheetOf(work, edit.sheet);
      const span = asColumns(edit.columns, "columns");
      const width = num(edit.widthInPixels, "widthInPixels", 8, 2_000);
      const widths = { ...((sheet.meta.columnWidths as Record<string, number>) ?? {}) };
      for (let c = span.start; c <= span.end; c++) widths[String(c)] = width;
      sheet.meta.columnWidths = widths;
      return;
    }
    case "fitColumns": {
      const sheet = sheetOf(work, edit.sheet);
      const span = asColumns(edit.columns, "columns");
      const widths = { ...((sheet.meta.columnWidths as Record<string, number>) ?? {}) };
      const merges = (sheet.meta.merges as SheetRange[] | undefined) ?? [];
      for (let c = span.start; c <= span.end; c++) {
        let need = 0;
        for (const cell of sheet.cells.values()) {
          if (cell.c !== c || cell.v === null) continue;
          if (merges.some((m) => rangeContains(m, cell.r, cell.c) && m.c1 > m.c0)) continue;
          const shown = displayText(cell);
          const lines = cell.s?.wrap ? [] : shown.split("\n");
          for (const line of lines)
            need = Math.max(need, Math.min(360, textWidth(line, cell.s?.size)));
          if (dropdownAt(sheet, cell.r, cell.c)) need = Math.max(need, textWidth(shown) + 28);
        }
        if (need > 0) widths[String(c)] = Math.max(32, Math.ceil(need + 16));
      }
      sheet.meta.columnWidths = widths;
      return;
    }
    case "setRowHeights": {
      const sheet = sheetOf(work, edit.sheet);
      const span = asRows(edit.rows, "rows");
      const heights = { ...((sheet.meta.rowHeights as Record<string, number>) ?? {}) };
      const height =
        edit.heightInPixels === null ? null : num(edit.heightInPixels, "heightInPixels", 8, 2_000);
      for (let r = span.start; r <= span.end; r++) {
        if (height === null) delete heights[String(r)];
        else heights[String(r)] = height;
      }
      if (Object.keys(heights).length) sheet.meta.rowHeights = heights;
      else delete sheet.meta.rowHeights;
      return;
    }
    case "insertRows":
      return insertLines(work, edit, "row");
    case "insertColumns":
      return insertLines(work, edit, "column");
    case "deleteRows":
      return deleteLines(work, edit, "row");
    case "deleteColumns":
      return deleteLines(work, edit, "column");
    case "moveRows":
      return moveLines(work, edit, "row");
    case "moveColumns":
      return moveLines(work, edit, "column");
    case "sortRows":
      return sortRows(work, edit, true);
    case "sortCells":
      return sortRows(work, edit, false);
    case "groupRows":
      return groupLines(work, edit, "row", true);
    case "groupColumns":
      return groupLines(work, edit, "column", true);
    case "ungroupRows":
      return groupLines(work, edit, "row", false);
    case "ungroupColumns":
      return groupLines(work, edit, "column", false);
    case "setSheetSettings":
      return setSheetSettings(work, edit);
    case "makeDropdown":
      return makeDropdown(work, edit);
    case "setDropdownOptions":
      return setDropdownOptions(work, edit);
    case "setCellTable":
      return setCellTable(work, edit);
    case "replaceConditionalFormats": {
      const name = str(edit.sheet, "sheet").toLowerCase();
      return replaceRules(
        work,
        edit,
        original.sheets.find((s) => s.name.toLowerCase() === name),
      );
    }
    case "addChart": {
      const { chart, on } = readChart(work, edit.chart);
      const all = work.sheets.reduce(
        (n, s) => n + ((s.meta.charts as SheetChart[] | undefined)?.length ?? 0),
        0,
      );
      if (all >= SHEET_DATA_LIMITS.charts)
        refuse("tooManyCharts", "A workbook holds at most 200 charts.");
      on.meta.charts = [...((on.meta.charts as SheetChart[] | undefined) ?? []), chart];
      return;
    }
    case "setChart": {
      const found = findChart(work, edit.chartId);
      const { chart, on } = readChart(work, edit.chart, found.chart);
      found.sheet.meta.charts = (found.sheet.meta.charts as SheetChart[]).filter(
        (c) => c.id !== found.chart.id,
      );
      on.meta.charts = [...((on.meta.charts as SheetChart[] | undefined) ?? []), chart];
      return;
    }
    case "deleteChart": {
      const found = findChart(work, edit.chartId);
      const rest = (found.sheet.meta.charts as SheetChart[]).filter((c) => c.id !== found.chart.id);
      if (rest.length) found.sheet.meta.charts = rest;
      else delete found.sheet.meta.charts;
      return;
    }
    case "setLocale": {
      if (!isSheetLocale(edit.locale))
        refuse("notRead", `locale must be one of ${Object.keys(SHEET_LOCALES).join(", ")}.`);
      work.locale = edit.locale === "zh-CN" ? undefined : edit.locale;
      return;
    }
    case "setTimeZone": {
      if (edit.timeZone !== null && !isSheetTimeZone(edit.timeZone))
        refuse("notRead", "timeZone must be an IANA time zone such as Asia/Shanghai, or null.");
      const next = edit.timeZone === null ? undefined : (edit.timeZone as string);
      work.timeZone = next;
      return;
    }
  }
}

export interface SheetEditsResult {
  readonly workbook: SheetWorkbook;
  /** Indices of edits of looks or layout that changed nothing. */
  readonly changedNothing: number[];
  /** The ids of charts and dropdowns the edits made, in order. */
  readonly made: {
    readonly editIndex: number;
    readonly kind: "chart" | "dropdown";
    readonly id: string;
  }[];
}

/**
 * Makes `edits` in order, each on what the ones before it left. All land or none does: a
 * refusal names the edit (`editIndex`) and why. Formula results are worked out afterwards.
 */
export function applySheetEdits(workbook: SheetWorkbook, rawEdits: unknown): SheetEditsResult {
  if (!Array.isArray(rawEdits) || rawEdits.length === 0)
    refuse("notRead", "edits must list at least one edit.");
  if (rawEdits.length > MAX_EDITS)
    refuse(
      "tooManyEdits",
      `One update holds at most ${MAX_EDITS} edits. Send the rest in another update.`,
    );
  const work = toWork(workbook);
  const changedNothing: number[] = [];
  const made: { editIndex: number; kind: "chart" | "dropdown"; id: string }[] = [];
  const LOOKS = new Set([
    "formatCells",
    "setBorders",
    "setColumnWidths",
    "fitColumns",
    "setRowHeights",
    "setSheetSettings",
    "mergeCells",
    "unmergeCells",
    "groupRows",
    "groupColumns",
    "ungroupRows",
    "ungroupColumns",
    "setCellTable",
  ]);
  const snapshot = (raw: unknown) => {
    const edit = raw as Json;
    if (!LOOKS.has(String(edit?.kind)) || typeof edit.sheet !== "string") return null;
    const sheet = work.sheets.find(
      (s) => s.name.toLowerCase() === String(edit.sheet).trim().toLowerCase(),
    );
    return sheet ? JSON.stringify(fromWorkSheet(sheet)) : null;
  };
  for (const [i, raw] of rawEdits.entries()) {
    const before = snapshot(raw);
    const charts = new Set(
      work.sheets.flatMap((s) =>
        ((s.meta.charts as SheetChart[] | undefined) ?? []).map((c) => c.id),
      ),
    );
    const dropdowns = new Set(work.sheets.flatMap((s) => dropdownsOf(s).map((d) => d.id)));
    try {
      applyEdit(work, obj(raw, `edits[${i}]`), workbook);
    } catch (cause) {
      if (cause instanceof SheetEditRefusal)
        throw new SheetEditRefusal(cause.refusal, cause.detail, i, cause.address);
      throw cause;
    }
    if (work.written > MAX_CELLS_WRITTEN)
      throw new SheetEditRefusal(
        "editTooLarge",
        `That update writes more than ${MAX_CELLS_WRITTEN.toLocaleString("en-US")} cells. Send it in parts, from the top.`,
        i,
      );
    if (before !== null && snapshot(raw) === before) changedNothing.push(i);
    for (const s of work.sheets) {
      for (const c of (s.meta.charts as SheetChart[] | undefined) ?? [])
        if (!charts.has(c.id)) made.push({ editIndex: i, kind: "chart", id: c.id });
      for (const d of dropdownsOf(s))
        if (!dropdowns.has(d.id)) made.push({ editIndex: i, kind: "dropdown", id: d.id });
    }
  }
  if (changedNothing.length === rawEdits.length)
    throw new SheetEditRefusal(
      "nothingToChange",
      "None of these edits would change anything.",
      null,
    );
  const next = fromWork(work);
  let parsed: SheetWorkbook;
  try {
    parsed = parseSheetWorkbook(computeWorkbookFormulas(next));
  } catch (cause) {
    throw new SheetEditRefusal(
      "workbookTooLarge",
      cause instanceof Error ? cause.message : "The workbook would be invalid.",
      null,
    );
  }
  return { workbook: parsed, changedNothing, made };
}
