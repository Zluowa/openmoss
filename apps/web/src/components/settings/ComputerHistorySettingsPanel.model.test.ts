import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SETTINGS,
  browserPermissionSubtitle,
  clearScopeQuestionKey,
  extractComputerHistoryErrorCode,
  dateHeading,
  fallbackApplicationName,
  formatTimelineEntryTime,
  formatTimelineIntervalTooltip,
  isComputerHistoryApplicationIncluded,
  normalizeHostInput,
  segmentExampleText,
  timelineDayGroups,
  timelineHasGap,
  toggleHighlightedApp,
  toggleTimelineCluster,
} from "./ComputerHistorySettingsPanel.model";

const translate = (key: string) =>
  ({
    "settings.history.morning": "Morning",
    "settings.history.afternoon": "Afternoon",
    "settings.history.evening": "Evening",
    "settings.history.overnight": "Overnight",
  })[key] ?? key;

function entry(
  id: string,
  startMs: number,
  endMs: number,
  summaryLevel: "ten_minute" | "six_hour" = "ten_minute",
) {
  return {
    id,
    summaryLevel,
    interval: { startMs, endMs },
    title: id,
    description: id,
    applications: [
      {
        bundleIdentifier: `com.example.${id}`,
        displayName: id,
      },
    ],
    memoryFilePath: `/tmp/${id}.md`,
  } as const;
}

describe("Computer History settings model", () => {
  const format = (key: string, values?: Record<string, string | number>) =>
    ({
      "settings.history.browser.allWebsites": "All websites",
      "settings.history.browser.allButWebsite": "All but {count} website",
      "settings.history.browser.allButWebsites": "All but {count} websites",
      "settings.history.browser.noWebsites": "No websites",
      "settings.history.browser.onlyWebsite": "Only {count} website",
      "settings.history.browser.onlyWebsites": "Only {count} websites",
    })[key]?.replace("{count}", String(values?.count ?? "")) ?? key;

  it("keeps punctuation and whitespace with the preceding word cadence", () => {
    expect(segmentExampleText("Hello, world!", "en")).toEqual([
      { text: "Hello", delayIndex: 0 },
      { text: ",", delayIndex: 0 },
      { text: " ", delayIndex: 0 },
      { text: "world", delayIndex: 1 },
      { text: "!", delayIndex: 1 },
    ]);
  });

  it("uses long weekday/month and omits the year for older groups", () => {
    const now = new Date(2026, 7, 20, 12, 0, 0, 0).getTime();
    const older = new Date(2024, 0, 4, 12, 0, 0, 0).getTime();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const heading = dateHeading(older, (key) => key, "en-US");
      expect(heading).toMatch(/Thursday/u);
      expect(heading).toMatch(/January/u);
      expect(heading).toMatch(/4/u);
      expect(heading).not.toContain("2024");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps punctuation cadence when Intl.Segmenter is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    try {
      expect(segmentExampleText("Hello, world!", "en")).toEqual([
        { text: "Hello,", delayIndex: 0 },
        { text: " ", delayIndex: 0 },
        { text: "world!", delayIndex: 1 },
      ]);
    } finally {
      if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor);
    }
  });

  it("maps browser subtitles and exact clear questions", () => {
    expect(browserPermissionSubtitle(true, "block", "allow", 0, format)).toBe("All websites");
    expect(browserPermissionSubtitle(true, "block", "allow", 1, format)).toBe("All but 1 website");
    expect(browserPermissionSubtitle(true, "block", "allow", 2, format)).toBe("All but 2 websites");
    expect(browserPermissionSubtitle(true, "block", "block", 0, format)).toBe("No websites");
    expect(browserPermissionSubtitle(true, "block", "block", 1, format)).toBe("Only 1 website");
    expect(browserPermissionSubtitle(false, "block", "allow", 1, format)).toBeNull();
    expect(clearScopeQuestionKey("all")).toBe("settings.history.clearQuestion.all");
    expect(fallbackApplicationName("com.example.Editor")).toBe("Editor");
  });

  it("extracts native error codes through AggregateError and causes", () => {
    expect(
      extractComputerHistoryErrorCode(
        new AggregateError([new Error("AEGetDesc failed with -1743")]),
      ),
    ).toBe("-1743");
    expect(
      extractComputerHistoryErrorCode(
        new Error("Codex Computer Use Apple Event error 1001: denied"),
      ),
    ).toBe("1001");
    expect(extractComputerHistoryErrorCode(new Error("other"))).toBeNull();
  });

  it("normalizes website rules to hostnames", () => {
    expect(normalizeHostInput("HTTPS://Example.com/path?q=1")).toBe("example.com");
    expect(normalizeHostInput("example.com")).toBe("example.com");
    expect(normalizeHostInput("")).toBeNull();
    expect(normalizeHostInput("not a host")).toBeNull();
    expect(normalizeHostInput("https://EXAMPLE.com:443/private")).toBe("example.com");
    expect(normalizeHostInput("   ")).toBeNull();
  });

  it("formats exact Codex ten-minute and six-hour time displays", () => {
    const tenStart = new Date(2026, 7, 19, 8, 1, 0, 0).getTime();
    const tenMinute = entry("ten", tenStart, tenStart + 10 * 60 * 1_000);
    expect(formatTimelineEntryTime(tenMinute, translate)).toMatch(/8:01/);
    expect(formatTimelineIntervalTooltip(tenMinute, "en-US")).toMatch(/8:01.*8:11/);
    const sixStart = new Date(2026, 7, 19, 8, 0, 0, 0).getTime();
    const sixHour = entry("six", sixStart, sixStart + 6 * 60 * 60 * 1_000, "six_hour");
    expect(formatTimelineEntryTime(sixHour, translate)).toBe("Morning");
    expect(formatTimelineIntervalTooltip(sixHour, "en-US")).toMatch(/8:00.*2:00/);
  });

  it("groups formal entries by local day and keeps newest intervals first", () => {
    const entries = [
      entry(
        "older",
        new Date("2026-08-18T23:50:00").getTime(),
        new Date("2026-08-19T00:00:00").getTime(),
      ),
      entry(
        "newer",
        new Date("2026-08-19T09:10:00").getTime(),
        new Date("2026-08-19T09:20:00").getTime(),
      ),
      entry(
        "same-day-older",
        new Date("2026-08-19T08:10:00").getTime(),
        new Date("2026-08-19T08:20:00").getTime(),
      ),
    ];
    const groups = timelineDayGroups(entries);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.entries.map((item) => item.id)).toEqual(["newer", "same-day-older"]);
    expect(groups[1]?.entries.map((item) => item.id)).toEqual(["older"]);
  });

  it("uses only adjacent exact intervals for rail gaps", () => {
    const previous = entry("newer", 300, 400);
    const current = entry("current", 100, 200);
    const next = entry("older", 0, 50);
    expect(timelineHasGap(previous, current, next)).toEqual({ before: true, after: true });
    expect(
      timelineHasGap(entry("touching", 200, 300), current, entry("touching-old", 0, 100)),
    ).toEqual({ before: false, after: false });
  });

  it("keeps collapse/highlight transitions and one policy action deterministic", () => {
    const collapsed = toggleTimelineCluster(new Set<string>(), "today:10m");
    expect(collapsed.has("today:10m")).toBe(true);
    expect(toggleTimelineCluster(collapsed, "today:10m").has("today:10m")).toBe(false);
    expect(toggleHighlightedApp(null, "com.example.editor")).toBe("com.example.editor");
    expect(toggleHighlightedApp("com.example.editor", "com.example.editor")).toBeNull();
    expect(isComputerHistoryApplicationIncluded(DEFAULT_SETTINGS, "com.example.editor")).toBe(true);
    const excluded = {
      ...DEFAULT_SETTINGS,
      observation: { ...DEFAULT_SETTINGS.observation, blocklist: ["com.example.editor"] },
    };
    expect(isComputerHistoryApplicationIncluded(excluded, "com.example.editor")).toBe(false);
  });
});
