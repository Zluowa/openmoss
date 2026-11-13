// FILE: sheetWorkbook.ts
// Purpose: The 电子表格 (kind `sheet`) document: sheets of sparse cells with values, formulas
//          and styling, plus each sheet's layout (sizes, freeze, merges, dropdowns, checkboxes,
//          a declared table, conditional formats, charts); A1 addressing; range read/write;
//          the standard colour palette; and the text projection.
// Layer: Shared model (server validates and serves agent sheet tools; web maps it to the
//        spreadsheet engine and to xlsx/csv)
// Why: The stored shape is engine-neutral so the engine can be replaced without migrating rows,
//      and so agents can read and write on the server without a browser. Every field past the
//      first version is optional, so older rows still parse.

export const SHEET_DATA_LIMITS = {
  bytes: 2_000_000,
  sheets: 200,
  cells: 100_000,
  rows: 1_048_576,
  columns: 16_384,
  merges: 5_000,
  dropdowns: 500,
  dropdownOptions: 100,
  rules: 500,
  charts: 200,
  deletedSheets: 20,
} as const;

export type SheetScalar = string | number | boolean | null;

export const SHEET_BORDER_STYLES = [
  "thin",
  "medium",
  "thick",
  "dashed",
  "dotted",
  "double",
] as const;
export type SheetBorderStyle = (typeof SHEET_BORDER_STYLES)[number];
export interface SheetBorderLine {
  readonly style: SheetBorderStyle;
  /** #RRGGBB; absent = the sheet's ink. */
  readonly color?: string;
}
export interface SheetCellBorder {
  readonly t?: SheetBorderLine;
  readonly r?: SheetBorderLine;
  readonly b?: SheetBorderLine;
  readonly l?: SheetBorderLine;
}

export interface SheetCellStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: "single" | "double";
  readonly strike?: boolean;
  /** Font size in points, 6–96 (absent = 10). */
  readonly size?: number;
  /** #RRGGBB text color. */
  readonly color?: string;
  /** #RRGGBB fill. */
  readonly fill?: string;
  readonly align?: "left" | "center" | "right";
  readonly valign?: "top" | "middle" | "bottom";
  readonly wrap?: boolean;
  /** Number format code (`0.00`, `0%`, `yyyy-mm-dd`…). */
  readonly format?: string;
  readonly border?: SheetCellBorder;
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
/** A rectangle of cells by zero-based indices, both ends included. */
export interface SheetRange {
  readonly r0: number;
  readonly c0: number;
  readonly r1: number;
  readonly c1: number;
}
export interface SheetDropdownOption {
  readonly id: string;
  readonly label: string;
  /** #RRGGBB pill fill; absent = a plain pill. */
  readonly color?: string;
}
export interface SheetDropdown {
  readonly id: string;
  readonly ranges: readonly SheetRange[];
  readonly options: readonly SheetDropdownOption[];
}
/** The one declared table of a sheet: which columns, which rows name them, which rows total. */
export interface SheetTable {
  readonly c0: number;
  readonly c1: number;
  readonly headerR0: number;
  readonly headerR1: number;
  /** Footer (total) rows, or absent for none. */
  readonly footerR0?: number;
  readonly footerR1?: number;
}
export type SheetRuleTested =
  | { readonly kind: "theCellItself" }
  | { readonly kind: "sameRowInColumn"; readonly c: number };
export type SheetRuleOperand =
  | { readonly kind: "number"; readonly number: number }
  | { readonly kind: "daysFromToday"; readonly days: number }
  | { readonly kind: "sameRowInColumn"; readonly c: number };
export type SheetRuleCondition =
  | { readonly kind: "isBlank" | "isNotBlank" | "isAnError" | "appearsMoreThanOnce" }
  | {
      readonly kind:
        | "textIs"
        | "textIsNot"
        | "textContains"
        | "textDoesNotContain"
        | "textStartsWith"
        | "textEndsWith";
      readonly text: string;
    }
  | { readonly kind: "booleanIs"; readonly value: boolean }
  | {
      readonly kind: "numberIs";
      readonly comparison:
        | "equalTo"
        | "notEqualTo"
        | "greaterThan"
        | "greaterThanOrEqualTo"
        | "lessThan"
        | "lessThanOrEqualTo";
      readonly operand: SheetRuleOperand;
    }
  | {
      readonly kind: "numberIsBetween" | "numberIsNotBetween";
      readonly oneEnd: SheetRuleOperand;
      readonly otherEnd: SheetRuleOperand;
    }
  | { readonly kind: "isAmongTheLargest" | "isAmongTheSmallest"; readonly count: number };
export interface SheetRuleFormat {
  readonly fill?: string;
  readonly color?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strike?: boolean;
  readonly underline?: "single" | "double";
}
export type SheetRuleAnchor =
  | { readonly kind: "smallestNumber" }
  | { readonly kind: "largestNumber" }
  | { readonly kind: "number"; readonly number: number }
  | { readonly kind: "percentile"; readonly percentile: number };
export interface SheetColorStop {
  readonly anchor: SheetRuleAnchor;
  /** #RRGGBB, or null for no colour. */
  readonly color: string | null;
}
export type SheetRuleEffect =
  | {
      readonly kind: "formatWhere";
      readonly allOf: readonly {
        readonly tested: SheetRuleTested;
        readonly condition: SheetRuleCondition;
      }[];
      readonly format: SheetRuleFormat;
    }
  | {
      readonly kind: "colorScale";
      readonly lowest: SheetColorStop;
      readonly middle: SheetColorStop | null;
      readonly highest: SheetColorStop;
    };
export interface SheetRule {
  readonly ranges: readonly SheetRange[];
  readonly effect: SheetRuleEffect;
}
/** Charts Moss draws itself, and "custom": a chart drawn by code an agent wrote. */
export const SHEET_CHART_KINDS = ["bar", "stackedBar", "line", "pie", "custom"] as const;
/** The longest code a custom chart keeps. */
export const SHEET_CHART_CODE_LIMIT = 60_000;
export type SheetChartKind = (typeof SHEET_CHART_KINDS)[number];
export interface SheetChart {
  readonly id: string;
  readonly name: string;
  readonly caption: string;
  readonly kind: SheetChartKind;
  /** The cells the chart draws: first row = series names, first column = labels. */
  readonly source: { readonly sheetId: string; readonly range: SheetRange };
  /** The cell the chart's top-left corner hangs from, and how far inside it. */
  readonly anchor: {
    readonly r: number;
    readonly c: number;
    readonly dx: number;
    readonly dy: number;
  };
  readonly width: number;
  readonly height: number;
  /**
   * For a "custom" chart: JavaScript that draws into #chart from `window.MOSS_CHART` (its cells,
   * size and colours). It runs in a sandboxed frame that can reach nothing outside it.
   */
  readonly code?: string;
}
export interface SheetGroup {
  readonly start: number;
  readonly end: number;
  readonly collapsed: boolean;
}
export interface Sheet {
  readonly id: string;
  readonly name: string;
  readonly cells: readonly SheetCell[];
  readonly columnWidths?: Readonly<Record<string, number>>;
  readonly rowHeights?: Readonly<Record<string, number>>;
  /** Rows kept in view from the top (1 = the first row). */
  readonly frozenRows?: number;
  readonly frozenColumns?: number;
  readonly gridlinesHidden?: boolean;
  /** Row / column count of the grid (absent = 1000 × 26, or what the cells need). */
  readonly rowCount?: number;
  readonly columnCount?: number;
  readonly merges?: readonly SheetRange[];
  readonly dropdowns?: readonly SheetDropdown[];
  readonly checkboxes?: readonly SheetRange[];
  readonly table?: SheetTable;
  readonly rules?: readonly SheetRule[];
  readonly charts?: readonly SheetChart[];
  readonly rowGroups?: readonly SheetGroup[];
  readonly columnGroups?: readonly SheetGroup[];
  /** Results that spilled out of one formula cell into the cells beside and below it. */
  readonly spills?: readonly SheetSpill[];
}

/**
 * A formula whose answer is a block of values (FILTER, SORT, UNIQUE, SEQUENCE …) shows its
 * first value in its own cell and the rest in the cells right and below. The cells it wrote
 * are listed so the next working-out knows which cells are the spill's and which are a
 * person's (a person's value in the way makes the formula #SPILL!).
 */
export interface SheetSpill {
  /** The formula's cell. */
  readonly r: number;
  readonly c: number;
  /** The cells the spill wrote, as [row, column, value]. */
  readonly cells: readonly (readonly [number, number, SheetScalar])[];
}
export interface SheetWorkbook {
  readonly version: 1;
  readonly sheets: readonly Sheet[];
  /** Deleted sheets, newest last, so a delete can be taken back. */
  readonly deletedSheets?: readonly Sheet[];
  /** How numbers are written for everyone (1,234.5 or 1.234,5); absent means zh-CN. */
  readonly locale?: SheetLocale;
  /** The IANA time zone TODAY and NOW use for everyone; absent means the viewer's own. */
  readonly timeZone?: string;
}

/** The locales a sheet can be written in, with how each writes 1234.5. */
export const SHEET_LOCALES = {
  "zh-CN": { label: "中文（中国）", sample: "1,234.5" },
  "en-US": { label: "English (US)", sample: "1,234.5" },
  "en-GB": { label: "English (UK)", sample: "1,234.5" },
  "ja-JP": { label: "日本語", sample: "1,234.5" },
  "de-DE": { label: "Deutsch", sample: "1.234,5" },
  "es-ES": { label: "Español", sample: "1.234,5" },
  "it-IT": { label: "Italiano", sample: "1.234,5" },
  "pt-BR": { label: "Português (Brasil)", sample: "1.234,5" },
  "fr-FR": { label: "Français", sample: "1\u202f234,5" },
  "ru-RU": { label: "Русский", sample: "1\u00a0234,5" },
} as const;
export type SheetLocale = keyof typeof SHEET_LOCALES;
export const isSheetLocale = (value: unknown): value is SheetLocale =>
  typeof value === "string" && Object.hasOwn(SHEET_LOCALES, value);

/** True for a time zone the platform knows, such as "Asia/Shanghai". */
export function isSheetTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * A number as the sheet's locale writes it: the US-style text a format gives, with the decimal
 * and thousands marks of that locale. Dates written yyyy-mm-dd and times stay as they are.
 */
export function localizeNumberText(text: string, locale: SheetLocale | undefined): string {
  if (!locale) return text;
  text = localizeMonthNames(text, locale);
  const sample = SHEET_LOCALES[locale].sample;
  if (sample === "1,234.5") return text;
  // The mark between "1" and "234" in the sample: ".", a narrow or a no-break space.
  const thousands = sample.charAt(1) || ".";
  if (/^\d{4}-\d{2}-\d{2}/u.test(text) || /^\d{1,2}:\d{2}/u.test(text)) return text;
  // Swap the two marks through a stand-in, then put the locale's thousands mark in.
  return text
    .replace(/[,.]/gu, (mark) => (mark === "," ? "\u0001" : ","))
    .replaceAll("\u0001", thousands);
}

const ENGLISH_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const monthNames = new Map<string, { long: string[]; short: string[] }>();
/** "Mar 15, 2026" with the locale's month names (3月15, 2026; 15 mars …); English stays. */
export function localizeMonthNames(text: string, locale: SheetLocale): string {
  if (locale.startsWith("en") || !/[A-Za-z]{3}/u.test(text)) return text;
  let names = monthNames.get(locale);
  if (!names) {
    const name = (month: "long" | "short") =>
      ENGLISH_MONTHS.map((_, i) =>
        new Intl.DateTimeFormat(locale, { month, timeZone: "UTC" }).format(
          new Date(Date.UTC(2026, i, 15)),
        ),
      );
    names = { long: name("long"), short: name("short") };
    monthNames.set(locale, names);
  }
  const found = names;
  return text.replace(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/gu,
    (word) => {
      const long = ENGLISH_MONTHS.indexOf(word);
      if (long >= 0) return found.long[long]!;
      const short = ENGLISH_MONTHS.findIndex((m) => m.startsWith(word.slice(0, 3)));
      return short >= 0 ? found.short[short]! : word;
    },
  );
}

/** Locales that write the day before the month (31/12/2026, 31.12.2026). */
const DAY_FIRST_LOCALES: ReadonlySet<SheetLocale> = new Set([
  "en-GB",
  "de-DE",
  "es-ES",
  "it-IT",
  "pt-BR",
  "fr-FR",
  "ru-RU",
]);

/**
 * A number or date a person typed the locale's way (1.234,5, 1 234,5, 31.12.2026) as the text
 * the cell reader takes (1234.5, 2026-12-31). Anything else comes back as it was.
 */
export function delocalizeNumberText(text: string, locale: SheetLocale | undefined): string {
  if (!locale) return text;
  // Dates: 2026/3/15 anywhere, and 31.12.2026 or 31/12/26 where the day comes first, as ISO.
  const iso = (y: string, m: string, d: string) => {
    const year = y.length === 2 ? (Number(y) < 30 ? 2000 : 1900) + Number(y) : Number(y);
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  };
  const trimmed = text.trim();
  const ymd = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/u.exec(trimmed);
  if (ymd) return iso(ymd[1]!, ymd[2]!, ymd[3]!);
  if (DAY_FIRST_LOCALES.has(locale)) {
    const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/u.exec(trimmed);
    if (dmy) return iso(dmy[3]!, dmy[2]!, dmy[1]!);
  }
  if (SHEET_LOCALES[locale].sample === "1,234.5") return text;
  const match = /^([-+]?[$€£¥₹]?)([\d.\s\u00a0\u202f]+)(?:,(\d+))?(%?)$/u.exec(text.trim());
  if (!match || !/\d/u.test(match[2]!)) return text;
  // 15.03.2026 is a date, not a number with thousands marks.
  if (!match[3] && /^\d{1,2}\.\d{1,2}\.\d{2,4}$/u.test(match[2]!.trim())) return text;
  const whole = match[2]!.replace(/[.\s\u00a0\u202f]/gu, "");
  return `${match[1]}${whole}${match[3] ? `.${match[3]}` : ""}${match[4]}`;
}

export const DEFAULT_SHEET_ROWS = 1000;
export const DEFAULT_SHEET_COLUMNS = 26;
export const DEFAULT_COLUMN_WIDTH = 104;
export const DEFAULT_ROW_HEIGHT = 28;

// ── Standard colours ─────────────────────────────────────────────────────────────────────────
// Moss's own palette: nine hues, six shades from pale (100) to deep (800). Fills under text use
// 100–300; text uses 600. Stored as hex so the engine and Excel read them as they are.
export const SHEET_HUES = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "magenta",
] as const;
export type SheetHue = (typeof SHEET_HUES)[number];
export const SHEET_SHADES = [100, 200, 300, 400, 600, 800] as const;
export type SheetShade = (typeof SHEET_SHADES)[number];
export const SHEET_PALETTE: Readonly<Record<SheetHue, Readonly<Record<SheetShade, string>>>> = {
  gray: {
    100: "#F1F0EE",
    200: "#E3E2DF",
    300: "#CFCDC9",
    400: "#B3B0AA",
    600: "#6F6C66",
    800: "#3B3935",
  },
  red: {
    100: "#FCE9E7",
    200: "#F8D0CC",
    300: "#F1ABA4",
    400: "#E7786D",
    600: "#C2352A",
    800: "#7A1F18",
  },
  orange: {
    100: "#FDEEDF",
    200: "#FAD9B8",
    300: "#F5BB84",
    400: "#EE9446",
    600: "#C25F12",
    800: "#73380B",
  },
  yellow: {
    100: "#FDF6D8",
    200: "#FAEAA8",
    300: "#F5D86A",
    400: "#E9C130",
    600: "#9C7A06",
    800: "#5C4704",
  },
  green: {
    100: "#E5F5E8",
    200: "#C7EACD",
    300: "#9DD8A8",
    400: "#62BE74",
    600: "#2A8540",
    800: "#174D25",
  },
  teal: {
    100: "#E1F4F3",
    200: "#BEE7E4",
    300: "#8DD3CE",
    400: "#4CB5AE",
    600: "#1E7B75",
    800: "#114844",
  },
  blue: {
    100: "#E6F0FC",
    200: "#C9DEF8",
    300: "#A0C4F2",
    400: "#6AA2E9",
    600: "#2A6AC9",
    800: "#173E78",
  },
  purple: {
    100: "#F0EBFB",
    200: "#DED3F6",
    300: "#C5B2EE",
    400: "#A487E3",
    600: "#6B47B8",
    800: "#3E296C",
  },
  magenta: {
    100: "#FBE9F3",
    200: "#F5CFE4",
    300: "#EDA9CF",
    400: "#E073B0",
    600: "#B23A7C",
    800: "#6A2149",
  },
};

const HEX = /^#[0-9A-Fa-f]{6}$/u;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

export class SheetDataError extends Error {
  constructor(message: string) {
    super(`Invalid workbook: ${message}`);
    this.name = "SheetDataError";
  }
}
function fail(message: string): never {
  throw new SheetDataError(message);
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
function hex(value: unknown, where: string): string {
  if (typeof value !== "string" || !HEX.test(value)) fail(`${where} must be #RRGGBB`);
  return value.toUpperCase();
}
function text(value: unknown, where: string, max: number): string {
  if (typeof value !== "string" || value.length > max)
    fail(`${where} must be text of at most ${max} characters`);
  return value;
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
function borderLine(raw: unknown, where: string): SheetBorderLine | undefined {
  if (raw === undefined) return undefined;
  const value = record(raw, where);
  if (!SHEET_BORDER_STYLES.includes(value.style as SheetBorderStyle))
    fail(`${where}.style is invalid`);
  return {
    style: value.style as SheetBorderStyle,
    ...(value.color === undefined ? {} : { color: hex(value.color, `${where}.color`) }),
  };
}
export function parseSheetCellStyle(raw: unknown, where = "style"): SheetCellStyle | undefined {
  if (raw === undefined) return undefined;
  const value = record(raw, where);
  const out: { -readonly [K in keyof SheetCellStyle]: SheetCellStyle[K] } = {};
  if (value.bold === true) out.bold = true;
  if (value.italic === true) out.italic = true;
  if (value.strike === true) out.strike = true;
  if (value.wrap === true) out.wrap = true;
  if (value.underline !== undefined) {
    if (value.underline !== "single" && value.underline !== "double")
      fail(`${where}.underline must be single or double`);
    out.underline = value.underline;
  }
  if (value.size !== undefined) {
    if (!Number.isInteger(value.size) || (value.size as number) < 6 || (value.size as number) > 96)
      fail(`${where}.size must be a whole number from 6 to 96`);
    if (value.size !== 10) out.size = value.size as number;
  }
  for (const key of ["color", "fill"] as const) {
    if (value[key] === undefined) continue;
    out[key] = hex(value[key], `${where}.${key}`);
  }
  if (value.align !== undefined) {
    if (value.align !== "left" && value.align !== "center" && value.align !== "right") {
      fail(`${where}.align must be left, center or right`);
    }
    out.align = value.align;
  }
  if (value.valign !== undefined) {
    if (value.valign !== "top" && value.valign !== "middle" && value.valign !== "bottom")
      fail(`${where}.valign must be top, middle or bottom`);
    if (value.valign !== "top") out.valign = value.valign;
  }
  if (value.format !== undefined) {
    if (typeof value.format !== "string" || value.format.length > 128)
      fail(`${where}.format is invalid`);
    if (value.format !== "General") out.format = value.format;
  }
  if (value.border !== undefined) {
    const border = record(value.border, `${where}.border`);
    const sides: { -readonly [K in keyof SheetCellBorder]: SheetCellBorder[K] } = {};
    for (const side of ["t", "r", "b", "l"] as const) {
      const line = borderLine(border[side], `${where}.border.${side}`);
      if (line) sides[side] = line;
    }
    if (Object.keys(sides).length) out.border = sides;
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
function range(raw: unknown, where: string): SheetRange {
  const value = record(raw, where);
  const r0 = index(value.r0, `${where}.r0`, SHEET_DATA_LIMITS.rows);
  const r1 = index(value.r1, `${where}.r1`, SHEET_DATA_LIMITS.rows);
  const c0 = index(value.c0, `${where}.c0`, SHEET_DATA_LIMITS.columns);
  const c1 = index(value.c1, `${where}.c1`, SHEET_DATA_LIMITS.columns);
  return { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
}
function ranges(raw: unknown, where: string, max: number): SheetRange[] {
  if (!Array.isArray(raw)) fail(`${where} must be an array`);
  if (raw.length > max) fail(`${where} has more than ${max} entries`);
  return raw.map((item, i) => range(item, `${where}[${i}]`));
}
function sizes(raw: unknown, where: string, max: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, size] of Object.entries(record(raw, where))) {
    index(Number(key), `${where} key`, max);
    if (typeof size !== "number" || size < 8 || size > 2_000) fail(`${where} value`);
    out[key] = Math.round(size);
  }
  return out;
}
function groups(raw: unknown, where: string, max: number): SheetGroup[] {
  if (!Array.isArray(raw)) fail(`${where} must be an array`);
  return raw.slice(0, 200).map((item, i) => {
    const g = record(item, `${where}[${i}]`);
    const start = index(g.start, `${where}[${i}].start`, max);
    const end = index(g.end, `${where}[${i}].end`, max);
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
      collapsed: g.collapsed === true,
    };
  });
}
function operand(raw: unknown, where: string): SheetRuleOperand {
  const value = record(raw, where);
  if (value.kind === "number" && typeof value.number === "number" && Number.isFinite(value.number))
    return { kind: "number", number: value.number };
  if (value.kind === "daysFromToday" && Number.isInteger(value.days))
    return { kind: "daysFromToday", days: value.days as number };
  if (value.kind === "sameRowInColumn")
    return { kind: "sameRowInColumn", c: index(value.c, `${where}.c`, SHEET_DATA_LIMITS.columns) };
  return fail(`${where} is not an operand`);
}
const TEXT_CONDITIONS = new Set([
  "textIs",
  "textIsNot",
  "textContains",
  "textDoesNotContain",
  "textStartsWith",
  "textEndsWith",
]);
const COMPARISONS = new Set([
  "equalTo",
  "notEqualTo",
  "greaterThan",
  "greaterThanOrEqualTo",
  "lessThan",
  "lessThanOrEqualTo",
]);
function condition(raw: unknown, where: string): SheetRuleCondition {
  const value = record(raw, where);
  const kind = value.kind;
  if (
    kind === "isBlank" ||
    kind === "isNotBlank" ||
    kind === "isAnError" ||
    kind === "appearsMoreThanOnce"
  )
    return { kind };
  if (typeof kind === "string" && TEXT_CONDITIONS.has(kind)) {
    const words = text(value.text, `${where}.text`, 100);
    if (!words || /[\u0000-\u001f]/u.test(words))
      fail(`${where}.text must be 1-100 characters with no control characters`);
    return { kind: kind as "textIs", text: words };
  }
  if (kind === "booleanIs" && typeof value.value === "boolean") return { kind, value: value.value };
  if (
    kind === "numberIs" &&
    typeof value.comparison === "string" &&
    COMPARISONS.has(value.comparison)
  )
    return {
      kind,
      comparison: value.comparison as "equalTo",
      operand: operand(value.operand, `${where}.operand`),
    };
  if (kind === "numberIsBetween" || kind === "numberIsNotBetween")
    return {
      kind,
      oneEnd: operand(value.oneEnd, `${where}.oneEnd`),
      otherEnd: operand(value.otherEnd, `${where}.otherEnd`),
    };
  if (
    (kind === "isAmongTheLargest" || kind === "isAmongTheSmallest") &&
    Number.isInteger(value.count) &&
    (value.count as number) >= 1 &&
    (value.count as number) <= 1000
  )
    return { kind, count: value.count as number };
  return fail(`${where} is not a condition`);
}
function ruleFormat(raw: unknown, where: string): SheetRuleFormat {
  const value = record(raw, where);
  const out: { -readonly [K in keyof SheetRuleFormat]: SheetRuleFormat[K] } = {};
  if (value.fill !== undefined) out.fill = hex(value.fill, `${where}.fill`);
  if (value.color !== undefined) out.color = hex(value.color, `${where}.color`);
  for (const key of ["bold", "italic", "strike"] as const)
    if (typeof value[key] === "boolean") out[key] = value[key] as boolean;
  if (value.underline === "single" || value.underline === "double") out.underline = value.underline;
  if (Object.keys(out).length === 0) fail(`${where} must set a fill or a font look`);
  return out;
}
function anchor(raw: unknown, where: string): SheetRuleAnchor {
  const value = record(raw, where);
  if (value.kind === "smallestNumber" || value.kind === "largestNumber")
    return { kind: value.kind };
  if (value.kind === "number" && typeof value.number === "number" && Number.isFinite(value.number))
    return { kind: "number", number: value.number };
  if (
    value.kind === "percentile" &&
    typeof value.percentile === "number" &&
    value.percentile >= 0 &&
    value.percentile <= 100
  )
    return { kind: "percentile", percentile: value.percentile };
  return fail(`${where} is not an anchor`);
}
function stop(raw: unknown, where: string): SheetColorStop {
  const value = record(raw, where);
  return {
    anchor: anchor(value.anchor, `${where}.anchor`),
    color: value.color === null ? null : hex(value.color, `${where}.color`),
  };
}
export function parseSheetRule(raw: unknown, where = "rule"): SheetRule {
  const value = record(raw, where);
  const cells = ranges(value.ranges, `${where}.ranges`, 20);
  if (cells.length === 0) fail(`${where}.ranges needs 1 to 20 ranges`);
  const effect = record(value.effect, `${where}.effect`);
  if (effect.kind === "formatWhere") {
    if (!Array.isArray(effect.allOf) || effect.allOf.length < 1 || effect.allOf.length > 5)
      fail(`${where}.effect.allOf needs 1 to 5 tests`);
    return {
      ranges: cells,
      effect: {
        kind: "formatWhere",
        allOf: effect.allOf.map((rawTest, i) => {
          const test = record(rawTest, `${where}.effect.allOf[${i}]`);
          const tested = record(test.tested, `${where}.effect.allOf[${i}].tested`);
          return {
            tested:
              tested.kind === "sameRowInColumn"
                ? {
                    kind: "sameRowInColumn" as const,
                    c: index(tested.c, `${where}.tested.c`, SHEET_DATA_LIMITS.columns),
                  }
                : tested.kind === "theCellItself"
                  ? { kind: "theCellItself" as const }
                  : fail(`${where}.effect.allOf[${i}].tested is invalid`),
            condition: condition(test.condition, `${where}.effect.allOf[${i}].condition`),
          };
        }),
        format: ruleFormat(effect.format, `${where}.effect.format`),
      },
    };
  }
  if (effect.kind === "colorScale") {
    return {
      ranges: cells,
      effect: {
        kind: "colorScale",
        lowest: stop(effect.lowest, `${where}.effect.lowest`),
        middle:
          effect.middle === null || effect.middle === undefined
            ? null
            : stop(effect.middle, `${where}.effect.middle`),
        highest: stop(effect.highest, `${where}.effect.highest`),
      },
    };
  }
  return fail(`${where}.effect.kind must be formatWhere or colorScale`);
}
function chart(raw: unknown, where: string): SheetChart {
  const value = record(raw, where);
  if (typeof value.id !== "string" || !value.id || value.id.length > 64)
    fail(`${where}.id is invalid`);
  if (!SHEET_CHART_KINDS.includes(value.kind as SheetChartKind)) fail(`${where}.kind is invalid`);
  if (value.kind === "custom" && (typeof value.code !== "string" || !value.code.trim()))
    fail(`${where}.code is needed for a custom chart`);
  if (typeof value.code === "string" && value.code.length > SHEET_CHART_CODE_LIMIT)
    fail(`${where}.code is longer than ${SHEET_CHART_CODE_LIMIT} characters`);
  const source = record(value.source, `${where}.source`);
  const at = record(value.anchor, `${where}.anchor`);
  const side = (n: unknown, name: string) => {
    if (typeof n !== "number" || n < 40 || n > 4_000) fail(`${where}.${name} must be 40 to 4000`);
    return Math.round(n);
  };
  return {
    id: value.id,
    name: text(value.name, `${where}.name`, 200),
    caption: text(value.caption ?? "", `${where}.caption`, 500),
    kind: value.kind as SheetChartKind,
    ...(value.kind === "custom" ? { code: value.code as string } : {}),
    source: {
      sheetId: text(source.sheetId, `${where}.source.sheetId`, 64),
      range: range(source.range, `${where}.source.range`),
    },
    anchor: {
      r: index(at.r, `${where}.anchor.r`, SHEET_DATA_LIMITS.rows),
      c: index(at.c, `${where}.anchor.c`, SHEET_DATA_LIMITS.columns),
      dx: typeof at.dx === "number" ? Math.max(0, Math.round(at.dx)) : 0,
      dy: typeof at.dy === "number" ? Math.max(0, Math.round(at.dy)) : 0,
    },
    width: side(value.width, "width"),
    height: side(value.height, "height"),
  };
}

function parseSheet(rawSheet: unknown, where: string, count: { cells: number }): Sheet {
  const sheet = record(rawSheet, where);
  if (typeof sheet.id !== "string" || !sheet.id || sheet.id.length > 64)
    fail(`${where}.id is invalid`);
  if (typeof sheet.name !== "string" || !sheet.name.trim() || sheet.name.length > 100) {
    fail(`${where}.name must be 1-100 characters`);
  }
  if (!Array.isArray(sheet.cells)) fail(`${where}.cells must be an array`);
  count.cells += sheet.cells.length;
  if (count.cells > SHEET_DATA_LIMITS.cells) fail(`at most ${SHEET_DATA_LIMITS.cells} cells`);
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
    const s = parseSheetCellStyle(cell.s, `${at}.s`);
    const v = sheetScalar(cell.v, `${at}.v`);
    if (v === null && !f && !s) continue;
    cells.push({ r, c, v, ...(f ? { f } : {}), ...(s ? { s } : {}) });
  }
  cells.sort((a, b) => a.r - b.r || a.c - b.c);
  const out: { -readonly [K in keyof Sheet]: Sheet[K] } = {
    id: sheet.id,
    name: sheet.name.trim(),
    cells,
  };
  if (sheet.columnWidths !== undefined) {
    const widths = sizes(sheet.columnWidths, `${where}.columnWidths`, SHEET_DATA_LIMITS.columns);
    if (Object.keys(widths).length) out.columnWidths = widths;
  }
  if (sheet.rowHeights !== undefined) {
    const heights = sizes(sheet.rowHeights, `${where}.rowHeights`, SHEET_DATA_LIMITS.rows);
    if (Object.keys(heights).length) out.rowHeights = heights;
  }
  if (sheet.frozenRows !== undefined) {
    const n = index(sheet.frozenRows, `${where}.frozenRows`, 1_000);
    if (n) out.frozenRows = n;
  }
  if (sheet.frozenColumns !== undefined) {
    const n = index(sheet.frozenColumns, `${where}.frozenColumns`, 200);
    if (n) out.frozenColumns = n;
  }
  if (sheet.gridlinesHidden === true) out.gridlinesHidden = true;
  if (sheet.rowCount !== undefined)
    out.rowCount = index(sheet.rowCount, `${where}.rowCount`, SHEET_DATA_LIMITS.rows + 1) || 1;
  if (sheet.columnCount !== undefined)
    out.columnCount =
      index(sheet.columnCount, `${where}.columnCount`, SHEET_DATA_LIMITS.columns + 1) || 1;
  if (sheet.merges !== undefined) {
    const merges = ranges(sheet.merges, `${where}.merges`, SHEET_DATA_LIMITS.merges).filter(
      (m) => m.r1 > m.r0 || m.c1 > m.c0,
    );
    if (merges.length) out.merges = merges;
  }
  if (sheet.dropdowns !== undefined) {
    if (!Array.isArray(sheet.dropdowns) || sheet.dropdowns.length > SHEET_DATA_LIMITS.dropdowns)
      fail(`${where}.dropdowns is invalid`);
    const dropdowns = sheet.dropdowns.map((rawDropdown, i): SheetDropdown => {
      const dd = record(rawDropdown, `${where}.dropdowns[${i}]`);
      if (typeof dd.id !== "string" || !dd.id || dd.id.length > 64)
        fail(`${where}.dropdowns[${i}].id`);
      if (
        !Array.isArray(dd.options) ||
        dd.options.length < 1 ||
        dd.options.length > SHEET_DATA_LIMITS.dropdownOptions
      )
        fail(`${where}.dropdowns[${i}].options needs 1 to 100 options`);
      const labels = new Set<string>();
      return {
        id: dd.id,
        ranges: ranges(dd.ranges, `${where}.dropdowns[${i}].ranges`, 100),
        options: dd.options.map((rawOption, j) => {
          const option = record(rawOption, `${where}.dropdowns[${i}].options[${j}]`);
          const label = text(option.label, `${where}.dropdowns[${i}].options[${j}].label`, 100);
          if (!label.trim() || labels.has(label.toLowerCase()))
            fail(`${where}.dropdowns[${i}] option labels must be unique and not blank`);
          labels.add(label.toLowerCase());
          return {
            id: text(option.id, `${where}.dropdowns[${i}].options[${j}].id`, 64),
            label,
            ...(option.color === undefined
              ? {}
              : { color: hex(option.color, `${where}.dropdowns[${i}].options[${j}].color`) }),
          };
        }),
      };
    });
    if (dropdowns.length) out.dropdowns = dropdowns;
  }
  if (sheet.checkboxes !== undefined) {
    const boxes = ranges(sheet.checkboxes, `${where}.checkboxes`, 1_000);
    if (boxes.length) out.checkboxes = boxes;
  }
  if (sheet.table !== undefined) {
    const t = record(sheet.table, `${where}.table`);
    const c0 = index(t.c0, `${where}.table.c0`, SHEET_DATA_LIMITS.columns);
    const c1 = index(t.c1, `${where}.table.c1`, SHEET_DATA_LIMITS.columns);
    const h0 = index(t.headerR0, `${where}.table.headerR0`, SHEET_DATA_LIMITS.rows);
    const h1 = index(t.headerR1, `${where}.table.headerR1`, SHEET_DATA_LIMITS.rows);
    out.table = {
      c0: Math.min(c0, c1),
      c1: Math.max(c0, c1),
      headerR0: Math.min(h0, h1),
      headerR1: Math.max(h0, h1),
      ...(t.footerR0 === undefined
        ? {}
        : {
            footerR0: index(t.footerR0, `${where}.table.footerR0`, SHEET_DATA_LIMITS.rows),
            footerR1: index(
              t.footerR1 ?? t.footerR0,
              `${where}.table.footerR1`,
              SHEET_DATA_LIMITS.rows,
            ),
          }),
    };
  }
  if (sheet.rules !== undefined) {
    if (!Array.isArray(sheet.rules) || sheet.rules.length > SHEET_DATA_LIMITS.rules)
      fail(`${where}.rules is invalid`);
    const rules = sheet.rules.map((rule, i) => parseSheetRule(rule, `${where}.rules[${i}]`));
    if (rules.length) out.rules = rules;
  }
  if (sheet.charts !== undefined) {
    if (!Array.isArray(sheet.charts) || sheet.charts.length > SHEET_DATA_LIMITS.charts)
      fail(`${where}.charts is invalid`);
    const charts = sheet.charts.map((item, i) => chart(item, `${where}.charts[${i}]`));
    if (charts.length) out.charts = charts;
  }
  if (sheet.rowGroups !== undefined) {
    const g = groups(sheet.rowGroups, `${where}.rowGroups`, SHEET_DATA_LIMITS.rows);
    if (g.length) out.rowGroups = g;
  }
  if (sheet.columnGroups !== undefined) {
    const g = groups(sheet.columnGroups, `${where}.columnGroups`, SHEET_DATA_LIMITS.columns);
    if (g.length) out.columnGroups = g;
  }
  if (sheet.spills !== undefined) {
    if (!Array.isArray(sheet.spills)) fail(`${where}.spills must be an array`);
    const spills = sheet.spills.slice(0, 500).map((raw, i): SheetSpill => {
      const spill = record(raw, `${where}.spills[${i}]`);
      if (!Array.isArray(spill.cells)) fail(`${where}.spills[${i}].cells must be an array`);
      return {
        r: index(spill.r, `${where}.spills[${i}].r`, SHEET_DATA_LIMITS.rows),
        c: index(spill.c, `${where}.spills[${i}].c`, SHEET_DATA_LIMITS.columns),
        cells: spill.cells.slice(0, SHEET_DATA_LIMITS.cells).map((cell, j) => {
          const at = `${where}.spills[${i}].cells[${j}]`;
          if (!Array.isArray(cell) || cell.length !== 3) fail(`${at} must be [row, column, value]`);
          return [
            index(cell[0], `${at}[0]`, SHEET_DATA_LIMITS.rows),
            index(cell[1], `${at}[1]`, SHEET_DATA_LIMITS.columns),
            sheetScalar(cell[2], `${at}[2]`),
          ] as const;
        }),
      };
    });
    if (spills.length) out.spills = spills;
  }
  return out;
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
  const count = { cells: 0 };
  const sheets = value.sheets.map((rawSheet, sheetIndex) =>
    parseSheet(rawSheet, `sheets[${sheetIndex}]`, count),
  );
  if (new Set(sheets.map((sheet) => sheet.name.toLowerCase())).size !== sheets.length) {
    fail("sheet names must be unique");
  }
  if (new Set(sheets.map((sheet) => sheet.id)).size !== sheets.length)
    fail("sheet ids must be unique");
  let deletedSheets: Sheet[] = [];
  if (value.deletedSheets !== undefined) {
    if (!Array.isArray(value.deletedSheets)) fail("deletedSheets must be an array");
    deletedSheets = value.deletedSheets
      .slice(-SHEET_DATA_LIMITS.deletedSheets)
      .map((rawSheet, i) => parseSheet(rawSheet, `deletedSheets[${i}]`, { cells: 0 }));
  }
  if (value.locale !== undefined && !isSheetLocale(value.locale))
    fail(`locale must be one of ${Object.keys(SHEET_LOCALES).join(", ")}`);
  if (value.timeZone !== undefined && !isSheetTimeZone(value.timeZone))
    fail("timeZone must be an IANA time zone such as Asia/Shanghai");
  const workbook: SheetWorkbook = {
    version: 1,
    sheets,
    ...(deletedSheets.length ? { deletedSheets } : {}),
    ...(isSheetLocale(value.locale) ? { locale: value.locale } : {}),
    ...(isSheetTimeZone(value.timeZone) ? { timeZone: value.timeZone } : {}),
  };
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
export function columnIndex(name: string): number {
  let c = 0;
  for (const char of name.toUpperCase()) c = c * 26 + (char.charCodeAt(0) - 64);
  return c - 1;
}
export function cellAddress(r: number, c: number): string {
  return `${columnName(c)}${r + 1}`;
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/u;
function parseCell(input: string): { r: number; c: number } {
  const match = CELL.exec(input.trim());
  if (!match) fail(`${input} is not an A1 cell address`);
  const c = columnIndex(match[1]!);
  const r = Number(match[2]) - 1;
  if (r < 0 || r >= SHEET_DATA_LIMITS.rows || c >= SHEET_DATA_LIMITS.columns)
    fail(`${input} is out of range`);
  return { r, c };
}
/** `B2`, `A1:C10`. The range is normalized so r0<=r1 and c0<=c1. */
export function parseSheetRange(input: string): SheetRange {
  const parts = input.split(":");
  if (parts.length > 2 || !parts[0]) fail(`${input} is not an A1 range`);
  const a = parseCell(parts[0]);
  const b = parseCell(parts[1] ?? parts[0]);
  return {
    r0: Math.min(a.r, b.r),
    c0: Math.min(a.c, b.c),
    r1: Math.max(a.r, b.r),
    c1: Math.max(a.c, b.c),
  };
}
export function formatSheetRange(target: SheetRange): string {
  const start = cellAddress(target.r0, target.c0);
  const end = cellAddress(target.r1, target.c1);
  return start === end ? start : `${start}:${end}`;
}
/** `3` or `3:5` (1-based) → zero-based inclusive indices. */
export function parseSheetRows(input: string): { start: number; end: number } {
  const match = /^(\d{1,7})(?::(\d{1,7}))?$/u.exec(input.trim());
  if (!match) fail(`${input} is not a row or rows such as 3 or 3:5`);
  const a = Number(match[1]) - 1;
  const b = Number(match[2] ?? match[1]) - 1;
  if (a < 0 || b < 0 || Math.max(a, b) >= SHEET_DATA_LIMITS.rows) fail(`${input} is out of range`);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}
/** `B` or `B:D` → zero-based inclusive indices. */
export function parseSheetColumns(input: string): { start: number; end: number } {
  const match = /^([A-Za-z]{1,3})(?::([A-Za-z]{1,3}))?$/u.exec(input.trim());
  if (!match) fail(`${input} is not a column or columns such as B or B:D`);
  const a = columnIndex(match[1]!);
  const b = columnIndex(match[2] ?? match[1]!);
  if (Math.max(a, b) >= SHEET_DATA_LIMITS.columns) fail(`${input} is out of range`);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}
export function rangeContains(outer: SheetRange, r: number, c: number): boolean {
  return r >= outer.r0 && r <= outer.r1 && c >= outer.c0 && c <= outer.c1;
}
export function rangesOverlap(a: SheetRange, b: SheetRange): boolean {
  return a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
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
/** The smallest range holding every cell with a value or formula, or null. */
export function filledRange(sheet: Sheet): SheetRange | null {
  let out: { r0: number; c0: number; r1: number; c1: number } | null = null;
  for (const cell of sheet.cells) {
    if (cell.v === null && !cell.f) continue;
    if (!out) out = { r0: cell.r, c0: cell.c, r1: cell.r, c1: cell.c };
    else {
      out.r0 = Math.min(out.r0, cell.r);
      out.c0 = Math.min(out.c0, cell.c);
      out.r1 = Math.max(out.r1, cell.r);
      out.c1 = Math.max(out.c1, cell.c);
    }
  }
  return out;
}
/** Rows and columns of the grid: the stored size, grown to hold every cell. */
export function sheetSize(sheet: Sheet): { rows: number; columns: number } {
  const used = usedRange(sheet);
  return {
    rows: Math.max(sheet.rowCount ?? DEFAULT_SHEET_ROWS, used ? used.r1 + 1 : 0),
    columns: Math.max(sheet.columnCount ?? DEFAULT_SHEET_COLUMNS, used ? used.c1 + 1 : 0),
  };
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
  input?: string,
): SheetRangeRead {
  const sheet = findSheet(workbook, sheetName);
  const target = input
    ? parseSheetRange(input)
    : (usedRange(sheet) ?? { r0: 0, c0: 0, r1: 0, c1: 0 });
  const rows = target.r1 - target.r0 + 1;
  const columns = target.c1 - target.c0 + 1;
  if (rows * columns > MAX_READ_CELLS) fail(`read at most ${MAX_READ_CELLS} cells at once`);
  const byKey = new Map(sheet.cells.map((cell) => [`${cell.r}:${cell.c}`, cell]));
  const values: SheetScalar[][] = [];
  const formulas: (string | null)[][] = [];
  for (let r = target.r0; r <= target.r1; r++) {
    const valueRow: SheetScalar[] = [];
    const formulaRow: (string | null)[] = [];
    for (let c = target.c0; c <= target.c1; c++) {
      const cell = byKey.get(`${r}:${c}`);
      valueRow.push(cell?.v ?? null);
      formulaRow.push(cell?.f ?? null);
    }
    values.push(valueRow);
    formulas.push(formulaRow);
  }
  return { sheet: sheet.name, range: formatSheetRange(target), values, formulas };
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
  const target = {
    r0: origin.r0,
    c0: origin.c0,
    r1: origin.r0 + rows.length - 1,
    c1: origin.c0 + width - 1,
  };
  if (target.r1 >= SHEET_DATA_LIMITS.rows || target.c1 >= SHEET_DATA_LIMITS.columns)
    fail("write is out of range");
  const byKey = new Map(sheet.cells.map((cell) => [`${cell.r}:${cell.c}`, cell]));
  rows.forEach((row, dr) =>
    row.forEach((raw, dc) => {
      const r = target.r0 + dr;
      const c = target.c0 + dc;
      const key = `${r}:${c}`;
      const previous = byKey.get(key);
      const input = typeof raw === "string" ? raw : null;
      const isFormula = input !== null && input.startsWith("=") && input.length > 1;
      const v = isFormula ? null : sheetScalar(raw, `values[${dr}][${dc}]`);
      if (!isFormula && v === null && !previous?.s) {
        byKey.delete(key);
        return;
      }
      byKey.set(key, {
        r,
        c,
        v,
        ...(isFormula ? { f: formula(input, `values[${dr}][${dc}]`)! } : {}),
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
    range: formatSheetRange(target),
  };
}

function csvField(value: SheetScalar, separator: string): string {
  const out = value === null ? "" : String(value);
  return new RegExp(`["${separator === "\t" ? "\\t" : separator}\\n\\r]`, "u").test(out)
    ? `"${out.replaceAll('"', '""')}"`
    : out;
}
export function sheetToCsv(sheet: Sheet, separator: "," | "\t" = ","): string {
  const used = usedRange(sheet);
  if (!used) return "";
  const byKey = new Map(sheet.cells.map((cell) => [`${cell.r}:${cell.c}`, cell]));
  const lines: string[] = [];
  for (let r = 0; r <= used.r1; r++) {
    const fields: string[] = [];
    for (let c = 0; c <= used.c1; c++)
      fields.push(csvField(byKey.get(`${r}:${c}`)?.v ?? null, separator));
    lines.push(fields.join(separator));
  }
  return lines.join("\r\n");
}

/** Which character separates a delimited file's cells: commas, or semicolons / tabs if the first line has more of those. */
export function detectCsvSeparator(input: string): "," | ";" | "\t" {
  const first = input.replace(/^﻿/u, "").split(/\r?\n/u, 1)[0] ?? "";
  const count = (char: string) => first.split(char).length - 1;
  const comma = count(",");
  const semicolon = count(";");
  const tab = count("\t");
  if (tab > comma && tab >= semicolon) return "\t";
  if (semicolon > comma) return ";";
  return ",";
}

/** RFC 4180 parsing; numbers stay text unless the whole field is numeric. */
export function csvToSheet(
  input: string,
  name = "工作表1",
  id = "sheet1",
  separator: "," | ";" | "\t" = detectCsvSeparator(input),
): Sheet {
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
  const source = input.replace(/^﻿/u, "");
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
    } else if (char === separator) push();
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
