import { createHash } from "node:crypto";
import { PageGuestViewRequest, PageId, type SpaceId } from "@moss/contracts";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../../auth/Services/ServerSecretStore";
import { pageAccessEpoch } from "../pageAccessEpoch";
import {
  PageRealtimeService,
  type PageRealtimeServiceShape,
} from "../realtime/PageRealtimeService";
import {
  GUEST_FRAME_LIMIT,
  GUEST_ROOM_STATE_LIMIT,
  prepareGuestFrame,
} from "../realtime/guestRoomFrame";
import { copyOrdinaryByteView } from "../realtime/ordinaryByteView";
import { PageSharingService, type PageSharingServiceShape } from "../sharing/PageSharingService";
import { commitGuestPageFrame } from "./commitGuestPageFrame";
import { pageGuestActorRef, PAGE_GUEST_AUTHOR_KEY_PURPOSE } from "./pageGuestAuthor";
import { discardUnusedGuestSeed, publishedSeedForGuestOpen } from "./publishedSeedForGuestOpen";
import { GuestProjectionError, safeSeedLimit } from "./guestProjectionContent";
import {
  makeGuestProjectionSessions,
  type GuestProjectionSessions,
  type ProjectionPage,
} from "./guestProjectionSessions";

export type PageProjectionOperations = Pick<
  GuestProjectionSessions<PageGuestViewRequest>,
  "open" | "read" | "submit" | "release" | "observe"
>;
export class GuestPageProjectionService extends ServiceMap.Service<
  GuestPageProjectionService,
  PageProjectionOperations
>()("moss/pages/guestEditing/GuestPageProjectionService") {}

const unavailable = () => new GuestProjectionError("unavailable");
const stale = () => new GuestProjectionError("conflict");

function proofFor(raw: PageGuestViewRequest, pageId: string) {
  return Effect.try({
    try: () => {
      const parsed = Schema.decodeUnknownOption(PageGuestViewRequest)(raw);
      if (
        Option.isNone(parsed) ||
        (parsed.value.pageId !== undefined && parsed.value.pageId !== pageId) ||
        Object.keys(raw).some((key) => !["link", "key", "pageId", "visitor"].includes(key))
      )
        throw unavailable();
      return parsed.value;
    },
    catch: unavailable,
  });
}

interface SourceContext {
  readonly sql: SqlClient.SqlClient;
  readonly sharing: Pick<PageSharingServiceShape, "resolveEditableGuestPage">;
  readonly secrets: ServerSecretStoreShape;
  readonly activeGeneration: (id: string) => string | null;
  readonly stamp: () => string | null;
}

/** Always resolve the original proof in the caller's actual transaction. */
function authorizedPublication(
  context: SourceContext,
  entry: PageGuestViewRequest,
  pageId: PageId,
) {
  return Effect.gen(function* () {
    const { sql, sharing, secrets } = context;
    const stamp = context.stamp();
    if (stamp === null) return yield* Effect.fail(unavailable());
    const [doc] = yield* sql<{
      revision: number;
    }>`SELECT revision FROM pages_documents WHERE page_id=${pageId} AND trashed_at IS NULL AND kind='page'`;
    if (!doc) return yield* Effect.fail(unavailable());
    const allowed = yield* sharing.resolveEditableGuestPage({
      ...entry,
      pageId,
      expectedPageRevision: doc.revision,
    });
    if (allowed.pageId !== pageId || allowed.pageRevision !== doc.revision)
      return yield* Effect.fail(stale());
    const [source] = yield* sql<{ rich_content: string }>`SELECT rich_content FROM pages_versions
      WHERE page_id=${pageId} AND revision=${doc.revision} AND rich_content IS NOT NULL
      AND length(CAST(rich_content AS BLOB))<=${safeSeedLimit}`;
    if (!source) return yield* Effect.fail(new GuestProjectionError("unsupported"));
    const key = yield* secrets.getOrCreateRandom(PAGE_GUEST_AUTHOR_KEY_PURPOSE, 32);
    if (key.byteLength !== 32 || stamp !== context.stamp())
      return yield* Effect.fail(unavailable());
    return { key, stamp, allowed, rich: source.rich_content };
  });
}

/** For export read only the durable published checkpoint. During mapping replace
 * it with the actual locked owner state for the private exact-cut comparison. */
function currentSource(
  context: SourceContext,
  entry: PageGuestViewRequest,
  pageId: PageId,
  liveBase?: {
    readonly state: Uint8Array;
    readonly revision: number;
    readonly scope: SpaceId | null;
  },
) {
  return Effect.gen(function* () {
    const { sql, activeGeneration } = context;
    const { key, stamp, allowed, rich } = yield* authorizedPublication(context, entry, pageId);
    const revision = allowed.pageRevision;
    if (liveBase && (liveBase.revision !== revision || liveBase.scope !== allowed.scopeSpaceId))
      return yield* Effect.fail(stale());
    const generation = activeGeneration(pageId);
    if (!generation) return yield* Effect.fail(unavailable());
    let state = liveBase?.state;
    if (!state) {
      const [row] = yield* sql<{
        state: Uint8Array;
      }>`SELECT state FROM pages_realtime_docs WHERE page_id=${pageId}
        AND generation=${generation} AND compacted_revision<=${revision} AND compacted_key=${rich}
        AND typeof(state)='blob' AND length(state)<=${GUEST_ROOM_STATE_LIMIT}`;
      if (!row) return yield* Effect.fail(stale());
      state = row.state;
    }
    if (stamp !== context.stamp() || generation !== activeGeneration(pageId))
      return yield* Effect.fail(unavailable());
    const page: ProjectionPage = {
      mode: "share",
      role: "edit",
      kind: "page",
      pageId,
      scope: allowed.scopeSpaceId,
      actorRef: pageGuestActorRef(key, allowed),
      grantEpoch: stamp,
      generation,
      revision,
      publishedRich: rich,
      ownerState: state,
    };
    return { page, key };
  });
}

/** Both the internal service and the opted-in publisher share the same writer and proof resolver. */
export const makeGuestPageProjectionService = (dependencies: {
  sql: SqlClient.SqlClient;
  realtime: PageRealtimeServiceShape;
  sharing: SourceContext["sharing"];
  secrets: ServerSecretStoreShape;
  issuer?: () => string | null;
}) =>
  Effect.gen(function* () {
    const { sql, realtime, sharing, secrets } = dependencies;
    const epoch = pageAccessEpoch(sql);
    const currentStamp = () => {
      const value = epoch.current();
      if (!value || !dependencies.issuer) return value;
      const issuer = dependencies.issuer();
      return issuer ? value + ":" + createHash("sha256").update(issuer).digest("hex") : null;
    };
    const services = yield* Effect.services<never>();
    const execute = Effect.runPromiseWith(services);
    const running = new Set<Promise<unknown>>();
    let closed = false;
    const run = <A, E>(task: Effect.Effect<A, E>, signal: AbortSignal): Promise<A> => {
      if (closed || signal.aborted) return Promise.reject(unavailable());
      const operation = execute(task, { signal });
      running.add(operation);
      operation.then(
        () => running.delete(operation),
        () => running.delete(operation),
      );
      return operation;
    };
    const context = {
      sql,
      sharing,
      secrets,
      activeGeneration: realtime.activeGuestGeneration,
      stamp: currentStamp,
    };
    const sessions = makeGuestProjectionSessions<PageGuestViewRequest>({
      currentGrantEpoch: (page) =>
        realtime.activeGuestGeneration(page.pageId) === page.generation ? currentStamp() : null,
      isChanging: () => epoch.current() === null,
      readIdentity: (raw, id, signal) =>
        run(
          sql.withTransaction(
            Effect.gen(function* () {
              const entry = yield* proofFor(raw, id);
              const pageId = PageId.makeUnsafe(id);
              const stamp = currentStamp();
              const generation = realtime.activeGuestGeneration(id);
              if (!stamp || !generation) return yield* Effect.fail(unavailable());
              const [doc] = yield* sql<{
                revision: number;
              }>`SELECT revision FROM pages_documents WHERE page_id=${pageId} AND trashed_at IS NULL AND kind='page'`;
              if (!doc) return yield* Effect.fail(unavailable());
              const allowed = yield* sharing.resolveEditableGuestPage({
                ...entry,
                pageId,
                expectedPageRevision: doc.revision,
              });
              const key = yield* secrets.getOrCreateRandom(PAGE_GUEST_AUTHOR_KEY_PURPOSE, 32);
              if (
                key.byteLength !== 32 ||
                currentStamp() !== stamp ||
                !realtime.touchGuestGeneration(id, generation)
              )
                return yield* Effect.fail(unavailable());
              return {
                mode: "share" as const,
                role: "edit" as const,
                kind: "page",
                pageId,
                scope: allowed.scopeSpaceId,
                actorRef: pageGuestActorRef(key, allowed),
                grantEpoch: stamp,
                generation,
                revision: allowed.pageRevision,
              };
            }),
          ),
          signal,
        ),
      readCurrent: (raw, id, signal) =>
        run(
          Effect.gen(function* () {
            const entry = yield* proofFor(raw, id);
            const before = currentStamp();
            if (before === null) return yield* Effect.fail(unavailable());
            const pageId = PageId.makeUnsafe(id);
            if (!realtime.activeGuestGeneration(pageId)) {
              yield* realtime.prepareProjectionRoom(
                pageId,
                () =>
                  sql.withTransaction(
                    Effect.gen(function* () {
                      const source = yield* authorizedPublication(context, entry, pageId);
                      if (source.stamp !== before) return yield* Effect.fail(unavailable());
                      const { seed, created } = yield* publishedSeedForGuestOpen(
                        sql,
                        pageId,
                        source.allowed.pageRevision,
                        source.rich,
                      );
                      if (currentStamp() !== before) return yield* Effect.fail(unavailable());
                      return {
                        scope: source.allowed.scopeSpaceId,
                        seed,
                        ...(created ? { discard: discardUnusedGuestSeed(sql, pageId, seed) } : {}),
                      };
                    }),
                  ),
                (generation, scope) =>
                  sql.withTransaction(
                    Effect.gen(function* () {
                      const { page } = yield* currentSource(context, entry, pageId);
                      if (
                        page.grantEpoch !== before ||
                        page.generation !== generation ||
                        page.scope !== scope
                      )
                        return yield* Effect.fail(unavailable());
                    }),
                  ),
              );
            }
            const { page } = yield* sql.withTransaction(currentSource(context, entry, pageId));
            if (
              page.grantEpoch !== before ||
              currentStamp() !== before ||
              !realtime.touchGuestGeneration(id, page.generation)
            )
              return yield* Effect.fail(unavailable());
            return page;
          }),
          signal,
        ),
      commitAuthorized: (raw, id, map, signal) =>
        run(
          Effect.gen(function* () {
            const entry = yield* proofFor(raw, id);
            const before = currentStamp();
            if (before === null) return yield* Effect.fail(unavailable());
            const pageId = PageId.makeUnsafe(id);
            const generation = realtime.activeGuestGeneration(pageId);
            if (!generation) return yield* Effect.fail(unavailable());
            return yield* realtime.transactMappedGuestFrame(pageId, generation, (base, scope) =>
              sql.withTransaction(
                Effect.gen(function* () {
                  const { page, key } = yield* currentSource(context, entry, pageId, {
                    state: base.baselineState,
                    revision: base.revision,
                    scope,
                  });
                  if (page.grantEpoch !== before) return yield* Effect.fail(unavailable());
                  const mapped = yield* Effect.try({
                    try: () => map(page),
                    catch: (cause) =>
                      cause instanceof GuestProjectionError ? cause : unavailable(),
                  });
                  const bytes =
                    mapped === null
                      ? Uint8Array.of(0, 0)
                      : copyOrdinaryByteView(mapped, GUEST_FRAME_LIMIT, 1);
                  if (!bytes) return yield* Effect.fail(new GuestProjectionError("invalid"));
                  const frame = yield* Effect.try({
                    try: () => prepareGuestFrame(base.baselineState, bytes),
                    catch: () => new GuestProjectionError("invalid"),
                  });
                  const stored = yield* commitGuestPageFrame(sql, sharing, {
                    entry,
                    pageId,
                    scope,
                    key,
                    cut: { ...base, ...frame },
                  });
                  if (
                    page.grantEpoch !== currentStamp() ||
                    generation !== realtime.activeGuestGeneration(pageId)
                  )
                    return yield* Effect.fail(unavailable());
                  return { frame, stored };
                }),
              ),
            );
          }),
          signal,
        ),
    });
    const unsubscribe = epoch.listen(sessions.invalidate);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closed = true;
        unsubscribe();
        sessions.close();
        await Promise.allSettled([...running]);
      }),
    );
    return {
      open: sessions.open,
      read: sessions.read,
      submit: sessions.submit,
      observe: sessions.observe,
      release: sessions.release,
    };
  });

export const GuestPageProjectionServiceLive = Layer.effect(
  GuestPageProjectionService,
  Effect.gen(function* () {
    return yield* makeGuestPageProjectionService({
      sql: yield* SqlClient.SqlClient,
      realtime: yield* PageRealtimeService,
      sharing: yield* PageSharingService,
      secrets: yield* ServerSecretStore,
    });
  }),
);
