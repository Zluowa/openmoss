// FILE: workRunNarration.test.ts
// Purpose: One work log for every provider. The same turn (think, run, think,
//          read, think, search, think, edit) arrives in each provider's
//          persisted activity shape and must reach the transcript as one folded
//          run with the reasoning inside it, never as single rows split by
//          each thought (the owner's 2026-11-21 report).
// Layer: Web chat presentation tests

import { describe, expect, it } from "vitest";

import { codexOwnerWorkEntries } from "../../test/fixtures/codexOwnerImageTurn.timeline";
import { makeActivity } from "../../storeTestFixtures";
import {
  INTERLEAVED_TURN,
  WORK_RUN_TURN_ID,
  WORK_RUN_PROVIDERS,
  workRunActivities,
  workRunEntries,
} from "../../test/fixtures/providerWorkRun.fixture";
import { formatWorkRunNarrationLine, isWorkRunNarrationEntry } from "./agentActivity.logic";
import { planWorkEntryRenderChunks } from "./MessagesTimeline.logic";
import { classifyToolCallSummaryCategory } from "./toolCallGroup.logic";

describe("one work log for every provider", () => {
  for (const provider of WORK_RUN_PROVIDERS) {
    it(provider + ": a turn that thinks between its calls folds into one run", () => {
      const entries = workRunEntries(workRunActivities(provider, INTERLEAVED_TURN));
      const plan = planWorkEntryRenderChunks(entries, { tailIsLive: false });
      expect(plan).toHaveLength(1);
      const [run] = plan;
      const calls = run!.entries.filter((entry) => !isWorkRunNarrationEntry(entry));
      expect(calls.map(classifyToolCallSummaryCategory)).toEqual([
        "command",
        "read",
        "search",
        "edit",
      ]);
      // Four kinds read as two named kinds and the rest (upstream cap).
      expect(run!.summary?.label).toBe("Ran a command, read a file, and 2 more actions");
      expect(run!.summary?.entryCount).toBe(4);
      // The thoughts stay in order inside the run, behind its disclosure, each
      // as one quiet line.
      const thoughts = run!.entries.filter(isWorkRunNarrationEntry);
      expect(thoughts.map(formatWorkRunNarrationLine)).toEqual(
        provider === "acp"
          ? []
          : ["Running the tests", "Reading the app", "Searching for settings", "Editing the app"],
      );
    });
  }

  it("folds the owner's real Codex turn into runs instead of one row per call", () => {
    const plan = planWorkEntryRenderChunks(codexOwnerWorkEntries(), { tailIsLive: false });
    // Before: 41 separate rows (every reasoning item split the run). The image
    // card is the only boundary left.
    expect(plan.map((chunk) => (chunk.summary ? "fold" : chunk.entries[0]!.itemType))).toEqual([
      "fold",
      "image_generation",
      "fold",
    ]);
  });

  it("folds one call with its thought, but never thoughts alone", () => {
    const plan = planWorkEntryRenderChunks(
      workRunEntries(
        workRunActivities("codex", [
          { kind: "think", text: "**Checking**" },
          { kind: "command", command: "bun run test" },
        ]),
      ),
      { tailIsLive: false },
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]!.summary?.label).toBe("Ran a command");

    const thoughts = planWorkEntryRenderChunks(
      workRunEntries(
        workRunActivities("codex", [
          { kind: "think", text: "**Checking**" },
          { kind: "think", text: "**Done**" },
        ]),
      ),
      { tailIsLive: false },
    );
    expect(thoughts.every((chunk) => chunk.summary === null)).toBe(true);
    expect(thoughts).toHaveLength(2);
  });
});

describe("formatWorkRunNarrationLine", () => {
  it("shows the newest of stacked step headings, not bold Markdown", () => {
    expect(
      formatWorkRunNarrationLine({
        label: "Reasoning trace",
        detail: "**正在准备透明通道图像**\n\n**正在查看图像生成规范**",
      }),
    ).toBe("正在查看图像生成规范");
    expect(
      formatWorkRunNarrationLine({
        label: "Reasoning trace",
        detail: "## Closing CDP with NO_PROXY\n\nThe proxy was in the way.\n\n<!-- -->",
      }),
    ).toBe("Closing CDP with NO_PROXY");
  });

  it("opens prose without headings with its first paragraph, as plain text", () => {
    expect(
      formatWorkRunNarrationLine({
        label: "Reasoning trace",
        detail: "The user wants **one** layout for `every` agent.\nCheck the mapper.\n\nThen test.",
      }),
    ).toBe("The user wants one layout for every agent. Check the mapper.");
  });

  it("has no line for an empty or comment-only item", () => {
    expect(formatWorkRunNarrationLine({ label: "Reasoning trace", detail: "<!-- -->" })).toBeNull();
  });
});

describe("Claude's tool-use summary", () => {
  it("rides in the run of calls as narration, not as a call or a status line", () => {
    const activities = [
      ...workRunActivities("claudeAgent", [{ kind: "command", command: "bun run test" }]),
      makeActivity({
        id: "provider-tool-summary",
        createdAt: "2026-11-20T16:00:05.000Z",
        kind: "tool.summary",
        summary: "Tool summary",
        tone: "info",
        turnId: WORK_RUN_TURN_ID,
        payload: { detail: "Ran the tests and read the failing file." },
      }),
      ...workRunActivities(
        "claudeAgent",
        [{ kind: "read", path: "src/app.ts" }],
        Date.UTC(2026, 10, 20, 16, 0, 10),
        "claude-after-summary",
      ),
    ];
    const plan = planWorkEntryRenderChunks(workRunEntries(activities), { tailIsLive: false });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.summary?.label).toBe("Ran a command, read a file");
    const summary = plan[0]!.entries.find((entry) => entry.activityKind === "tool.summary");
    expect(summary && isWorkRunNarrationEntry(summary)).toBe(true);
    expect(summary?.tone).toBe("tool");
  });
});
