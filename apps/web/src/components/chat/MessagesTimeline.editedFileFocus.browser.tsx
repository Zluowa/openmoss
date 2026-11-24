// FILE: MessagesTimeline.editedFileFocus.browser.tsx
// Purpose: The edited-file rows listed under an answer show keyboard focus (the WALK-7 rhythm change moved the
//          shared row onto the tool row's hover/focus group; this row must carry that group too).
//          Runs on the walker's WALK-7 edit entry, with the files taken from the turn summary.
// Layer: Web appearance tests (real Chromium, real Moss CSS).

import "../../index.css";

import { MessageId, TurnId, type OrchestrationThreadActivity } from "@moss/contracts";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { TimelineEntry } from "../../session-logic";
import { walk7Turn, walk7TurnActivities } from "../../test/fixtures/walk7CodexTurn.fixture";
import { deriveWorkLogEntries } from "../../workLog";
import { deriveAgentActivityTimelineState } from "./agentActivity.logic";
import { MessagesTimeline } from "./MessagesTimeline";

const turnId = TurnId.makeUnsafe(walk7Turn.turnId);
const ANSWER_ID = MessageId.makeUnsafe("walk7-answer");
const editEntry = deriveAgentActivityTimelineState(
  deriveWorkLogEntries(walk7TurnActivities as unknown as OrchestrationThreadActivity[], turnId, {
    latestTurnState: "completed",
    latestTurnCompletedAt: walk7Turn.completedAt,
  }),
).timelineWorkEntries.find((entry) => entry.itemType === "file_change")!;

const TIMELINE: TimelineEntry[] = [
  {
    id: "entry-narration",
    kind: "message",
    createdAt: "2026-11-24T09:59:58.000Z",
    message: {
      id: MessageId.makeUnsafe("walk7-narration"),
      role: "assistant",
      text: "I will edit index.js.",
      turnId,
      createdAt: "2026-11-24T09:59:58.000Z",
      completedAt: "2026-11-24T09:59:59.000Z",
      streaming: false,
    },
  },
  {
    id: "entry-edit",
    kind: "work",
    createdAt: "2026-11-24T10:00:00.000Z",
    // A generic file change: the answer lists the turn's files instead of this row.
    entry: { ...editEntry, changedFiles: [] },
  },
  {
    id: "entry-answer",
    kind: "message",
    createdAt: "2026-11-24T10:00:05.000Z",
    message: {
      id: ANSWER_ID,
      role: "assistant",
      text: "done",
      turnId,
      createdAt: "2026-11-24T10:00:05.000Z",
      streaming: true,
    },
  },
];

function Timeline() {
  return (
    <MessagesTimeline
      hasMessages
      isWorking
      activeTurnInProgress
      activeTurnId={turnId}
      activeTurnStartedAt="2026-11-24T09:59:50.000Z"
      timelineEntries={TIMELINE}
      turnDiffSummaryByAssistantMessageId={
        new Map([
          [
            ANSWER_ID,
            {
              turnId,
              completedAt: "2026-11-24T10:00:06.000Z",
              assistantMessageId: ANSWER_ID,
              files: [{ path: "index.js", additions: 2, deletions: 0 }],
            },
          ],
        ])
      }
      nowIso="2026-11-24T10:00:06.000Z"
      expandedWorkGroups={{}}
      onToggleWorkGroup={() => {}}
      onOpenTurnDiff={() => {}}
      revertTurnCountByUserMessageId={new Map()}
      onRevertUserMessage={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme="dark"
      timestampFormat="locale"
      workspaceRoot={undefined}
    />
  );
}

describe("edited-file rows under an answer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps focus visible: tabbing to an edited-file row under the answer shows it (underline and full-strength text)", async () => {
    const host = document.createElement("div");
    host.style.cssText = "display:flex;flex-direction:column;width:700px;height:520px;";
    document.body.append(host);
    await render(<Timeline />, { container: host });

    const rowSelector = 'button:has([data-tool-icon="edit"]) [data-edited-file-name]';
    await expect.poll(() => document.querySelectorAll(rowSelector).length).toBeGreaterThan(0);
    const name = document.querySelector<HTMLElement>(rowSelector)!;
    const button = name.closest("button")!;
    expect(button.getAttribute("data-edited-file-row")).toBeNull();
    const before = {
      underline: getComputedStyle(name).textDecorationLine,
      color: getComputedStyle(name.parentElement!).color,
    };
    expect(before.underline).toBe("none");

    for (let i = 0; i < 40 && document.activeElement !== button; i += 1) {
      await userEvent.tab();
    }
    expect(document.activeElement).toBe(button);
    expect(button.matches(":focus-visible")).toBe(true);
    // Transitions run 150 ms; read after they settle.
    await expect.poll(() => getComputedStyle(name).textDecorationLine).toContain("underline");
    await expect.poll(() => getComputedStyle(name.parentElement!).color).not.toBe(before.color);
  });
});
