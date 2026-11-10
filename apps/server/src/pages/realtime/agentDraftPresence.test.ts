import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { SpaceId, ThreadId } from "@moss/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { PageDraftsServiceLive } from "../drafts/Layers/PageDraftsService";
import { PageDraftsService } from "../drafts/Services/PageDraftsService";
import { LOCAL_PAGES_PRINCIPAL as user, PagesService } from "../Services/PagesService";
import type { RoomConnection } from "./PageRealtimeRoom";
import { PageRealtimeService, PagesRealtimeLive } from "./PageRealtimeService";

const tests = it.layer(
  PageDraftsServiceLive.pipe(
    Layer.provideMerge(PagesRealtimeLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const timestamp = "2026-11-04T00:00:00.000Z";
const p = (text: string) => ({ type: "p", children: [{ text }] });
const agentsIn = (states: Map<number, Record<string, unknown>>) =>
  [...states.values()].flatMap(
    (state) => (state.moss as { agents?: Array<{ id: string }> } | undefined)?.agents ?? [],
  );

tests("Agent drafts on a live page", (it) => {
  it.effect("show the agent in the page's presence, and a person's draft does not", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pages = yield* PagesService;
      const drafts = yield* PageDraftsService;
      const realtime = yield* PageRealtimeService;
      const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
      yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES (${scopeSpaceId}, 'Presence test', 'folder', 0, ${timestamp}, ${timestamp})`;
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
          richContent: JSON.stringify([p("alpha")]),
          spaceId: null,
          parentPageId: null,
        },
        user,
      );
      const ticket = yield* realtime.issueToken({ scopeSpaceId, pageId: created.page.id }, user);
      const connection: RoomConnection = { mode: "edit", send: () => {}, close: () => {} };
      const joined = yield* Effect.promise(() =>
        realtime.join({
          pageId: created.page.id,
          token: ticket.token,
          connection: () => connection,
        }),
      );
      assert.ok(joined);
      const draft = (principal: Parameters<typeof drafts.mutate>[1]) =>
        drafts.mutate(
          {
            op: "create",
            requestId: randomUUID(),
            scopeSpaceId,
            pageId: created.page.id,
            baseRevision: created.page.revision,
            ops: [{ kind: "insert", markdown: "proposed" }],
          },
          principal,
        );

      yield* draft(user);
      assert.deepStrictEqual(agentsIn(joined.room.awareness.getStates()), []);

      yield* draft({ kind: "agent", threadId });
      assert.deepStrictEqual(
        agentsIn(joined.room.awareness.getStates()).map((agent) => agent.id),
        [threadId],
      );
      realtime.leave(created.page.id, joined.connection);
    }),
  );
});
