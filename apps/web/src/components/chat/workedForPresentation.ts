// FILE: workedForPresentation.ts
// Purpose: Pure duration and fallback helpers for a settled turn's Worked-for summary.
// Layer: Chat presentation helpers

import { formatDurationUnit, type DurationUnit } from "~/lib/timeFormat";

export interface WorkedPauseInterval {
  readonly startMs: number;
  readonly endMs: number;
}

export type WorkedForSummary =
  | { kind: "duration"; timeLabel: string; durationMs: number }
  | { kind: "previous-messages"; count: number; plural: "one" | "many" };

/** Merge overlapping or adjacent pause intervals so multi-approval waits subtract once. */
export function mergeWorkedPauseIntervals(
  intervals: ReadonlyArray<WorkedPauseInterval>,
): WorkedPauseInterval[] {
  const valid = intervals
    .filter(
      (interval) =>
        Number.isFinite(interval.startMs) &&
        Number.isFinite(interval.endMs) &&
        interval.endMs > interval.startMs,
    )
    .toSorted((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged: WorkedPauseInterval[] = [];
  for (const interval of valid) {
    const previous = merged.at(-1);
    if (previous && interval.startMs <= previous.endMs) {
      merged[merged.length - 1] = {
        startMs: previous.startMs,
        endMs: Math.max(previous.endMs, interval.endMs),
      };
    } else {
      merged.push({ startMs: interval.startMs, endMs: interval.endMs });
    }
  }
  return merged;
}

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
 * Return active worked duration excluding any merged pause intervals (such as
 * waiting for user approval or user input) that overlap `[startedAt, completedAt]`.
 */
export function computeActiveWorkedDurationMs(
  startedAt: string | number | Date | null | undefined,
  completedAt: string | number | Date | null | undefined,
  pausedIntervals?: ReadonlyArray<WorkedPauseInterval> | null | undefined,
): number | null {
  const totalMs = computeWorkedDurationMs(startedAt, completedAt);
  if (totalMs === null) return null;
  if (!pausedIntervals || pausedIntervals.length === 0) return totalMs;
  const startMs = toTimestampMs(startedAt!);
  const completedMs = toTimestampMs(completedAt!);
  if (startMs === null || completedMs === null || completedMs <= startMs) return totalMs;
  const merged = mergeWorkedPauseIntervals(pausedIntervals);
  let pausedMs = 0;
  for (const interval of merged) {
    const overlapStart = Math.max(startMs, interval.startMs);
    const overlapEnd = Math.min(completedMs, interval.endMs);
    if (overlapEnd > overlapStart) {
      pausedMs += overlapEnd - overlapStart;
    }
  }
  return Math.max(totalMs - pausedMs, 0);
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

function formatUnit(value: number, unit: DurationUnit, locale: string): string {
  return formatDurationUnit(value, unit, locale);
}
