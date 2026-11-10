import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { ROOM_ENVELOPE_LIMITS, copyBytes } from "./roomEnvelopeProtocol";

export interface CommittedCutLocator {
  readonly pageId: string;
  readonly scopeKey: string;
  readonly generation: string;
}

export interface CommittedRoomCut {
  readonly generation: string;
  readonly revision: number;
  readonly throughSequence: number;
  readonly state: Uint8Array<ArrayBuffer>;
}

export type CommittedCutRead =
  | { readonly kind: "ready"; readonly cut: CommittedRoomCut }
  | { readonly kind: "cut-not-ready" | "over-budget" };

/** Read only the compacted prefix, never pending/live journal state. Call within
 * the same SQLite snapshot as the owner head/fence, and repeat in its write CAS.
 * The body-valued compacted_key stays inside SQL. Oversized blobs stay in SQLite.
 */
export const readPageRoomCommittedCut = (sql: SqlClient.SqlClient, locator: CommittedCutLocator) =>
  Effect.gen(function* () {
    const cap = ROOM_ENVELOPE_LIMITS.frameBytes;
    const [row] = yield* sql<{
      generation: string;
      revision: number;
      through_seq: number;
      size: number;
      state: Uint8Array | null;
    }>`
      SELECT d.generation, d.compacted_revision AS revision, d.compacted_through_sequence AS through_seq,
        length(d.state) AS size, CASE WHEN length(d.state) <= ${cap} THEN d.state END AS state
      FROM main.pages_realtime_docs d
      JOIN main.pages_documents p ON p.page_id = d.page_id AND p.revision = d.compacted_revision
      JOIN main.pages_versions v ON v.page_id = p.page_id AND v.revision = p.revision
      WHERE d.page_id = ${locator.pageId} AND d.generation = ${locator.generation}
        AND p.scope_key = ${locator.scopeKey} AND p.trashed_at IS NULL AND typeof(d.state) = 'blob'
        AND d.compacted_key = COALESCE(v.rich_content, 'markdown:' || v.content)
        AND d.compacted_through_sequence >= 0 AND d.compacted_through_sequence < d.next_sequence`;
    if (
      !row ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      !Number.isSafeInteger(row.through_seq)
    ) {
      return { kind: "cut-not-ready" } as const;
    }
    if (row.size > cap) return { kind: "over-budget" } as const;
    if (!row.state || row.size < 1) return { kind: "cut-not-ready" } as const;
    return {
      kind: "ready",
      cut: Object.freeze({
        generation: row.generation,
        revision: row.revision,
        throughSequence: row.through_seq,
        state: copyBytes(row.state, row.size, row.size),
      }),
    } as const;
  });
