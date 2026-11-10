import { Effect } from "effect";
import type { PageVersionContributor } from "@moss/contracts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { PagesServiceError } from "../Services/PagesService";
import type { RoomCheckpoint } from "./PageRealtimeRoom";
import { encodeContributors, readContributors } from "../pageVersionContributors";
import { RoomContributors } from "./pageRoomContributors";

const SNAPSHOTS_KEPT = 40;
const changed = () =>
  new PagesServiceError({
    code: "conflict",
    message: "Page room generation or checkpoint changed",
  });

/** Allocate from persistent generation state. Pruning every journal row never reuses a seq. */
export const appendRoomUpdate = (
  sql: SqlClient.SqlClient,
  pageId: string,
  generation: string,
  update: Uint8Array,
  sources: readonly PageVersionContributor[],
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{
        seq: number;
      }>`UPDATE pages_realtime_docs SET next_sequence=next_sequence+1
      WHERE page_id=${pageId} AND generation=${generation} AND next_sequence < ${Number.MAX_SAFE_INTEGER}
      RETURNING next_sequence-1 AS seq`;
      if (rows.length !== 1) return yield* changed();
      const seq = rows[0]!.seq;
      yield* sql`INSERT INTO pages_realtime_updates(page_id, seq, generation, update_data, created_at, contributors_json)
      VALUES (${pageId}, ${seq}, ${generation}, ${update}, ${new Date().toISOString()}, ${encodeContributors(sources)})`;
      return seq;
    }),
  );

export function journalContributors(rows: readonly { contributors_json: string | null }[]) {
  const sources = new RoomContributors();
  for (const row of rows) {
    for (const source of readContributors(row.contributors_json)) sources.accept(source);
  }
  return sources.cut().sources;
}

/** Called inside the Page-version transaction (or its own transaction for an existing
 * version/initial seed). Only this generation's recorded prefix belongs to the snapshot.
 */
export const commitRoomCheckpoint = (
  sql: SqlClient.SqlClient,
  pageId: string,
  cut: RoomCheckpoint,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const { generation, state, revision, key, throughSequence } = cut;
      if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) return yield* changed();
      const now = new Date().toISOString();
      const existing = yield* sql<{
        generation: string;
      }>`SELECT generation FROM pages_realtime_docs WHERE page_id=${pageId}`;
      if (!existing.length) {
        if (throughSequence !== 0) return yield* changed();
        yield* sql`INSERT INTO pages_realtime_docs(page_id,generation,state,compacted_revision,compacted_key,updated_at,next_sequence,compacted_through_sequence)
        VALUES(${pageId},${generation},${state},${revision},${key},${now},1,0)`;
      } else {
        const updated =
          yield* sql`UPDATE pages_realtime_docs SET state=${state}, compacted_revision=${revision},
        compacted_key=${key}, updated_at=${now}, compacted_through_sequence=${throughSequence}
        WHERE page_id=${pageId} AND generation=${generation} AND compacted_revision<=${revision}
          AND compacted_through_sequence<=${throughSequence} AND next_sequence>${throughSequence} RETURNING page_id`;
        if (updated.length !== 1) return yield* changed();
      }
      yield* sql`DELETE FROM pages_realtime_updates WHERE page_id=${pageId} AND generation=${generation} AND seq<=${throughSequence}`;
      yield* sql`INSERT INTO pages_realtime_snapshots(page_id,generation,revision,state,created_at)
      VALUES(${pageId},${generation},${revision},${state},${now})
      ON CONFLICT(page_id,generation,revision) DO UPDATE SET state=excluded.state`;
      yield* sql`DELETE FROM pages_realtime_snapshots WHERE page_id=${pageId}
      AND (generation<>${generation} OR revision NOT IN (SELECT revision FROM pages_realtime_snapshots
        WHERE page_id=${pageId} AND generation=${generation} ORDER BY revision DESC LIMIT ${SNAPSHOTS_KEPT}))`;
    }),
  );
