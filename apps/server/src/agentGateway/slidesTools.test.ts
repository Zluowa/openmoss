import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import { SpaceId, ThreadId } from "@moss/contracts";
import { applyDeckOps, type DeckOp } from "@moss/shared/spaceItems/deckOps";
import { parseSlidesDeck } from "@moss/shared/spaceItems/slidesDeck";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PageDraftsServiceLive } from "../pages/drafts/Layers/PageDraftsService";
import { PageDraftsService } from "../pages/drafts/Services/PageDraftsService";
import { PagesServiceLive } from "../pages/Layers/PagesService";
import { LOCAL_PAGES_PRINCIPAL as user } from "../pages/Services/PagesService";
import { PageTypesService, PageTypesServiceLive } from "../pages/types/PageTypesService";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makeSlidesTools, type SlidesToolActivity } from "./slidesTools";

const tests = it.layer(
  Layer.mergeAll(PageTypesServiceLive, PageDraftsServiceLive).pipe(
    Layer.provideMerge(PagesServiceLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const timestamp = "2026-11-04T00:00:00.000Z";

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const types = yield* PageTypesService;
  const drafts = yield* PageDraftsService;
  const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
    VALUES (${scopeSpaceId}, 'Slides test', 'folder', 0, ${timestamp}, ${timestamp})`;
  const projectId = randomUUID();
  const threadId = ThreadId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
    VALUES (${projectId}, 'Test project', '/fixture', '[]', ${scopeSpaceId}, ${timestamp}, ${timestamp})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Deck writer', ${timestamp}, ${timestamp})`;
  const workspace = mkdtempSync(path.join(os.tmpdir(), "moss-slides-tools-"));
  const activities: SlidesToolActivity[] = [];
  const tools = new Map(
    makeSlidesTools({
      types,
      drafts,
      resolveWorkspaceRoot: () => Effect.succeed(workspace),
      recordActivity: (_context, activity) => Effect.sync(() => void activities.push(activity)),
    }).map((tool) => [tool.definition.name, tool]),
  );
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
  return { types, drafts, scopeSpaceId, threadId, workspace, call, activities };
});

tests("moss_slides_* agent tools", (it) => {
  it.effect("an agent makes a deck from an outline, reads it and edits its own deck directly", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const guide = yield* h.call("moss_slides_guide", {});
      assert.include(guide.body.guide, "One idea per slide");
      const created = yield* h.call("moss_slides_create", {
        requestId: "deck-1",
        title: "Moss 进展",
        spaceId: null,
        parentPageId: null,
        theme: "ink",
        outline: {
          title: "Moss 现在走到哪了",
          subtitle: "2026 年 11 月",
          sections: [
            {
              title: "已经做成的",
              slides: [
                { title: "1.0.3 正在线上运行", bullets: ["Windows 自动更新", "国内登录通道"] },
                {
                  title: "版本对比",
                  table: [
                    ["版本", "日期"],
                    ["1.0.2", "10-28"],
                    ["1.0.3", "11-01"],
                  ],
                },
              ],
            },
          ],
        },
      });
      assert.isFalse(created.error, JSON.stringify(created.body));
      assert.strictEqual(created.body.theme, "夜墨");
      // cover, section divider, 2 content slides, closing
      assert.strictEqual(created.body.slideCount, 5);
      assert.deepStrictEqual(
        created.body.slides.map((slide: { layout: string }) => slide.layout),
        ["title", "section", "bullets", "table", "closing"],
      );

      const read = yield* h.call("moss_slides_read", { pageId: created.body.pageId });
      assert.isFalse(read.error, JSON.stringify(read.body));
      const bullets = read.body.slides[2];
      const title = bullets.elements.find((e: { role?: string }) => e.role === "title");
      assert.strictEqual(title.text, "1.0.3 正在线上运行");

      const edited = yield* h.call("moss_slides_edit", {
        requestId: "edit-1",
        pageId: created.body.pageId,
        expectedRevision: read.body.revision,
        ops: [
          { op: "set-text", slideId: bullets.id, elementId: title.id, text: "1.0.3 已上线" },
          { op: "add-slide", layout: "quote", index: 3, content: { quote: "先发，空间下版" } },
        ],
      });
      assert.isFalse(edited.error, JSON.stringify(edited.body));
      assert.isTrue(edited.body.applied);
      assert.strictEqual(edited.body.changes.addedSlides.length, 1);
      assert.isUndefined(edited.body.layoutFaults);
      assert.include(
        String(created.body.openLink),
        `moss://space-page/${encodeURIComponent(created.body.pageId)}`,
      );
      assert.isUndefined(created.body.layoutFaults);

      // Moving the title onto the bullets is reported, so the agent fixes it before answering.
      const body = bullets.elements.find((e: { role?: string }) => e.role !== "title");
      const overlapped = yield* h.call("moss_slides_edit", {
        requestId: "edit-overlap",
        pageId: created.body.pageId,
        expectedRevision: edited.body.revision,
        ops: [
          {
            op: "update-element",
            slideId: bullets.id,
            elementId: title.id,
            set: { x: body.box[0], y: body.box[1], w: body.box[2], h: body.box[3] },
          },
        ],
      });
      assert.isFalse(overlapped.error, JSON.stringify(overlapped.body));
      assert.strictEqual(overlapped.body.layoutFaults[0].kind, "overlap");
      assert.include(String(overlapped.body.fixFirst), "moss_slides_edit");

      const stale = yield* h.call("moss_slides_edit", {
        requestId: "edit-stale",
        pageId: created.body.pageId,
        expectedRevision: read.body.revision,
        ops: [{ op: "delete-slide", slideId: bullets.id }],
      });
      assert.isTrue(stale.error);
      assert.strictEqual(stale.body.error.code, "conflict");

      const missing = yield* h.call("moss_slides_edit", {
        requestId: "edit-missing",
        pageId: created.body.pageId,
        ops: [{ op: "delete-slide", slideId: "nope" }],
      });
      assert.isTrue(missing.error);
    }),
  );

  it.effect("once the person edits the deck, agent edits become reviewable drafts", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const created = yield* h.call("moss_slides_create", {
        requestId: "deck-2",
        title: "提案",
        spaceId: null,
        parentPageId: null,
        templateId: "builtin:pitch-deck",
      });
      assert.isFalse(created.error, JSON.stringify(created.body));
      const item = yield* h.types.read(
        { scopeSpaceId: h.scopeSpaceId, pageId: created.body.pageId },
        user,
      );
      const deck = parseSlidesDeck(item.data!);
      // The person moves the closing slide first.
      const personal = applyDeckOps(deck, [
        { op: "move-slide", slideId: deck.slides.at(-1)!.id, index: 1 },
      ]);
      const saved = yield* h.types.save(
        {
          requestId: randomUUID(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: item.page.id,
          expectedRevision: item.page.revision,
          data: JSON.stringify(personal),
        },
        user,
      );
      const cover = personal.slides[0]!;
      const titleId = cover.elements.find((e) => e.type === "text" && e.role === "title")!.id;
      const ops: DeckOp[] = [
        { op: "set-text", slideId: cover.id, elementId: titleId, text: "新的标题" },
      ];

      const forced = yield* h.call("moss_slides_edit", {
        requestId: "edit-apply",
        pageId: item.page.id,
        mode: "apply",
        ops,
      });
      assert.isTrue(forced.error);

      const proposed = yield* h.call("moss_slides_edit", {
        requestId: "edit-propose",
        pageId: item.page.id,
        summary: "改封面标题",
        target: { slideIds: [cover.id], elementIds: [titleId] },
        ops,
      });
      assert.isFalse(proposed.error, JSON.stringify(proposed.body));
      assert.isFalse(proposed.body.applied);
      assert.strictEqual(proposed.body.baseRevision, saved.page.revision);
      // Nothing changed on the deck itself.
      const after = yield* h.types.read(
        { scopeSpaceId: h.scopeSpaceId, pageId: item.page.id },
        user,
      );
      assert.strictEqual(after.page.revision, saved.page.revision);
      const list = yield* h.drafts.list(
        { scopeSpaceId: h.scopeSpaceId, pageId: item.page.id },
        user,
      );
      assert.strictEqual(list.drafts.length, 1);
      const op = list.drafts[0]!.ops[0]!;
      assert.strictEqual(op.kind, "deck");
      if (op.kind === "deck") {
        assert.deepStrictEqual(JSON.parse(op.deckOps), ops);
        assert.deepStrictEqual(op.target, { slideIds: [cover.id], elementIds: [titleId] });
      }
      const read = yield* h.call("moss_slides_read", {
        pageId: item.page.id,
        slideIds: [cover.id],
      });
      assert.strictEqual(read.body.openChanges.length, 1);
      assert.strictEqual(read.body.slides.length, 1);
    }),
  );

  it.effect("fills a blank deck the person just made (新建幻灯片 → 让 Moss 生成) directly", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const blank = yield* h.types.create(
        {
          requestId: randomUUID(),
          scopeSpaceId: h.scopeSpaceId,
          kind: "slides",
          title: "新建幻灯片",
          spaceId: null,
          parentPageId: null,
        },
        user,
      );
      const filled = yield* h.call("moss_slides_create", {
        requestId: "fill-1",
        title: "团队周报",
        pageId: blank.page.id,
        outline: { title: "团队周报", slides: [{ title: "本周", bullets: ["一", "二"] }] },
      });
      assert.isFalse(filled.error, JSON.stringify(filled.body));
      assert.isTrue(filled.body.applied);
      const after = yield* h.types.read(
        { scopeSpaceId: h.scopeSpaceId, pageId: blank.page.id },
        user,
      );
      const deck = parseSlidesDeck(after.data!);
      assert.deepStrictEqual(
        deck.slides.map((slide) => slide.layout),
        ["title", "bullets", "closing"],
      );
      // Now it holds work: a second fill is only proposed.
      const again = yield* h.call("moss_slides_create", {
        requestId: "fill-2",
        title: "团队周报",
        pageId: blank.page.id,
        outline: { title: "另一个版本", slides: [{ title: "x" }] },
      });
      assert.isFalse(again.error, JSON.stringify(again.body));
      // The agent wrote the last revision itself, so its own deck is still edited directly.
      assert.isTrue(again.body.applied);
    }),
  );

  it.effect("exports a deck to .pptx in the workspace and imports it back as editable slides", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const created = yield* h.call("moss_slides_create", {
        requestId: "deck-3",
        title: "季度回顾",
        spaceId: null,
        parentPageId: null,
        templateId: "builtin:quarterly-review-deck",
      });
      assert.isFalse(created.error, JSON.stringify(created.body));
      const exported = yield* h.call("moss_slides_export", {
        requestId: "export-1",
        pageId: created.body.pageId,
        format: "pptx",
        path: "out/review.pptx",
      });
      assert.isFalse(exported.error, JSON.stringify(exported.body));
      assert.include(String(exported.body.downloadUrl), "/api/thread-output?");
      assert.include(String(exported.body.markdownLink), String(exported.body.downloadUrl));
      const bytes = readFileSync(path.join(h.workspace, "out", "review.pptx"));
      assert.strictEqual(bytes.subarray(0, 2).toString(), "PK");

      const escape = yield* h.call("moss_slides_export", {
        requestId: "export-2",
        pageId: created.body.pageId,
        format: "pptx",
        path: "../outside.pptx",
      });
      assert.isTrue(escape.error);

      const imported = yield* h.call("moss_slides_create", {
        requestId: "deck-4",
        title: "导入的回顾",
        spaceId: null,
        parentPageId: null,
        pptxPath: "out/review.pptx",
      });
      assert.isFalse(imported.error, JSON.stringify(imported.body));
      assert.strictEqual(imported.body.slideCount, created.body.slideCount);
      const texts = JSON.stringify(imported.body.slides);
      assert.include(texts, "目标完成情况");
      assert.include(texts, '"type":"table"');
      assert.deepStrictEqual(
        imported.body.sections.map((section: { title: string }) => section.title),
        created.body.sections.map((section: { title: string }) => section.title),
      );
      rmSync(h.workspace, { recursive: true, force: true });
    }),
  );

  it.effect("records each deck and exported file for the chat's cards", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const created = yield* h.call("moss_slides_create", {
        requestId: "deck-cards",
        title: "年终汇报",
        spaceId: null,
        parentPageId: null,
        outline: {
          title: "年终汇报",
          subtitle: "2026 年",
          slides: [{ title: "进展", bullets: ["上线"] }],
        },
      });
      assert.isFalse(created.error, JSON.stringify(created.body));
      assert.deepStrictEqual(h.activities[0], {
        kind: "slides.deck.updated",
        summary: "年终汇报",
        payload: {
          slidesDeck: {
            pageId: created.body.pageId,
            scopeSpaceId: h.scopeSpaceId,
            title: "年终汇报",
            slideCount: created.body.slideCount,
            coverText: "年终汇报 · 2026 年",
            change: "created",
          },
        },
      });

      const edited = yield* h.call("moss_slides_edit", {
        requestId: "deck-cards-edit",
        pageId: created.body.pageId,
        ops: [{ op: "delete-slide", slideId: created.body.slides.at(-1).id }],
      });
      assert.isFalse(edited.error, JSON.stringify(edited.body));
      const editedPayload = h.activities[1]!.payload as {
        slidesDeck: { change: string; slideCount: number };
      };
      assert.strictEqual(editedPayload.slidesDeck.change, "edited");
      assert.strictEqual(editedPayload.slidesDeck.slideCount, created.body.slideCount - 1);

      const exported = yield* h.call("moss_slides_export", {
        requestId: "deck-cards-export",
        pageId: created.body.pageId,
        format: "pptx",
      });
      assert.isFalse(exported.error, JSON.stringify(exported.body));
      const file = h.activities[2]!;
      assert.strictEqual(file.kind, "thread-output.published");
      assert.strictEqual(file.summary, "年终汇报.pptx");
      const output = (file.payload as { threadOutput: Record<string, unknown> }).threadOutput;
      assert.strictEqual(output.file, "年终汇报.pptx");
      assert.strictEqual(output.path, exported.body.path);
      assert.strictEqual(output.bytes, exported.body.bytes);
      assert.match(String(output.sha256), /^[a-f\d]{64}$/u);
      assert.strictEqual(h.activities.length, 3);
      rmSync(h.workspace, { recursive: true, force: true });
    }),
  );
});
