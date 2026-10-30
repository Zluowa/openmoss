// FILE: workedForPresentation.ts
// Purpose: Pure duration and fallback helpers for a settled turn's Worked-for summary.
// Layer: Chat presentation helpers

export type WorkedForSummary =
  | { kind: "duration"; timeLabel: string; durationMs: number }
  | { kind: "previous-messages"; count: number; plural: "one" | "many" };

/**
 * Format an elapsed duration with the same narrow Intl units used by Codex.
 * Durations are floored to whole seconds and zero-valued trailing units are
 * omitted, while an empty/under-second duration is represented as 0 seconds.
 */
export function formatWorkedDuration(elapsedMs: number, locale = "en-US"): string {
  const totalSeconds = Math.floor(Math.max(elapsedMs, 0) / 1000);
  if (totalSeconds < 60) {
    return formatUnit(totalSeconds, "second", locale);
  }

  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor(totalSeconds / 3_600) % 24;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) parts.push(formatUnit(days, "day", locale));
  if (hours > 0) parts.push(formatUnit(hours, "hour", locale));
  if (minutes > 0) parts.push(formatUnit(minutes, "minute", locale));
  if (seconds > 0) parts.push(formatUnit(seconds, "second", locale));

  return parts.join(" ") || formatUnit(0, "second", locale);
}

/** Return a valid non-negative duration only when both timestamps are usable. */
export function computeWorkedDurationMs(
  startedAt: string | number | Date | null | undefined,
  completedAt: string | number | Date | null | undefined,
): number | null {
  if (startedAt == null || completedAt == null) return null;
  const startMs = toTimestampMs(startedAt);
  const completedMs = toTimestampMs(completedAt);
  if (startMs === null || completedMs === null) return null;
  return Math.max(completedMs - startMs, 0);
}

/**
 * Use the number of folded items plus the visible final answer for the no-time
 * fallback. Codex keeps singular/plural selection explicit in translations.
 */
export function resolveWorkedForSummary(input: {
  workedDurationMs?: number | null | undefined;
  foldedItemCount: number;
  includesFinalAnswer?: boolean;
  locale?: string;
}): WorkedForSummary {
  const durationMs = input.workedDurationMs;
  if (durationMs != null && Number.isFinite(durationMs) && durationMs >= 0) {
    return {
      kind: "duration",
      durationMs,
      timeLabel: formatWorkedDuration(durationMs, input.locale),
    };
  }

  const foldedItemCount = Number.isFinite(input.foldedItemCount)
    ? Math.max(0, Math.floor(input.foldedItemCount))
    : 0;
  const count = Math.max(1, foldedItemCount + (input.includesFinalAnswer === false ? 0 : 1));
  return { kind: "previous-messages", count, plural: count === 1 ? "one" : "many" };
}

function toTimestampMs(value: string | number | Date): number | null {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatUnit(value: number, unit: Intl.RelativeTimeFormatUnit, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "narrow",
  });
  return formatter.format(value);
}
