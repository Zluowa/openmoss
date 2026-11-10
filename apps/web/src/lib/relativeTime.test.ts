import { describe, expect, it } from "vitest";

import { formatElapsedSpan, formatRelativeTime } from "./relativeTime";

describe("formatRelativeTime", () => {
  it('returns "now" for timestamps less than 1 minute ago', () => {
    const iso = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("now");
  });

  it("returns minutes for timestamps under an hour", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("5m");
  });

  it("returns days for timestamps over a day", () => {
    const iso = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("2d");
  });

  it('returns "now" for future timestamps caused by clock skew', () => {
    const iso = new Date(Date.now() + 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("now");
  });
});

describe("one relative-time format on the Tasks page", () => {
  const now = Date.parse("2026-11-11T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("writes zh-CN units for every span, so 4h and 5h read alike", () => {
    expect(formatRelativeTime(ago(4 * 3_600_000), "zh-CN", now)).toBe("4 小时");
    expect(formatRelativeTime(ago(5 * 3_600_000), "zh-CN", now)).toBe("5 小时");
    expect(formatRelativeTime(ago(7 * 60_000), "zh-CN", now)).toBe("7 分钟");
    expect(formatRelativeTime(ago(20_000), "zh-CN", now)).toBe("刚刚");
  });

  it("measures against the given clock when a locale is passed", () => {
    expect(formatRelativeTime(ago(2 * 86_400_000), "en", now)).toBe("2d");
  });

  it("states elapsed work in the same units, never a clock or 'now'", () => {
    expect(formatElapsedSpan(ago(65 * 60_000), "zh-CN", now)).toBe("1 小时");
    expect(formatElapsedSpan(ago(3 * 60_000), "en", now)).toBe("3m");
    expect(formatElapsedSpan(ago(10_000), "zh-CN", now)).toBe("不到 1 分钟");
    expect(formatElapsedSpan(ago(10_000), "en", now)).toBe("<1m");
  });
});
