import { describe, expect, it } from "vitest";

import {
  computeActiveWorkedDurationMs,
  computeWorkedDurationMs,
  formatWorkedDuration,
  mergeWorkedPauseIntervals,
  resolveWorkedForSummary,
} from "./workedForPresentation";

describe("worked-for duration formatting", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [1_000, "1s"],
    [61_000, "1m 1s"],
    [3_600_000 + 61_000, "1h 1m 1s"],
    [86_400_000 + 3_600_000 + 61_000, "1d 1h 1m 1s"],
  ])("uses narrow English units for %d ms", (elapsedMs, expected) => {
    expect(formatWorkedDuration(elapsedMs, "en-US")).toBe(expected);
  });

  it.each([
    [0, "0 秒"],
    [1_000, "1 秒"],
    [61_000, "1 分钟 1 秒"],
    [3_600_000 + 61_000, "1 小时 1 分钟 1 秒"],
    [86_400_000 + 3_600_000 + 61_000, "1 天 1 小时 1 分钟 1 秒"],
  ])("uses the shared, spaced Simplified Chinese units for %d ms", (elapsedMs, expected) => {
    expect(formatWorkedDuration(elapsedMs, "zh-CN")).toBe(expected);
  });
});

describe("worked-for summary resolution", () => {
  it("keeps zero duration valid and distinct from the no-duration fallback", () => {
    expect(
      resolveWorkedForSummary({ workedDurationMs: 0, foldedItemCount: 4, locale: "en-US" }),
    ).toEqual({ kind: "duration", durationMs: 0, timeLabel: "0s" });
    expect(
      resolveWorkedForSummary({ workedDurationMs: null, foldedItemCount: 4, locale: "en-US" }),
    ).toEqual({ kind: "previous-messages", count: 5, plural: "many" });
  });

  it("selects one/other fallback keys from folded items and final answer", () => {
    expect(resolveWorkedForSummary({ foldedItemCount: 0 })).toMatchObject({
      count: 1,
      plural: "one",
    });
    expect(
      resolveWorkedForSummary({ foldedItemCount: 1, includesFinalAnswer: false }),
    ).toMatchObject({ count: 1, plural: "one" });
    expect(
      resolveWorkedForSummary({ foldedItemCount: 1, includesFinalAnswer: true }),
    ).toMatchObject({ count: 2, plural: "many" });
    expect(resolveWorkedForSummary({ foldedItemCount: 2 })).toMatchObject({
      count: 3,
      plural: "many",
    });
  });
});

describe("worked-for timestamp validation", () => {
  it("floors valid timestamps and rejects missing or invalid completion times", () => {
    expect(computeWorkedDurationMs("2026-08-28T00:00:00.900Z", "2026-08-28T00:00:02.100Z")).toBe(
      1_200,
    );
    expect(computeWorkedDurationMs("2026-08-28T00:00:02Z", "2026-08-28T00:00:01Z")).toBe(0);
    expect(computeWorkedDurationMs("not-a-date", "2026-08-28T00:00:01Z")).toBeNull();
    expect(computeWorkedDurationMs("2026-08-28T00:00:00Z", null)).toBeNull();
  });

  it("merges overlapping pauses and subtracts only pauses inside the active window", () => {
    const startMs = Date.parse("2026-08-28T00:00:00Z");
    const endMs = Date.parse("2026-08-28T00:06:00Z");
    const merged = mergeWorkedPauseIntervals([
      { startMs: startMs + 20_000, endMs: startMs + 120_000 },
      { startMs: startMs + 60_000, endMs: startMs + 260_000 },
      { startMs: startMs + 300_000, endMs: startMs + 290_000 },
    ]);
    expect(merged).toEqual([{ startMs: startMs + 20_000, endMs: startMs + 260_000 }]);
    expect(computeActiveWorkedDurationMs(startMs, endMs, merged)).toBe(120_000);
    // Out-of-bounds pauses clamp to the turn boundaries.
    expect(
      computeActiveWorkedDurationMs(startMs, startMs + 30_000, [
        { startMs: startMs - 10_000, endMs: startMs + 10_000 },
        { startMs: startMs + 25_000, endMs: startMs + 45_000 },
      ]),
    ).toBe(15_000);
  });
});
