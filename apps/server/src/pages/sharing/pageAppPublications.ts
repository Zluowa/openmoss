import { createHash, randomUUID } from "node:crypto";
import type { PageAppId, PageGuestAppReference, PageId } from "@moss/contracts";
import { parsePageRichContent, type PageRichNode } from "@moss/shared/pageRichContent";
import { Data, Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PageAppsService } from "../apps/PageAppsService.ts";
import type { PagesPrincipal } from "../Services/PagesService.ts";
import {
  PageSharingService,
  type GuestAppHostPage,
  type GuestPageRevisionRequest,
} from "./PageSharingService.ts";
import { scopeKey } from "./pageSharingStore.ts";
import { pageGuestFailure } from "./pageGuestHandler.ts";

type Entry = GuestAppHostPage["entry"];
type Slot = {
  readonly entry: Entry;
  readonly pageId: PageId;
  readonly nodePath: readonly number[];
};
type Publish = Slot & {
  readonly pageRevision: number;
  readonly appId: PageAppId;
  readonly appRevision: number;
  readonly expectedGeneration: number;
};
type Publication = {
  publication_id: string;
  generation: number;
  entry_kind: Entry["kind"];
  entry_id: string;
  page_id: PageId;
  node_path: string;
  page_revision: number;
  policy_stamp: string;
  scope_key: string;
  space_id: string | null;
  body_digest: string;
  app_id: PageAppId;
  app_revision: number;
  app_digest: string;
};
export class AppPublicationFailure extends Data.TaggedError("AppPublicationFailure")<{
  readonly reason: "invalid" | "forbidden" | "conflict" | "unavailable";
}> {}
const fail = (reason: AppPublicationFailure["reason"]) => new AppPublicationFailure({ reason });
const unavailable = () => fail("unavailable");
const digest = (input: string) => createHash("sha256").update(input, "utf8").digest("hex");
const validPath = (path: readonly number[]) =>
  Array.isArray(path) &&
  path.length > 0 &&
  path.length <= 64 &&
  Array.from(path).every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000);
const validSlot = (s: Slot) =>
  (s.entry.kind === "link" || s.entry.kind === "site") &&
  typeof s.entry.id === "string" &&
  s.entry.id.length > 0 &&
  s.entry.id.length <= 128 &&
  validPath(s.nodePath);
const generationOk = (n: number) =>
  Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER;
function hasReference(
  body: string | null,
  path: readonly number[],
  app: PageAppId,
  revision: number,
): boolean {
  if (!body || !validPath(path)) return false;
  try {
    let list: readonly PageRichNode[] = parsePageRichContent(body).nodes;
    let node: PageRichNode | undefined;
    for (const index of path) {
      node = list[index];
      if (!node || typeof node.text === "string" || !Array.isArray(node.children)) return false;
      list = node.children;
    }
    return (
      node?.type === "moss_visualization" &&
      node.appPageId === app &&
      (node.appRevision === undefined || node.appRevision === revision)
    );
  } catch {
    return false;
  }
}

/** Internal only. No owner credential is synthesized for a guest; no HTTP,
 * relay, frame token, DB broker or capability grant is provided by this layer. */
export const makePageAppPublicationsFor = (
  sharing: Pick<
    import("./PageSharingService.ts").PageSharingServiceShape,
    "resolveGuestAppHostPage" | "resolveOwnerAppHostPage"
  >,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const apps = yield* PageAppsService;
    const fixed = (
      host: GuestAppHostPage,
      path: readonly number[],
      appId: PageAppId,
      revision: number,
    ) =>
      Effect.gen(function* () {
        if (
          !Number.isSafeInteger(revision) ||
          revision < 1 ||
          !hasReference(host.richContent, path, appId, revision)
        )
          return yield* unavailable();
        const frame = yield* apps.frameContent(appId, revision).pipe(Effect.mapError(unavailable));
        if (
          frame.app.scopeSpaceId !== host.scopeSpaceId ||
          frame.app.spaceId !== host.spaceId ||
          frame.revision !== revision
        )
          return yield* unavailable();
        // frame.app is current metadata; only the title belonging to the published bytes may leave this service.
        const rows = yield* sql<{
          title: string;
        }>`SELECT title FROM page_app_versions WHERE app_id=${appId} AND revision=${revision}`;
        if (!rows[0]) return yield* unavailable();
        const title = rows[0].title;
        return {
          title,
          html: frame.html,
          bodyDigest: digest(host.richContent!),
          appDigest: digest(
            JSON.stringify(["page-app-publication-v1", title, frame.html, frame.capabilities]),
          ),
        };
      });

    const advance = (slot: Slot, expected: number) =>
      Effect.gen(function* () {
        const key = JSON.stringify(slot.nodePath);
        const rows =
          expected === 0
            ? yield* sql<{
                generation: number;
              }>`INSERT INTO page_app_publication_slots(entry_kind,entry_id,page_id,node_path,generation)
          VALUES (${slot.entry.kind},${slot.entry.id},${slot.pageId},${key},1)
          ON CONFLICT DO NOTHING RETURNING generation`
            : yield* sql<{
                generation: number;
              }>`UPDATE page_app_publication_slots SET generation=generation+1
          WHERE entry_kind=${slot.entry.kind} AND entry_id=${slot.entry.id} AND page_id=${slot.pageId}
            AND node_path=${key} AND generation=${expected} RETURNING generation`;
        if (!rows[0]) return yield* fail("conflict");
        yield* sql`DELETE FROM page_app_publications WHERE entry_kind=${slot.entry.kind} AND entry_id=${slot.entry.id}
      AND page_id=${slot.pageId} AND node_path=${key}`;
        return rows[0].generation;
      });
    const ownerError = (e: unknown) => (e instanceof AppPublicationFailure ? e : unavailable());
    const publish = (input: Publish, principal: PagesPrincipal) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (principal.kind !== "local-user") return yield* fail("forbidden");
            if (!validSlot(input) || !generationOk(input.expectedGeneration))
              return yield* fail("invalid");
            const host = yield* sharing
              .resolveOwnerAppHostPage(input.entry, input.pageId, input.pageRevision, principal)
              .pipe(Effect.mapError(unavailable));
            // The owner explicitly picks the revision; owner read still runs its normal principal check.
            yield* apps
              .read({ appId: input.appId, revision: input.appRevision }, principal)
              .pipe(Effect.mapError(unavailable));
            const bytes = yield* fixed(host, input.nodePath, input.appId, input.appRevision);
            const generation = yield* advance(input, input.expectedGeneration);
            const publicationId = randomUUID();
            yield* sql`INSERT INTO page_app_publications(publication_id,entry_kind,entry_id,page_id,node_path,generation,policy_stamp,
      page_revision,scope_key,space_id,body_digest,app_id,app_revision,app_digest) VALUES
      (${publicationId},${host.entry.kind},${host.entry.id},${host.pageId},${JSON.stringify(input.nodePath)},${generation},
       ${host.policyStamp},${host.pageRevision},${scopeKey(host.scopeSpaceId)},${host.spaceId},${bytes.bodyDigest},${input.appId},${input.appRevision},${bytes.appDigest})`;
            return { publicationId, generation };
          }),
        )
        .pipe(Effect.mapError(ownerError));
    const revoke = (slot: Slot, expectedGeneration: number, principal: PagesPrincipal) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (principal.kind !== "local-user") return yield* fail("forbidden");
            if (!validSlot(slot) || !generationOk(expectedGeneration) || !expectedGeneration)
              return yield* fail("invalid");
            return { generation: yield* advance(slot, expectedGeneration) };
          }),
        )
        .pipe(Effect.mapError(ownerError));
    const resolve = (request: GuestPageRevisionRequest, publicationId: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const host = yield* sharing.resolveGuestAppHostPage(request);
            const [row] =
              yield* sql<Publication>`SELECT * FROM page_app_publications WHERE publication_id=${publicationId}
      AND entry_kind=${host.entry.kind} AND entry_id=${host.entry.id} AND page_id=${host.pageId} AND page_revision=${host.pageRevision}`;
            if (
              !row ||
              row.scope_key !== scopeKey(host.scopeSpaceId) ||
              row.space_id !== host.spaceId ||
              row.policy_stamp !== host.policyStamp
            )
              return yield* unavailable();
            const path = yield* Effect.try({
              try: () => JSON.parse(row.node_path) as number[],
              catch: unavailable,
            });
            const bytes = yield* fixed(host, path, row.app_id, row.app_revision);
            if (row.body_digest !== bytes.bodyDigest || row.app_digest !== bytes.appDigest)
              return yield* unavailable();
            return {
              publicationId,
              generation: row.generation,
              pageId: host.pageId,
              pageRevision: host.pageRevision,
              appId: row.app_id,
              appRevision: row.app_revision,
              title: bytes.title,
              html: bytes.html,
              availableCapabilities: [] as const,
            };
          }),
        )
        .pipe(Effect.mapError(() => pageGuestFailure("unavailable")));
    // A reference in guest-editable rich content is only a selector. No lookup by bare app ID.
    const findForGuest = (request: GuestPageRevisionRequest, ref: PageGuestAppReference) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const host = yield* sharing.resolveGuestAppHostPage(request);
            if (!validPath(ref.nodePath)) return yield* unavailable();
            const [row] = yield* sql<{
              publication_id: string;
              app_revision: number;
            }>`SELECT publication_id,app_revision FROM page_app_publications
      WHERE entry_kind=${host.entry.kind} AND entry_id=${host.entry.id} AND page_id=${host.pageId} AND page_revision=${host.pageRevision}
      AND scope_key=${scopeKey(host.scopeSpaceId)} AND space_id IS ${host.spaceId} AND policy_stamp=${host.policyStamp}
      AND node_path=${JSON.stringify(ref.nodePath)} AND app_id=${ref.appId}`;
            if (!row || (ref.appRevision !== undefined && ref.appRevision !== row.app_revision))
              return yield* unavailable();
            return row.publication_id;
          }),
        )
        .pipe(Effect.mapError(() => pageGuestFailure("unavailable")));
    return { publish, revoke, resolve, findForGuest };
  });
export const makePageAppPublications = Effect.flatMap(
  Effect.service(PageSharingService),
  makePageAppPublicationsFor,
);
