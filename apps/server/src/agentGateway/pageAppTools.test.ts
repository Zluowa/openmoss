import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makePageAppsServiceShape, PageAppsService } from "../pages/apps/PageAppsService";
import { makePageAppTools } from "./pageAppTools";
import type { ToolContext } from "./toolRuntime";

const layer = Layer.effect(
  PageAppsService,
  makePageAppsServiceShape({ ai: { ask: async function* () {} } }),
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const tests = it.layer(layer);
const timestamp = "2026-11-04T00:00:00.000Z";

const contextFor = (threadId: string): ToolContext => ({
  principal: {
    kind: "provider-session",
    sessionKey: "s",
    threadId,
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: threadId,
  callerThreadLabel: "Current conversation",
  callerSessionKey: "s",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:read", "thread:write"]),
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
});
const json = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  JSON.parse((result.content[0] as { text: string }).text);

tests("应用页 agent tools", (it) => {
  it.effect("publish, update, and read/write the page's db as the owner", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectId = randomUUID();
      const threadId = randomUUID();
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
        VALUES (${projectId}, 'P', '/fixture', '[]', ${null}, ${timestamp}, ${timestamp})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES (${threadId}, ${projectId}, 'T', ${timestamp}, ${timestamp})`;
      const tools = new Map(
        makePageAppTools({ apps: yield* PageAppsService }).map((tool) => [
          tool.definition.name,
          tool,
        ]),
      );
      const context = contextFor(threadId);
      assert.deepEqual(
        [...tools.keys()],
        ["moss_app_guide", "moss_app_list", "moss_app_read", "moss_app_publish", "moss_app_db"],
      );
      const guide = yield* tools.get("moss_app_guide")!.handler({}, context);
      assert.include((guide.content[0] as { text: string }).text, "moss.use");

      const created = json(
        yield* tools.get("moss_app_publish")!.handler(
          {
            requestId: randomUUID(),
            scopeSpaceId: null,
            html: "<!doctype html><title>Votes</title><p>x</p>",
            capabilities: { db: {}, ai: {} },
          },
          context,
        ),
      );
      assert.equal(created.title, "Votes");
      assert.deepEqual(created.capabilities, ["db", "ai"]);
      assert.equal(created.link, `/apps/${created.appId}`);

      const bad = yield* tools.get("moss_app_publish")!.handler(
        {
          requestId: randomUUID(),
          scopeSpaceId: null,
          html: "<p>x</p>",
          capabilities: { warp: {} },
        },
        context,
      );
      assert.isTrue(bad.isError);

      const updated = json(
        yield* tools.get("moss_app_publish")!.handler(
          {
            requestId: randomUUID(),
            scopeSpaceId: null,
            appId: created.appId,
            expectedRevision: created.revision,
            html: "<!doctype html><title>Votes v2</title>",
          },
          context,
        ),
      );
      assert.equal(updated.revision, 2);
      assert.deepEqual(updated.capabilities, ["db", "ai"]);

      const db = tools.get("moss_app_db")!;
      yield* db.handler(
        { appId: created.appId, op: "set", path: "votes/a", data: { choice: 1 } },
        context,
      );
      const read = json(
        yield* db.handler({ appId: created.appId, op: "get", path: "votes/a" }, context),
      );
      assert.deepEqual(read.result.data, { choice: 1 });
      const query = json(
        yield* db.handler(
          { appId: created.appId, op: "query", query: { collection: "votes" } },
          context,
        ),
      );
      assert.equal(query.result.docs.length, 1);

      const listed = json(
        yield* tools.get("moss_app_list")!.handler({ scopeSpaceId: null }, context),
      );
      assert.equal(listed.apps[0].appId, created.appId);
      const html = json(
        yield* tools.get("moss_app_read")!.handler({ appId: created.appId }, context),
      );
      assert.include(html.html, "moss-app-manifest");
    }),
  );
});
