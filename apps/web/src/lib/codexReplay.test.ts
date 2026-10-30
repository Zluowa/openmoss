import { MessageId, TurnId, type CodexReplayTurn } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types";
import { makeActivity } from "../storeTestFixtures";
import { deriveTimelineEntries, deriveWorkLogEntries, type TimelineEntry } from "../workLog";
import { deriveMessagesTimelineRows } from "../components/chat/MessagesTimeline.logic";
import { applyCodexReplayOrder, deriveCodexReplayTurns } from "./codexReplay";
const time = "2026-09-06T08:55:04.000Z";
const message = (id: string, role: ChatMessage["role"]): ChatMessage => ({
  id: MessageId.makeUnsafe(id),
  role,
  text: id,
  turnId: TurnId.makeUnsafe("native-turn"),
  createdAt: time,
  completedAt: time,
  streaming: false,
});
const turn: CodexReplayTurn = {
  version: 1,
  turnId: TurnId.makeUnsafe("native-turn"),
  status: "completed",
  startedAt: time,
  completedAt: time,
  durationMs: 77544,
  terminalMessageId: MessageId.makeUnsafe("final"),
  entries: ["opening", "early-final", "steering", "commentary", "shell", "final"].map((id) => ({
    id,
    kind: id === "shell" ? "activity" : "message",
  })),
};
const options = {
  isWorking: false,
  worktreeSetup: null,
  worktreeSetupOpen: false,
  activeTurnInProgress: false,
  activeTurnStartedAt: null,
  turnDiffSummaryByAssistantMessageId: new Map(),
  revertTurnCountByUserMessageId: new Map(),
};
const messages = [
  message("opening", "user"),
  message("early-final", "assistant"),
  message("steering", "user"),
  message("commentary", "assistant"),
  message("final", "assistant"),
];
const shell = {
  id: "shell",
  turnId: turn.turnId,
  createdAt: time,
  label: "Ran command",
  tone: "tool" as const,
  itemType: "command_execution" as const,
  command: "wc -c hello.txt",
};

describe("native replay timeline", () => {
  it("uses item order when timestamps tie and folds steering inside the native turn", () => {
    const timelineEntries = applyCodexReplayOrder(deriveTimelineEntries(messages, [], [shell]), [
      turn,
    ]);
    expect(timelineEntries.map((row) => row.id)).toEqual(turn.entries.map((entry) => entry.id));
    const rows = deriveMessagesTimelineRows({ ...options, timelineEntries });
    expect(rows.map((row) => row.id)).toEqual(["opening", "final"]);
    const final = rows.at(-1)!;
    expect(final.kind).toBe("message");
    if (final.kind !== "message") return;
    expect(final.collapsedTurnItems?.map((item) => item.id)).toEqual([
      "early-final",
      "steering",
      "commentary",
      "shell",
    ]);
    expect(final.collapsedTurnItems?.find((item) => item.id === "steering")).toMatchObject({
      kind: "narration",
      message: { role: "user" },
    });
  });

  it("keeps incomplete replay turns inline and retains stable annotations", () => {
    const live = { ...turn, status: "inProgress" };
    const first = applyCodexReplayOrder(deriveTimelineEntries(messages, [], [shell]), [live]);
    const second = applyCodexReplayOrder(deriveTimelineEntries(messages, [], [shell]), [live]);
    expect(first.filter((row) => row.kind === "message").map((row) => row.message)).toEqual(
      second.filter((row) => row.kind === "message").map((row) => row.message),
    );
    const rows = deriveMessagesTimelineRows({ ...options, timelineEntries: first });
    expect(rows.some((row) => row.kind === "message" && row.collapsedTurnItems)).toBe(false);
  });

  it("keeps metadata invisible, ignores malformed metadata, and removes old transport duplicates", () => {
    const good = makeActivity({
      kind: "codex.turn.replayed",
      // Encode through JSON so optional entry fields become durable Json.
      payload: JSON.parse(JSON.stringify(turn)),
    });
    const bad = makeActivity({ kind: "codex.turn.replayed", payload: { version: 999 } });
    expect(deriveCodexReplayTurns([good, bad])).toEqual([turn]);
    expect(deriveWorkLogEntries([good, bad], undefined)).toEqual([]);
    const legacy = message("workspace-import:old:hidden", "user");
    const rows: TimelineEntry[] = [legacy, ...messages].map((message) => ({
      id: message.id,
      kind: "message",
      message,
      createdAt: time,
    }));
    expect(applyCodexReplayOrder(rows, [turn]).map((row) => row.id)).not.toContain(legacy.id);
    expect(applyCodexReplayOrder(rows, [])).toBe(rows);
  });
});
