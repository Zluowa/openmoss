// FILE: PageRealtimeService.ts
// Purpose: Owns the live Page rooms of this Moss server: tickets, SQLite storage, room lifetime,
//          and a PagesService that sends content writes of an open Page through its room.
// Layer: Pages realtime (collab). Registered once in serverLayers (`PagesRealtimeLive`).
// Why: Every writer reaches Pages through PagesService: the RPC (any window or paired device),
//      agent tools and automations. Wrapping it is the one place where an agent's
//      `moss_pages_mutate` becomes a Yjs transaction that merges with what people are typing,
//      instead of a revision conflict or an overwrite.

import { randomUUID } from "node:crypto";

import {
  PAGES_REALTIME_WS_PATH,
  type PagesMutateInput,
  type PagesMutateResult,
  type PagesRealtimeTokenInput,
  type PagesRealtimeTokenResult,
  type ThreadId,
} from "@moss/contracts";
import { parsePageRichContent } from "@moss/shared/pageRichContent";
import { Effect, Exit, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PagesServiceLive } from "../Layers/PagesService";
import {
  LOCAL_PAGES_PRINCIPAL,
  PagesService,
  PagesServiceError,
  type PagesPrincipal,
  type PagesServiceShape,
} from "../Services/PagesService";
import {
  PageRealtimeRoom,
  PageRoomCloseFailure,
  sourceKey,
  type RoomConnection,
  type RoomPageState,
  type RoomStore,
  type RoomWriter,
  type GuestRoomCandidate,
  type GuestRoomCommit,
  type FrozenGuestRoom,
  type GuestRoomPublication,
  type PublishedRoomSeed,
} from "./PageRealtimeRoom";
import { appendRoomUpdate, commitRoomCheckpoint, journalContributors } from "./pageRoomPublication";
import { encodeContributors, unrecordedContributor } from "../pageVersionContributors";
import { makePageRoomReservations } from "./pageRoomReservations";
import {
  PageRealtimeTickets,
  type RealtimeTicket,
  type RealtimeTicketMode,
} from "./pageRealtimeTokens";

/** A room stays loaded this long after its last window leaves, for quick reconnects. */
const IDLE_CLOSE_MS = 30_000;

export interface PageRealtimeServiceShape {
  readonly issueToken: (
    input: PagesRealtimeTokenInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PagesRealtimeTokenResult, PagesServiceError>;
  /** Redeems a ticket for this Page; null when it is forged, expired, used or for another Page.
   * The route calls this before upgrading, so a bad ticket gets a plain HTTP refusal. */
  readonly admit: (pageId: string, token: string) => RealtimeTicket | null;
  /** Joins the ticket's room (redeeming `token` first when given instead of a ticket). */
  readonly join: (
    input: {
      readonly pageId: string;
      readonly connection: (mode: RealtimeTicketMode) => RoomConnection;
    } & ({ readonly ticket: RealtimeTicket } | { readonly token: string }),
  ) => Promise<{
    readonly room: PageRealtimeRoom;
    readonly connection: RoomConnection;
  } | null>;
  readonly leave: (pageId: string, connection: RoomConnection) => void;
  readonly roomCount: () => number;
  /** In-process transaction hook for the proof-checking guest writer. No client-facing method. */
  readonly transactGuestFrame: (
    pageId: string,
    generation: string,
    update: Uint8Array,
    commit: (
      candidate: GuestRoomCandidate,
      scope: ScopeSpaceId,
    ) => Effect.Effect<GuestRoomCommit, unknown>,
  ) => Effect.Effect<{ revision: number; applied: boolean }, unknown>;
  readonly activeGuestGeneration: (pageId: string) => string | null;
  readonly touchGuestGeneration: (pageId: string, generation: string) => boolean;
  readonly prepareProjectionRoom: (
    pageId: string,
    prepare: () => Effect.Effect<
      { scope: ScopeSpaceId; seed: PublishedRoomSeed; discard?: Effect.Effect<void, unknown> },
      unknown
    >,
    confirm: (generation: string, scope: ScopeSpaceId) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<string, unknown>;
  readonly transactMappedGuestFrame: (
    pageId: string,
    generation: string,
    commit: (
      base: FrozenGuestRoom,
      scope: ScopeSpaceId,
    ) => Effect.Effect<GuestRoomPublication, unknown>,
  ) => Effect.Effect<{ revision: number; applied: boolean }, unknown>;
  /** Internal no-room transaction gate, not an authorization or guest admission API. */
  readonly withRoomClosed: <A, E, R>(
    pageId: string,
    task: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PagesServiceError, R>;
  /** Shows an agent as editing a page that has a live room (no-op otherwise), for example while
   * it writes a draft that only lands when the person accepts it. */
  readonly showAgent: (pageId: string, threadId: string, name?: string) => void;
}

export class PageRealtimeService extends ServiceMap.Service<
  PageRealtimeService,
  PageRealtimeServiceShape
>()("moss/pages/realtime/PageRealtimeService") {}

const storeFor = (
  sql: SqlClient.SqlClient,
  run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>,
  pageId: string,
): RoomStore => {
  const bytes = (value: unknown) =>
    value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value as ArrayBuffer);
  return {
    load: () =>
      run(
        Effect.gen(function* () {
          const docs = yield* sql<{
            generation: string;
            state: Uint8Array;
            compacted_revision: number;
            compacted_key: string;
            next_sequence: number;
            compacted_through_sequence: number;
          }>`SELECT generation, state, compacted_revision, compacted_key, next_sequence, compacted_through_sequence
            FROM pages_realtime_docs WHERE page_id = ${pageId}`;
          const doc = docs[0];
          if (!doc) return null;
          const updates = yield* sql<{
            update_data: Uint8Array;
            contributors_json: string | null;
          }>`SELECT update_data, contributors_json
            FROM pages_realtime_updates
            WHERE page_id = ${pageId} AND generation = ${doc.generation} ORDER BY seq`;
          return {
            generation: doc.generation,
            state: bytes(doc.state),
            compactedRevision: doc.compacted_revision,
            compactedKey: doc.compacted_key,
            lastSequence: doc.next_sequence - 1,
            compactedThroughSequence: doc.compacted_through_sequence,
            updates: updates.map((row) => bytes(row.update_data)),
            unpublishedContributors: journalContributors(updates),
          };
        }),
      ),
    append: (generation, update, sources) =>
      run(appendRoomUpdate(sql, pageId, generation, update, sources)),
    compacted: (cut) => run(commitRoomCheckpoint(sql, pageId, cut)),
    snapshot: (generation, revision) =>
      run(
        sql<{ state: Uint8Array }>`SELECT state FROM pages_realtime_snapshots
          WHERE page_id = ${pageId} AND generation = ${generation} AND revision = ${revision}`.pipe(
          Effect.map((rows) => (rows[0] ? bytes(rows[0].state) : null)),
        ),
      ),
    clear: () =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM pages_realtime_updates WHERE page_id = ${pageId}`;
            yield* sql`DELETE FROM pages_realtime_snapshots WHERE page_id = ${pageId}`;
            yield* sql`DELETE FROM pages_realtime_docs WHERE page_id = ${pageId}`;
          }),
        ),
      ),
  };
};

const principalFor = (writer: RoomWriter): PagesPrincipal =>
  writer.kind === "agent"
    ? { kind: "agent", threadId: writer.threadId as ThreadId }
    : LOCAL_PAGES_PRINCIPAL;

type ScopeSpaceId = PagesRealtimeTokenInput["scopeSpaceId"];

interface RoomEntry {
  readonly room: PageRealtimeRoom;
  readonly scopeSpaceId: ScopeSpaceId;
  readonly ready: Promise<void>;
  idle: ReturnType<typeof setTimeout> | undefined;
}

export const makePageRealtime = (base: PagesServiceShape) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const services = yield* Effect.services<SqlClient.SqlClient>();
    const runWith = Effect.runPromiseWith(services);
    const run = <A>(effect: Effect.Effect<A, unknown>) => runWith(effect as Effect.Effect<A>);
    const tickets = new PageRealtimeTickets();
    const rooms = new Map<string, RoomEntry>();
    const reservations = yield* makePageRoomReservations();

    const pageState = (result: {
      readonly page: { readonly revision: number; readonly trashedAt: string | null };
      readonly content: string;
      readonly richContent?: string | undefined;
    }): RoomPageState => ({
      revision: result.page.revision,
      richContent: result.richContent ?? null,
      content: result.content,
      trashed: result.page.trashedAt !== null,
    });

    const roomFor = (
      pageId: string,
      scopeSpaceId: ScopeSpaceId,
      published?: PublishedRoomSeed,
    ): RoomEntry => {
      const existing = rooms.get(pageId);
      if (existing) return existing;
      const room: PageRealtimeRoom = new PageRealtimeRoom({
        pageId,
        store: storeFor(sql, run, pageId),
        newGeneration: randomUUID,
        onError: (message, cause) =>
          void run(Effect.logWarning(message, { pageId, cause: String(cause) })),
        pages: {
          read: () =>
            run(base.read({ scopeSpaceId, pageId: pageId as never }, LOCAL_PAGES_PRINCIPAL)).then(
              pageState,
            ),
          publish: (cut) =>
            run(
              sql
                .withTransaction(
                  Effect.gen(function* () {
                    const prefix = yield* sql<{
                      contributors_json: string | null;
                    }>`SELECT contributors_json FROM pages_realtime_updates
              WHERE page_id=${pageId} AND generation=${cut.generation} AND seq<=${cut.throughSequence} ORDER BY seq`;
                    const sources = journalContributors(prefix);
                    if (encodeContributors(sources) !== encodeContributors(cut.contributors))
                      return yield* new PagesServiceError({
                        code: "storage",
                        message: "Page contributor journal differs from the publication cut",
                      });
                    if (sources.some((source) => source.kind === "guest"))
                      return yield* new PagesServiceError({
                        code: "invalid",
                        message: "Guest room publication is unavailable",
                      });
                    // Retain the original local/agent authorization, rich normalization, version and
                    // request-replay behavior. The checkpoint/prune shares the same SQL transaction.
                    const principal = principalFor(cut.writer);
                    const result = cut.checkpointOnly
                      ? yield* base.read({ scopeSpaceId, pageId: pageId as never }, principal)
                      : yield* base.mutate(
                          {
                            op: "update",
                            requestId: randomUUID(),
                            scopeSpaceId,
                            pageId: pageId as never,
                            expectedRevision: cut.expectedRevision,
                            richContent: cut.richContent,
                          },
                          principal,
                        );
                    const page = pageState(result);
                    if (page.trashed)
                      return yield* new PagesServiceError({
                        code: "invalid",
                        message: "Restore the page before publishing its room",
                      });
                    if (
                      cut.checkpointOnly &&
                      (page.revision !== cut.expectedRevision ||
                        sourceKey(page) !== cut.baseContentKey)
                    )
                      return yield* new PagesServiceError({
                        code: "conflict",
                        message: "Page changed before room checkpoint",
                      });
                    if (!cut.checkpointOnly) {
                      const recorded = encodeContributors(
                        sources.length ? sources : [unrecordedContributor],
                      );
                      yield* sql`INSERT INTO pages_version_contributors(page_id,revision,contributors_json) VALUES(${pageId},${page.revision},${recorded})`;
                    }
                    yield* commitRoomCheckpoint(sql, pageId, {
                      generation: cut.generation,
                      state: cut.state,
                      revision: page.revision,
                      key: sourceKey(page),
                      throughSequence: cut.throughSequence,
                    });
                    return page;
                  }),
                )
                .pipe(
                  Effect.catchIf(
                    (error) => error instanceof PagesServiceError && error.code === "conflict",
                    () => Effect.succeed(null),
                  ),
                ),
            ),
        },
      });
      const entry: RoomEntry = {
        room,
        scopeSpaceId,
        ready: published ? room.openPublished(published) : room.open(),
        idle: undefined,
      };
      rooms.set(pageId, entry);
      entry.ready
        .then(() => scheduleIdle(pageId, entry))
        .catch(() => {
          if (rooms.get(pageId) === entry) rooms.delete(pageId);
        });
      return entry;
    };

    const closeEntry = async (pageId: string, entry: RoomEntry) => {
      clearTimeout(entry.idle);
      try {
        await entry.room.close();
      } catch (cause) {
        const volatile = !(cause instanceof PageRoomCloseFailure) || cause.hasVolatileUpdates;
        if (!volatile && rooms.get(pageId) === entry) rooms.delete(pageId);
        await run(Effect.logWarning("Page room close failed", { pageId, volatile }));
        throw cause;
      } finally {
        clearTimeout(entry.idle);
        entry.idle = undefined;
      }
      if (rooms.get(pageId) === entry) rooms.delete(pageId);
    };
    const availableRoom = (pageId: string, scopeSpaceId: ScopeSpaceId) =>
      Effect.gen(function* () {
        const prior = rooms.get(pageId);
        if (prior?.room.isClosing) {
          // A previous close retained volatile bytes. An explicit owner admission retries
          // exactly once; it must not connect to the failed/closing instance.
          yield* Effect.uninterruptible(
            Effect.tryPromise({
              try: () => closeEntry(pageId, prior),
              catch: () =>
                new PagesServiceError({
                  code: "storage",
                  message: "Page room could not finish saving",
                }),
            }),
          );
        }
        return roomFor(pageId, scopeSpaceId);
      });

    const scheduleIdle = (pageId: string, entry: RoomEntry) => {
      clearTimeout(entry.idle);
      entry.idle = undefined;
      // A canceled open can settle while shutdown is awaiting the real close/flush.
      // The entry intentionally stays in the map then, but must never start a new timer.
      if (rooms.get(pageId) !== entry || entry.room.isClosing) return;
      if (entry.room.connections.size > 0) return;
      entry.idle = setTimeout(() => {
        void run(
          reservations.withPage(
            pageId,
            Effect.uninterruptible(
              Effect.promise(async () => {
                if (rooms.get(pageId) !== entry || entry.room.connections.size > 0) return;
                // Keep the room visible until its final flush finishes. A guest transaction must
                // not overtake close() merely because the idle timer removed its map entry.
                // close() has no cancellation protocol: interruption must await the real flush,
                // not release the permit while its Promise continues mutating shared state.
                await closeEntry(pageId, entry);
              }),
            ),
          ),
        ).catch(() => undefined);
      }, IDLE_CLOSE_MS);
    };

    const issueToken: PageRealtimeServiceShape["issueToken"] = (input, principal) =>
      reservations.withPage(
        input.pageId,
        Effect.gen(function* () {
          // Reading the Page is the authorization check and rejects pages in another scope.
          const page = yield* base.read(
            { scopeSpaceId: input.scopeSpaceId, pageId: input.pageId },
            principal,
          );
          const mode: RealtimeTicketMode =
            page.page.trashedAt !== null || input.mode === "view" ? "view" : "edit";
          const entry = yield* availableRoom(input.pageId, input.scopeSpaceId);
          yield* Effect.tryPromise({
            try: () => entry.ready,
            catch: (cause) =>
              new PagesServiceError({
                code: "storage",
                message: "Page room failed to open",
                cause,
              }),
          });
          scheduleIdle(input.pageId, entry);
          const ticket = tickets.issue({
            pageId: input.pageId,
            scopeSpaceId: input.scopeSpaceId,
            mode,
          });
          return {
            pageId: input.pageId,
            token: ticket.token,
            expiresAt: new Date(ticket.expiresAt).toISOString(),
            mode,
            generation: entry.room.generation,
            revision: Math.max(1, entry.room.currentRevision || page.page.revision),
            wsPath: PAGES_REALTIME_WS_PATH,
          };
        }),
      );

    const withLiveGuestRoom = (
      pageId: string,
      generation: string,
      use: (
        entry: RoomEntry,
        signal: AbortSignal,
      ) => Promise<{ revision: number; applied: boolean }>,
    ) =>
      reservations.withPage(
        pageId,
        Effect.suspend(() => {
          const entry = rooms.get(pageId);
          if (!entry || entry.room.isClosing || entry.room.generation !== generation)
            return Effect.fail(
              new PagesServiceError({ code: "invalid", message: "Page room unavailable" }),
            );
          return Effect.callback<{ revision: number; applied: boolean }, unknown>(
            (resume, signal) => {
              const operation = use(entry, signal);
              operation.then(
                (result) => resume(Effect.succeed(result)),
                (cause) => resume(Effect.fail(cause)),
              );
              // SQL receives cancellation, while the real promise retains the reservation
              // until its rollback/commit and room adoption have finished.
              return Effect.promise(() =>
                operation.then(
                  () => undefined,
                  () => undefined,
                ),
              );
            },
          );
        }),
      );

    const service: PageRealtimeServiceShape = {
      issueToken,
      admit: (pageId, token) => tickets.redeem(token, pageId),
      join: (input) =>
        run(
          reservations.withPage(
            input.pageId,
            Effect.gen(function* () {
              const { pageId, connection } = input;
              const ticket = "ticket" in input ? input.ticket : tickets.redeem(input.token, pageId);
              if (!ticket || ticket.pageId !== pageId) return null;
              const entry = yield* availableRoom(pageId, ticket.scopeSpaceId as ScopeSpaceId);
              if (entry.scopeSpaceId !== ticket.scopeSpaceId) return null;
              yield* Effect.tryPromise({
                try: () => entry.ready,
                catch: () =>
                  new PagesServiceError({ code: "storage", message: "Page room failed to join" }),
              });
              clearTimeout(entry.idle);
              const joined = connection(ticket.mode);
              entry.room.connect(joined);
              return { room: entry.room, connection: joined };
            }),
          ),
        ).catch(() => null),
      leave: (pageId, connection) => {
        const entry = rooms.get(pageId);
        if (!entry) return;
        entry.room.disconnect(connection);
        scheduleIdle(pageId, entry);
      },
      roomCount: () => rooms.size,
      activeGuestGeneration: (pageId) => {
        const entry = rooms.get(pageId);
        return entry && !entry.room.isClosing ? entry.room.generation : null;
      },
      touchGuestGeneration: (pageId, generation) => {
        const entry = rooms.get(pageId);
        if (!entry || entry.room.isClosing || entry.room.generation !== generation) return false;
        scheduleIdle(pageId, entry);
        return true;
      },
      prepareProjectionRoom: (pageId, prepare, confirm) =>
        reservations.withPage(
          pageId,
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const prior = rooms.get(pageId);
              if (prior?.room.isClosing)
                return yield* new PagesServiceError({
                  code: "storage",
                  message: "Page room unavailable",
                });
              let entry = prior;
              let discard: Effect.Effect<void, unknown> | undefined;
              if (!entry) {
                const prepared = yield* restore(prepare());
                discard = prepared.discard;
                entry = roomFor(pageId, prepared.scope, prepared.seed);
              }
              const selected = entry;
              const admit = Effect.gen(function* () {
                yield* Effect.tryPromise({
                  try: () => selected.ready,
                  catch: () =>
                    new PagesServiceError({ code: "storage", message: "Page room unavailable" }),
                });
                const generation = selected.room.generation;
                if (!generation || selected.room.isClosing)
                  return yield* new PagesServiceError({
                    code: "storage",
                    message: "Page room unavailable",
                  });
                yield* confirm(generation, selected.scopeSpaceId);
                scheduleIdle(pageId, selected);
                return generation;
              });
              return yield* restore(admit).pipe(
                Effect.onExit((outcome) => {
                  if (Exit.isSuccess(outcome) || prior || selected.room.connections.size)
                    return Effect.void;
                  const current = rooms.get(pageId);
                  if (current && current !== selected) return Effect.void;
                  const close = current
                    ? Effect.promise(() => closeEntry(pageId, selected))
                    : Effect.void;
                  return close.pipe(Effect.andThen(discard ?? Effect.void));
                }),
              );
            }),
          ),
        ),
      transactGuestFrame: (pageId, generation, update, commit) =>
        withLiveGuestRoom(pageId, generation, (entry, signal) =>
          entry.room.applyGuestFrame(generation, update, signal, (candidate) =>
            runWith(commit(candidate, entry.scopeSpaceId), { signal }),
          ),
        ),
      transactMappedGuestFrame: (pageId, generation, commit) =>
        withLiveGuestRoom(pageId, generation, (entry, signal) =>
          entry.room.applyMappedGuestFrame(generation, signal, (base) =>
            runWith(commit(base, entry.scopeSpaceId), { signal }),
          ),
        ),
      withRoomClosed: (pageId, task) =>
        reservations.withPage(
          pageId,
          Effect.gen(function* () {
            if (rooms.has(pageId)) {
              return yield* new PagesServiceError({
                code: "invalid",
                message: "Live page edits require room authorization",
              });
            }
            return yield* task;
          }),
        ),
      showAgent: (pageId, threadId, name) => {
        const room = rooms.get(pageId)?.room;
        if (room?.seeded) room.showAgent(threadId, name);
      },
    };

    /** Content writes to a Page with a live room merge into it; everything else passes through
     * and the room follows the result. */
    const mutate: PagesServiceShape["mutate"] = (raw: PagesMutateInput, principal) =>
      Effect.gen(function* () {
        let input = raw;
        const found = "pageId" in input ? rooms.get(input.pageId) : undefined;
        const entry = found && found.scopeSpaceId === input.scopeSpaceId ? found : undefined;
        if (entry) {
          if (entry.room.isClosing)
            return yield* new PagesServiceError({
              code: "storage",
              message: "Page room is finishing a previous save",
            });
          yield* Effect.tryPromise({
            try: () => entry.ready,
            catch: (cause) =>
              new PagesServiceError({
                code: "storage",
                message: "Page room failed to open",
                cause,
              }),
          });
          if (input.op === "update" && entry.room.seeded) {
            input = yield* withoutUnchangedBody(input, principal);
            const actorKey =
              principal.kind === "local-user" ? "local-user" : `thread:${principal.threadId}`;
            // A retry of an answered request must replay it unchanged, so it is never rebased.
            const answered = yield* sql<{ found: number }>`SELECT 1 AS found FROM pages_requests
              WHERE actor_key = ${actorKey} AND request_id = ${input.requestId}`.pipe(
              Effect.map((rows) => rows.length > 0),
              Effect.orElseSucceed(() => true),
            );
            if (!answered && input.content === undefined && input.richContent === undefined) {
              // Title and metadata are last-writer-wins beside a live body; the revision a window
              // last loaded lags the room's compactions, so rebase instead of conflicting.
              const latest = yield* base.read(
                { scopeSpaceId: input.scopeSpaceId, pageId: input.pageId },
                principal,
              );
              input = { ...input, expectedRevision: latest.page.revision };
            }
          }
        }
        if (
          !entry ||
          !entry.room.seeded ||
          input.op !== "update" ||
          typeof input.richContent !== "string"
        ) {
          const result = yield* base.mutate(input, principal);
          if (entry) yield* follow(entry, result, input);
          return result;
        }
        // Authorize and validate before anything reaches the live document.
        const current = yield* base.read(
          { scopeSpaceId: input.scopeSpaceId, pageId: input.pageId },
          principal,
        );
        if (current.page.trashedAt !== null)
          return yield* Effect.fail(
            new PagesServiceError({
              code: "invalid",
              message: "Restore the page before editing it",
            }),
          );
        yield* Effect.try({
          try: () => parsePageRichContent(input.richContent as string),
          catch: (cause) =>
            new PagesServiceError({
              code: "invalid",
              message: cause instanceof Error ? cause.message : "Invalid page richContent",
            }),
        });
        const writer: RoomWriter =
          principal.kind === "agent"
            ? { kind: "agent", threadId: principal.threadId }
            : { kind: "local-user" };
        yield* Effect.tryPromise({
          try: () =>
            entry.room.applyWrite({
              richContent: input.richContent as string,
              baseRevision: input.expectedRevision,
              writer,
            }),
          catch: (cause) =>
            new PagesServiceError({
              code: "storage",
              message: "Live page merge failed; retry the same request",
              cause,
            }),
        });
        const merged = yield* base.read(
          { scopeSpaceId: input.scopeSpaceId, pageId: input.pageId },
          principal,
        );
        const { title, sourceThreadId, assetIds, automationIds } = input;
        const metadata = { title, sourceThreadId, assetIds, automationIds };
        const changesMetadata = Object.values(metadata).some((value) => value !== undefined);
        if (!changesMetadata) return { ...merged, affectedPageIds: [merged.page.id] };
        const result = yield* base.mutate(
          {
            op: "update",
            requestId: input.requestId,
            scopeSpaceId: input.scopeSpaceId,
            pageId: input.pageId,
            expectedRevision: merged.page.revision,
            ...Object.fromEntries(
              Object.entries(metadata).filter(([, value]) => value !== undefined),
            ),
          },
          principal,
        );
        yield* follow(entry, result, input);
        return result;
      });

    /** A window that saves its title resends the body it last loaded. Unchanged against the
     * revision it names, that body is not an edit, and with a live room it may be older than
     * what people typed since; drop it so it cannot roll the live document back. */
    const withoutUnchangedBody = (
      input: Extract<PagesMutateInput, { op: "update" }>,
      principal: PagesPrincipal,
    ) =>
      base
        .read(
          {
            scopeSpaceId: input.scopeSpaceId,
            pageId: input.pageId,
            revision: input.expectedRevision,
          },
          principal,
        )
        .pipe(
          Effect.map((read) => {
            const sameRich =
              input.richContent === undefined ||
              (input.richContent ?? null) === (read.richContent ?? null);
            const sameContent =
              input.content === undefined ||
              typeof input.richContent === "string" ||
              input.content === read.content;
            if (!sameRich || !sameContent) return input;
            const { content: _content, richContent: _richContent, ...rest } = input;
            return rest;
          }),
          Effect.orElseSucceed(() => input),
        );

    const follow = (entry: RoomEntry, result: PagesMutateResult, input: PagesMutateInput) =>
      Effect.promise(async () => {
        if (input.op === "trash" || input.op === "trash-space" || result.page.trashedAt !== null) {
          entry.room.reject("页面已移到回收站。", (connection) => connection.mode === "edit");
          return;
        }
        await entry.room.followPage(pageState(result)).catch(() => undefined);
      });

    const pages: PagesServiceShape = { ...base, mutate };
    yield* Effect.addFinalizer(() =>
      reservations.close.pipe(
        Effect.andThen(
          Effect.promise(async () => {
            // Do not clear first: volatile close failures retain the in-memory document, and
            // successful/durably recoverable entries are removed only after their flush settles.
            const outcomes = await Promise.allSettled(
              [...rooms.entries()].map(([pageId, entry]) => closeEntry(pageId, entry)),
            );
            const failures = outcomes.flatMap((outcome) =>
              outcome.status === "rejected" ? [outcome.reason] : [],
            );
            if (failures.length)
              throw new AggregateError(failures, "Some Page rooms did not finish saving");
          }),
        ),
      ),
    );
    return { service, pages };
  });

/** PagesService (with live-room routing) and PageRealtimeService, built on the SQLite service. */
export const PagesRealtimeLive = Layer.effectServices(
  Effect.gen(function* () {
    const base = yield* PagesService;
    const { service, pages } = yield* makePageRealtime(base);
    return ServiceMap.make(PagesService, pages).pipe(ServiceMap.add(PageRealtimeService, service));
  }),
).pipe(Layer.provide(PagesServiceLive));
