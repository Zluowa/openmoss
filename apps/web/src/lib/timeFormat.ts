// FILE: timeFormat.ts
// Purpose: The one way Moss writes times a person reads: "time ago" labels (刚刚, 2 分钟前,
//          3 小时前 / just now, 2m ago) and duration units (59 秒, 1 小时 22 分钟 / 59s, 1h 22m),
//          so code review, the Tasks board and the chat timeline never mix "4h" with
//          "4 小时" or "30秒" with "59 秒".
// Layer: Web UI utility
// Exports: currentUiLocale, isChineseLocale, formatDurationUnit, formatTimeAgo

/** zh-CN duration units, written with the standard space after the number ("59 秒"). */
const ZH_DURATION_UNIT = {
  day: "天",
  hour: "小时",
  minute: "分钟",
  second: "秒",
} as const;

export type DurationUnit = keyof typeof ZH_DURATION_UNIT;

const durationUnitFormatters = new Map<string, Intl.NumberFormat>();

/**
 * The language the app is showing right now (MossLocalizationProvider writes it onto
 * <html>), for formatters called outside React. Tests and SSR without a document read "en".
 */
export function currentUiLocale(): string {
  if (typeof document === "undefined") return "en";
  const root = document.documentElement;
  return root.dataset.mossLocale || root.lang || "en";
}

export function isChineseLocale(locale: string): boolean {
  return locale.toLowerCase().split("-")[0] === "zh";
}

/** One duration unit: zh-CN "59 秒", "3 分钟", "1 小时", "2 天"; other languages Intl narrow. */
export function formatDurationUnit(value: number, unit: DurationUnit, locale: string): string {
  if (isChineseLocale(locale)) return `${value} ${ZH_DURATION_UNIT[unit]}`;
  const cacheKey = `${locale}:${unit}`;
  let formatter = durationUnitFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" });
    durationUnitFormatters.set(cacheKey, formatter);
  }
  if (locale.toLowerCase().split("-")[0] === "hu") {
    return formatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => part.value)
      .join("");
  }
  return formatter.format(value);
}

/**
 * How long ago `iso` was: zh-CN 刚刚 / 2 分钟前 / 3 小时前 / 2 天前 / 1 周前 / 5 个月前 / 1 年前,
 * English just now / 2m ago / 3h ago / 2d ago / 1w ago / 5mo ago / 1y ago. Future timestamps
 * (clock skew) read as now. The locale defaults to the language the app is showing.
 */
export function formatTimeAgo(
  iso: string,
  options: { locale?: string | undefined; now?: number | undefined } = {},
): string {
  const locale = options.locale ?? currentUiLocale();
  const zh = isChineseLocale(locale);
  const diff = Math.max(0, (options.now ?? Date.now()) - new Date(iso).getTime());
  const minutes = Number.isFinite(diff) ? Math.floor(diff / 60_000) : 0;
  if (minutes < 1) return zh ? "刚刚" : "just now";
  const span = (count: number, zhUnit: string, enUnit: string) =>
    zh ? `${count} ${zhUnit}前` : `${count}${enUnit} ago`;
  if (minutes < 60) return span(minutes, "分钟", "m");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return span(hours, "小时", "h");
  const days = Math.floor(hours / 24);
  if (days < 7) return span(days, "天", "d");
  if (days < 30) return span(Math.floor(days / 7), "周", "w");
  if (days < 365) return span(Math.floor(days / 30), "个月", "mo");
  return span(Math.floor(days / 365), "年", "y");
}
