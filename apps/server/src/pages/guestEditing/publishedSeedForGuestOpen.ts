import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Y from "yjs";
import type { PublishedRoomSeed } from "../realtime/PageRealtimeRoom";
import { GUEST_ROOM_STATE_LIMIT } from "../realtime/guestRoomFrame";
import { commitRoomCheckpoint } from "../realtime/pageRoomPublication";
import { seedPageDoc } from "../realtime/pageYjsContent";
import {
  checkedOwnerBase,
  GuestProjectionError,
  visibleParagraphs,
} from "./guestProjectionContent";

const unavailable = () => new GuestProjectionError("unavailable");
type StoredGeneration = {
  generation: string;
  compacted_revision: number;
  same_key: number;
  compacted_through_sequence: number;
  next_sequence: number;
  state_bytes: number;
  state_type: string;
};

/** Called inside the actual proof/preparation transaction. The normal owner recovery path
 * is intentionally not an implementation of this method: it can publish a durable tail. */
export function publishedSeedForGuestOpen(
  sql: SqlClient.SqlClient,
  pageId: string,
  revision: number,
  rich: string,
) {
  return Effect.gen(function* () {
    const visible = yield* Effect.try({
      try: () => visibleParagraphs(rich),
      catch: () => new GuestProjectionError("unsupported"),
    });
    const dirty = yield* sql`SELECT 1 FROM pages_realtime_updates WHERE page_id=${pageId} LIMIT 1`;
    if (dirty.length) return yield* Effect.fail(unavailable());
    const [previous] =
      yield* sql<StoredGeneration>`SELECT generation,compacted_revision,compacted_key=${rich} AS same_key,
      compacted_through_sequence,next_sequence,length(state) AS state_bytes,typeof(state) AS state_type
      FROM pages_realtime_docs WHERE page_id=${pageId}`;
    if (previous) {
      if (
        typeof previous.generation !== "string" ||
        !previous.generation ||
        previous.generation.length > 128 ||
        !Number.isSafeInteger(previous.compacted_through_sequence) ||
        previous.compacted_through_sequence < 0 ||
        !Number.isSafeInteger(previous.next_sequence) ||
        !previous.same_key ||
        previous.compacted_revision < 1 ||
        previous.compacted_revision > revision ||
        previous.next_sequence !== previous.compacted_through_sequence + 1 ||
        previous.state_type !== "blob" ||
        previous.state_bytes <= 0 ||
        previous.state_bytes > GUEST_ROOM_STATE_LIMIT
      )
        return yield* Effect.fail(unavailable());
      const [row] = yield* sql<{
        state: Uint8Array;
      }>`SELECT state FROM pages_realtime_docs WHERE page_id=${pageId} AND generation=${previous.generation}`;
      if (!row) return yield* Effect.fail(unavailable());
      const state = yield* Effect.try({
        try: () => checkedOwnerBase(row.state, JSON.stringify(visible)),
        catch: unavailable,
      });
      const seed = {
        generation: previous.generation,
        revision,
        key: rich,
        state,
        throughSequence: previous.compacted_through_sequence,
      } satisfies PublishedRoomSeed;
      return { seed, created: false };
    }
    // A missing header accompanied by historical snapshots is not a blank room.
    // Creating a generation would prune somebody else's recovery evidence.
    const orphan =
      yield* sql`SELECT 1 FROM pages_realtime_snapshots WHERE page_id=${pageId} LIMIT 1`;
    if (orphan.length) return yield* Effect.fail(unavailable());
    const state = yield* Effect.try({
      try: () => {
        const doc = new Y.Doc();
        try {
          seedPageDoc(doc, visible);
          return Y.encodeStateAsUpdate(doc);
        } finally {
          doc.destroy();
        }
      },
      catch: unavailable,
    });
    const seed = {
      generation: randomUUID(),
      revision,
      key: rich,
      state,
      throughSequence: 0,
    } satisfies PublishedRoomSeed;
    yield* commitRoomCheckpoint(sql, pageId, seed);
    return { seed, created: true };
  });
}

/** Undo only this failed initialization's newly-created cache if nobody changed
 * its generation, checkpoint, snapshots, revision or journal. Never delete a prior
 * generation, even when it happens to have the same public text. */
export function discardUnusedGuestSeed(
  sql: SqlClient.SqlClient,
  pageId: string,
  seed: PublishedRoomSeed,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const unchanged =
        yield* sql`SELECT 1 FROM pages_realtime_docs d JOIN pages_documents p USING(page_id)
      WHERE d.page_id=${pageId} AND d.generation=${seed.generation} AND d.compacted_revision=${seed.revision}
        AND p.revision=${seed.revision} AND d.compacted_key=${seed.key} AND d.state=${seed.state}
        AND d.next_sequence=1 AND d.compacted_through_sequence=0
        AND NOT EXISTS(SELECT 1 FROM pages_realtime_updates u WHERE u.page_id=d.page_id)
        AND (SELECT count(*) FROM pages_realtime_snapshots s WHERE s.page_id=d.page_id)=1
        AND EXISTS(SELECT 1 FROM pages_realtime_snapshots s WHERE s.page_id=d.page_id AND s.generation=d.generation
          AND s.revision=d.compacted_revision AND s.state=d.state)`;
      if (!unchanged.length) return;
      yield* sql`DELETE FROM pages_realtime_snapshots WHERE page_id=${pageId} AND generation=${seed.generation} AND revision=${seed.revision}`;
      yield* sql`DELETE FROM pages_realtime_docs WHERE page_id=${pageId} AND generation=${seed.generation}`;
    }),
  );
}
