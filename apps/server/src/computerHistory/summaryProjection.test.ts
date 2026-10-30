import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import type { ComputerHistoryObservation } from "@synara/contracts";

import {
  COMPUTER_HISTORY_SIX_HOUR_MS,
  COMPUTER_HISTORY_TEN_MINUTE_MS,
  computerHistorySummaryFilename,
  projectComputerHistoryEntryForModel,
  projectComputerHistory,
} from "./summaryProjection.ts";
import {
  isComputerHistorySummaryFilename,
  resolveComputerHistorySummaryPath,
} from "./summaryResources.ts";

const observation = (capturedAtMs: number, title = "Editing"): ComputerHistoryObservation => ({
  capturedAtMs,
  app: { bundleIdentifier: "com.example.editor", name: "Editor" },
  window: { title },
  activityText: "Worked on the active project",
});

describe("Computer History summary projection", () => {
  it("groups observations into deterministic ten-minute buckets", () => {
    const first = projectComputerHistory(
      [
        { seq: 1, observation: observation(10_001) },
        { seq: 2, observation: observation(20_000) },
        { seq: 3, observation: observation(COMPUTER_HISTORY_TEN_MINUTE_MS + 1, "Reviewing") },
      ],
      { nowMs: 100_000 },
    );
    const second = projectComputerHistory(
      [
        { seq: 3, observation: observation(COMPUTER_HISTORY_TEN_MINUTE_MS + 1, "Reviewing") },
        { seq: 1, observation: observation(10_001) },
        { seq: 2, observation: observation(20_000) },
      ],
      { nowMs: 100_000 },
    );
    expect(first.entries).toHaveLength(2);
    expect(first.entries.map((entry) => entry.id)).toEqual(second.entries.map((entry) => entry.id));
    expect(first.entries[0]).toMatchObject({
      summaryLevel: "ten_minute",
      interval: {
        startMs: 0,
        endMs: COMPUTER_HISTORY_TEN_MINUTE_MS,
      },
      applications: [{ bundleIdentifier: "com.example.editor", displayName: "Editor" }],
    });
    expect(first.intervals.map((interval) => interval.entryCount)).toEqual([2, 1]);
    expect(first.resources.filter((resource) => resource.kind === "6h")).toHaveLength(0);
    expect(
      first.resources.find((resource) => resource.kind === "10min")?.suggestion,
    ).toBeUndefined();
  });

  it("supersedes completed six-hour children but keeps unfinished windows at ten minutes", () => {
    const completedNow = COMPUTER_HISTORY_SIX_HOUR_MS * 2;
    const completed = projectComputerHistory(
      [
        { seq: 1, observation: observation(1_000) },
        { seq: 2, observation: observation(COMPUTER_HISTORY_TEN_MINUTE_MS + 1) },
      ],
      { nowMs: completedNow },
    );
    expect(completed.entries).toHaveLength(1);
    expect(completed.entries[0]?.id).toContain("history-summary-6h-");
    expect(completed.resources.filter((resource) => resource.kind === "10min")).toHaveLength(2);
    const sixHour = completed.resources.filter((resource) => resource.kind === "6h");
    expect(sixHour).toHaveLength(1);
    expect(
      completed.resources
        .filter((resource) => resource.kind === "10min")
        .every((resource) => resource.suggestion === undefined),
    ).toBe(true);
    expect(sixHour.filter((resource) => resource.suggestion !== undefined)).toHaveLength(1);
    expect(sixHour[0]?.suggestion).toMatchObject({ type: "skill", name: expect.any(String) });
    expect(completed.intervals.filter((interval) => interval.kind === "10min")).toHaveLength(2);
    expect(completed.intervals.filter((interval) => interval.kind === "6h")).toHaveLength(1);

    const incomplete = projectComputerHistory(
      [{ seq: 1, observation: observation(COMPUTER_HISTORY_SIX_HOUR_MS + 1) }],
      { nowMs: COMPUTER_HISTORY_SIX_HOUR_MS * 2 - 1 },
    );
    expect(incomplete.entries[0]?.id).toContain("history-summary-10min-");
    expect(incomplete.resources.some((resource) => resource.kind === "6h")).toBe(false);
  });

  it("projects bounded queries from bounded observations without leaking bucket neighbors", () => {
    const completedNow = COMPUTER_HISTORY_SIX_HOUR_MS * 2;
    const outsideTimestamp = 1_000;
    const insideTimestamp = COMPUTER_HISTORY_TEN_MINUTE_MS + 1;
    const projection = projectComputerHistory(
      [
        {
          seq: 1,
          observation: {
            capturedAtMs: outsideTimestamp,
            app: { bundleIdentifier: "com.example.outside", name: "OutsideApp" },
            window: { title: "Outside title" },
            activityText: "Outside activity",
          },
        },
        {
          seq: 2,
          observation: {
            capturedAtMs: insideTimestamp,
            app: { bundleIdentifier: "com.example.inside", name: "InsideApp" },
            window: { title: "Inside title" },
            activityText: "Inside activity",
          },
        },
      ],
      {
        nowMs: completedNow,
        sinceMs: insideTimestamp,
        untilMs: insideTimestamp,
      },
    );

    expect(projection.entries).toHaveLength(1);
    expect(projection.entries[0]).toMatchObject({
      title: "Inside title",
      description: "Inside activity",
      applications: [{ displayName: "InsideApp" }],
    });
    expect(projection.entries[0]?.description).not.toContain("OutsideApp");
    expect(projection.entries[0]?.description).not.toContain("Outside activity");
    expect(projection.intervals).toHaveLength(2);
    expect(projection.intervals.every((interval) => !interval.summary.includes("OutsideApp"))).toBe(
      true,
    );
    expect(
      projection.intervals.every((interval) => !interval.summary.includes("Outside activity")),
    ).toBe(true);

    const fullSixHour = projection.resources.find((resource) => resource.kind === "6h");
    expect(fullSixHour?.description).toContain("Outside activity");
    expect(fullSixHour?.description).toContain("Inside activity");
  });

  it("uses stable UTC resource names and rejects path traversal", () => {
    const filename = computerHistorySummaryFilename("10min", 0);
    expect(filename).toMatch(/^1970-01-01T00-00-00-[a-f0-9]{16}-10min-memory-summary\.md$/u);
    expect(isComputerHistorySummaryFilename(filename)).toBe(true);
    expect(resolveComputerHistorySummaryPath("/tmp/history", filename)).toBe(
      resolve("/tmp/history", "resources", filename),
    );
    expect(resolveComputerHistorySummaryPath("/tmp/history", "../events.moss-history")).toBeNull();
  });

  it("projects only the exact safe model fields and strips local/URL/icon payloads", () => {
    const entry = projectComputerHistory(
      [
        {
          seq: 1,
          observation: {
            capturedAtMs: 10_001,
            app: { bundleIdentifier: "com.example.editor", name: "Editor" },
            window: { title: "Opened /Users/moss/private.md" },
            activityText: "Reviewed local notes without exposing the exact path.",
          },
        },
      ],
      { nowMs: 100_000 },
    ).entries[0]!;
    const modelEntry = projectComputerHistoryEntryForModel({
      ...entry,
      memoryFilePath: "/Users/moss/.moss/resources/private.md",
      applications: entry.applications.map((application, index) =>
        index === 0 ? { ...application, iconDataURL: "data:image/png;base64,AAAA" } : application,
      ),
    });
    expect(modelEntry).toMatchObject({
      summaryLevel: "ten_minute",
      interval: { startMs: 0, endMs: COMPUTER_HISTORY_TEN_MINUTE_MS },
      applications: [{ bundleIdentifier: "com.example.editor", displayName: "Editor" }],
    });
    expect(JSON.stringify(modelEntry)).not.toContain("data:image");
    expect(JSON.stringify(modelEntry)).not.toContain("memoryFilePath");
    expect(JSON.stringify(modelEntry)).not.toContain("/Users/moss");
    expect(JSON.stringify(modelEntry)).not.toContain("token=secret");
    expect(modelEntry).not.toHaveProperty("memoryFilePath");
  });

  it("prefers a safe on-device semantic title and description over metadata fallback", () => {
    const projection = projectComputerHistory(
      [
        {
          seq: 1,
          observation: {
            ...observation(10_001, "Window metadata title"),
            semanticSummary: {
              title: "Editing a project",
              description: "Reviewing high-level work in the editor",
              source: "apple_on_device",
            },
          },
        },
      ],
      { nowMs: 100_000 },
    );
    expect(projection.entries[0]).toMatchObject({
      title: "Editing a project",
      description: "Reviewing high-level work in the editor",
    });
  });
});
