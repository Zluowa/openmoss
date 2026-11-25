// FILE: mossCanvasEdited.ts
// Purpose: Records, once per conversation, that its 画布 first held content.
// Layer: Canvas storage route (mossMediaJobsRoute.ts) → orchestration (server-only command).
// Why: A chat nothing was sent in is not listed (#863); one whose 画布 has content is, so a person
//      who drew in a new chat and left finds it again (WALK-7 N7-1). Only the server sets it, from
//      a Canvas storage write that holds at least one shape; no window or phone command can.

import { CommandId, ThreadId } from "@moss/contracts";
import { Effect, Option } from "effect";

import { createLogger } from "./logger";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";

export { canvasSnapshotHasShapes, isCanvasContentWrite } from "./mossCanvasContent";

const log = createLogger("canvas-edited");
// Threads recorded by this process: later saves skip the projection read and the command.
const recorded = new Set<string>();

/**
 * Marks the thread's 画布 as having content, once. Never fails the write that triggered it: a
 * missing engine (tests, a server without orchestration) or an error is logged and ignored.
 */
export const recordMossCanvasEdited = (threadId: string) =>
  Effect.gen(function* () {
    if (recorded.has(threadId)) return;
    const query = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    if (Option.isSome(query)) {
      const shell = yield* query.value.getThreadShellById(ThreadId.makeUnsafe(threadId));
      if (Option.isSome(shell) && shell.value.canvasEditedAt != null) {
        recorded.add(threadId);
        return;
      }
    }
    const engine = yield* Effect.serviceOption(OrchestrationEngineService);
    if (Option.isNone(engine)) return;
    yield* engine.value.dispatch({
      type: "thread.canvas-edited.record",
      // One command per thread: a repeat is the same command, never a second record.
      commandId: CommandId.makeUnsafe(`canvas-edited:${threadId}`),
      threadId: ThreadId.makeUnsafe(threadId),
      editedAt: new Date().toISOString(),
    });
    recorded.add(threadId);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => log.warn("could not record the 画布's first content", { threadId, cause })),
    ),
  );

export function resetMossCanvasEditedForTests(): void {
  recorded.clear();
}
