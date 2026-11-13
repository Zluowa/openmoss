// FILE: dashboardTools.test.ts
// Purpose: An agent builds a 数据看板 with moss_dashboard_* tools against the real typed-item
//          service; live queries run only read-only tools with checked filters; the open view's
//          report comes back to the agent.

import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import { PageId, SpaceId, ThreadId } from "@moss/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { PageAppMcpSources } from "../pages/apps/extensions/mcpSources";
import { PagesServiceLive } from "../pages/Layers/PagesService";
import { makeDashboardRuntime, readLibraryDataFile } from "../pages/types/dashboardRuntime";
import { PageTypesService, PageTypesServiceLive } from "../pages/types/PageTypesService";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makePageTypeTools } from "./pageTypeTools";

const tests = it.layer(
  PageTypesServiceLive.pipe(
    Layer.provideMerge(PagesServiceLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const timestamp = "2026-11-13T00:00:00.000Z";
const LOCAL = { kind: "local-user" } as const;

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const types = yield* PageTypesService;
  const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
    VALUES (${scopeSpaceId}, 'Dashboard test', 'folder', 0, ${timestamp}, ${timestamp})`;
  const projectId = randomUUID();
  const threadId = ThreadId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
    VALUES (${projectId}, 'Test project', '/fixture', '[]', ${scopeSpaceId}, ${timestamp}, ${timestamp})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Dashboard writer', ${timestamp}, ${timestamp})`;
  const tools = new Map(makePageTypeTools({ types }).map((tool) => [tool.definition.name, tool]));
  const context = {
    callerThreadId: threadId,
    assertCallerTurnActive: () => Effect.void,
  } as unknown as Parameters<NonNullable<ReturnType<typeof tools.get>>["handler"]>[1];
  const call = (name: string, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const result = (yield* tools
        .get(name)!
        .handler({ scopeSpaceId, ...args }, context)) as unknown as {
        content: { text: string }[];
        isError?: boolean;
      };
      const text = result.content[0]!.text;
      const body = result.isError && !text.startsWith("{") ? { message: text } : JSON.parse(text);
      return { error: result.isError === true, body };
    });
  return { types, scopeSpaceId, call };
});

const PAGE = `<meta name="dash-one-writer"><h1 id="t">订单</h1><p><b data-draw="n" data-source="orders" data-field="n" data-row="0">—</b></p>
<script>dash.draw('n', (el) => { const d = dash.data('orders'); el.textContent = d.status === 'ok' ? d.data[0].n : '—'; });</script>`;

tests("moss_dashboard_* agent tools", (it) => {
  it.effect(
    "an agent creates, writes and reads back a dashboard with its check and the open view's report",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const guide = yield* h.call("moss_dashboard_guide", {});
        assert.include(guide.body.guide, "dash-one-writer");
        const created = yield* h.call("moss_dashboard_create", {
          requestId: "dash-1",
          title: "订单看板",
          spaceId: null,
          parentPageId: null,
        });
        assert.isFalse(created.error, JSON.stringify(created.body));
        const empty = yield* h.call("moss_dashboard_read", { pageId: created.body.pageId });
        assert.strictEqual(empty.body.check[0].where, "files/index.html");
        assert.property(empty.body.report, "none");

        const written = yield* h.call("moss_dashboard_write", {
          requestId: "dash-2",
          pageId: created.body.pageId,
          expectedRevision: created.body.revision,
          writes: [
            { op: "set", path: "meta", data: { title: "订单看板", lang: "zh-CN" } },
            {
              op: "set",
              path: "datasets/orders",
              data: {
                title: "示例订单",
                source: { kind: "file", name: "o.csv", text: "n\n42\n" },
                updated: { at: timestamp, by: "Moss" },
                edit: { via: "moss", at: timestamp },
              },
            },
            { op: "set", path: "files/index.html", data: { text: PAGE } },
          ],
        });
        assert.isFalse(written.error, JSON.stringify(written.body));
        assert.deepStrictEqual(written.body.check, []);

        // A stale revision is refused, so the agent rereads instead of overwriting.
        const stale = yield* h.call("moss_dashboard_write", {
          requestId: "dash-3",
          pageId: created.body.pageId,
          expectedRevision: created.body.revision,
          writes: [{ op: "update", path: "settings", data: { updates: "hour" } }],
        });
        assert.isTrue(stale.error);
        assert.strictEqual(stale.body.error.code, "conflict");

        // The open view reports how the page ran; the agent reads it with the revision it describes.
        yield* h.types.dashboard.report(
          {
            scopeSpaceId: h.scopeSpaceId,
            pageId: PageId.makeUnsafe(created.body.pageId),
            revision: written.body.revision,
            faults: [{ where: "绘制 n", message: "boom" }],
            sources: [{ id: "orders", status: "ok", message: "", rows: 1 }],
            page: '<h1 id="t">订单</h1><p><b>42</b></p>',
            width: 900,
          },
          LOCAL,
        );
        const read = yield* h.call("moss_dashboard_read", { pageId: created.body.pageId });
        assert.strictEqual(read.body.dashboard.datasets.orders.title, "示例订单");
        assert.isTrue(read.body.report.current);
        assert.deepStrictEqual(read.body.report.faults, [{ where: "绘制 n", message: "boom" }]);
        assert.include(read.body.report.page, "42");
      }),
  );

  it.effect("refuses writes that break the payload and leaves the item as it was", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const created = yield* h.call("moss_dashboard_create", {
        requestId: "dash-bad",
        title: "坏的",
        spaceId: null,
        parentPageId: null,
      });
      const bad = yield* h.call("moss_dashboard_write", {
        requestId: "dash-bad-2",
        pageId: created.body.pageId,
        expectedRevision: created.body.revision,
        writes: [{ op: "set", path: "datasets/x", data: { title: "X", source: { kind: "sql" } } }],
      });
      assert.isTrue(bad.error);
      const read = yield* h.call("moss_dashboard_read", { pageId: created.body.pageId });
      assert.strictEqual(read.body.revision, created.body.revision);
    }),
  );

  it.effect("an earlier revision reads the payload as it was then", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const created = yield* h.call("moss_dashboard_create", {
        requestId: "dash-hist",
        title: "历史",
        spaceId: null,
        parentPageId: null,
      });
      yield* h.call("moss_dashboard_write", {
        requestId: "dash-hist-2",
        pageId: created.body.pageId,
        expectedRevision: created.body.revision,
        writes: [{ op: "set", path: "files/index.html", data: { text: "<p id='a'>二</p>" } }],
      });
      const old = yield* h.types.read(
        {
          scopeSpaceId: h.scopeSpaceId,
          pageId: PageId.makeUnsafe(created.body.pageId),
          revision: created.body.revision,
        },
        LOCAL,
      );
      assert.notInclude(old.data!, "二");
      assert.strictEqual(old.dataRevision, created.body.revision);
    }),
  );
});

tests("数据看板 live queries", (it) => {
  const sourcesWith = (
    calls: Array<{ tool: string; args: Record<string, unknown> }>,
  ): PageAppMcpSources => ({
    dispose: async () => {},
    resolve: async (server) => ({
      server,
      key: `connector:${server}`,
      label: server,
      kind: "connector" as never,
      needsAuth: false,
      reason: null,
      session: {
        listTools: async () => [
          {
            name: "run_query",
            title: null,
            description: null,
            annotations: { readOnlyHint: true },
          },
          {
            name: "delete_rows",
            title: null,
            description: null,
            annotations: { destructiveHint: true },
          },
        ],
        callTool: async (tool, args) => {
          calls.push({ tool, args });
          return {
            content: [
              { type: "text", text: JSON.stringify({ rows: [{ day: "2026-11-01", n: 3 }] }) },
            ],
            structuredContent: undefined,
            isError: false,
          };
        },
      },
    }),
  });

  it.effect(
    "runs the stored read-only call with checked filters and refuses tools that change data",
    () =>
      Effect.gen(function* () {
        const types = yield* PageTypesService;
        const sql = yield* SqlClient.SqlClient;
        const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
        yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES (${scopeSpaceId}, 'Query test', 'folder', 0, ${timestamp}, ${timestamp})`;
        const dataset = (tool: string) => ({
          title: "每日",
          source: {
            kind: "call",
            connector: "Warehouse",
            tool,
            args: { sql: "SELECT day, n FROM t WHERE region = '{{region}}'", limit: "{{limit}}" },
            rules: {
              region: { enum: ["east", "west"] },
              limit: { type: "number", minimum: 1, maximum: 100 },
            },
          },
        });
        const created = yield* types.create(
          {
            requestId: randomUUID(),
            scopeSpaceId,
            kind: "app",
            title: "查询",
            spaceId: null,
            parentPageId: null,
            data: JSON.stringify({
              version: 2,
              form: "dashboard",
              meta: { title: "查询" },
              params: { region: "east", limit: 10 },
              settings: { updates: "viewed" },
              datasets: { daily: dataset("run_query"), wipe: dataset("delete_rows") },
              files: {},
            }),
          },
          LOCAL,
        );
        const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
        const runtime = makeDashboardRuntime({ types, sources: sourcesWith(calls) });
        const ok = yield* runtime.query(
          { scopeSpaceId, pageId: created.page.id, datasetId: "daily", params: { region: "west" } },
          LOCAL,
        );
        assert.strictEqual(ok.status, "ok");
        assert.deepStrictEqual(ok.answer, { rows: [{ day: "2026-11-01", n: 3 }] });
        assert.deepStrictEqual(calls, [
          {
            tool: "run_query",
            args: { sql: "SELECT day, n FROM t WHERE region = 'west'", limit: 10 },
          },
        ]);
        const injected = yield* runtime.query(
          {
            scopeSpaceId,
            pageId: created.page.id,
            datasetId: "daily",
            params: { region: "x' OR 1=1 --" },
          },
          LOCAL,
        );
        assert.strictEqual(injected.status, "error");
        const destructive = yield* runtime.query(
          { scopeSpaceId, pageId: created.page.id, datasetId: "wipe", params: {} },
          LOCAL,
        );
        assert.strictEqual(destructive.status, "declined");
        assert.lengthOf(calls, 1);
        // A loader's next page stays on the dataset's connector and passes the same check.
        const next = yield* runtime.query(
          {
            scopeSpaceId,
            pageId: created.page.id,
            datasetId: "daily",
            params: {},
            call: { tool: "run_query", args: { pageToken: "p2" } },
          },
          LOCAL,
        );
        assert.strictEqual(next.status, "ok");
        assert.deepStrictEqual(calls[1], { tool: "run_query", args: { pageToken: "p2" } });
        const sneaky = yield* runtime.query(
          {
            scopeSpaceId,
            pageId: created.page.id,
            datasetId: "daily",
            params: {},
            call: { tool: "delete_rows", args: {} },
          },
          LOCAL,
        );
        assert.strictEqual(sneaky.status, "declined");
        assert.lengthOf(calls, 2);
      }),
  );
});

tests("数据看板 资料库 files", (it) => {
  it.effect("reads a large file from the 资料库 by id, data files only, UTF-8", () =>
    Effect.gen(function* () {
      const types = yield* PageTypesService;
      const sql = yield* SqlClient.SqlClient;
      const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
      yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES (${scopeSpaceId}, 'Library test', 'folder', 0, ${timestamp}, ${timestamp})`;
      const created = yield* types.create(
        {
          requestId: randomUUID(),
          scopeSpaceId,
          kind: "app",
          title: "大文件",
          spaceId: null,
          parentPageId: null,
          data: JSON.stringify({
            version: 2,
            form: "dashboard",
            meta: { title: "大文件" },
            params: {},
            settings: { updates: "viewed" },
            datasets: {
              big: {
                title: "大表",
                source: {
                  kind: "file",
                  name: "big.csv",
                  text: "",
                  library: { itemId: "lib-1", size: 2_000_000 },
                },
                updated: { at: timestamp, by: "Moss" },
              },
            },
            files: {},
          }),
        },
        LOCAL,
      );
      const runtime = makeDashboardRuntime({
        types,
        sources: null,
        library: {
          read: async (itemId) => {
            if (itemId !== "lib-1") throw new Error("资料库里找不到这个文件");
            return "a,b\n1,2\n";
          },
          add: async () => ({ itemId: "lib-2", size: 10, name: "x.csv" }),
        },
      });
      const read = yield* runtime.query(
        { scopeSpaceId, pageId: created.page.id, datasetId: "big", params: {} },
        LOCAL,
      );
      assert.strictEqual(read.status, "ok");
      assert.strictEqual(read.answer, "a,b\n1,2\n");
      const refused = yield* runtime.addLibraryFile("C:/secret/id_rsa").pipe(Effect.flip);
      assert.include(refused.message, ".csv");
    }),
  );

  it.effect("the 资料库 reader refuses non-data, oversized and non-UTF-8 files", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(path.join(os.tmpdir(), "moss-dash-lib-"));
      const good = path.join(dir, "ok.csv");
      writeFileSync(good, "a\n1\n");
      const bad = path.join(dir, "bad.csv");
      writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x00]));
      const key = path.join(dir, "key.pem");
      writeFileSync(key, "secret");
      const item = (p: string) => ({ path: p, trashedAt: null, title: path.basename(p) });
      assert.strictEqual(yield* Effect.promise(() => readLibraryDataFile(item(good))), "a\n1\n");
      const notUtf8 = yield* Effect.promise(() =>
        readLibraryDataFile(item(bad)).catch((e: Error) => e.message),
      );
      assert.include(notUtf8, "UTF-8");
      const notData = yield* Effect.promise(() =>
        readLibraryDataFile(item(key)).catch((e: Error) => e.message),
      );
      assert.include(notData, ".csv");
      const gone = yield* Effect.promise(() =>
        readLibraryDataFile(undefined).catch((e: Error) => e.message),
      );
      assert.include(gone, "找不到");
    }),
  );
});
