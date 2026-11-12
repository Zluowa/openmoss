import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makePageAppsServiceShape, PageAppsService } from "../pages/apps/PageAppsService";
import { PageDraftsServiceLive } from "../pages/drafts/Layers/PageDraftsService";
import { PageDraftsService } from "../pages/drafts/Services/PageDraftsService";
import { PagesServiceLive } from "../pages/Layers/PagesService";
import { LOCAL_PAGES_PRINCIPAL as user, PagesService } from "../pages/Services/PagesService";
import { makePageDraftTools } from "./pageDraftTools";
import {
  assembleVisualizationHtml,
  makePageVisualizeTool,
  normalizeCodeText,
} from "./pageVisualizeTool";
import type { ToolContext } from "./toolRuntime";

const tests = it.layer(
  PageDraftsServiceLive.pipe(
    Layer.provideMerge(PagesServiceLive),
    Layer.provideMerge(
      Layer.effect(
        PageAppsService,
        makePageAppsServiceShape({ ai: { ask: async function* () {} } }),
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const timestamp = "2026-11-12T00:00:00.000Z";
const json = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  JSON.parse((result.content[0] as { text: string }).text);

const contextFor = (threadId: string): ToolContext => ({
  principal: {
    kind: "provider-session",
    sessionKey: "s",
    threadId,
    provider: "claudeAgent",
    turnId: "t",
  },
  callerThreadId: threadId,
  callerThreadLabel: "Current conversation",
  callerSessionKey: "s",
  callerProvider: "claudeAgent",
  callerCapabilities: new Set(["thread:read", "thread:write"]),
  callerTurnId: "t",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
});

const placeholder = {
  type: "moss_visualization",
  id: "viz",
  title: "柱状图：甲3 乙5 丙2",
  prompt: "柱状图：甲3 乙5 丙2",
  appPageId: null,
  children: [{ text: "" }],
};

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pages = yield* PagesService;
  const created = yield* pages.mutate(
    {
      op: "create",
      requestId: randomUUID(),
      scopeSpaceId: null,
      title: "验收 可视化",
      richContent: JSON.stringify([
        { type: "p", id: "a", children: [{ text: "第一段" }] },
        placeholder,
      ]),
      spaceId: null,
      parentPageId: null,
    },
    user,
  );
  const projectId = randomUUID();
  const threadId = randomUUID();
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
    VALUES (${projectId}, 'P', '/fixture', '[]', ${null}, ${timestamp}, ${timestamp})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'T', ${timestamp}, ${timestamp})`;
  const services = {
    pages,
    apps: yield* PageAppsService,
    drafts: yield* PageDraftsService,
  };
  return { ...services, page: created.page, context: contextFor(threadId) };
});

tests("moss_app_visualize", (it) => {
  it.effect("publishes the chart and proposes the filled 可视化 block in one call", () =>
    Effect.gen(function* () {
      const { pages, apps, drafts, page, context } = yield* harness;
      const tool = makePageVisualizeTool({ pages, apps, drafts });
      const result = json(
        yield* tool.handler(
          {
            pageId: page.id,
            blockId: "viz",
            title: "柱状图 · 甲3 乙5 丙2",
            html: '```html\n<div id="root"></div>\n```',
            js: '<script>document.getElementById("root").innerHTML = "<b>乙 5</b>";</script>',
          },
          context,
        ),
      );
      assert.match(result.link, /^\/apps\//u);
      const app = yield* apps.read({ appId: result.appId } as never, user);
      assert.include(app.html, '<div id="root"></div>');
      assert.isTrue(app.html.indexOf('id="root"') < app.html.indexOf("getElementById"));

      const listed = yield* drafts.list({ scopeSpaceId: null, pageId: page.id }, user);
      const draft = listed.drafts[0]!;
      assert.strictEqual(draft.kind, "visualization");
      const op = draft.ops[0] as { kind: string; blockId: string; richContent: string };
      assert.strictEqual(op.kind, "replace");
      assert.strictEqual(op.blockId, "viz");
      expect(JSON.parse(op.richContent)).toEqual([
        {
          type: "moss_visualization",
          title: "柱状图 · 甲3 乙5 丙2",
          prompt: placeholder.prompt,
          appPageId: result.appId,
          children: [{ text: "" }],
        },
      ]);

      // A retry with the same arguments neither publishes twice nor drafts twice.
      const again = json(
        yield* tool.handler(
          {
            pageId: page.id,
            blockId: "viz",
            title: "柱状图 · 甲3 乙5 丙2",
            html: '```html\n<div id="root"></div>\n```',
            js: '<script>document.getElementById("root").innerHTML = "<b>乙 5</b>";</script>',
          },
          context,
        ),
      );
      assert.strictEqual(again.appId, result.appId);
      assert.strictEqual(
        (yield* drafts.list({ scopeSpaceId: null, pageId: page.id }, user)).drafts.length,
        1,
      );
    }),
  );

  it.effect("tells the model what to resend when the code is missing", () =>
    Effect.gen(function* () {
      const { pages, apps, drafts, page, context } = yield* harness;
      const result = yield* makePageVisualizeTool({ pages, apps, drafts }).handler(
        { pageId: page.id, blockId: "viz" },
        context,
      );
      assert.isTrue(result.isError);
      assert.match(JSON.stringify(result), /html is required/u);
    }),
  );

  it.effect("moss_pages_draft turns round-10 style input into a 可视化 block, never text", () =>
    Effect.gen(function* () {
      const { pages, apps, drafts, page, context } = yield* harness;
      const published = yield* apps.mutate(
        {
          op: "create",
          requestId: randomUUID(),
          scopeSpaceId: null,
          html: "<!doctype html><title>折线图</title><div id=root></div>",
        },
        { kind: "agent", threadId: context.callerThreadId } as never,
      );
      const tool = makePageDraftTools({ drafts, pages }).find(
        (entry) => entry.definition.name === "moss_pages_draft",
      )!;
      // An array where a string is expected, no baseRevision, no requestId.
      const fromArray = json(
        yield* tool.handler(
          {
            pageId: page.id,
            ops: [
              {
                type: "replace",
                blockId: "viz",
                richContent: [{ type: "moss_visualization", appId: published.app.id }],
              },
            ],
          },
          context,
        ),
      );
      const op = fromArray.drafts[0].ops[0];
      expect(JSON.parse(op.richContent)[0]).toMatchObject({
        type: "moss_visualization",
        appPageId: published.app.id,
        title: placeholder.title,
        children: [{ text: "" }],
      });
      // Plain text over the 可视化 block is refused with the one call to make instead.
      const asText = yield* tool.handler(
        {
          pageId: page.id,
          baseRevision: page.revision,
          ops: [{ kind: "replace", blockId: "viz", markdown: "折线图：一月10 二月14 三月9" }],
        },
        context,
      );
      assert.isTrue(asText.isError);
      assert.match(JSON.stringify(asText), /moss_app_visualize/u);
    }),
  );

  it.effect(
    "a suggestion never touches a block the person added after the agent read the page",
    () =>
      Effect.gen(function* () {
        const { pages, drafts, page, context } = yield* harness;
        const video = {
          type: "video",
          id: "vid",
          url: "/media/leaf.mp4",
          children: [{ text: "" }],
        };
        const edited = yield* pages.mutate(
          {
            op: "update",
            requestId: randomUUID(),
            scopeSpaceId: null,
            pageId: page.id,
            expectedRevision: page.revision,
            richContent: JSON.stringify([
              { type: "p", id: "a", children: [{ text: "第一段" }] },
              placeholder,
              video,
            ]),
          },
          user,
        );
        assert.isTrue(edited.page.revision > page.revision);
        const tool = makePageDraftTools({ drafts, pages }).find(
          (entry) => entry.definition.name === "moss_pages_draft",
        )!;
        // A whole-page rewrite and a delete, both written against the revision before the video.
        const result = json(
          yield* tool.handler(
            {
              pageId: page.id,
              baseRevision: page.revision,
              ops: [
                {
                  kind: "replace-all",
                  richContent: [
                    { type: "p", id: "a", children: [{ text: "AI 改写" }] },
                    placeholder,
                  ],
                },
              ],
            },
            context,
          ),
        );
        const merged = JSON.parse(result.drafts[0].ops[0].richContent);
        expect(merged.map((node: { id: string }) => node.id)).toEqual(["a", "viz", "vid"]);
        expect(merged[2]).toEqual(video);

        const deleteOnly = yield* tool.handler(
          {
            pageId: page.id,
            baseRevision: page.revision,
            ops: [{ kind: "delete", blockId: "vid" }],
          },
          context,
        );
        // The video did not exist at that revision: nothing in the suggestion can apply.
        assert.isTrue(deleteOnly.isError);
        assert.match(JSON.stringify(deleteOnly), /Read it again with moss_pages_read/u);
      }),
  );
});

describe("visualization code", () => {
  it("undoes fences, wrapper tags and one level of escaping", () => {
    expect(normalizeCodeText("```js\nrun()\n```", "script")).toBe("run()");
    expect(normalizeCodeText("<style>b{}</style>", "style")).toBe("b{}");
    expect(normalizeCodeText('<div class=\\"a\\">\\n<b>1</b>\\n</div>')).toBe(
      '<div class="a">\n<b>1</b>\n</div>',
    );
    expect(normalizeCodeText(JSON.stringify("<p>x</p>"))).toBe("<p>x</p>");
  });

  it("builds one document around a fragment and adds css/js to a full one", () => {
    const fragment = assembleVisualizationHtml({
      html: "<svg></svg>",
      css: "b{}",
      js: "go()",
      title: "图 <1>",
    });
    expect(fragment).toMatch(/^<!doctype html>/u);
    expect(fragment).toContain("<title>图 &lt;1&gt;</title>");
    expect(fragment.indexOf("<svg>")).toBeLessThan(fragment.indexOf("go()"));
    const full = assembleVisualizationHtml({
      html: "<!doctype html><html><head></head><body><svg></svg></body></html>",
      css: "b{}",
      js: "go()",
      title: "x",
    });
    expect(full.indexOf("b{}")).toBeLessThan(full.indexOf("</head>"));
    expect(full.indexOf("go()")).toBeLessThan(full.indexOf("</body>"));
  });
});
