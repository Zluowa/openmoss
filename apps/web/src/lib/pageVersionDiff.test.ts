import { describe, expect, it } from "vitest";

import { diffPageLines, historyDayLabel } from "./pageVersionDiff";

describe("diffPageLines", () => {
  it("marks added and removed lines in reading order", () => {
    expect(diffPageLines("# Plan\nGoal: 500\nRisks", "# Plan\nGoal: 750\nRisks\nOwner")).toEqual([
      { kind: "same", text: "# Plan" },
      { kind: "removed", text: "Goal: 500" },
      { kind: "added", text: "Goal: 750" },
      { kind: "same", text: "Risks" },
      { kind: "added", text: "Owner" },
    ]);
  });

  it("treats an empty earlier version as everything added", () => {
    expect(diffPageLines("", "a\nb").filter((line) => line.kind === "added")).toHaveLength(2);
  });

  it("reports no change for the same text", () => {
    expect(diffPageLines("a\r\nb", "a\nb").every((line) => line.kind === "same")).toBe(true);
  });
});

describe("historyDayLabel", () => {
  const now = new Date(2026, 10, 13, 15, 0);
  it("names today and yesterday, then the date", () => {
    expect(historyDayLabel(new Date(2026, 10, 13, 1).toISOString(), now)).toBe("今天");
    expect(historyDayLabel(new Date(2026, 10, 12, 23).toISOString(), now)).toBe("昨天");
    expect(historyDayLabel(new Date(2026, 9, 2).toISOString(), now)).toBe("10月2日");
    expect(historyDayLabel(new Date(2025, 0, 5).toISOString(), now)).toBe("2025年1月5日");
  });
});
