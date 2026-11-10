// FILE: legacyThreadRetention.ts
// Purpose: Gives back the conversations that Moss's removed age-based archiving hid. Older
//          versions archived any conversation untouched for seven days with a
//          `thread-retention:` command. Neither Codex nor Claude does that, so the sweep is gone
//          and its archives are undone. Anything the person archived stays archived.
// Layer: Server startup maintenance
// Exports: THREAD_RETENTION_COMMAND_ID_PREFIX, listRetentionArchivedRoots,
//          restoreThreadsArchivedByRetention, startRetentionArchiveRestore

import { randomUUID } from "node:crypto";

import { CommandId, ThreadId } from "@moss/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";

/** Command id prefix of every archive (and, before that, delete) the removed sweep issued. */
export const THREAD_RETENTION_COMMAND_ID_PREFIX = "thread-retention:";
// Deliberately not under the prefix above, so a restore is never mistaken for a sweep.
const RESTORE_COMMAND_ID_PREFIX = "retention-restore:";
// Let startup finish serving history before restoring in the background.
const RESTORE_DELAY_MS = 15_000;

/** An archived, undeleted thread and the command behind its most recent archive. */
export interface ArchivedThreadRow {
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly commandId: string | null;
}

const archivedBySweep = (row: ArchivedThreadRow | undefined) =>
  row?.commandId?.startsWith(THREAD_RETENTION_COMMAND_ID_PREFIX) === true;

/**
 * The archived threads the sweep archived, one per archive: restoring a root also restores
 * the subagent threads archived with it by the same command. The latest archive decides, so
 * a thread the person archived again after a sweep stays archived.
 */
export function listRetentionArchivedRoots(rows: ReadonlyArray<ArchivedThreadRow>): ThreadId[] {
  const byId = new Map(rows.map((row) => [row.threadId, row] as const));
  return rows
    .filter((row) => {
      if (!archivedBySweep(row)) return false;
      const parent = row.parentThreadId ? byId.get(row.parentThreadId) : undefined;
      return !(archivedBySweep(parent) && parent?.commandId === row.commandId);
    })
    .map((row) => ThreadId.makeUnsafe(row.threadId));
}

// The event log is the record of who archived what; the projection keeps no reliable copy
// for threads that had no sidebar placement.
const listArchivedThreads = (sql: SqlClient.SqlClient) => sql<ArchivedThreadRow>`
  SELECT
    t.thread_id AS "threadId",
    t.parent_thread_id AS "parentThreadId",
    (
      SELECT e.command_id
      FROM orchestration_events e
      WHERE e.aggregate_kind = 'thread'
        AND e.stream_id = t.thread_id
        AND e.event_type = 'thread.archived'
      ORDER BY e.sequence DESC
      LIMIT 1
    ) AS "commandId"
  FROM projection_threads t
  WHERE t.archived_at IS NOT NULL AND t.deleted_at IS NULL
`;

/** Un-archives what the sweep archived. Once done there is nothing left to find. */
export const restoreThreadsArchivedByRetention = Effect.fn("restoreThreadsArchivedByRetention")(
  function* (orchestrationEngine: OrchestrationEngineShape) {
    const sql = yield* SqlClient.SqlClient;
    const roots = listRetentionArchivedRoots(yield* listArchivedThreads(sql));
    if (roots.length === 0) return 0;
    yield* Effect.logInfo("restoring conversations hidden by the removed age-based archiving").pipe(
      Effect.annotateLogs({ count: roots.length }),
    );
    let restored = 0;
    yield* Effect.forEach(
      roots,
      (threadId) =>
        orchestrationEngine
          .dispatch({
            type: "thread.unarchive",
            commandId: CommandId.makeUnsafe(`${RESTORE_COMMAND_ID_PREFIX}${randomUUID()}`),
            threadId,
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                restored += 1;
              }),
            ),
            // A thread that can't come back now (for example its sidebar section is full)
            // stays archived; the next start tries again.
            Effect.catch((error) =>
              Effect.logWarning("could not restore a conversation hidden by age").pipe(
                Effect.annotateLogs({ threadId, error: String(error) }),
              ),
            ),
          ),
      { concurrency: 1, discard: true },
    );
    return restored;
  },
);

export const startRetentionArchiveRestore = Effect.fn("startRetentionArchiveRestore")(function* (
  orchestrationEngine: OrchestrationEngineShape,
) {
  yield* restoreThreadsArchivedByRetention(orchestrationEngine).pipe(
    Effect.delay(RESTORE_DELAY_MS),
    Effect.catchCause((cause) =>
      Effect.logWarning("restoring conversations hidden by age failed").pipe(
        Effect.annotateLogs({ cause: String(cause) }),
      ),
    ),
    Effect.forkScoped,
  );
});
