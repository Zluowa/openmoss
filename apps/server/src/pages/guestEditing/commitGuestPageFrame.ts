import { Page, type PageGuestViewRequest, type PageId, type SpaceId } from "@moss/contracts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Y from "yjs";

import { persistPageVersion } from "../pageVersionPersistence";
import { encodeContributors, PAGE_CONTRIBUTOR_RECORD_BYTE_LIMIT } from "../pageVersionContributors";
import { sourceKey, type GuestRoomCandidate } from "../realtime/PageRealtimeRoom";
import { GUEST_ROOM_STATE_LIMIT } from "../realtime/guestRoomFrame";
import { RoomContributors } from "../realtime/pageRoomContributors";
import {
  appendRoomUpdate,
  commitRoomCheckpoint,
  journalContributors,
} from "../realtime/pageRoomPublication";
import { pageGuestFailure } from "../sharing/pageGuestHandler";
import { guestEditPreservesMediaAccess } from "../sharing/pageGuestMediaReferences";
import type { PageSharingServiceShape } from "../sharing/PageSharingService";
import { pageGuestActorRef } from "./pageGuestAuthor";

type PageRow = { page_json: string; content: string; rich_content: string | null };
type RoomHeader = {
  state_bytes: number;
  compacted_revision: number;
  compacted_through_sequence: number;
  next_sequence: number;
};
type UpdateRow = { seq: number; update_data: Uint8Array; contributors_json: string | null };
const unavailable = () => pageGuestFailure("unavailable");

function readPageSource(
  sql: SqlClient.SqlClient,
  pageId: PageId,
  scope: SpaceId | null,
  cut: GuestRoomCandidate,
) {
  return Effect.gen(function* () {
    const [row] = yield* sql<PageRow>`SELECT v.page_json, v.content, v.rich_content
      FROM pages_documents d JOIN pages_versions v ON v.page_id=d.page_id AND v.revision=d.revision
      WHERE d.page_id=${pageId} AND d.revision=${cut.revision} AND d.trashed_at IS NULL AND d.kind='page'`;
    if (!row || sourceKey({ richContent: row.rich_content, content: row.content }) !== cut.pageKey)
      return yield* unavailable();
    const page = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Page)(JSON.parse(row.page_json)),
      catch: unavailable,
    });
    if (
      page.id !== pageId ||
      page.scopeSpaceId !== scope ||
      page.revision !== cut.revision ||
      page.trashedAt !== null ||
      (page.kind ?? "page") !== "page"
    )
      return yield* unavailable();
    return { page, richContent: row.rich_content };
  });
}

/** Reconstruct the actual stored generation/prefix and add only the room's frozen
 * owner updates. Matching counters or state vectors alone do not establish identical content. */
function checkRoomPrefix(sql: SqlClient.SqlClient, pageId: PageId, cut: GuestRoomCandidate) {
  return Effect.gen(function* () {
    const [stored] =
      yield* sql<RoomHeader>`SELECT length(state) AS state_bytes, compacted_revision, compacted_through_sequence, next_sequence
      FROM pages_realtime_docs WHERE page_id=${pageId} AND generation=${cut.generation} AND typeof(state)='blob' AND compacted_key=${cut.pageKey}`;
    if (
      !stored ||
      stored.compacted_revision > cut.revision ||
      stored.compacted_through_sequence !== cut.compactedThrough ||
      stored.next_sequence !== cut.sequence + 1
    )
      return yield* unavailable();

    // Establish row and total UTF-8/byte limits without returning any payload to JS.
    // The same transaction pins these lengths until both payload SELECTs complete.
    const [size] = yield* sql<{
      count: number;
      bytes: number;
      largest_record: number;
    }>`SELECT count(*) AS count,
      coalesce(sum(update_bytes + source_bytes),0) AS bytes, coalesce(max(source_bytes),0) AS largest_record
      FROM (SELECT length(CAST(update_data AS BLOB)) AS update_bytes,
          coalesce(length(CAST(contributors_json AS BLOB)),0) AS source_bytes FROM pages_realtime_updates
        WHERE page_id=${pageId} AND generation=${cut.generation} LIMIT 4097)`;
    if (
      !size ||
      size.count > 4096 ||
      size.largest_record > PAGE_CONTRIBUTOR_RECORD_BYTE_LIMIT ||
      size.bytes + stored.state_bytes + (cut.pendingUpdate?.byteLength ?? 0) >
        GUEST_ROOM_STATE_LIMIT
    )
      return yield* unavailable();
    const [payload] = yield* sql<{
      state: Uint8Array;
    }>`SELECT state FROM pages_realtime_docs WHERE page_id=${pageId} AND generation=${cut.generation}`;
    if (!payload) return yield* unavailable();
    const tail =
      yield* sql<UpdateRow>`SELECT seq, update_data, contributors_json FROM pages_realtime_updates
      WHERE page_id=${pageId} AND generation=${cut.generation} ORDER BY seq`;
    if (tail.some((row) => row.seq <= cut.compactedThrough || row.seq > cut.sequence))
      return yield* unavailable();
    const matches = yield* Effect.try({
      try: () => {
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, payload.state);
          for (const record of tail) Y.applyUpdate(doc, record.update_data);
          if (cut.pendingUpdate) Y.applyUpdate(doc, cut.pendingUpdate);
          return (
            !doc.store.pendingStructs &&
            !doc.store.pendingDs &&
            Buffer.from(Y.encodeStateAsUpdate(doc)).equals(cut.baselineState)
          );
        } finally {
          doc.destroy();
        }
      },
      catch: unavailable,
    });
    if (!matches) return yield* unavailable();

    const sources = yield* Effect.try({
      try: () => {
        const accepted = new RoomContributors();
        for (const source of journalContributors(tail)) accepted.accept(source);
        for (const source of cut.pendingSources) accepted.accept(source);
        return accepted;
      },
      catch: unavailable,
    });
    if (encodeContributors(sources.cut().sources) !== encodeContributors(cut.previousSources))
      return yield* unavailable();
    return sources;
  });
}

interface GuestFrameAdmission {
  readonly entry: PageGuestViewRequest;
  readonly pageId: PageId;
  readonly scope: SpaceId | null;
  readonly key: Uint8Array;
  readonly cut: GuestRoomCandidate;
}

/** Every call resolves the original proof inside the transaction that writes its bytes.
 * No earlier eligibility object, client baseline or claimed actor can authorize this write. */
export function commitGuestPageFrame(
  sql: SqlClient.SqlClient,
  sharing: Pick<PageSharingServiceShape, "resolveEditableGuestPage">,
  admission: GuestFrameAdmission,
) {
  const { entry, pageId, scope, key, cut } = admission;
  return sql.withTransaction(
    Effect.gen(function* () {
      const allowed = yield* sharing.resolveEditableGuestPage({
        ...entry,
        pageId,
        expectedPageRevision: cut.revision,
      });
      if (
        allowed.pageId !== pageId ||
        allowed.scopeSpaceId !== scope ||
        allowed.pageRevision !== cut.revision
      )
        return yield* unavailable();
      const previous = yield* readPageSource(sql, pageId, scope, cut);
      const sources = yield* checkRoomPrefix(sql, pageId, cut);
      const mediaAllowed = yield* Effect.try({
        try: () =>
          guestEditPreservesMediaAccess(previous.richContent, cut.rich.nodes) &&
          guestEditPreservesMediaAccess(cut.previous, cut.rich.nodes),
        catch: unavailable,
      });
      if (!mediaAllowed) return yield* pageGuestFailure("forbidden");
      // A repeated delta still passed all current authorization, room and media checks.
      if (!cut.delta) return { revision: cut.revision, throughSequence: cut.sequence };

      const actorRef = pageGuestActorRef(key, allowed);
      const guest = { kind: "guest", actorRef } as const;
      yield* Effect.try({ try: () => sources.accept(guest), catch: unavailable });
      const batch = new RoomContributors();
      for (const source of cut.pendingSources) batch.accept(source);
      batch.accept(guest);
      const update = cut.pendingUpdate ? Y.mergeUpdates([cut.pendingUpdate, cut.delta]) : cut.delta;
      const throughSequence = yield* appendRoomUpdate(
        sql,
        pageId,
        cut.generation,
        update,
        batch.cut().sources,
      );
      if (throughSequence !== cut.sequence + 1) return yield* unavailable();

      const page = {
        ...previous.page,
        revision: cut.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      yield* persistPageVersion(
        sql,
        page,
        cut.rich.content,
        "update",
        guest,
        cut.revision,
        null,
        cut.rich.richContent,
      );
      yield* sql`INSERT INTO pages_version_contributors(page_id,revision,contributors_json)
      VALUES(${pageId},${page.revision},${encodeContributors(sources.cut().sources)})`;
      yield* commitRoomCheckpoint(sql, pageId, {
        generation: cut.generation,
        state: cut.state,
        revision: page.revision,
        key: cut.rich.richContent,
        throughSequence,
      });
      return { revision: page.revision, throughSequence };
    }),
  );
}
