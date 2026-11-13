import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { SpaceId, ThreadId } from "@moss/contracts";
import { parseSheetWorkbook, readSheetRange } from "@moss/shared/spaceItems/sheetWorkbook";
import { parseSlidesDeck } from "@moss/shared/spaceItems/slidesDeck";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makePageTypeTools } from "../../agentGateway/pageTypeTools";
import type { PageAppsServiceShape } from "../apps/PageAppsService";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { PagesServiceLive } from "../Layers/PagesService";
import { LOCAL_PAGES_PRINCIPAL as user, PagesService } from "../Services/PagesService";
import { PageTypesService, PageTypesServiceLive } from "./PageTypesService";

const tests = it.layer(
  PageTypesServiceLive.pipe(
    Layer.provideMerge(PagesServiceLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const timestamp = "2026-11-04T00:00:00.000Z";
const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const types = yield* PageTypesService;
  const pages = yield* PagesService;
  const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
    VALUES (${scopeSpaceId}, 'Types test', 'folder', 0, ${timestamp}, ${timestamp})`;
  const create = (
    kind: "page" | "slides" | "sheet" | "board" | "app",
    extra: { templateId?: string; data?: string } = {},
  ) =>
    types.create(
      {
        requestId: randomUUID(),
        scopeSpaceId,
        kind,
        title: `New ${kind}`,
        spaceId: null,
        parentPageId: null,
        ...extra,
      },
      user,
    );
  const seedThread = Effect.gen(function* () {
    const projectId = randomUUID();
    const threadId = ThreadId.makeUnsafe(randomUUID());
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
      VALUES (${projectId}, 'Test project', '/fixture', '[]', ${scopeSpaceId}, ${timestamp}, ${timestamp})`;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES (${threadId}, ${projectId}, 'Test conversation', ${timestamp}, ${timestamp})`;
    return threadId;
  });
  return { sql, types, pages, scopeSpaceId, create, seedThread };
});

tests("typed 资料空间 items", (it) => {
  it.effect("creates each typed kind with a valid empty payload and the page kind", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      for (const kind of ["slides", "sheet", "board", "app"] as const) {
        const item = yield* h.create(kind);
        assert.strictEqual(item.kind, kind);
        assert.strictEqual(item.page.kind, kind);
        assert.ok(item.data);
        assert.strictEqual(item.dataRevision, item.page.revision);
      }
      const board = yield* h.create("board");
      assert.include(board.data!, `space-board-${board.page.id}`);
      const page = yield* h.create("page");
      assert.strictEqual(page.kind, "page");
      assert.strictEqual(page.data, null);
    }),
  );

  it.effect("saves a payload at the next revision and projects it into the page body", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const deck = yield* h.create("slides", { templateId: "builtin:weekly-report-deck" });
      assert.strictEqual(parseSlidesDeck(deck.data!).slides.length, 6);
      const parsed = parseSlidesDeck(deck.data!);
      const next = { ...parsed, slides: parsed.slides.slice(0, 2) };
      const saved = yield* h.types.save(
        {
          requestId: randomUUID(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: deck.page.id,
          expectedRevision: deck.page.revision,
          title: "周报 11 月",
          data: JSON.stringify(next),
        },
        user,
      );
      assert.strictEqual(saved.page.revision, deck.page.revision + 1);
      assert.strictEqual(saved.page.title, "周报 11 月");
      const body = yield* h.pages.read(
        { scopeSpaceId: h.scopeSpaceId, pageId: deck.page.id },
        user,
      );
      assert.include(body.content, "## 1. 本周工作汇报");
      assert.notInclude(body.content, "下周计划");
      // An older revision still reads the payload it was saved with.
      const reread = yield* h.types.read(
        { scopeSpaceId: h.scopeSpaceId, pageId: deck.page.id },
        user,
      );
      assert.strictEqual(parseSlidesDeck(reread.data!).slides.length, 2);
    }),
  );

  it.effect("rejects a stale revision and malformed payloads without creating pages", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const sheet = yield* h.create("sheet");
      const stale = yield* Effect.exit(
        h.types.save(
          {
            requestId: randomUUID(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: sheet.page.id,
            expectedRevision: sheet.page.revision + 5,
            data: sheet.data!,
          },
          user,
        ),
      );
      assert.ok(Exit.isFailure(stale));
      const before = (yield* h.pages.list({ scopeSpaceId: h.scopeSpaceId }, user)).pages.length;
      const bad = yield* Effect.exit(
        h.create("slides", {
          data: '{"version":1,"slides":[{"id":"x","elements":[{"type":"video"}]}]}',
        }),
      );
      assert.ok(Exit.isFailure(bad));
      const wrongTemplate = yield* Effect.exit(
        h.create("sheet", { templateId: "builtin:kpi-dashboard" }),
      );
      assert.ok(Exit.isFailure(wrongTemplate));
      assert.strictEqual(
        (yield* h.pages.list({ scopeSpaceId: h.scopeSpaceId }, user)).pages.length,
        before,
      );
    }),
  );

  it.effect("is idempotent for a retried create", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const input = {
        requestId: randomUUID(),
        scopeSpaceId: h.scopeSpaceId,
        kind: "app" as const,
        title: "KPI",
        spaceId: null,
        parentPageId: null,
        templateId: "builtin:kpi-dashboard",
      };
      const first = yield* h.types.create(input, user);
      const second = yield* h.types.create(input, user);
      assert.strictEqual(second.page.id, first.page.id);
      assert.strictEqual(second.data, first.data);
      assert.include(first.data!, '"capabilities":["db"]');
    }),
  );

  it.effect("lists built-in templates and saves, uses and deletes personal templates", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const listed = yield* h.types.listTemplates(
        { scopeSpaceId: h.scopeSpaceId, kind: "app" },
        user,
      );
      assert.deepStrictEqual(
        listed.templates.map((template) => template.id),
        [
          "builtin:sales-dashboard",
          "builtin:kpi-dashboard",
          "builtin:tracker",
          "builtin:poll-signup",
        ],
      );
      const sheet = yield* h.create("sheet", { templateId: "builtin:budget-sheet" });
      const template = yield* h.types.saveTemplate(
        {
          requestId: "save-1",
          scopeSpaceId: h.scopeSpaceId,
          pageId: sheet.page.id,
          title: "我的预算",
        },
        user,
      );
      assert.strictEqual(template.kind, "sheet");
      assert.strictEqual(template.builtIn, false);
      const again = yield* h.types.saveTemplate(
        {
          requestId: "save-1",
          scopeSpaceId: h.scopeSpaceId,
          pageId: sheet.page.id,
          title: "我的预算",
        },
        user,
      );
      assert.strictEqual(again.id, template.id);
      const copy = yield* h.create("sheet", { templateId: template.id });
      assert.strictEqual(copy.data, sheet.data);
      const deleted = yield* h.types.deleteTemplate(
        { scopeSpaceId: h.scopeSpaceId, templateId: template.id },
        user,
      );
      assert.isTrue(deleted.deleted);
      const builtIn = yield* Effect.exit(
        h.types.deleteTemplate(
          { scopeSpaceId: h.scopeSpaceId, templateId: "builtin:tracker" },
          user,
        ),
      );
      assert.ok(Exit.isFailure(builtIn));
    }),
  );

  it.effect("agent tools edit spreadsheet ranges against the read revision", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const threadId = yield* h.seedThread;
      const tools = new Map(
        makePageTypeTools({ types: h.types }).map((tool) => [tool.definition.name, tool]),
      );
      const context = {
        callerThreadId: threadId,
        assertCallerTurnActive: () => Effect.void,
      } as unknown as Parameters<NonNullable<ReturnType<typeof tools.get>>["handler"]>[1];
      const call = (name: string, args: Record<string, unknown>) =>
        Effect.gen(function* () {
          const result = (yield* tools.get(name)!.handler(args, context)) as unknown as {
            content: { text: string }[];
            isError?: boolean;
          };
          const text = result.content[0]!.text;
          const body =
            result.isError && !text.startsWith("{") ? { message: text } : JSON.parse(text);
          return { error: result.isError === true, body };
        });
      const sheet = yield* call("moss_space_create_item", {
        requestId: "agent-sheet",
        scopeSpaceId: h.scopeSpaceId,
        kind: "sheet",
        title: "Numbers",
        spaceId: null,
        parentPageId: null,
      });
      const wrote = yield* call("moss_sheet_write_range", {
        requestId: "agent-write",
        scopeSpaceId: h.scopeSpaceId,
        pageId: sheet.body.pageId,
        expectedRevision: sheet.body.revision,
        start: "A1",
        values: [
          ["item", "amount"],
          ["a", 2],
          ["b", 3],
          ["total", "=SUM(B2:B3)"],
        ],
      });
      assert.isFalse(wrote.error, JSON.stringify(wrote.body));
      assert.strictEqual(wrote.body.range, "A1:B4");
      const stale = yield* call("moss_sheet_write_range", {
        requestId: "agent-write-stale",
        scopeSpaceId: h.scopeSpaceId,
        pageId: sheet.body.pageId,
        expectedRevision: sheet.body.revision,
        start: "C1",
        values: [["x"]],
      });
      assert.isTrue(stale.error);
      assert.strictEqual(stale.body.error.code, "conflict");
      const range = yield* call("moss_sheet_read_range", {
        scopeSpaceId: h.scopeSpaceId,
        pageId: sheet.body.pageId,
        range: "A3:B4",
      });
      assert.deepStrictEqual(range.body.values, [
        ["b", 3],
        ["total", null],
      ]);
      assert.deepStrictEqual(range.body.formulas, [
        [null, null],
        [null, "=SUM(B2:B3)"],
      ]);
      // The page body shows the table for search and plain reads.
      const item = yield* h.types.read(
        { scopeSpaceId: h.scopeSpaceId, pageId: sheet.body.pageId },
        user,
      );
      assert.deepStrictEqual(
        readSheetRange(parseSheetWorkbook(item.data!), undefined, "A1").values,
        [["item"]],
      );

      // The moss_sheet_* protocol: typed reads with worked-out formulas, edits against a base.
      const guide = yield* call("moss_sheet_guide", { scopeSpaceId: h.scopeSpaceId });
      assert.include(guide.body.guide, "moss_sheet_apply_edits");
      const sheets = yield* call("moss_sheet_read", {
        scopeSpaceId: h.scopeSpaceId,
        pageId: sheet.body.pageId,
        payload: { kind: "readSheets" },
      });
      assert.strictEqual(sheets.body.revision, wrote.body.revision);
      assert.strictEqual(sheets.body.sheets[0].filledRange, "A1:B4");
      const applied = yield* call("moss_sheet_apply_edits", {
        requestId: "agent-edits",
        scopeSpaceId: h.scopeSpaceId,
        pageId: sheet.body.pageId,
        base: sheets.body.revision,
        edits: [
          { kind: "writeCells", sheet: "工作表1", topLeft: "C1", rows: [["share"], ["=B2/B4"]] },
          {
            kind: "formatCells",
            sheet: "工作表1",
            ranges: ["C2"],
            format: { numberFormat: { pattern: "0%" } },
          },
        ],
      });
      assert.isFalse(applied.error, JSON.stringify(applied.body));
      const cells = yield* call("moss_sheet_read", {
        scopeSpaceId: h.scopeSpaceId,
        pageId: sheet.body.pageId,
        payload: { kind: "readCells", sheet: "工作表1", range: "B4:C4" },
      });
      assert.deepStrictEqual(cells.body.rows["4"], [{ formula: "=SUM(B2:B3)", value: 5 }]);
      const share = yield* call("moss_sheet_read", {
        scopeSpaceId: h.scopeSpaceId,
        pageId: sheet.body.pageId,
        payload: { kind: "readCells", sheet: "工作表1", range: "C2" },
      });
      assert.deepStrictEqual(share.body.rows["2"], [
        { formula: "=B2/B4", value: { number: 0.4, shown: "40%" } },
      ]);
      const late = yield* call("moss_sheet_apply_edits", {
        requestId: "agent-edits-late",
        scopeSpaceId: h.scopeSpaceId,
        pageId: sheet.body.pageId,
        base: sheets.body.revision,
        edits: [{ kind: "addSheet", name: "Notes" }],
      });
      assert.isTrue(late.error);
      assert.strictEqual(late.body.error.refusal, "baseIsNotTheRevision");
      const refused = yield* call("moss_sheet_apply_edits", {
        requestId: "agent-edits-bad",
        scopeSpaceId: h.scopeSpaceId,
        pageId: sheet.body.pageId,
        base: applied.body.revision,
        edits: [
          { kind: "addSheet", name: "Notes" },
          { kind: "writeCell", sheet: "Notes" },
        ],
      });
      assert.isTrue(refused.error);
      assert.strictEqual(refused.body.error.refusal, "kindNotKnown");
      assert.strictEqual(refused.body.error.editIndex, 1);

      // 版本历史: the sheet as it was at an earlier revision; the page row stays current.
      const before = yield* h.types.read(
        { scopeSpaceId: h.scopeSpaceId, pageId: sheet.body.pageId, revision: wrote.body.revision },
        user,
      );
      assert.strictEqual(before.page.revision, applied.body.revision);
      assert.strictEqual(before.dataRevision, wrote.body.revision);
      assert.isFalse(before.data!.includes("share"));
      const now = yield* h.types.read(
        { scopeSpaceId: h.scopeSpaceId, pageId: sheet.body.pageId },
        user,
      );
      assert.isTrue(now.data!.includes("share"));
    }),
  );

  it.effect("creates dashboards as real 应用页 when the apps runtime is present", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const threadId = yield* h.seedThread;
      const calls: unknown[] = [];
      const apps = {
        mutate: (input: { title?: string }) => {
          calls.push(input);
          return Effect.succeed({ app: { id: "app_1", revision: 1, title: input.title } });
        },
      } as unknown as PageAppsServiceShape;
      const tool = makePageTypeTools({ types: h.types, apps }).find(
        (entry) => entry.definition.name === "moss_space_create_item",
      )!;
      const context = {
        callerThreadId: threadId,
        assertCallerTurnActive: () => Effect.void,
      } as unknown as Parameters<typeof tool.handler>[1];
      const result = (yield* tool.handler(
        {
          requestId: "agent-kpi",
          scopeSpaceId: h.scopeSpaceId,
          kind: "app",
          title: "销售 KPI",
          spaceId: null,
          parentPageId: null,
          templateId: "builtin:kpi-dashboard",
        },
        context,
      )) as unknown as { content: { text: string }[]; isError?: boolean };
      assert.isNotTrue(result.isError, result.content[0]!.text);
      assert.deepStrictEqual(JSON.parse(result.content[0]!.text), {
        appId: "app_1",
        kind: "app",
        revision: 1,
        title: "销售 KPI",
      });
      const sent = calls[0] as {
        op: string;
        html: string;
        capabilities: unknown;
        spaceId: unknown;
      };
      assert.strictEqual(sent.op, "create");
      assert.include(sent.html, "moss-app-manifest");
      assert.deepStrictEqual(sent.capabilities, { db: {} });
      // No typed `app` page was made.
      const pages = yield* h.pages.list({ scopeSpaceId: h.scopeSpaceId }, user);
      assert.isFalse(pages.pages.some((page) => page.title === "销售 KPI"));
    }),
  );
});
