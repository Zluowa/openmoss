import { EventId, type ProviderRuntimeEvent, ThreadId, TurnId } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { activeTimeStepMs } from "./activeTime.ts";
import {
  createSilentTurnWatch,
  SILENT_TURN_NOTICE_MS,
  SILENT_TURN_OPEN_TOOL_NOTICE_MS,
} from "./silentTurnWatch.ts";

const threadId = ThreadId.makeUnsafe("thread-silent");
const turnId = TurnId.makeUnsafe("turn-silent");
let sequence = 0;
const event = (
  type: ProviderRuntimeEvent["type"],
  fields: Record<string, unknown> = {},
): ProviderRuntimeEvent =>
  ({
    type,
    eventId: EventId.makeUnsafe(`evt-${(sequence += 1)}`),
    provider: "claudeAgent",
    threadId,
    turnId,
    createdAt: "2026-11-13T00:00:00.000Z",
    payload: {},
    ...fields,
  }) as ProviderRuntimeEvent;

const watch = () =>
  createSilentTurnWatch({
    noticeMs: SILENT_TURN_NOTICE_MS,
    openToolNoticeMs: SILENT_TURN_OPEN_TOOL_NOTICE_MS,
  });

/** Advances the watch by `ms` of active time in one-second ticks. */
const advance = (silent: ReturnType<typeof watch>, ms: number) => {
  const transitions = [];
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) transitions.push(...silent.advance(1_000));
  return transitions;
};

describe("createSilentTurnWatch", () => {
  it("notices a running turn after 180 s with no event, once", () => {
    const silent = watch();
    silent.observe(event("turn.started"));
    expect(advance(silent, 179_000)).toEqual([]);
    expect(advance(silent, 1_000)).toEqual([
      {
        kind: "silent",
        threadId,
        turnId,
        silentForMs: 180_000,
        thresholdMs: 180_000,
        openToolCalls: 0,
      },
    ]);
    expect(advance(silent, 600_000)).toEqual([]);
  });

  it("clears the notice on the first event and starts counting again", () => {
    const silent = watch();
    silent.observe(event("turn.started"));
    advance(silent, 180_000);
    expect(
      silent.observe(
        event("content.delta", { payload: { streamKind: "assistant_text", delta: "x" } }),
      ),
    ).toEqual({ kind: "cleared", threadId, turnId, silentForMs: 180_000 });
    expect(advance(silent, 179_000)).toEqual([]);
    expect(advance(silent, 1_000)).toHaveLength(1);
  });

  it("any event restarts the count before a notice, without a transition", () => {
    const silent = watch();
    silent.observe(event("turn.started"));
    advance(silent, 170_000);
    expect(silent.observe(event("runtime.warning", { payload: { message: "slow" } }))).toBeNull();
    expect(advance(silent, 170_000)).toEqual([]);
  });

  it("waits 600 s while a tool call is open, and 180 s again once it closes", () => {
    const silent = watch();
    silent.observe(event("turn.started"));
    silent.observe(
      event("item.started", {
        itemId: "tool-1",
        payload: { itemType: "command_execution", status: "inProgress" },
      }),
    );
    expect(advance(silent, 599_000)).toEqual([]);
    const [notice] = advance(silent, 1_000);
    expect(notice).toMatchObject({ kind: "silent", thresholdMs: 600_000, openToolCalls: 1 });

    silent.observe(
      event("item.completed", {
        itemId: "tool-1",
        payload: { itemType: "command_execution", status: "completed" },
      }),
    );
    expect(advance(silent, 180_000)).toEqual([
      expect.objectContaining({ kind: "silent", thresholdMs: 180_000, openToolCalls: 0 }),
    ]);
  });

  it("does not count time spent waiting on the person", () => {
    const silent = watch();
    silent.observe(event("turn.started"));
    silent.observe(event("request.opened", { requestId: "approval-1", payload: {} }));
    expect(advance(silent, 3_600_000)).toEqual([]);
    silent.observe(event("request.resolved", { requestId: "approval-1", payload: {} }));
    expect(advance(silent, 180_000)).toHaveLength(1);
  });

  it("forgets a turn that ended, clearing its notice", () => {
    const silent = watch();
    silent.observe(event("turn.started"));
    advance(silent, 180_000);
    expect(silent.observe(event("turn.aborted", { payload: { reason: "killed" } }))).toEqual({
      kind: "cleared",
      threadId,
      turnId,
      silentForMs: 180_000,
    });
    expect(silent.size).toBe(0);
    expect(advance(silent, 600_000)).toEqual([]);
  });

  it("never watches a thread without a started turn", () => {
    const silent = watch();
    silent.observe(event("content.delta", { payload: { streamKind: "assistant_text" } }));
    expect(advance(silent, 3_600_000)).toEqual([]);
  });

  it("an event-loop stall adds at most two ticks, so it cannot make a turn look silent", () => {
    const silent = watch();
    silent.observe(event("turn.started"));
    // Ticks one second apart, with a 113-second stall (as in acceptance round 11) between two.
    const tickTimes = [1_000, 2_000, 115_000, 116_000];
    let last = 0;
    for (const now of tickTimes) {
      expect(silent.advance(activeTimeStepMs(last, now, 1_000))).toEqual([]);
      last = now;
    }
  });
});
