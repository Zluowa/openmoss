import { Page, PageGuestViewRequest, type PageId, type PagesReadResult } from "@moss/contracts";
import { parsePageRichContent } from "@moss/shared/pageRichContent";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import { persistPageVersion } from "../pageVersionPersistence";
import { makePageRoomReservations } from "../realtime/pageRoomReservations";
import { PageRealtimeService } from "../realtime/PageRealtimeService";
import { PageSharingService } from "../sharing/PageSharingService";
import { PageGuestFailure, pageGuestFailure } from "../sharing/pageGuestHandler";
import { PAGE_GUEST_AUTHOR_KEY_PURPOSE, pageGuestActorRef } from "./pageGuestAuthor";
import { guestEditPreservesMediaAccess } from "../sharing/pageGuestMediaReferences";

export interface GuestPageContentWrite {
  readonly entry: PageGuestViewRequest;
  readonly pageId: PageId;
  readonly expectedPageRevision: number;
  readonly richContent: string;
}
export interface GuestPageContentWriterShape {
  readonly write: (
    input: GuestPageContentWrite,
  ) => Effect.Effect<PagesReadResult, PageGuestFailure>;
}
export class GuestPageContentWriter extends ServiceMap.Service<
  GuestPageContentWriter,
  GuestPageContentWriterShape
>()("moss/pages/guestEditing/GuestPageContentWriter") {}

/** Dedicated server-owned purpose; never a user credential or a browser vault key. */
export { PAGE_GUEST_AUTHOR_KEY_PURPOSE } from "./pageGuestAuthor";

/** Internal checkpoint only. No RPC/relay registration; live-room guest edits require G1c. */
export const makeGuestPageContentWriter = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sharing = yield* PageSharingService;
    const realtime = yield* PageRealtimeService;
    const secrets = yield* ServerSecretStore;
    const lifetime = yield* makePageRoomReservations();
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
      }).pipe(Effect.andThen(lifetime.close)),
    );
    const write: GuestPageContentWriterShape["write"] = (input) =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(pageGuestFailure("unavailable"));
        const entry = Schema.decodeUnknownOption(PageGuestViewRequest)(input?.entry);
        // Reject extra write fields; never accept a caller-supplied principal/eligibility/scope.
        if (
          Option.isNone(entry) ||
          typeof input.pageId !== "string" ||
          !input.pageId ||
          !Number.isSafeInteger(input.expectedPageRevision) ||
          input.expectedPageRevision < 1 ||
          typeof input.richContent !== "string" ||
          Object.keys(input).some(
            (key) => !["entry", "pageId", "expectedPageRevision", "richContent"].includes(key),
          )
        )
          return Effect.fail(pageGuestFailure("invalid"));
        return lifetime
          .withPage(
            input.pageId,
            realtime.withRoomClosed(
              input.pageId,
              Effect.gen(function* () {
                const rich = yield* Effect.try({
                  try: () => parsePageRichContent(input.richContent),
                  catch: () => pageGuestFailure("invalid"),
                });
                const key = yield* secrets.getOrCreateRandom(PAGE_GUEST_AUTHOR_KEY_PURPOSE, 32);
                if (key.byteLength !== 32 || closed) return yield* pageGuestFailure("unavailable");
                return yield* sql.withTransaction(
                  Effect.gen(function* () {
                    // The original proof is resolved again inside the write transaction. A previous
                    // eligibility result is not an authorization capability and is never accepted here.
                    const authorized = yield* sharing.resolveEditableGuestPage({
                      ...entry.value,
                      pageId: input.pageId,
                      expectedPageRevision: input.expectedPageRevision,
                    });
                    const rows = yield* sql<{
                      page_json: string;
                      rich_content: string | null;
                    }>`SELECT v.page_json, v.rich_content FROM pages_versions v
          JOIN pages_documents d ON d.page_id = v.page_id AND d.revision = v.revision
          WHERE d.page_id = ${authorized.pageId} AND d.revision = ${authorized.pageRevision}
            AND d.trashed_at IS NULL AND d.kind = 'page'`;
                    if (!rows[0] || closed) return yield* pageGuestFailure("unavailable");
                    const previous = yield* Effect.try({
                      try: () => Schema.decodeUnknownSync(Page)(JSON.parse(rows[0]!.page_json)),
                      catch: () => pageGuestFailure("unavailable"),
                    });
                    if (
                      previous.id !== authorized.pageId ||
                      previous.scopeSpaceId !== authorized.scopeSpaceId ||
                      previous.revision !== authorized.pageRevision
                    )
                      return yield* pageGuestFailure("unavailable");
                    const preservesMediaAccess = yield* Effect.try({
                      try: () => guestEditPreservesMediaAccess(rows[0]!.rich_content, rich.nodes),
                      catch: () => pageGuestFailure("unavailable"),
                    });
                    if (!preservesMediaAccess) return yield* pageGuestFailure("forbidden");
                    const actorRef = pageGuestActorRef(key, authorized);
                    const page = {
                      ...previous,
                      revision: previous.revision + 1,
                      updatedAt: new Date().toISOString(),
                    };
                    yield* persistPageVersion(
                      sql,
                      page,
                      rich.content,
                      "update",
                      { kind: "guest", actorRef },
                      previous.revision,
                      null,
                      rich.richContent,
                    );
                    return { page, content: rich.content, richContent: rich.richContent };
                  }),
                );
              }),
            ),
          )
          .pipe(
            // Guest admission has its own deadline. Existing owner room open/join/flush do not.
            Effect.timeoutOrElse({
              duration: "5 seconds",
              onTimeout: () => Effect.fail(pageGuestFailure("unavailable")),
            }),
            Effect.mapError((cause) =>
              cause instanceof PageGuestFailure ? cause : pageGuestFailure("unavailable"),
            ),
          );
      });
    return { write };
  });

export const GuestPageContentWriterLive = Layer.effect(
  GuestPageContentWriter,
  makeGuestPageContentWriter(),
);
