// FILE: canvasEditorOps.ts
// Purpose: Hands an agent's 画布 edit (moss_canvas_mutate) to the open Canvas editor in the window.
// Layer: Agent gateway. AgentGateway.ts dispatches the request; the window (routes/_chat.tsx) answers.
// Why: Writing the saved board under an open editor can drop what the person drew since the last
//      save, or be overwritten by the editor's next save. Applied in the editor, the edit is one
//      more change in the person's own store: it appears without a reload and the editor saves both.
//      Only when the window says no editor has the board, or does not answer, does the gateway
//      write storage (with a revision check, mossCanvasMutate.ts).

import { Duration, Effect, Fiber, Option, Stream } from "effect";
import type { OrchestrationEvent } from "@moss/contracts";

export const CANVAS_OPS_REQUESTED_KIND = "canvas.ops.requested";
export const CANVAS_OPS_REPLY_KIND = "canvas.ops.reply";
export const CANVAS_OPS_REPLY_SOURCE = "moss-canvas-window";
/** The gateway's storage write for a request ended (written or not): a held 画布 may load. */
export const CANVAS_OPS_DONE_KIND = "canvas.ops.done";

export interface CanvasEditorOpsResult {
  readonly created: Readonly<Record<string, string>>;
  readonly deletedCount: number;
  readonly shapes: readonly unknown[];
  readonly truncated: boolean;
  /** False when the edit is on the board but the editor's save has not gone through yet. */
  readonly saved: boolean;
}

export type CanvasEditorOpsReply =
  | { readonly status: "accepted" }
  | { readonly status: "applied"; readonly result: CanvasEditorOpsResult }
  | { readonly status: "failed"; readonly errorCode: string }
  | { readonly status: "no-editor" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The window's answer to one request, read from a `canvas.ops.reply` activity. */
export function readCanvasOpsReply(
  event: OrchestrationEvent,
  threadId: string,
  requestId: string,
): CanvasEditorOpsReply | null {
  if (event.type !== "thread.activity-appended" || String(event.payload.threadId) !== threadId)
    return null;
  const activity = event.payload.activity;
  if (activity.kind !== CANVAS_OPS_REPLY_KIND) return null;
  const payload = record(activity.payload);
  if (!payload || payload.source !== CANVAS_OPS_REPLY_SOURCE || payload.requestId !== requestId)
    return null;
  switch (payload.status) {
    case "accepted":
      return { status: "accepted" };
    case "no-editor":
      return { status: "no-editor" };
    case "failed":
      return {
        status: "failed",
        errorCode: typeof payload.errorCode === "string" ? payload.errorCode : "canvas_ops_failed",
      };
    case "applied": {
      const result = record(payload.result);
      const created = record(result?.created) ?? {};
      return {
        status: "applied",
        result: {
          created: Object.fromEntries(
            Object.entries(created).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          deletedCount: typeof result?.deletedCount === "number" ? result.deletedCount : 0,
          shapes: Array.isArray(result?.shapes) ? result.shapes.slice(0, 200) : [],
          truncated: result?.truncated === true,
          saved: result?.saved !== false,
        },
      };
    }
    default:
      return null;
  }
}

export const CANVAS_EDITOR_ACCEPT_WAIT = Duration.seconds(4);
export const CANVAS_EDITOR_APPLY_WAIT = Duration.seconds(30);

/**
 * Asks the window to apply `ops` in the open editor and waits for its answer. "timeout" means no
 * window answered at all (none is open); then nothing was applied and the caller may write storage.
 */
export const requestCanvasEditorOps = <E, R>(input: {
  readonly events: Stream.Stream<OrchestrationEvent>;
  readonly threadId: string;
  readonly requestId: string;
  readonly dispatch: Effect.Effect<void, E, R>;
  readonly acceptWait?: Duration.Duration;
  readonly applyWait?: Duration.Duration;
}): Effect.Effect<CanvasEditorOpsReply | { readonly status: "timeout" }, E, R> =>
  Effect.gen(function* () {
    const replies = input.events.pipe(
      Stream.map((event) => readCanvasOpsReply(event, input.threadId, input.requestId)),
      Stream.filter((reply): reply is CanvasEditorOpsReply => reply !== null),
    );
    // Listen before asking, so a quick answer is never missed.
    const first = yield* Stream.runHead(replies).pipe(Effect.forkChild({ startImmediately: true }));
    const final = yield* Stream.runHead(
      replies.pipe(Stream.filter((reply) => reply.status !== "accepted")),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* input.dispatch;
    const answered = yield* Fiber.join(first).pipe(
      Effect.timeoutOption(input.acceptWait ?? CANVAS_EDITOR_ACCEPT_WAIT),
      Effect.map(Option.flatten),
    );
    if (Option.isNone(answered)) {
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(final);
      return { status: "timeout" } as const;
    }
    if (answered.value.status !== "accepted") {
      yield* Fiber.interrupt(final);
      return answered.value;
    }
    const done = yield* Fiber.join(final).pipe(
      Effect.timeoutOption(input.applyWait ?? CANVAS_EDITOR_APPLY_WAIT),
      Effect.map(Option.flatten),
    );
    if (Option.isNone(done)) {
      yield* Fiber.interrupt(final);
      // The editor took the edit and has not finished: never write storage on top of it.
      return { status: "failed", errorCode: "canvas_busy" } as const;
    }
    return done.value;
  });
