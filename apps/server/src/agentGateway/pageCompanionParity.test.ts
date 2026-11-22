// FILE: pageCompanionParity.test.ts
// Purpose: End-to-end tests for companionContext support, Docs & Dashboard auto-apply with
//          pre-apply rollback revisions, 建议模式 (draft mode) preservation, and rich awareness.

import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { SpaceId, ThreadId } from "@moss/contracts";
import { createDashboard, parseDashboard } from "@moss/shared/spaceItems/dashboard";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as decoding from "lib0/decoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";

import { PageDraftsServiceLive } from "../pages/drafts/Layers/PageDraftsService";
import { PageDraftsService } from "../pages/drafts/Services/PageDraftsService";
import { MESSAGE_AWARENESS, type RoomConnection } from "../pages/realtime/PageRealtimeRoom";
import { PageRealtimeService, PagesRealtimeLive } from "../pages/realtime/PageRealtimeService";
import { LOCAL_PAGES_PRINCIPAL, PagesService } from "../pages/Services/PagesService";
import {
  PageTypesService,
  PageTypesServiceLive,
  restorePageTypeRevision,
} from "../pages/types/PageTypesService";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makePageDraftTools } from "./pageDraftTools";
import { makePageTools } from "./pageTools";
import { makePageTypeTools } from "./pageTypeTools";
import type { McpToolCallResult } from "./protocol";
import type { ToolContext } from "./toolRuntime";

const baseLayer = PageTypesServiceLive.pipe(
  Layer.provideMerge(PageDraftsServiceLive),
  Layer.provideMerge(PagesRealtimeLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const tests = it.layer(baseLayer);
const now = "2026-11-22T00:00:00.000Z";

function decodeToolJson(res: McpToolCallResult) {
  const first = res.content[0];
  return first && first.type === "text" ? (JSON.parse(first.text) as Record<string, unknown>) : {};
}

function readLatestAgents(frames: Array<Uint8Array | string>) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  for (const frame of frames) {
    if (typeof frame === "string") continue;
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        "test",
      );
    }
  }
  const states = [...awareness.getStates().values()]
    .map((state) => (state as { moss?: { kind?: string; agents?: unknown[] } })?.moss)
    .filter((moss) => moss?.kind === "agents");
  return states.at(-1)?.agents ?? [];
}

tests("Space companion auto-apply, rollback & rich awareness parity", (it) => {
  it.effect(
    "auto-applies Docs edits live with rich presence & rollback, while preserving draft mode",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const pages = yield* PagesService;
        const drafts = yield* PageDraftsService;
        const realtime = yield* PageRealtimeService;

        const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
        const projectId = randomUUID();
        const threadId = ThreadId.makeUnsafe(randomUUID());
        yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES (${scopeSpaceId}, 'Companion Doc', 'folder', 0, ${now}, ${now})`;
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
        VALUES (${projectId}, 'Project', '/fixture', '[]', ${scopeSpaceId}, ${now}, ${now})`;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES (${threadId}, ${projectId}, 'Companion Thread', ${now}, ${now})`;

        const created = yield* pages.mutate(
          {
            op: "create",
            requestId: randomUUID(),
            scopeSpaceId,
            title: "Spec Doc",
            richContent: JSON.stringify([
              { type: "p", id: "blk-1", children: [{ text: "Initial line" }] },
            ]),
            spaceId: null,
            parentPageId: null,
          },
          LOCAL_PAGES_PRINCIPAL,
        );

        const ticket = yield* realtime.issueToken(
          { pageId: created.page.id, scopeSpaceId },
          LOCAL_PAGES_PRINCIPAL,
        );
        const frames: Array<Uint8Array | string> = [];
        const conn: RoomConnection = { mode: "edit", send: (f) => frames.push(f), close: () => {} };
        const joined = yield* Effect.promise(() =>
          realtime.join({ pageId: created.page.id, token: ticket.token, connection: () => conn }),
        );

        const ctx: ToolContext = {
          callerThreadId: threadId,
          callerTurnId: "turn-1" as never,
          assertCallerTurnActive: () => Effect.void,
        } as unknown as ToolContext;

        const pageTools = new Map(
          makePageTools({ pages, drafts, realtime }).map((t) => [t.definition.name, t]),
        );
        const draftTools = new Map(
          makePageDraftTools({ drafts, pages, realtime }).map((t) => [t.definition.name, t]),
        );

        // 1. moss_pages_read with companionContext triggers "thinking" awareness
        const readRes = yield* pageTools.get("moss_pages_read")!.handler(
          {
            scopeSpaceId,
            pageId: created.page.id,
            companionContext: {
              kind: "page",
              itemId: created.page.id,
              selection: { blockIds: ["blk-1"] },
            },
          },
          ctx,
        );
        const readBody = decodeToolJson(readRes);
        assert.strictEqual((readBody.page as { revision: number }).revision, 1);
        assert.deepStrictEqual(readLatestAgents(frames), [
          {
            id: threadId,
            name: "Moss",
            state: "thinking",
            label: "Moss · 正在思考...",
            blockIds: ["blk-1"],
            threadId,
          },
        ]);

        // 2. moss_pages_draft with applyMode="auto" updates live doc & returns undoRevision
        const autoRes = yield* draftTools.get("moss_pages_draft")!.handler(
          {
            scopeSpaceId,
            pageId: created.page.id,
            baseRevision: 1,
            applyMode: "auto",
            ops: [
              {
                kind: "replace",
                blockId: "blk-1",
                richContent: JSON.stringify([
                  { type: "p", id: "blk-1", children: [{ text: "Auto edited line" }] },
                ]),
              },
            ],
          },
          ctx,
        );
        const autoBody = decodeToolJson(autoRes);
        assert.strictEqual(autoBody.status, "applied");
        assert.strictEqual(autoBody.applyMode, "auto");
        assert.strictEqual(autoBody.previousRevision, 1);
        assert.strictEqual(autoBody.undoRevision, 1);
        assert.strictEqual(autoBody.revision, 2);
        assert.deepStrictEqual(readLatestAgents(frames), [
          {
            id: threadId,
            name: "Moss",
            state: "done",
            label: "Moss 已修改",
            blockIds: ["blk-1"],
            threadId,
          },
        ]);

        // 3. One-click rollback via restore-version brings original line back
        const restored = yield* pageTools.get("moss_pages_mutate")!.handler(
          {
            op: "restore-version",
            requestId: "undo-1",
            scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 2,
            revision: autoBody.undoRevision,
          },
          ctx,
        );
        const restoredBody = decodeToolJson(restored);
        assert.strictEqual((restoredBody.page as { revision: number }).revision, 3);
        const rereadRestored = yield* pages.read(
          { scopeSpaceId, pageId: created.page.id },
          LOCAL_PAGES_PRINCIPAL,
        );
        assert.strictEqual(rereadRestored.content, "Initial line");

        // 4. 建议模式 (`applyMode: "draft"`) keeps body edits staged as reviewable drafts
        const draftRes = yield* draftTools.get("moss_pages_draft")!.handler(
          {
            scopeSpaceId,
            pageId: created.page.id,
            baseRevision: 3,
            applyMode: "draft",
            ops: [{ kind: "insert", afterBlockId: "blk-1", markdown: "Suggested addition" }],
          },
          ctx,
        );
        const draftBody = decodeToolJson(draftRes);
        assert.isArray(draftBody.drafts);
        const afterDraftRead = yield* pages.read(
          { scopeSpaceId, pageId: created.page.id },
          LOCAL_PAGES_PRINCIPAL,
        );
        assert.strictEqual(afterDraftRead.page.revision, 3);

        realtime.leave(created.page.id, joined!.connection);
      }),
  );

  it.effect(
    "auto-applies Dashboard edits with rollback revision and stages 建议模式 drafts cleanly",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const types = yield* PageTypesService;
        const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
        const projectId = randomUUID();
        const threadId = ThreadId.makeUnsafe(randomUUID());
        yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES (${scopeSpaceId}, 'Dashboard space', 'folder', 0, ${now}, ${now})`;
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
        VALUES (${projectId}, 'Project', '/fixture', '[]', ${scopeSpaceId}, ${now}, ${now})`;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES (${threadId}, ${projectId}, 'Dashboard Thread', ${now}, ${now})`;

        const baseDashboard = {
          ...createDashboard("KPI"),
          files: { "index.html": { text: "<h1>Original KPI</h1>" } },
        };
        const created = yield* types.create(
          {
            requestId: randomUUID(),
            scopeSpaceId,
            kind: "app",
            title: "KPI",
            spaceId: null,
            parentPageId: null,
            data: JSON.stringify(baseDashboard),
          },
          LOCAL_PAGES_PRINCIPAL,
        );

        const tools = new Map(makePageTypeTools({ types }).map((t) => [t.definition.name, t]));
        const ctx: ToolContext = {
          callerThreadId: threadId,
          callerTurnId: "turn-dash" as never,
          assertCallerTurnActive: () => Effect.void,
        } as unknown as ToolContext;

        const writeAuto = yield* tools.get("moss_dashboard_write")!.handler(
          {
            requestId: "dash-auto-1",
            scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 1,
            companionContext: { kind: "dashboard", itemId: created.page.id },
            writes: [
              { op: "set", path: "files/index.html", data: { text: "<h1>Live Updated KPI</h1>" } },
            ],
          },
          ctx,
        );
        const autoBody = decodeToolJson(writeAuto);
        assert.strictEqual(autoBody.applied, true);
        assert.strictEqual(autoBody.applyMode, "auto");
        assert.strictEqual(autoBody.previousRevision, 1);
        assert.strictEqual(autoBody.undoRevision, 1);
        assert.strictEqual(autoBody.revision, 2);

        // Verify rollback restores original HTML cleanly
        const rolledBack = yield* restorePageTypeRevision(
          types,
          {
            requestId: "dash-undo-1",
            scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 2,
            targetRevision: Number(autoBody.undoRevision),
          },
          LOCAL_PAGES_PRINCIPAL,
        );
        assert.strictEqual(
          parseDashboard(rolledBack.item.data!).files["index.html"]?.text,
          "<h1>Original KPI</h1>",
        );

        // Verify applyMode: "draft" stages changes under `draft` without mutating live files
        const writeDraft = yield* tools.get("moss_dashboard_write")!.handler(
          {
            requestId: "dash-draft-1",
            scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 3,
            applyMode: "draft",
            writes: [
              { op: "set", path: "files/index.html", data: { text: "<h1>Suggested KPI</h1>" } },
            ],
          },
          ctx,
        );
        const draftBody = decodeToolJson(writeDraft);
        assert.strictEqual(draftBody.applied, false);
        assert.strictEqual(draftBody.applyMode, "draft");
        const current = yield* types.read(
          { scopeSpaceId, pageId: created.page.id },
          LOCAL_PAGES_PRINCIPAL,
        );
        const parsed = parseDashboard(current.data!);
        assert.strictEqual(parsed.files["index.html"]?.text, "<h1>Original KPI</h1>");
        assert.strictEqual(parsed.draft?.files["index.html"]?.text, "<h1>Suggested KPI</h1>");
      }),
  );
});
