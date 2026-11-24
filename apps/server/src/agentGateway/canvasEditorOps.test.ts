import { EventId, ThreadId, type OrchestrationEvent } from "@moss/contracts";
import { Duration, Effect, PubSub, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  CANVAS_OPS_REPLY_KIND,
  CANVAS_OPS_REPLY_SOURCE,
  requestCanvasEditorOps,
} from "./canvasEditorOps";

const THREAD = "thread-canvas";
const REQUEST = "canvas-ops:1";

function replyEvent(payload: Record<string, unknown>, requestId = REQUEST): OrchestrationEvent {
  return {
    type: "thread.activity-appended",
    payload: {
      threadId: ThreadId.makeUnsafe(THREAD),
      activity: {
        id: EventId.makeUnsafe(`reply-${Math.random()}`),
        tone: "info",
        kind: CANVAS_OPS_REPLY_KIND,
        summary: "Canvas edit",
        payload: { source: CANVAS_OPS_REPLY_SOURCE, requestId, ...payload },
        turnId: null,
        createdAt: "2026-11-24T00:00:00.000Z",
      },
    },
  } as unknown as OrchestrationEvent;
}

/** The window as the gateway sees it: replies it publishes after the request is dispatched. */
const run = (answers: readonly OrchestrationEvent[], wait = { accept: 200, apply: 300 }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const hub = yield* PubSub.unbounded<OrchestrationEvent>();
      let dispatched = 0;
      const result = yield* requestCanvasEditorOps({
        events: Stream.fromPubSub(hub),
        threadId: THREAD,
        requestId: REQUEST,
        acceptWait: Duration.millis(wait.accept),
        applyWait: Duration.millis(wait.apply),
        dispatch: Effect.gen(function* () {
          dispatched += 1;
          for (const answer of answers) yield* PubSub.publish(hub, answer);
        }),
      });
      return { result, dispatched };
    }),
  );

describe("an agent's 画布 edit goes to the open editor first", () => {
  it("returns what the editor applied", async () => {
    const { result, dispatched } = await run([
      replyEvent({ status: "accepted" }),
      replyEvent({
        status: "applied",
        result: { created: { n: "shape:n" }, deletedCount: 0, shapes: [{ id: "shape:n" }] },
      }),
    ]);
    expect(dispatched).toBe(1);
    expect(result).toMatchObject({
      status: "applied",
      result: { created: { n: "shape:n" }, saved: true },
    });
  });

  it("ignores answers for other requests and other threads", async () => {
    const { result } = await run([
      replyEvent({ status: "applied", result: {} }, "canvas-ops:other"),
      replyEvent({ status: "no-editor" }),
    ]);
    expect(result).toEqual({ status: "no-editor" });
  });

  it("reports no window when nothing answers, so storage may be written", async () => {
    const { result } = await run([]);
    expect(result).toEqual({ status: "timeout" });
  });

  it("never falls back to storage once the editor took the edit", async () => {
    const { result } = await run([replyEvent({ status: "accepted" })]);
    expect(result).toEqual({ status: "failed", errorCode: "canvas_busy" });
  });

  it("passes the editor's refusal through", async () => {
    const { result } = await run([
      replyEvent({ status: "accepted" }),
      replyEvent({ status: "failed", errorCode: "canvas_ops_invalid" }),
    ]);
    expect(result).toEqual({ status: "failed", errorCode: "canvas_ops_invalid" });
  });

  it("tells the agent an edit that is drawn but not yet saved, so it is not sent again", async () => {
    const { result } = await run([
      replyEvent({ status: "accepted" }),
      replyEvent({ status: "applied", result: { created: {}, saved: false } }),
    ]);
    expect(result).toMatchObject({ status: "applied", result: { saved: false } });
  });
});
