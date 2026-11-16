import { afterEach, describe, expect, it, vi } from "vitest";

import { formatResetsAt, resolveVisibleRateLimitStatus } from "./RateLimitBanner";

describe("rate limit banner reset time", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads long resets in days and hours instead of raw minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T00:00:00.000Z"));
    // 9044 minutes away used to print "Resets in 9044m".
    expect(formatResetsAt("2026-11-17T06:44:00.000Z")).toBe(" Resets in 6d 6h.");
    expect(formatResetsAt("2026-11-11T02:16:30.000Z")).toBe(" Resets in 2h 16m.");
    expect(formatResetsAt("2026-11-11T00:07:00.000Z")).toBe(" Resets in 7m.");
    expect(formatResetsAt("2026-11-11T00:00:20.000Z")).toBe(" Resets soon.");
    expect(formatResetsAt("not a date")).toBe("");
  });
});

describe("rate limit banner visibility", () => {
  const warning = { status: "allowed_warning", utilization: 0.82 } as const;
  const reached = { status: "rejected" } as const;

  it("hides only the early warning when rate limit warnings are off", () => {
    expect(
      resolveVisibleRateLimitStatus(warning, { dismissed: false, showWarnings: false }),
    ).toBeNull();
    expect(resolveVisibleRateLimitStatus(reached, { dismissed: false, showWarnings: false })).toBe(
      reached,
    );
    expect(resolveVisibleRateLimitStatus(warning, { dismissed: false, showWarnings: true })).toBe(
      warning,
    );
  });

  it("keeps a dismissed banner hidden", () => {
    expect(
      resolveVisibleRateLimitStatus(reached, { dismissed: true, showWarnings: true }),
    ).toBeNull();
    expect(
      resolveVisibleRateLimitStatus(null, { dismissed: false, showWarnings: true }),
    ).toBeNull();
  });
});
