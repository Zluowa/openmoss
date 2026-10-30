import { describe, expect, it } from "vitest";

import { isCompactionCommandText, isManualCompactionTurnActive } from "./contextCompaction";

const compactionActivity = (turnId: string | null, payload: Record<string, string>) => ({
  kind: "context-compaction",
  turnId: turnId as never,
  payload,
});

describe("isCompactionCommandText", () => {
  it("matches /compact with or without instructions", () => {
    expect(isCompactionCommandText("/compact")).toBe(true);
    expect(isCompactionCommandText("  /compact keep the plan\n")).toBe(true);
  });

  it("rejects other text", () => {
    expect(isCompactionCommandText("/compacting")).toBe(false);
    expect(isCompactionCommandText("please /compact")).toBe(false);
    expect(isCompactionCommandText(undefined)).toBe(false);
  });
});

describe("isManualCompactionTurnActive", () => {
  it("is true while the live turn runs a manual compaction", () => {
    expect(
      isManualCompactionTurnActive({
        activeTurnId: "turn-1",
        activities: [
          compactionActivity("turn-1", {
            itemType: "context_compaction",
            status: "inProgress",
            source: "manual",
          }),
        ],
      }),
    ).toBe(true);
  });

  it("ignores automatic compaction inside ordinary work", () => {
    expect(
      isManualCompactionTurnActive({
        activeTurnId: "turn-1",
        activities: [compactionActivity("turn-1", { status: "inProgress" })],
      }),
    ).toBe(false);
  });

  it("is false once the compaction settles, whatever the activity order", () => {
    for (const terminal of [
      { status: "completed", source: "manual" },
      { status: "failed" },
      { status: "declined" },
      { state: "compacted" },
    ]) {
      const progress = compactionActivity("turn-1", { status: "inProgress", source: "manual" });
      const settled = compactionActivity("turn-1", terminal);
      expect(
        isManualCompactionTurnActive({ activeTurnId: "turn-1", activities: [progress, settled] }),
      ).toBe(false);
      expect(
        isManualCompactionTurnActive({ activeTurnId: "turn-1", activities: [settled, progress] }),
      ).toBe(false);
    }
  });

  it("only considers the live turn", () => {
    const activities = [
      compactionActivity("turn-0", { status: "inProgress", source: "manual" }),
      compactionActivity(null, { status: "inProgress", source: "manual" }),
      {
        kind: "tool.started",
        turnId: "turn-1" as never,
        payload: { status: "inProgress", source: "manual" },
      },
    ];
    expect(isManualCompactionTurnActive({ activeTurnId: "turn-1", activities })).toBe(false);
    expect(isManualCompactionTurnActive({ activeTurnId: null, activities })).toBe(false);
  });
});
