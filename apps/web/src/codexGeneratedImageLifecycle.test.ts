// A Codex image made on a person's own account, as the owner's 2026-11-17 chat
// stored it (round 20261117-owner-test, thread f22bee60). Builds up to 1.0.7
// put the predicted file on the started record as a full artifact; the
// transcript then drew an empty placeholder box for that record which the
// finished picture never replaced.
import { TurnId } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveMessagesTimelineRows,
  groupGeneratedImagesByTurn,
} from "./components/chat/MessagesTimeline.logic";
import { makeActivity } from "./storeTestFixtures";
import { deriveTimelineEntries, deriveWorkLogEntries, type WorkLogEntry } from "./workLog";

const TURN = "01a1e7c1-4ee5-7c51-87dc-bdaac48772ee";
const CALL = "exec-98c98b54-7665-4fdc-b6e9-fe02edc92b99";
const IMAGE =
  "E:\\Codex\\.moss\\runtime\\cross-volume-overlays\\5ce6afd83b1f\\codex-home-overlay\\generated_images\\01a1e7c1-4de6-79d2-b03d-830dd5119c8a\\exec-98c98b54-7665-4fdc-b6e9-fe02edc92b99.png";
const artifact = { kind: "codex.generated_image", path: IMAGE, callId: CALL };

// Exactly the stored payloads.
const storedStarted = makeActivity({
  id: "d5fd58a4-3ebd-41d7-83f0-e42623203827",
  kind: "tool.started",
  summary: "Generated image started",
  turnId: TURN,
  sequence: 41541,
  createdAt: "2026-11-17T04:27:46.359Z",
  payload: {
    itemType: "image_generation",
    status: "inProgress",
    title: "Generated image",
    detail: IMAGE,
    data: artifact,
  },
});
const completed = makeActivity({
  id: "646d28ac-417b-4c81-9584-8e6c25df6621",
  kind: "tool.completed",
  summary: "Generated image",
  turnId: TURN,
  sequence: 41544,
  createdAt: "2026-11-17T04:28:21.341Z",
  payload: {
    itemType: "image_generation",
    status: "completed",
    title: "Generated image",
    detail: IMAGE,
    data: artifact,
  },
});
// What the server sends for an unfinished image from now on.
const started = makeActivity({
  id: "image-started",
  kind: "tool.started",
  summary: "Generated image started",
  turnId: TURN,
  sequence: 41541,
  createdAt: "2026-11-17T04:27:46.359Z",
  payload: {
    itemType: "image_generation",
    status: "inProgress",
    title: "Generated image",
    data: { callId: CALL },
  },
});

const live = { activeTurnId: TurnId.makeUnsafe(TURN), latestTurnState: "running" as const };

function timelineRows(entries: WorkLogEntry[], running: boolean) {
  return deriveMessagesTimelineRows({
    isWorking: running,
    activeTurnInProgress: running,
    activeTurnId: running ? TurnId.makeUnsafe(TURN) : null,
    worktreeSetup: null,
    worktreeSetupOpen: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
    timelineEntries: deriveTimelineEntries([], [], entries),
  });
}

/** Image rows the transcript draws as a bare placeholder box (TimelineCodexNoticeRow). */
function untypedImageRows(rows: ReturnType<typeof deriveMessagesTimelineRows>) {
  return rows
    .flatMap((row) => (row.kind === "work" ? row.groupedEntries : []))
    .filter((entry) => entry.itemType === "image_generation" && !entry.generatedImage);
}

describe("a Codex generated image on the owner's own account", () => {
  for (const [label, first] of [
    ["the stored started record", storedStarted],
    ["the started record the server sends now", started],
  ] as const) {
    it(`shows the finished picture once, with no empty box, after ${label}`, () => {
      const entries = deriveWorkLogEntries([first, completed], TurnId.makeUnsafe(TURN));
      const imageEntries = entries.filter((entry) => entry.itemType === "image_generation");
      expect(imageEntries).toHaveLength(1);
      expect(imageEntries[0]?.generatedImage).toEqual({
        state: "completed",
        path: IMAGE,
        callId: CALL,
      });
      expect(
        groupGeneratedImagesByTurn(deriveTimelineEntries([], [], entries)).get(TURN),
      ).toMatchObject({ pendingImageCount: 0, images: [{ id: CALL, path: IMAGE }] });
      expect(untypedImageRows(timelineRows(entries, false))).toEqual([]);
    });

    it(`waits with the generating placeholder after ${label} while the turn runs`, () => {
      const entries = deriveWorkLogEntries([first], TurnId.makeUnsafe(TURN), live);
      expect(entries.map((entry) => entry.generatedImage)).toEqual([
        { state: "pending", callId: CALL },
      ]);
      expect(
        groupGeneratedImagesByTurn(deriveTimelineEntries([], [], entries)).get(TURN),
      ).toMatchObject({ pendingImageCount: 1, images: [] });
      expect(untypedImageRows(timelineRows(entries, true))).toEqual([]);
    });

    it(`draws nothing for ${label} alone once the turn is over`, () => {
      const entries = deriveWorkLogEntries([first], TurnId.makeUnsafe(TURN));
      expect(untypedImageRows(timelineRows(entries, false))).toEqual([]);
      expect(groupGeneratedImagesByTurn(deriveTimelineEntries([], [], entries)).size).toBe(0);
    });
  }
});
