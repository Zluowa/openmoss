import { MessageId, TurnId } from "@moss/contracts";
import {
  SLIDES_DECK_ACTIVITY_KIND,
  slidesDeckActivityPayload,
  THREAD_OUTPUT_FILE_ACTIVITY_KIND,
  threadOutputFileActivityPayload,
  type SlidesDeckArtifact,
} from "@moss/shared/chatArtifactActivity";
import { describe, expect, it } from "vitest";

import { deriveMessagesTimelineRows } from "../components/chat/MessagesTimeline.logic";
import type { TimelineEntry, WorkLogEntry } from "../session-logic";
import {
  chatArtifactFromActivity,
  chatArtifactsEqual,
  collectTurnChatArtifacts,
  deckCardPageIds,
  visibleChatArtifacts,
  type ChatArtifact,
} from "./chatArtifacts";

const deck = (change: SlidesDeckArtifact["change"], slideCount = 5): SlidesDeckArtifact => ({
  pageId: "page-1",
  scopeSpaceId: null,
  title: "季度回顾",
  slideCount,
  coverText: "季度回顾 · 2026 年",
  change,
});
const deckArtifact = (change: SlidesDeckArtifact["change"], slideCount?: number): ChatArtifact => ({
  kind: "deck",
  deck: deck(change, slideCount),
});
const fileArtifact: ChatArtifact = {
  kind: "file",
  file: {
    file: "out/季度回顾.pptx",
    name: "季度回顾.pptx",
    path: "C:/work/out/季度回顾.pptx",
    bytes: 52_000,
    sha256: "a".repeat(64),
  },
};

describe("chatArtifactFromActivity", () => {
  it("reads decks and exported files from the gateway's activities only", () => {
    expect(
      chatArtifactFromActivity({
        kind: SLIDES_DECK_ACTIVITY_KIND,
        payload: slidesDeckActivityPayload(deck("created")),
      }),
    ).toEqual(deckArtifact("created"));
    expect(
      chatArtifactFromActivity({
        kind: THREAD_OUTPUT_FILE_ACTIVITY_KIND,
        payload: threadOutputFileActivityPayload(
          (fileArtifact as Extract<ChatArtifact, { kind: "file" }>).file,
        ),
      }),
    ).toEqual(fileArtifact);
    // A tool's own output, or a malformed payload, never makes a card.
    expect(
      chatArtifactFromActivity({
        kind: "tool.completed",
        payload: { slidesDeck: deck("created") },
      }),
    ).toBeUndefined();
    expect(
      chatArtifactFromActivity({
        kind: SLIDES_DECK_ACTIVITY_KIND,
        payload: { slidesDeck: { ...deck("created"), slideCount: -1 } },
      }),
    ).toBeUndefined();
  });
});

describe("collectTurnChatArtifacts", () => {
  it("keeps one card per deck with its newest state, still marked as created", () => {
    const byTurn = collectTurnChatArtifacts([
      { id: "a", turnId: "t1", chatArtifact: deckArtifact("created", 5) },
      { id: "b", turnId: "t1", chatArtifact: deckArtifact("edited", 6) },
      { id: "c", turnId: "t1", chatArtifact: fileArtifact },
      { id: "d", turnId: "t2", chatArtifact: deckArtifact("proposed", 6) },
      { id: "e", turnId: null, chatArtifact: fileArtifact },
    ]);
    expect(byTurn.get("t1")).toEqual([
      { id: "a", artifact: deckArtifact("created", 6) },
      { id: "c", artifact: fileArtifact },
    ]);
    expect(byTurn.get("t2")).toEqual([{ id: "d", artifact: deckArtifact("proposed", 6) }]);
    expect(byTurn.size).toBe(2);
  });

  it("does not draw a file twice when the answer already links it", () => {
    const artifacts = [
      { id: "a", artifact: deckArtifact("created") },
      { id: "c", artifact: fileArtifact },
    ];
    const linked =
      "下载：[季度回顾.pptx](/api/thread-output?threadId=t&file=out%2F%E5%AD%A3%E5%BA%A6%E5%9B%9E%E9%A1%BE.pptx)";
    expect(visibleChatArtifacts(artifacts, linked)).toEqual([artifacts[0]]);
    expect(visibleChatArtifacts(artifacts, "已导出季度回顾.pptx")).toEqual(artifacts);
    expect([...deckCardPageIds(artifacts)]).toEqual(["page-1"]);
    expect(deckCardPageIds(artifacts)).toBe(deckCardPageIds(artifacts));
    expect(deckCardPageIds(undefined).size).toBe(0);
    expect(chatArtifactsEqual(artifacts, [...artifacts])).toBe(true);
    expect(
      chatArtifactsEqual(artifacts, [
        { id: "a", artifact: deckArtifact("created", 9) },
        artifacts[1]!,
      ]),
    ).toBe(false);
  });
});

describe("deck and file cards in the transcript rows", () => {
  const base = {
    isWorking: false,
    worktreeSetup: null,
    worktreeSetupOpen: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  };
  const turnId = TurnId.makeUnsafe("t1");
  const work = (id: string, createdAt: string, entry: Partial<WorkLogEntry>): TimelineEntry => ({
    id,
    kind: "work",
    createdAt,
    entry: { id, createdAt, label: id, tone: "info", turnId, ...entry },
  });
  const message = (
    id: string,
    role: "user" | "assistant",
    createdAt: string,
    text: string,
  ): TimelineEntry => ({
    id,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      createdAt,
      streaming: false,
      turnId,
      ...(role === "assistant" ? { completedAt: "2026-11-08T10:00:09Z" } : {}),
    },
  });

  it("puts the turn's deck and file cards under its answer, not in the work rows", () => {
    const rows = deriveMessagesTimelineRows({
      ...base,
      timelineEntries: [
        message("u1", "user", "2026-11-08T10:00:00Z", "做一个季度回顾 PPT"),
        work("tool", "2026-11-08T10:00:01Z", { label: "moss_slides_create", tone: "tool" }),
        work("deck", "2026-11-08T10:00:02Z", { chatArtifact: deckArtifact("created") }),
        work("file", "2026-11-08T10:00:03Z", { chatArtifact: fileArtifact }),
        message("a1", "assistant", "2026-11-08T10:00:04Z", "做好了。"),
      ],
    });
    const answer = rows.find((row) => row.kind === "message" && row.message.role === "assistant");
    expect(answer?.kind === "message" ? answer.chatArtifacts : undefined).toEqual([
      { id: "deck", artifact: deckArtifact("created") },
      { id: "file", artifact: fileArtifact },
    ]);
    const workEntries = rows.flatMap((row) =>
      row.kind === "work"
        ? row.groupedEntries
        : row.kind === "message"
          ? [
              ...(row.leadingWorkEntries ?? []),
              ...(row.inlineWorkEntries ?? []),
              ...(row.collapsedTurnItems ?? []).flatMap((item) =>
                item.kind === "work" ? [item.entry] : [],
              ),
            ]
          : [],
    );
    expect(workEntries.map((entry) => entry.id)).toEqual(["tool"]);
  });
});
