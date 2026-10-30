import { describe, expect, it } from "vitest";

import {
  computeWorkedDurationMs,
  formatWorkedDuration,
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
    [0, "0秒"],
    [1_000, "1秒"],
    [61_000, "1分钟 1秒"],
    [3_600_000 + 61_000, "1小时 1分钟 1秒"],
    [86_400_000 + 3_600_000 + 61_000, "1天 1小时 1分钟 1秒"],
  ])("uses narrow Simplified Chinese units for %d ms", (elapsedMs, expected) => {
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
});
