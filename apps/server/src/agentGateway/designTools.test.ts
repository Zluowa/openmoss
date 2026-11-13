import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { PageId, SpaceId, ThreadId } from "@moss/contracts";
import { parseDesignCanvas } from "@moss/shared/spaceItems/designCanvas";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PagesServiceLive } from "../pages/Layers/PagesService";
import { LOCAL_PAGES_PRINCIPAL as user } from "../pages/Services/PagesService";
import { PageTypesService, PageTypesServiceLive } from "../pages/types/PageTypesService";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makeDesignTools } from "./designTools";

const tests = it.layer(
  PageTypesServiceLive.pipe(
    Layer.provideMerge(PagesServiceLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const timestamp = "2026-11-13T00:00:00.000Z";

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const types = yield* PageTypesService;
  const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
    VALUES (${scopeSpaceId}, 'Design test', 'folder', 0, ${timestamp}, ${timestamp})`;
  const projectId = randomUUID();
  const threadId = ThreadId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
    VALUES (${projectId}, 'Test project', '/fixture', '[]', ${scopeSpaceId}, ${timestamp}, ${timestamp})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Designer', ${timestamp}, ${timestamp})`;
  const tools = new Map(makeDesignTools({ types }).map((tool) => [tool.definition.name, tool]));
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
  return { types, scopeSpaceId, call, tools };
});

const phone = (label: string, target?: string) =>
  `<div style="width: 390px; height: 844px; display: flex; flex-direction: column; gap: 12px"><h1 style="margin: 0">${label}</h1>${
    target ? `<a href="board:${target}">下一步</a>` : ""
  }</div>`;

tests("moss_design_* agent tools", (it) => {
  it.effect("an agent reads the guide, creates a design, streams artboards and lays them out", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      assert.deepStrictEqual(
        [...h.tools.keys()],
        [
          "moss_design_guide",
          "moss_design_create",
          "moss_design_read",
          "moss_design_write_boards",
          "moss_design_update",
          "moss_design_systems",
          "moss_design_set_system",
        ],
      );
      const guide = yield* h.call("moss_design_guide", {});
      assert.include(guide.body.guide, 'href="board:<id>"');
      assert.ok(
        guide.body.templates.some(
          (template: { templateId: string }) => template.templateId === "builtin:design-phone-app",
        ),
      );

      const created = yield* h.call("moss_design_create", {
        requestId: "design-1",
        title: "点餐应用",
        spaceId: null,
        parentPageId: null,
        boards: [
          {
            id: "home",
            name: "首页",
            w: 390,
            h: 844,
            html: phone("首页", "cart"),
            interactive: true,
          },
        ],
      });
      assert.isFalse(created.error, JSON.stringify(created.body));
      assert.strictEqual(
        created.body.href,
        `moss://space-page/${encodeURIComponent(created.body.pageId)}`,
      );

      const second = yield* h.call("moss_design_write_boards", {
        requestId: "design-2",
        pageId: created.body.pageId,
        expectedRevision: created.body.revision,
        boards: [
          { id: "cart", name: "购物车", w: 390, h: 844, html: phone("购物车"), interactive: true },
        ],
      });
      assert.isFalse(second.error, JSON.stringify(second.body));
      assert.deepStrictEqual(
        second.body.boards.map((board: { id: string; x: number }) => [board.id, board.x]),
        [
          ["home", 0],
          ["cart", 470],
        ],
      );

      const stale = yield* h.call("moss_design_write_boards", {
        requestId: "design-3",
        pageId: created.body.pageId,
        expectedRevision: created.body.revision,
        boards: [{ id: "home", name: "旧" }],
      });
      assert.isTrue(stale.error);
      assert.strictEqual(stale.body.error.code, "conflict");

      const laid = yield* h.call("moss_design_update", {
        requestId: "design-4",
        pageId: created.body.pageId,
        expectedRevision: second.body.revision,
        ops: [
          {
            op: "upsertNote",
            note: { id: "flow", kind: "title", x: 0, y: -260, text: "点餐流程" },
          },
          { op: "moveBoard", id: "cart", x: 500 },
          { op: "setLaunch", launch: { view: "focused", boardId: "home" } },
        ],
      });
      assert.isFalse(laid.error, JSON.stringify(laid.body));
      const refused = yield* h.call("moss_design_update", {
        requestId: "design-5",
        pageId: created.body.pageId,
        expectedRevision: laid.body.revision,
        ops: [{ op: "upsertBoard", board: { id: "x", html: "<p>sneak</p>" } }],
      });
      assert.isTrue(refused.error);

      const read = yield* h.call("moss_design_read", {
        pageId: created.body.pageId,
        boardIds: ["cart"],
      });
      assert.strictEqual(read.body.revision, laid.body.revision);
      assert.strictEqual(read.body.boards[0].html, undefined);
      assert.include(read.body.boards[0].text, "首页");
      assert.include(read.body.boards[1].html, "购物车");
      assert.strictEqual(read.body.system.name, "Moss 设计标准");
      assert.ok(read.body.system.colors.some((line: string) => line.startsWith("--ds-ink ")));

      const stored = yield* h.types.read(
        { scopeSpaceId: h.scopeSpaceId, pageId: PageId.makeUnsafe(created.body.pageId) },
        user,
      );
      assert.strictEqual(stored.kind, "design");
      const canvas = parseDesignCanvas(stored.data!);
      assert.deepStrictEqual(canvas.launch, { view: "focused", boardId: "home" });
      assert.include(stored.page.title, "点餐应用");
    }),
  );

  it.effect(
    "design systems: built-ins, a design that is a system, and installing it elsewhere",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const listed = yield* h.call("moss_design_systems", {});
        assert.deepStrictEqual(
          listed.body.systems.map((system: { source: string }) => system.source),
          ["builtin:moss", "builtin:editorial", "builtin:night", "builtin:fresh"],
        );
        const system = yield* h.call("moss_design_create", {
          requestId: "ds-1",
          title: "品牌设计系统",
          spaceId: null,
          parentPageId: null,
        });
        const own = yield* h.call("moss_design_set_system", {
          requestId: "ds-2",
          pageId: system.body.pageId,
          expectedRevision: system.body.revision,
          system: "own",
          tokens: {
            colors: [{ name: "brand", label: "品牌色", light: "#0e7490" }],
            text: [
              {
                name: "body",
                label: "正文",
                family: "sans",
                size: 15,
                lineHeight: 22,
                weight: 400,
              },
            ],
            readme: "品牌色只用于按钮。",
          },
        });
        assert.isFalse(own.error, JSON.stringify(own.body));
        const badTokens = yield* h.call("moss_design_set_system", {
          requestId: "ds-3",
          pageId: system.body.pageId,
          expectedRevision: own.body.revision,
          system: "own",
          tokens: { colors: [{ name: "brand", light: "red}body{" }] },
        });
        assert.isTrue(badTokens.error);

        const design = yield* h.call("moss_design_create", {
          requestId: "ds-4",
          title: "官网",
          spaceId: null,
          parentPageId: null,
          templateId: "builtin:design-landing",
          system: `page:${system.body.pageId}`,
        });
        assert.isFalse(design.error, JSON.stringify(design.body));
        const read = yield* h.call("moss_design_read", { pageId: design.body.pageId });
        assert.strictEqual(read.body.system.name, "品牌设计系统");
        assert.deepStrictEqual(read.body.system.colors, ["--ds-brand (品牌色: #0e7490)"]);
        assert.strictEqual(read.body.boards[0].id, "landing");

        const notASystem = yield* h.call("moss_design_create", {
          requestId: "ds-5",
          title: "再来一个",
          spaceId: null,
          parentPageId: null,
          system: `page:${design.body.pageId}`,
        });
        assert.isTrue(notASystem.error);
      }),
  );
});
