import { describe, expect, it } from "vitest";

import { formatClockDuration, localizeCodexDurationUnits } from "../session-logic";
import { formatWorkedDuration } from "../components/chat/workedForPresentation";
import { formatDurationUnit, formatTimeAgo } from "./timeFormat";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatTimeAgo", () => {
  it("writes zh-CN with the standard spacing and 前", () => {
    expect(formatTimeAgo(ago(20_000), { locale: "zh-CN", now: NOW })).toBe("刚刚");
    expect(formatTimeAgo(ago(2 * 60_000), { locale: "zh-CN", now: NOW })).toBe("2 分钟前");
    expect(formatTimeAgo(ago(4 * 3_600_000), { locale: "zh-CN", now: NOW })).toBe("4 小时前");
    expect(formatTimeAgo(ago(5 * 3_600_000), { locale: "zh-CN", now: NOW })).toBe("5 小时前");
    expect(formatTimeAgo(ago(8 * 86_400_000), { locale: "zh-CN", now: NOW })).toBe("1 周前");
    expect(formatTimeAgo(ago(40 * 86_400_000), { locale: "zh-CN", now: NOW })).toBe("1 个月前");
    expect(formatTimeAgo(ago(400 * 86_400_000), { locale: "zh-CN", now: NOW })).toBe("1 年前");
  });

  it("writes English compact units with ago", () => {
    expect(formatTimeAgo(ago(20_000), { locale: "en", now: NOW })).toBe("just now");
    expect(formatTimeAgo(ago(2 * 60_000), { locale: "en", now: NOW })).toBe("2m ago");
    expect(formatTimeAgo(ago(8 * 86_400_000), { locale: "en", now: NOW })).toBe("1w ago");
  });

  it("reads future timestamps (clock skew) as now", () => {
    expect(formatTimeAgo(new Date(NOW + 60_000).toISOString(), { locale: "zh-CN", now: NOW })).toBe(
      "刚刚",
    );
  });
});

describe("one duration format", () => {
  it("spaces zh-CN units like every other Moss time", () => {
    expect(formatDurationUnit(59, "second", "zh-CN")).toBe("59 秒");
    expect(formatDurationUnit(59, "second", "en")).toBe("59s");
  });

  it("is shared by the live clock, settled headers and worked-for summaries", () => {
    expect(formatClockDuration(30_000, "zh-CN")).toBe("30 秒");
    expect(formatClockDuration(83_000, "zh-CN")).toBe("1 分钟 23 秒");
    expect(formatWorkedDuration(59_000, "zh-CN")).toBe("59 秒");
    expect(localizeCodexDurationUnits("1m 23s", "zh-CN")).toBe("1 分钟 23 秒");
    expect(formatClockDuration(83_000, "en")).toBe("1m 23s");
  });
});
