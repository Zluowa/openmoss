// FILE: relativeTime.ts
// Purpose: Compact locale-aware relative-time labels ("now", "5m", "3h", "2d", "1w", "5mo"; zh-CN
//          "刚刚", "5 分钟", "3 小时", …) for thread, pull request and task lists, the same units
//          for elapsed work ("Worked for 4m"), plus the snooze countdown label.
// Layer: Web UI utility

import type { MossLocaleCode } from "~/appSettings";

export function formatRelativeTime(
  iso: string,
  localeOrNow: MossLocaleCode | number = "en",
  /** The clock to measure against when a locale is passed as the second argument. */
  now?: number,
): string {
  const locale = typeof localeOrNow === "string" ? localeOrNow : "en";
  const nowMs = typeof localeOrNow === "number" ? localeOrNow : (now ?? Date.now());
  const diff = Math.max(0, nowMs - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60_000);
  const isZhCn = locale === "zh-CN";
  if (minutes < 1) return isZhCn ? "刚刚" : "now";
  if (minutes < 60) return isZhCn ? `${minutes} 分钟` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return isZhCn ? `${hours} 小时` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return isZhCn ? `${days} 天` : `${days}d`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return isZhCn ? `${weeks} 周` : `${weeks}w`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return isZhCn ? `${months} 个月` : `${months}mo`;
  }
  const years = Math.floor(days / 365);
  return isZhCn ? `${years} 年` : `${years}y`;
}

/**
 * How long work has run since `startIso`, in the same units as `formatRelativeTime` so one page
 * never mixes "4h" with "4 小时" or a clock-style "1小时 2分钟". Under a minute reads "<1m" /
 * "不到 1 分钟" instead of "now", which would not make sense after "Worked for".
 */
export function formatElapsedSpan(startIso: string, locale: MossLocaleCode, nowMs: number): string {
  const label = formatRelativeTime(startIso, locale, nowMs);
  if (label === "now") return "<1m";
  if (label === "刚刚") return "不到 1 分钟";
  return label;
}

/** Countdown label for a snoozed thread ("28 min left", "1 hr 28 min left", "2 days 1 hr left"). */
export function formatSnoozeRemainingTime(snoozedUntil: string, nowMs: number): string {
  const remainingMs = Date.parse(snoozedUntil) - nowMs;
  if (!(remainingMs > 0)) return "Returning…";
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) return "Less than a minute left";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts =
    days > 0
      ? [`${days} ${days === 1 ? "day" : "days"}`, hours > 0 ? `${hours} hr` : null]
      : [hours > 0 ? `${hours} hr` : null, minutes > 0 ? `${minutes} min` : null];
  return `${parts.filter((part) => part !== null).join(" ")} left`;
}
