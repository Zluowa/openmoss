// FILE: sheetValues.ts
// Purpose: What a typed string means in a 电子表格 cell (number, percent, money, date, time,
//          boolean, text, formula) and how a number looks under a number format.
// Layer: Shared model (agent writes on the server, CSV import and the editor's formula row)
// Exports: parseTypedCellInput, formatSheetNumber, isDateFormat, dateToSerial, serialToIso,
//          SHEET_NUMBER_FORMATS.
// Why: An agent and a person both write "50%", "$1,200" or "2026-03-15"; the cell must store
//      the number and the format, the same way on the server and in the browser.

import type { SheetScalar } from "./sheetWorkbook";

/** Days between 1899-12-30 and 1970-01-01, the spreadsheet date epoch. */
const EPOCH_OFFSET = 25_569;
const DAY_MS = 86_400_000;

export function dateToSerial(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / DAY_MS + EPOCH_OFFSET;
}
export function timeToSerial(hours: number, minutes: number, seconds = 0): number {
  return (hours * 3_600 + minutes * 60 + seconds) / 86_400;
}
function serialParts(serial: number) {
  const whole = Math.floor(serial);
  const date = new Date((whole - EPOCH_OFFSET) * DAY_MS);
  let secondsOfDay = Math.round((serial - whole) * 86_400);
  if (secondsOfDay >= 86_400) secondsOfDay = 86_399;
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hours: Math.floor(secondsOfDay / 3_600),
    minutes: Math.floor((secondsOfDay % 3_600) / 60),
    seconds: secondsOfDay % 60,
  };
}
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
/** `2026-03-15`, `14:30:00` or `2026-03-15T14:30:00`, as the format shows the serial. */
export function serialToIso(serial: number, kind: "date" | "time" | "dateTime"): string {
  const p = serialParts(serial);
  const date = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
  const time = `${pad(p.hours)}:${pad(p.minutes)}:${pad(p.seconds)}`;
  return kind === "date" ? date : kind === "time" ? time : `${date}T${time}`;
}

/** Ready-made formats offered in the editor's number-format menu. */
export const SHEET_NUMBER_FORMATS = {
  general: "General",
  number: "#,##0.00",
  numberRounded: "#,##0",
  numberParentheses: "#,##0.00;(#,##0.00)",
  currency: "¥#,##0.00",
  currencyRounded: "¥#,##0",
  currencyDollar: "$#,##0.00",
  percent: "0.00%",
  percentRounded: "0%",
  scientific: "0.00E+00",
  fraction: "# ?/?",
  date: "yyyy-mm-dd",
  dateLong: "yyyy年m月d日",
  dateShortMonth: "mmm d, yyyy",
  time: "h:mm",
  timeAmPm: "h:mm AM/PM",
  dateTime: "yyyy-mm-dd h:mm",
  duration: "[h]:mm:ss",
  text: "@",
} as const;

export function isDateFormat(format: string | undefined): "date" | "time" | "dateTime" | null {
  if (!format) return null;
  const elapsed = /\[(h+|m+|s+)\]/iu.test(format);
  const bare = format.replace(/"[^"]*"|\[[^\]]*\]|\\.|AM\/PM|A\/P/giu, "");
  const hasTime = elapsed || /[hs]/iu.test(bare) || /AM\/PM|A\/P/iu.test(format);
  const hasDate = /[yd]/iu.test(bare) || (/m/iu.test(bare) && !hasTime);
  if (elapsed && !hasDate) return "time";
  if (hasDate && hasTime) return "dateTime";
  if (hasDate) return "date";
  if (hasTime) return "time";
  return null;
}

export interface TypedCellInput {
  readonly v: SheetScalar;
  /** A formula, including the leading `=`. */
  readonly f?: string;
  /** The number format the text implies, if any (`0%`, `$#,##0.00`, `yyyy-mm-dd`…). */
  readonly format?: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const CURRENCIES = "$€£¥₹";

function parseTime(text: string): { serial: number; format: string } | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|AM|PM)?$/u.exec(text);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] ? Number(match[3]) : 0;
  const half = match[4]?.toLowerCase();
  if (minutes > 59 || seconds > 59) return null;
  if (half) {
    if (hours < 1 || hours > 12) return null;
    if (half === "pm" && hours !== 12) hours += 12;
    if (half === "am" && hours === 12) hours = 0;
  } else if (hours > 23) return null;
  return {
    serial: timeToSerial(hours, minutes, seconds),
    format: half ? (match[3] ? "h:mm:ss AM/PM" : "h:mm AM/PM") : match[3] ? "h:mm:ss" : "h:mm",
  };
}
function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
function parseDate(text: string, thisYear: number): { serial: number; format: string } | null {
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(text);
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    return validDate(y, m, d) ? { serial: dateToSerial(y, m, d), format: "yyyy-mm-dd" } : null;
  }
  match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.exec(text);
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    return validDate(y, m, d) ? { serial: dateToSerial(y, m, d), format: "yyyy年m月d日" } : null;
  }
  // Month first, the way agents write dates in every locale.
  match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/u.exec(text);
  if (match) {
    const m = Number(match[1]);
    const d = Number(match[2]);
    let y = match[3] ? Number(match[3]) : thisYear;
    if (match[3]?.length === 2) y += y < 30 ? 2000 : 1900;
    return validDate(y, m, d) ? { serial: dateToSerial(y, m, d), format: "yyyy-mm-dd" } : null;
  }
  match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/u.exec(text);
  if (match) {
    const m = MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase()) + 1;
    const d = Number(match[2]);
    const y = match[3] ? Number(match[3]) : thisYear;
    if (m === 0 || !validDate(y, m, d)) return null;
    return { serial: dateToSerial(y, m, d), format: match[3] ? "mmm d, yyyy" : "mmm d" };
  }
  return null;
}

/**
 * Reads a string as if it were typed into a cell. `'` keeps anything as text; `=` starts a
 * formula; numbers may carry a percent sign, a currency symbol or thousands commas, which also
 * set the cell's format. `keptFormat` is the cell's current format: a bare number typed into a
 * percent cell means that many percent.
 */
export function parseTypedCellInput(
  input: string,
  keptFormat?: string,
  now: Date = new Date(),
): TypedCellInput {
  if (input.startsWith("'")) return { v: input.slice(1) };
  if (input.startsWith("=") && input.length > 1) return { v: null, f: input };
  const text = input.trim();
  if (text === "") return { v: null };
  const upper = text.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE") return { v: upper === "TRUE" };
  if (keptFormat === "@") return { v: input };

  // Percent: 50%, -12.5 %
  let match = /^([-+]?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.?\d+)\s*%$/u.exec(text);
  if (match) {
    const digits = match[2]!.replaceAll(",", "");
    const decimals = digits.includes(".") ? digits.split(".")[1]!.length : 0;
    return {
      v: Number(`${match[1]}${digits}`) / 100,
      format: decimals ? `0.${"0".repeat(decimals)}%` : "0%",
    };
  }
  // Money: $1,200.50, -€5, ¥ 30
  match = new RegExp(
    `^([-+]?)([${CURRENCIES}])\\s?(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d*\\.?\\d+)$`,
    "u",
  ).exec(text);
  if (match) {
    const digits = match[3]!.replaceAll(",", "");
    const decimals = digits.includes(".") ? digits.split(".")[1]!.length : 0;
    return {
      v: Number(`${match[1]}${digits}`),
      format: `${match[2]}#,##0${decimals || match[2] !== "¥" ? ".00" : ""}`,
    };
  }
  // Thousands: 1,200 or 1,200.5
  match = /^([-+]?)(\d{1,3}(?:,\d{3})+)(\.\d+)?$/u.exec(text);
  if (match) {
    return {
      v: Number(`${match[1]}${match[2]!.replaceAll(",", "")}${match[3] ?? ""}`),
      format: match[3] ? `#,##0.${"0".repeat(match[3].length - 1)}` : "#,##0",
    };
  }
  // Plain numbers (with exponent).
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u.test(text)) {
    const value = Number(text);
    if (!Number.isFinite(value)) return { v: input };
    // A bare number typed into a percent cell is that many percent.
    if (keptFormat && /%/u.test(keptFormat) && !/[eE]/u.test(text)) return { v: value / 100 };
    return { v: value };
  }
  // Date and time: 2026-03-15T14:30:00, 3/15/2026 2:30 PM
  match = /^(.+?)[T\s]+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?)$/u.exec(text);
  if (match) {
    const date = parseDate(match[1]!.trim(), now.getFullYear());
    const time = parseTime(match[2]!.replace(/(?:Z|[+-]\d{2}:?\d{2})$/u, "").trim());
    if (date && time)
      return {
        v: date.serial + time.serial,
        format: `${date.format} ${time.format.replace(":ss", "")}`,
      };
  }
  const time = parseTime(text);
  if (time) return { v: time.serial, format: time.format };
  const date = parseDate(text, now.getFullYear());
  if (date) return { v: date.serial, format: date.format };
  return { v: input };
}

// ── Number formats ───────────────────────────────────────────────────────────────────────────

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}
const MONTH_NAMES = [
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
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDateSection(section: string, serial: number): string {
  const p = serialParts(serial);
  const twelve = /AM\/PM|A\/P/iu.test(section);
  const hours12 = p.hours % 12 === 0 ? 12 : p.hours % 12;
  let out = "";
  let i = 0;
  let lastWasHour = false;
  while (i < section.length) {
    const rest = section.slice(i);
    const quoted = /^"([^"]*)"/u.exec(rest);
    if (quoted) {
      out += quoted[1];
      i += quoted[0].length;
      continue;
    }
    if (rest.startsWith("\\")) {
      out += rest[1] ?? "";
      i += 2;
      continue;
    }
    const ampm = /^(AM\/PM|am\/pm|A\/P|a\/p)/u.exec(rest);
    if (ampm) {
      out += p.hours < 12 ? "AM" : "PM";
      i += ampm[0].length;
      continue;
    }
    const elapsed = /^\[(h+|m+|s+)\]/iu.exec(rest);
    if (elapsed) {
      const unit = elapsed[1]![0]!.toLowerCase();
      const total =
        unit === "h"
          ? Math.floor(serial * 24)
          : unit === "m"
            ? Math.floor(serial * 1_440)
            : Math.round(serial * 86_400);
      out += pad(total, elapsed[1]!.length);
      i += elapsed[0].length;
      lastWasHour = unit === "h";
      continue;
    }
    const token = /^(y+|m+|d+|h+|s+)/iu.exec(rest);
    if (token) {
      const t = token[1]!;
      const kind = t[0]!.toLowerCase();
      const n = t.length;
      if (kind === "y") out += n <= 2 ? pad(p.year % 100) : pad(p.year, 4);
      else if (kind === "d")
        out +=
          n === 1
            ? String(p.day)
            : n === 2
              ? pad(p.day)
              : n === 3
                ? DAY_NAMES[p.weekday]!.slice(0, 3)
                : DAY_NAMES[p.weekday]!;
      else if (kind === "h")
        out += n === 1 ? String(twelve ? hours12 : p.hours) : pad(twelve ? hours12 : p.hours);
      else if (kind === "s") out += n === 1 ? String(p.seconds) : pad(p.seconds);
      else {
        // `m` after an hour or before seconds means minutes.
        const minutes = lastWasHour || /^[^a-zA-Z"]*s/iu.test(section.slice(i + n));
        if (minutes) out += n === 1 ? String(p.minutes) : pad(p.minutes);
        else
          out +=
            n === 1
              ? String(p.month)
              : n === 2
                ? pad(p.month)
                : n === 3
                  ? MONTH_NAMES[p.month - 1]!.slice(0, 3)
                  : MONTH_NAMES[p.month - 1]!;
      }
      lastWasHour = kind === "h";
      i += n;
      continue;
    }
    if (rest[0] !== ":" && rest[0] !== " ") lastWasHour = false;
    out += rest[0];
    i += 1;
  }
  return out;
}

function formatNumberSection(section: string, value: number): string {
  let pattern = section.replace(/\[[^\]]*\]/gu, "");
  const literal = (s: string) => s.replace(/"([^"]*)"/gu, "$1").replace(/\\(.)/gu, "$1");
  if (pattern.includes("@")) return literal(pattern.replace("@", String(value)));
  const percent = (pattern.match(/%/gu) ?? []).length;
  let scaled = value * 100 ** percent;
  // Scientific
  const sci = /0(?:\.(0+))?E([+-])(0+)/iu.exec(pattern);
  if (sci) {
    const digits = sci[1]?.length ?? 0;
    const [mantissa, exponent] = Math.abs(scaled).toExponential(digits).split("e");
    const exp = Number(exponent);
    const body = `${mantissa}E${exp < 0 ? "-" : sci[2] === "+" ? "+" : ""}${pad(Math.abs(exp), sci[3]!.length)}`;
    return literal(pattern.replace(sci[0], body));
  }
  // Fractions: # ?/?
  if (/\?\/\?/u.test(pattern)) {
    const whole = Math.trunc(Math.abs(scaled));
    const rest = Math.abs(scaled) - whole;
    let best = { n: 0, d: 1, err: rest };
    for (let d = 1; d <= 9; d++) {
      const n = Math.round(rest * d);
      const err = Math.abs(rest - n / d);
      if (err < best.err - 1e-12) best = { n, d, err };
    }
    const frac = best.n === 0 ? "" : `${best.n}/${best.d}`;
    return `${value < 0 ? "-" : ""}${whole || !frac ? whole : ""}${whole && frac ? " " : ""}${frac}`;
  }
  const numberPart = /[#0?,.]+/u.exec(pattern);
  if (!numberPart) return literal(pattern);
  const spec = numberPart[0];
  const [intSpec, decSpec = ""] = spec.split(".");
  const decimals = (decSpec.match(/[0#?]/gu) ?? []).length;
  const minDecimals = (decSpec.match(/0/gu) ?? []).length;
  const thousands = intSpec!.includes(",");
  // Trailing commas scale by thousands.
  const trailing = /,+$/u.exec(intSpec!)?.[0].length ?? 0;
  scaled /= 1000 ** trailing;
  const minInt = (intSpec!.replace(/,+$/u, "").match(/0/gu) ?? []).length;
  let [whole, fraction = ""] = Math.abs(scaled).toFixed(decimals).split(".");
  if (decimals > minDecimals)
    fraction = fraction.replace(new RegExp(`0{0,${decimals - minDecimals}}$`, "u"), "");
  if (whole === "0" && minInt === 0) whole = "";
  whole = whole!.padStart(minInt, "0");
  if (thousands) whole = groupThousands(whole);
  const body = `${whole}${fraction ? `.${fraction}` : decimals && minDecimals ? "." : ""}`;
  return literal(pattern.replace(spec, body || "0"));
}

/** How a number looks under a number format (`General` shows it plainly). */
export function formatSheetNumber(format: string | undefined, value: number): string {
  if (!format || format === "General") {
    if (Number.isInteger(value)) return String(value);
    const rounded = Number(value.toPrecision(11));
    return Math.abs(rounded) >= 1e11 || (Math.abs(rounded) < 1e-9 && rounded !== 0)
      ? rounded.toExponential(5).replace(/\.?0+e/u, "E")
      : String(rounded);
  }
  const sections = format.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/u);
  let section = sections[0]!;
  let shown = value;
  if (value < 0 && sections[1] !== undefined) {
    section = sections[1];
    shown = -value;
  } else if (value === 0 && sections[2] !== undefined) section = sections[2];
  const kind = isDateFormat(section);
  if (kind) return formatDateSection(section.replace(/\[(?![hms]+\])[^\]]*\]/giu, ""), shown);
  const out = formatNumberSection(section, shown);
  return shown < 0 && !/^-/u.test(out) ? `-${out}` : out;
}
