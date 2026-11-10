// FILE: zonedTimes.ts
// Purpose: The desktop chat underlines a clock time written with a zone ("15:00 PST",
//          "9:30am UTC+8") when that zone is not the reader's, and on hover shows it in
//          the reader's local time. This finds those times in text, decides whether one
//          is worth marking, and converts it; a rehype pass wraps each in <moss-time>.
//          A time right after a date is left alone (its day is not today's).
// Layer: Web markdown helpers (pure)
// Exports: ZonedTime, findZonedTimes, parseZonedTime, isForeignZonedTime,
//          describeZonedTime, rehypeZonedTimes, ZONED_TIME_ELEMENT_TAG

export interface ZonedTime {
  /** The matched text, e.g. "3:00 pm PST". */
  original: string;
  hour: number;
  minute: number;
  second: number;
  zone: { minutes: number } | { iana: string };
  /** How the zone was written, or "UTC+5:30" for an offset. */
  zoneLabel: string;
}

export interface ZonedTimeMatch {
  index: number;
  parsed: ZonedTime;
  /** Preceded by a date: not marked. */
  dated: boolean;
}

export const ZONED_TIME_ELEMENT_TAG = "moss-time";

const FIXED_ZONES: Readonly<Record<string, number>> = {
  UTC: 0,
  GMT: 0,
  Z: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
  AKST: -540,
  AKDT: -480,
  HST: -600,
  AST: -240,
  ADT: -180,
  NST: -210,
  NDT: -150,
  WET: 0,
  WEST: 60,
  BST: 60,
  CET: 60,
  CEST: 120,
  EET: 120,
  EEST: 180,
  MSK: 180,
  IST: 330,
  PKT: 300,
  GST: 240,
  ICT: 420,
  WIB: 420,
  HKT: 480,
  SGT: 480,
  MYT: 480,
  PHT: 480,
  JST: 540,
  KST: 540,
  AWST: 480,
  ACST: 570,
  ACDT: 630,
  AEST: 600,
  AEDT: 660,
  NZST: 720,
  NZDT: 780,
};
// Abbreviations that mean another zone somewhere: a reader at one of these offsets
// (Israel or Ireland for IST, China for CST, ...) is taken to mean their own zone.
const AMBIGUOUS_ZONE_OFFSETS: Readonly<Record<string, readonly number[]>> = {
  IST: [120, 180, 60],
  CST: [480],
  BST: [360],
  AST: [180],
  PST: [480],
};
const REGION_ZONES: Readonly<Record<string, string>> = {
  ET: "America/New_York",
  CT: "America/Chicago",
  MT: "America/Denver",
  PT: "America/Los_Angeles",
};
const ZONE_NAMES = [...Object.keys(FIXED_ZONES), ...Object.keys(REGION_ZONES)].sort(
  (left, right) => right.length - left.length,
);
const SPACE = "[^\\S\\r\\n]";
const OFFSET = "(?:UTC|GMT)([+\\u2212\\u2013-])(\\d{1,2})(?::?(\\d{2}))?";
const MERIDIEM = `([AaPp])(?:\\.[Mm]\\.|${SPACE}?[Mm])`;
const TIME_PATTERN = new RegExp(
  `(\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:(?:${SPACE}?${MERIDIEM})?${SPACE}+|(?=Z\\b))(?:${OFFSET}|(${ZONE_NAMES.join("|")}))(?![\\w+\\u2212\\u2013-])`,
  "g",
);
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const DATE_BEFORE = new RegExp(
  `(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}|${MONTH}${SPACE}+\\d{1,2}(?:,?${SPACE}+\\d{4})?|\\d{1,2}${SPACE}+${MONTH}(?:${SPACE}+\\d{4})?),?${SPACE}+$`,
);
const DATE_LOOKBEHIND_CHARS = 14;
const GLUED_BEFORE = /[\w:.]/;
const OFFSET_SIGN_BEFORE = new RegExp(`(?:UTC|GMT)${SPACE}?[+\\u2212\\u2013-]$`);
const OFFSET_SIGN_LOOKBEHIND_CHARS = 5;
const MINUS_SIGN = /^[-\u2212\u2013]$/;
// "UTC+5" written after a "UTC" match: the offset belongs to the zone, so skip it.
const OFFSET_AFTER_UTC = new RegExp(
  `^${SPACE}*(?:[+\\u2212]${SPACE}*\\d{1,2}(?::?\\d{2})?|[\\u2013-]${SPACE}*\\d{1,2}(?![:\\d])|[\\u2013-]\\d{1,2}(?::?\\d{2})?)`,
);

function offsetLabel(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return rest === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(rest).padStart(2, "0")}`;
}

function parseMatch(match: RegExpMatchArray): ZonedTime | null {
  const [original, hourText, minuteText, secondText, meridiem, sign, offsetHours, offsetMinutes] =
    match;
  const zoneName = match[8];
  const minute = Number(minuteText);
  const second = secondText ? Number(secondText) : 0;
  if (minute > 59 || second > 59) return null;
  let hour = Number(hourText);
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const pm = meridiem.toLowerCase() === "p";
    if (pm && hour !== 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  } else if (hour > 23) return null;
  if (zoneName) {
    if (zoneName in FIXED_ZONES) {
      return {
        original,
        hour,
        minute,
        second,
        zone: { minutes: FIXED_ZONES[zoneName]! },
        zoneLabel: zoneName,
      };
    }
    const iana = REGION_ZONES[zoneName];
    return iana ? { original, hour, minute, second, zone: { iana }, zoneLabel: zoneName } : null;
  }
  const offset =
    (sign === "+" ? 1 : -1) *
    (Number(offsetHours) * 60 + (offsetMinutes ? Number(offsetMinutes) : 0));
  if (offset < -720 || offset > 840) return null;
  return {
    original,
    hour,
    minute,
    second,
    zone: { minutes: offset },
    zoneLabel: offsetLabel(offset),
  };
}

export function findZonedTimes(text: string): ZonedTimeMatch[] {
  if (!/\d:\d/.test(text)) return [];
  const found: ZonedTimeMatch[] = [];
  let skipUntil = 0;
  for (const match of text.matchAll(TIME_PATTERN)) {
    const index = match.index ?? 0;
    if (index < skipUntil) continue;
    if (index > 0 && GLUED_BEFORE.test(text[index - 1]!)) continue;
    if (
      index > 0 &&
      OFFSET_SIGN_BEFORE.test(text.slice(Math.max(0, index - OFFSET_SIGN_LOOKBEHIND_CHARS), index))
    ) {
      continue;
    }
    const dated =
      index > 0 && DATE_BEFORE.test(text.slice(Math.max(0, index - DATE_LOOKBEHIND_CHARS), index));
    const end = index + match[0].length;
    const sign = match[5];
    const offsetMinutes = match[7];
    if (
      sign &&
      offsetMinutes &&
      MINUS_SIGN.test(sign) &&
      match[0].includes(":", match[0].indexOf(sign))
    ) {
      continue;
    }
    if (match[8] === "UTC" || match[8] === "GMT") {
      const trailing = OFFSET_AFTER_UTC.exec(text.slice(end));
      if (trailing) {
        if (!dated) skipUntil = end + trailing[0].length;
        continue;
      }
    }
    const parsed = parseMatch(match);
    if (parsed) found.push({ index, parsed, dated });
  }
  return found;
}

/** Parses a single matched time, as stored on a <moss-time> element. */
export function parseZonedTime(original: string): ZonedTime | null {
  const match = findZonedTimes(original)[0];
  return match && match.index === 0 && match.parsed.original === original ? match.parsed : null;
}

function zoneOffsetAt(timeZone: string, ms: number): number | null {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(new Date(ms))
      .find((part) => part.type === "timeZoneName")?.value;
    if (!name) return null;
    if (name === "GMT" || name === "UTC") return 0;
    const parts = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
    return parts
      ? (parts[1] === "-" ? -1 : 1) * (Number(parts[2]) * 60 + (parts[3] ? Number(parts[3]) : 0))
      : null;
  } catch {
    return null;
  }
}

interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

function calendarDay(date: Date, timeZone?: string): CalendarDay {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: read("year"), month: read("month") - 1, day: read("day") };
}

/** The instant the time names on the reader's calendar day `now`. */
function resolveInstant(
  time: ZonedTime,
  now: Date,
  timeZone?: string,
): { utcMs: number; offsetMinutes: number; today: CalendarDay } | null {
  const today = calendarDay(now, timeZone);
  const wallMs = Date.UTC(today.year, today.month, today.day, time.hour, time.minute, time.second);
  let offset: number | null;
  if ("minutes" in time.zone) {
    offset = time.zone.minutes;
  } else {
    const guess = zoneOffsetAt(time.zone.iana, now.getTime());
    if (guess === null) return null;
    offset = zoneOffsetAt(time.zone.iana, wallMs - guess * 60_000);
  }
  return offset === null ? null : { utcMs: wallMs - offset * 60_000, offsetMinutes: offset, today };
}

function localOffsetAt(ms: number): number {
  return -new Date(ms).getTimezoneOffset();
}

/** True when the time's zone is not the reader's, so it is worth converting. */
export function isForeignZonedTime(time: ZonedTime, now: Date = new Date()): boolean {
  const resolved = resolveInstant(time, now);
  if (!resolved) return false;
  const local = localOffsetAt(resolved.utcMs);
  if (local === resolved.offsetMinutes) return false;
  return !(AMBIGUOUS_ZONE_OFFSETS[time.zoneLabel]?.includes(local) ?? false);
}

export interface ZonedTimeDescription {
  /** The time in the reader's zone, e.g. "4:00 AM". */
  timeText: string;
  /** The reader's zone, e.g. "GMT+8". */
  zoneText: string;
  /** +1 when it falls on the reader's next day, -1 on the day before. */
  dayDelta: -1 | 0 | 1;
}

export function describeZonedTime(
  time: ZonedTime,
  options: { now: Date; locale: string; outputTimeZone?: string },
): ZonedTimeDescription | null {
  const resolved = resolveInstant(time, options.now, options.outputTimeZone);
  if (!resolved) return null;
  const instant = new Date(resolved.utcMs);
  const zoneOption = options.outputTimeZone ? { timeZone: options.outputTimeZone } : {};
  const timeText = new Intl.DateTimeFormat(options.locale, {
    ...zoneOption,
    hour: "numeric",
    minute: "2-digit",
    ...(time.second ? { second: "2-digit" } : {}),
  }).format(instant);
  let zoneText = "";
  try {
    zoneText =
      new Intl.DateTimeFormat(options.locale, { ...zoneOption, timeZoneName: "short" })
        .formatToParts(instant)
        .find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    zoneText = "";
  }
  const day = calendarDay(instant, options.outputTimeZone);
  const delta = Math.round(
    (Date.UTC(day.year, day.month, day.day) -
      Date.UTC(resolved.today.year, resolved.today.month, resolved.today.day)) /
      86_400_000,
  );
  return { timeText, zoneText, dayDelta: delta > 0 ? 1 : delta < 0 ? -1 : 0 };
}

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const SKIPPED_TAGS = new Set(["pre", "code", "a", "script", "style", ZONED_TIME_ELEMENT_TAG]);
// The transcript's find layer wraps each text run in this element; a time keeps a
// find wrapper of its own inside the <moss-time> so search still highlights it.
const FIND_TEXT_TAG = "chat-find-text";
const FIND_TEXT_START_PROPERTY = "dataChatFindTextStart";

function timeElement(original: string, inner: HastNode): HastNode {
  return {
    type: "element",
    tagName: ZONED_TIME_ELEMENT_TAG,
    properties: { dataOriginal: original },
    children: [inner],
  };
}

function splitText(
  value: string,
  makeText: (from: number, to: number) => HastNode,
): HastNode[] | null {
  const times = findZonedTimes(value).filter((match) => !match.dated);
  if (times.length === 0) return null;
  const parts: HastNode[] = [];
  let cursor = 0;
  for (const { index, parsed } of times) {
    if (index > cursor) parts.push(makeText(cursor, index));
    const end = index + parsed.original.length;
    parts.push(timeElement(parsed.original, makeText(index, end)));
    cursor = end;
  }
  if (cursor < value.length) parts.push(makeText(cursor, value.length));
  return parts;
}

function wrapChildren(node: HastNode): void {
  const children = node.children;
  if (!children) return;
  const next: HastNode[] = [];
  let changed = false;
  for (const child of children) {
    if (child.type === "element" && child.tagName === FIND_TEXT_TAG) {
      const only = child.children?.length === 1 ? child.children[0] : undefined;
      if (only?.type === "text" && only.value) {
        const value = only.value;
        const start = Number.parseInt(
          String(child.properties?.[FIND_TEXT_START_PROPERTY] ?? ""),
          10,
        );
        const split = splitText(value, (from, to) => ({
          ...child,
          properties: {
            ...child.properties,
            ...(Number.isFinite(start) ? { [FIND_TEXT_START_PROPERTY]: String(start + from) } : {}),
          },
          children: [{ type: "text", value: value.slice(from, to) }],
        }));
        if (split) {
          changed = true;
          next.push(...split);
          continue;
        }
      }
      next.push(child);
      continue;
    }
    if (child.type === "element") {
      if (!SKIPPED_TAGS.has(child.tagName ?? "")) wrapChildren(child);
      next.push(child);
      continue;
    }
    if (child.type === "text" && child.value) {
      const value = child.value;
      const split = splitText(value, (from, to) => ({
        type: "text",
        value: value.slice(from, to),
      }));
      if (split) {
        changed = true;
        next.push(...split);
        continue;
      }
    }
    next.push(child);
  }
  if (changed) node.children = next;
}

export function rehypeZonedTimes() {
  return (tree: HastNode) => {
    wrapChildren(tree);
  };
}
