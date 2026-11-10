import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { SpaceId, ThreadId } from "@moss/contracts";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { LOCAL_PAGES_PRINCIPAL as user, PagesService } from "../Services/PagesService";
import type { RoomConnection } from "./PageRealtimeRoom";
import { PageRealtimeService, PagesRealtimeLive } from "./PageRealtimeService";
import { applyPlateValue, readPageDoc } from "./pageYjsContent";
import { sendRoomEdit } from "./testing/sendRoomEdit";

const tests = it.layer(PagesRealtimeLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const timestamp = "2026-11-04T00:00:00.000Z";
const p = (text: string) => ({ type: "p", children: [{ text }] });

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pages = yield* PagesService;
  const realtime = yield* PageRealtimeService;
  const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
    VALUES (${scopeSpaceId}, 'Realtime test', 'folder', 0, ${timestamp}, ${timestamp})`;
  const projectId = randomUUID();
  const threadId = ThreadId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
    VALUES (${projectId}, 'Project', '/fixture', '[]', ${scopeSpaceId}, ${timestamp}, ${timestamp})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Agent thread', ${timestamp}, ${timestamp})`;
  const created = yield* pages.mutate(
    {
      op: "create",
      requestId: randomUUID(),
      scopeSpaceId,
      title: "Live page",
      richContent: JSON.stringify([p("alpha"), p("beta")]),
      spaceId: null,
      parentPageId: null,
    },
    user,
  );
  const sent: Array<Uint8Array | string> = [];
  const connection = (mode: "edit" | "view"): RoomConnection => ({
    mode,
    send: (message) => sent.push(message),
    close: () => {},
  });
  return { sql, pages, realtime, scopeSpaceId, threadId, page: created.page, sent, connection };
});

tests("Page rooms", (it) => {
  it.effect("serializes token room creation after a no-room transaction commits", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const beforeRoomCount = h.realtime.roomCount();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writing = yield* h.realtime
        .withRoomClosed(
          h.page.id,
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* h.pages.mutate(
              {
                op: "update",
                requestId: randomUUID(),
                scopeSpaceId: h.scopeSpaceId,
                pageId: h.page.id,
                expectedRevision: h.page.revision,
                richContent: JSON.stringify([p("committed first")]),
              },
              user,
            );
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const opening = yield* h.realtime
        .issueToken({ pageId: h.page.id, scopeSpaceId: h.scopeSpaceId }, user)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.strictEqual(h.realtime.roomCount(), beforeRoomCount);
      yield* Deferred.succeed(release, undefined);
      const write = yield* Fiber.join(writing);
      const token = yield* Fiber.join(opening);
      assert.strictEqual(token.revision, write.page.revision);
      const joined = yield* Effect.promise(() =>
        h.realtime.join({ pageId: h.page.id, token: token.token, connection: h.connection }),
      );
      assert.ok(joined);
      assert.deepStrictEqual(readPageDoc(joined.room.doc), [p("committed first")]);
      h.realtime.leave(h.page.id, joined.connection);
    }),
  );

  it.effect("serializes direct admitted-ticket join behind the same no-room gate", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const beforeRoomCount = h.realtime.roomCount();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const held = yield* h.realtime
        .withRoomClosed(
          h.page.id,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      let didJoin = false;
      const joinedPromise = h.realtime
        .join({
          pageId: h.page.id,
          ticket: {
            pageId: h.page.id,
            scopeSpaceId: h.scopeSpaceId,
            mode: "edit",
            expiresAt: Date.now() + 60_000,
          },
          connection: h.connection,
        })
        .then((result) => {
          didJoin = true;
          return result;
        });
      yield* Effect.yieldNow;
      assert.strictEqual(h.realtime.roomCount(), beforeRoomCount);
      assert.strictEqual(didJoin, false);
      const unchanged = yield* h.pages.read(
        { scopeSpaceId: h.scopeSpaceId, pageId: h.page.id },
        user,
      );
      assert.strictEqual(unchanged.page.revision, h.page.revision);
      assert.deepStrictEqual(JSON.parse(unchanged.richContent!), [p("alpha"), p("beta")]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(held);
      const joined = yield* Effect.promise(() => joinedPromise);
      assert.ok(joined);
      assert.deepStrictEqual(readPageDoc(joined.room.doc), [p("alpha"), p("beta")]);
      h.realtime.leave(h.page.id, joined.connection);
    }),
  );

  it.effect("admits a ticket once, for its own page only", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const ticket = yield* h.realtime.issueToken(
        { scopeSpaceId: h.scopeSpaceId, pageId: h.page.id },
        user,
      );
      assert.strictEqual(ticket.mode, "edit");
      assert.ok(ticket.generation);
      const wrongPage = yield* Effect.promise(() =>
        h.realtime.join({ pageId: "other-page", token: ticket.token, connection: h.connection }),
      );
      assert.strictEqual(wrongPage, null);
      const joined = yield* Effect.promise(() =>
        h.realtime.join({ pageId: h.page.id, token: ticket.token, connection: h.connection }),
      );
      assert.ok(joined);
      const replay = yield* Effect.promise(() =>
        h.realtime.join({ pageId: h.page.id, token: ticket.token, connection: h.connection }),
      );
      assert.strictEqual(replay, null);
      h.realtime.leave(h.page.id, joined.connection);
    }),
  );

  it.effect("merges an agent's mutate into live typing as a Yjs transaction", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const ticket = yield* h.realtime.issueToken(
        { scopeSpaceId: h.scopeSpaceId, pageId: h.page.id },
        user,
      );
      const joined = yield* Effect.promise(() =>
        h.realtime.join({ pageId: h.page.id, token: ticket.token, connection: h.connection }),
      );
      assert.ok(joined);
      // Someone types in the first block; the agent read revision 1 and rewrites the second.
      assert.strictEqual(
        sendRoomEdit(joined.room, joined.connection, [p("alpha typed live"), p("beta")]),
        true,
      );
      const result = yield* h.pages.mutate(
        {
          op: "update",
          requestId: randomUUID(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: h.page.id,
          expectedRevision: h.page.revision,
          richContent: JSON.stringify([p("alpha"), p("beta, rewritten by the agent")]),
        },
        { kind: "agent", threadId: h.threadId },
      );
      const expected = [p("alpha typed live"), p("beta, rewritten by the agent")];
      assert.deepStrictEqual(JSON.parse(result.richContent ?? "null"), expected);
      assert.deepStrictEqual(readPageDoc(joined.room.doc), expected);
      const versions = yield* h.pages.versions(
        { scopeSpaceId: h.scopeSpaceId, pageId: h.page.id },
        user,
      );
      assert.strictEqual(versions.versions[0]?.author, "agent");
      assert.strictEqual(versions.versions[0]?.authorThreadId, h.threadId);
      const sources = [{ kind: "local-user" }, { kind: "agent", threadId: h.threadId }] as const;
      assert.deepStrictEqual(versions.versions[0]?.contributors, sources);
      const summaries = yield* h.pages.versions(
        { scopeSpaceId: h.scopeSpaceId, pageId: h.page.id, summaryOnly: true },
        user,
      );
      assert.deepStrictEqual(summaries.versions[0]?.contributors, sources);
      assert.strictEqual(summaries.versions[0]?.content, "");
      assert.strictEqual(summaries.versions[1]?.contributors, undefined);
      const stored = yield* h.sql<{ compacted_revision: number }>`SELECT compacted_revision
        FROM pages_realtime_docs WHERE page_id = ${h.page.id}`;
      assert.strictEqual(stored[0]?.compacted_revision, result.page.revision);
      h.realtime.leave(h.page.id, joined.connection);
    }),
  );

  it.effect("ignores the stale body a window resends with its title", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const ticket = yield* h.realtime.issueToken(
        { scopeSpaceId: h.scopeSpaceId, pageId: h.page.id },
        user,
      );
      const joined = yield* Effect.promise(() =>
        h.realtime.join({ pageId: h.page.id, token: ticket.token, connection: h.connection }),
      );
      assert.ok(joined);
      applyPlateValue(joined.room.doc, [p("alpha"), p("beta"), p("typed live")], "person");
      yield* Effect.promise(() => joined.room.compact());
      // This window still holds revision 1 and saves only a new title.
      const renamed = yield* h.pages.mutate(
        {
          op: "update",
          requestId: randomUUID(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: h.page.id,
          expectedRevision: h.page.revision,
          title: "New title",
          content: "alpha\n\nbeta",
          richContent: JSON.stringify([p("alpha"), p("beta")]),
        },
        user,
      );
      assert.strictEqual(renamed.page.title, "New title");
      assert.deepStrictEqual(JSON.parse(renamed.richContent ?? "null"), [
        p("alpha"),
        p("beta"),
        p("typed live"),
      ]);
      h.realtime.leave(h.page.id, joined.connection);
    }),
  );

  it.effect("keeps a title change apart from the live content and gives viewers view mode", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const ticket = yield* h.realtime.issueToken(
        { scopeSpaceId: h.scopeSpaceId, pageId: h.page.id, mode: "view" },
        user,
      );
      assert.strictEqual(ticket.mode, "view");
      const joined = yield* Effect.promise(() =>
        h.realtime.join({ pageId: h.page.id, token: ticket.token, connection: h.connection }),
      );
      assert.ok(joined);
      assert.strictEqual(joined.connection.mode, "view");
      const renamed = yield* h.pages.mutate(
        {
          op: "update",
          requestId: randomUUID(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: h.page.id,
          expectedRevision: h.page.revision,
          title: "Renamed",
        },
        user,
      );
      assert.strictEqual(renamed.page.title, "Renamed");
      assert.ok(
        h.sent.some(
          (message) =>
            typeof message === "string" &&
            message === JSON.stringify({ type: "revision", revision: renamed.page.revision }),
        ),
      );
      h.realtime.leave(h.page.id, joined.connection);
    }),
  );
});
