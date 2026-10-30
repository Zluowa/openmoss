import { TurnId, type OrchestrationLatestTurn } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { makeActivity } from "../../storeTestFixtures";
import { deriveWorkLogEntries } from "../../workLog";
import { deriveSafetyBufferingState } from "./safetyBuffering";

const turnId = TurnId.makeUnsafe("buffered-turn");
const latestTurn: OrchestrationLatestTurn = {
  turnId,
  state: "running",
  requestedAt: "2026-09-05T00:00:00.000Z",
  startedAt: "2026-09-05T00:00:01.000Z",
  completedAt: null,
  assistantMessageId: null,
};
const activity = (showBufferingUi = true, id = "buffered-turn") =>
  makeActivity({
    id: "safety",
    turnId: id,
    kind: "model.safety-buffering.updated",
    tone: "info",
    payload: {
      threadId: "thread",
      turnId: id,
      model: "original-model",
      fasterModel: "faster-model",
      reasons: ["user_risk"],
      useCases: ["cyber"],
      showBufferingUi,
    },
  });

describe("safety buffering projection", () => {
  it("reads exact active-turn fields and keeps them out of transcript work", () => {
    expect(deriveSafetyBufferingState([activity()], latestTurn)).toEqual({
      turnId,
      model: "original-model",
      fasterModel: "faster-model",
      reasons: ["user_risk"],
      useCases: ["cyber"],
    });
    expect(deriveWorkLogEntries([activity()], turnId)).toEqual([]);
  });
  it("honors a false update and never revives an earlier true update", () => {
    expect(deriveSafetyBufferingState([activity(), activity(false)], latestTurn)).toBeNull();
    expect(deriveSafetyBufferingState([activity(false), activity()], latestTurn)).not.toBeNull();
  });
  it("uses durable sequence order and rejects malformed or mismatched latest metadata", () => {
    const older = { ...activity(), sequence: 1 };
    const latest = { ...activity(false), sequence: 2 };
    expect(deriveSafetyBufferingState([latest, older], latestTurn)).toBeNull();
    for (const payload of [
      { ...(activity().payload as object), turnId: "other-turn" },
      { ...(activity().payload as object), threadId: null },
    ]) {
      expect(deriveSafetyBufferingState([older, { ...latest, payload }], latestTurn)).toBeNull();
    }
  });
  it("ignores a different turn and retires after completion or interruption", () => {
    expect(deriveSafetyBufferingState([activity(true, "other-turn")], latestTurn)).toBeNull();
    for (const state of ["completed", "interrupted", "error"] as const) {
      expect(
        deriveSafetyBufferingState([activity()], {
          ...latestTurn,
          state,
          completedAt: "2026-09-05T00:01:00.000Z",
        }),
      ).toBeNull();
    }
  });
  it("requires explicit metadata instead of elapsed time, connecting or queued follow-ups", () => {
    expect(deriveSafetyBufferingState([], latestTurn)).toBeNull();
    expect(deriveSafetyBufferingState([activity()], null)).toBeNull();
    for (const payload of [
      { showBufferingUi: true },
      { ...(activity().payload as object), reasons: [1] },
    ]) {
      expect(deriveSafetyBufferingState([{ ...activity(), payload }], latestTurn)).toBeNull();
    }
  });
});
