import { CommandId, MessageId, ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildUserStoppedInterruptCommand,
  captureUserStoppedCandidate,
  createUserStoppedAttributionState,
  reconcileUserStoppedAttribution,
  registerUserStoppedCandidate,
  selectUserStoppedRecords,
  type UserStoppedCandidate,
} from "./userStoppedPresentation";

const THREAD_ID = ThreadId.makeUnsafe("thread-stopped");
const TURN_ID = TurnId.makeUnsafe("turn-stopped");
const USER_MESSAGE_ID = MessageId.makeUnsafe("user-stopped");
const REQUESTED_AT = "2026-08-28T01:00:00.000Z";
const STARTED_AT = "2026-08-28T01:00:01.000Z";
const COMPLETED_AT = "2026-08-28T01:00:04.000Z";
const COMMAND_ID = CommandId.makeUnsafe("command-stop");

function runningTurn(
  overrides: Partial<
    NonNullable<Parameters<typeof captureUserStoppedCandidate>[0]["latestTurn"]>
  > = {},
) {
  return {
    turnId: TURN_ID,
    state: "running" as const,
    requestedAt: REQUESTED_AT,
    startedAt: STARTED_AT,
    completedAt: null,
    assistantMessageId: MessageId.makeUnsafe("assistant-stopped"),
    ...overrides,
  };
}

function candidate(overrides: Partial<UserStoppedCandidate> = {}): UserStoppedCandidate {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    userMessageId: USER_MESSAGE_ID,
    startedAt: STARTED_AT,
    requestedAt: REQUESTED_AT,
    ...overrides,
  };
}

describe("user stopped attribution", () => {
  it("includes the exact turn id only for the current-response interrupt command", () => {
    expect(
      buildUserStoppedInterruptCommand({
        commandId: COMMAND_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        createdAt: REQUESTED_AT,
      }),
    ).toEqual({
      type: "thread.turn.interrupt",
      commandId: COMMAND_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: REQUESTED_AT,
    });
    expect(
      buildUserStoppedInterruptCommand({
        commandId: COMMAND_ID,
        threadId: THREAD_ID,
        createdAt: REQUESTED_AT,
      }),
    ).not.toHaveProperty("turnId");
  });

  it("captures the exact running turn and preceding user message", () => {
    const result = captureUserStoppedCandidate({
      threadId: THREAD_ID,
      latestTurn: runningTurn(),
      messages: [
        { id: MessageId.makeUnsafe("older-user"), role: "user" },
        { id: MessageId.makeUnsafe("assistant-stopped"), role: "assistant" },
        { id: USER_MESSAGE_ID, role: "user" },
        { id: MessageId.makeUnsafe("assistant-current"), role: "assistant" },
      ],
      requestedAt: REQUESTED_AT,
    });

    expect(result).toEqual(candidate({ userMessageId: MessageId.makeUnsafe("older-user") }));
  });

  it("uses requestedAt when the latest turn has not published startedAt", () => {
    const result = captureUserStoppedCandidate({
      threadId: THREAD_ID,
      latestTurn: runningTurn({ startedAt: null, assistantMessageId: null }),
      messages: [{ id: USER_MESSAGE_ID, role: "user" }],
      requestedAt: REQUESTED_AT,
    });

    expect(result).toMatchObject({
      turnId: TURN_ID,
      userMessageId: USER_MESSAGE_ID,
      startedAt: REQUESTED_AT,
      requestedAt: REQUESTED_AT,
    });
  });

  it("does not use a queued user message after the turn request as its anchor", () => {
    const result = captureUserStoppedCandidate({
      threadId: THREAD_ID,
      latestTurn: runningTurn({ assistantMessageId: null }),
      messages: [
        {
          id: MessageId.makeUnsafe("user-before-turn"),
          role: "user",
          createdAt: "2026-08-28T00:59:59.000Z",
        },
        {
          id: MessageId.makeUnsafe("user-queued-after-turn"),
          role: "user",
          createdAt: "2026-08-28T01:00:00.500Z",
        },
      ],
      requestedAt: REQUESTED_AT,
    });

    expect(result?.userMessageId).toBe(MessageId.makeUnsafe("user-before-turn"));
  });

  it("does not create a candidate without an exact turn/user anchor", () => {
    expect(
      captureUserStoppedCandidate({
        threadId: THREAD_ID,
        latestTurn: runningTurn({ assistantMessageId: MessageId.makeUnsafe("missing") }),
        messages: [{ id: USER_MESSAGE_ID, role: "user" }],
        requestedAt: REQUESTED_AT,
      }),
    ).toBeNull();
    expect(
      captureUserStoppedCandidate({
        threadId: THREAD_ID,
        latestTurn: runningTurn({ state: "interrupted" }),
        messages: [{ id: USER_MESSAGE_ID, role: "user" }],
        requestedAt: REQUESTED_AT,
      }),
    ).toBeNull();
  });

  it("promotes only the matching interrupted turn with a usable completion time", () => {
    const pending = registerUserStoppedCandidate(createUserStoppedAttributionState(), candidate());
    const next = reconcileUserStoppedAttribution({
      state: pending,
      threadId: THREAD_ID,
      latestTurn: { turnId: TURN_ID, state: "interrupted", completedAt: COMPLETED_AT },
    });

    expect(next.pendingByThreadId.size).toBe(0);
    expect(selectUserStoppedRecords(next, THREAD_ID)).toEqual([
      { ...candidate(), completedAt: COMPLETED_AT },
    ]);
  });

  it("keeps a pending candidate while the latest-turn detail is temporarily unknown", () => {
    const pending = registerUserStoppedCandidate(createUserStoppedAttributionState(), candidate());
    const duringRehydration = reconcileUserStoppedAttribution({
      state: pending,
      threadId: THREAD_ID,
      latestTurn: null,
    });

    expect(duringRehydration.pendingByThreadId.get(String(THREAD_ID))).toEqual(candidate());
    const afterRehydration = reconcileUserStoppedAttribution({
      state: duringRehydration,
      threadId: THREAD_ID,
      latestTurn: { turnId: TURN_ID, state: "interrupted", completedAt: COMPLETED_AT },
    });
    expect(selectUserStoppedRecords(afterRehydration, THREAD_ID)).toHaveLength(1);
  });

  it.each([
    ["completed", "completed"],
    ["error", "error"],
  ] as const)("discards a pending candidate when the same turn ends %s", (_label, state) => {
    const pending = registerUserStoppedCandidate(createUserStoppedAttributionState(), candidate());
    const next = reconcileUserStoppedAttribution({
      state: pending,
      threadId: THREAD_ID,
      latestTurn: { turnId: TURN_ID, state, completedAt: COMPLETED_AT },
    });

    expect(next.pendingByThreadId.size).toBe(0);
    expect(selectUserStoppedRecords(next, THREAD_ID)).toEqual([]);
  });

  it("discards a candidate when a newer turn replaces it", () => {
    const pending = registerUserStoppedCandidate(createUserStoppedAttributionState(), candidate());
    const next = reconcileUserStoppedAttribution({
      state: pending,
      threadId: THREAD_ID,
      latestTurn: {
        turnId: TurnId.makeUnsafe("newer-turn"),
        state: "running",
        completedAt: null,
      },
    });

    expect(next.pendingByThreadId.size).toBe(0);
    expect(selectUserStoppedRecords(next, THREAD_ID)).toEqual([]);
  });

  it("keeps pending/confirmed attribution isolated by thread and resets with a renderer", () => {
    const otherThread = ThreadId.makeUnsafe("other-thread");
    const stateWithBoth = registerUserStoppedCandidate(
      registerUserStoppedCandidate(createUserStoppedAttributionState(), candidate()),
      candidate({ threadId: otherThread, turnId: TurnId.makeUnsafe("other-turn") }),
    );
    const confirmedOther = reconcileUserStoppedAttribution({
      state: stateWithBoth,
      threadId: otherThread,
      latestTurn: {
        turnId: TurnId.makeUnsafe("other-turn"),
        state: "interrupted",
        completedAt: COMPLETED_AT,
      },
    });

    expect(selectUserStoppedRecords(confirmedOther, THREAD_ID)).toEqual([]);
    expect(selectUserStoppedRecords(confirmedOther, otherThread)).toHaveLength(1);
    expect(selectUserStoppedRecords(createUserStoppedAttributionState(), otherThread)).toEqual([]);
  });
});
