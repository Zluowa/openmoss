import { ThreadId, TurnId } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";

import { resolveSilentTurnNotice, stopAndRetrySilentTurn } from "./silentTurnNotice";

const turnId = TurnId.makeUnsafe("turn-silent");
const record = (id: string, state: "silent" | "cleared", turn: TurnId | null = turnId) => ({
  id,
  kind: "provider.turn.silent",
  turnId: turn,
  payload: { state, silentForMs: 185_000, openToolCalls: 0 },
});

describe("resolveSilentTurnNotice", () => {
  it("shows the newest silent record of the running turn", () => {
    expect(
      resolveSilentTurnNotice({
        latestTurn: { turnId, state: "running" },
        activities: [record("a", "silent")],
      }),
    ).toEqual({ id: "a", turnId, openToolCall: false, silentForMs: 185_000 });
  });

  it("clears as soon as the server records that the agent spoke", () => {
    expect(
      resolveSilentTurnNotice({
        latestTurn: { turnId, state: "running" },
        activities: [record("a", "silent"), record("b", "cleared")],
      }),
    ).toBeNull();
  });

  it("shows nothing once the turn has ended, or for another turn's record", () => {
    expect(
      resolveSilentTurnNotice({
        latestTurn: { turnId, state: "interrupted" },
        activities: [record("a", "silent")],
      }),
    ).toBeNull();
    expect(
      resolveSilentTurnNotice({
        latestTurn: { turnId, state: "running" },
        activities: [record("a", "silent", TurnId.makeUnsafe("older-turn"))],
      }),
    ).toBeNull();
  });

  it("says when a tool call was open", () => {
    expect(
      resolveSilentTurnNotice({
        latestTurn: { turnId, state: "running" },
        activities: [{ ...record("a", "silent"), payload: { state: "silent", openToolCalls: 2 } }],
      })?.openToolCall,
    ).toBe(true);
  });
});

describe("stopAndRetrySilentTurn", () => {
  const threadId = ThreadId.makeUnsafe("thread-silent");

  it("stops the turn, waits for it to settle, then continues the task", async () => {
    const states = ["running", "running", "interrupted"];
    const interrupt = vi.fn(async () => undefined);
    const continueTask = vi.fn(async () => true);
    const result = await stopAndRetrySilentTurn({
      threadId,
      turnId,
      interrupt,
      readLatestTurn: () => ({ turnId, state: states.shift() ?? "interrupted" }),
      continueTask,
      sleep: async () => undefined,
    });
    expect(result).toBe(true);
    expect(interrupt).toHaveBeenCalledWith({ threadId, turnId });
    expect(continueTask).toHaveBeenCalledWith(turnId);
    expect(interrupt.mock.invocationCallOrder[0]).toBeLessThan(
      continueTask.mock.invocationCallOrder[0]!,
    );
  });

  it("does not continue when the turn never settles or another turn took over", async () => {
    const continueTask = vi.fn(async () => true);
    expect(
      await stopAndRetrySilentTurn({
        threadId,
        turnId,
        interrupt: async () => undefined,
        readLatestTurn: () => ({ turnId, state: "running" }),
        continueTask,
        sleep: async () => undefined,
        waitMs: 1_000,
      }),
    ).toBe(false);
    expect(
      await stopAndRetrySilentTurn({
        threadId,
        turnId,
        interrupt: async () => undefined,
        readLatestTurn: () => ({ turnId: TurnId.makeUnsafe("newer"), state: "running" }),
        continueTask,
        sleep: async () => undefined,
      }),
    ).toBe(false);
    expect(continueTask).not.toHaveBeenCalled();
  });
});
